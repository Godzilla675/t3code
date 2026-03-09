/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import { randomUUID } from "node:crypto";

import {
  EventId,
  NonNegativeInt,
  type ProviderModelOptions,
  RuntimeRequestId,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Queue, Schema, SchemaIssue, Stream } from "effect";

import { ProviderValidationError } from "../Errors.ts";
import { readPersistedProviderModelOptions } from "../providerModelOptions.ts";
import { readPersistedProviderStartOptions } from "../providerStartOptions.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

const PENDING_APPROVAL_REQUESTS_KEY = "pendingApprovalRequests";
const PENDING_USER_INPUT_REQUESTS_KEY = "pendingUserInputRequests";
const RECENTLY_EXPIRED_REQUEST_TTL_MS = 15 * 60 * 1000;

type PersistedPendingApprovalRequest = {
  readonly requestId: string;
  readonly requestType:
    | "command_execution_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "apply_patch_approval"
    | "exec_command_approval"
    | "dynamic_tool_call"
    | "auth_tokens_refresh"
    | "unknown";
  readonly turnId?: TurnId;
};

type PersistedPendingUserInputRequest = {
  readonly requestId: string;
  readonly turnId?: TurnId;
};

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  options?: {
    readonly modelOptions?: ProviderModelOptions;
    readonly providerOptions?: ProviderStartOptions;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    [PENDING_APPROVAL_REQUESTS_KEY]: [],
    [PENDING_USER_INPUT_REQUESTS_KEY]: [],
    modelOptions: options?.modelOptions ?? null,
    ...(options?.providerOptions !== undefined ? { providerOptions: options.providerOptions } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedModel(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  const rawModel = "model" in runtimePayload ? runtimePayload.model : undefined;
  if (typeof rawModel !== "string") return undefined;
  const trimmed = rawModel.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedActiveTurnId(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): TurnId | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  const rawActiveTurnId = "activeTurnId" in runtimePayload ? runtimePayload.activeTurnId : undefined;
  if (typeof rawActiveTurnId !== "string") {
    return undefined;
  }
  const trimmed = rawActiveTurnId.trim();
  return trimmed.length > 0 ? TurnId.makeUnsafe(trimmed) : undefined;
}

function normalizePersistedRequestType(
  value: unknown,
): PersistedPendingApprovalRequest["requestType"] {
  switch (value) {
    case "command_execution_approval":
    case "file_read_approval":
    case "file_change_approval":
    case "apply_patch_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
    case "auth_tokens_refresh":
      return value;
    default:
      return "unknown";
  }
}

function normalizePersistedPendingApprovalRequest(
  value: unknown,
): PersistedPendingApprovalRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawRequestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
  if (!rawRequestId) {
    return undefined;
  }
  const rawTurnId = typeof value.turnId === "string" ? value.turnId.trim() : "";
  return {
    requestId: rawRequestId,
    requestType: normalizePersistedRequestType(value.requestType),
    ...(rawTurnId ? { turnId: TurnId.makeUnsafe(rawTurnId) } : {}),
  };
}

function normalizePersistedPendingUserInputRequest(
  value: unknown,
): PersistedPendingUserInputRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawRequestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
  if (!rawRequestId) {
    return undefined;
  }
  const rawTurnId = typeof value.turnId === "string" ? value.turnId.trim() : "";
  return {
    requestId: rawRequestId,
    ...(rawTurnId ? { turnId: TurnId.makeUnsafe(rawTurnId) } : {}),
  };
}

function readPersistedPendingApprovalRequests(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ReadonlyArray<PersistedPendingApprovalRequest> {
  if (!isRecord(runtimePayload)) {
    return [];
  }
  const rawRequests =
    PENDING_APPROVAL_REQUESTS_KEY in runtimePayload ? runtimePayload[PENDING_APPROVAL_REQUESTS_KEY] : [];
  if (!Array.isArray(rawRequests)) {
    return [];
  }
  return rawRequests.flatMap((entry) => {
    const normalized = normalizePersistedPendingApprovalRequest(entry);
    return normalized ? [normalized] : [];
  });
}

function readPersistedPendingUserInputRequests(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ReadonlyArray<PersistedPendingUserInputRequest> {
  if (!isRecord(runtimePayload)) {
    return [];
  }
  const rawRequests =
    PENDING_USER_INPUT_REQUESTS_KEY in runtimePayload
      ? runtimePayload[PENDING_USER_INPUT_REQUESTS_KEY]
      : [];
  if (!Array.isArray(rawRequests)) {
    return [];
  }
  return rawRequests.flatMap((entry) => {
    const normalized = normalizePersistedPendingUserInputRequest(entry);
    return normalized ? [normalized] : [];
  });
}

function toPersistedRuntimeModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return undefined;
  }
  return trimmed;
}

function withoutPendingRequestId<T extends { readonly requestId: string }>(
  requests: ReadonlyArray<T>,
  requestId: string,
): Array<T> {
  return requests.filter((entry) => entry.requestId !== requestId);
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const analytics = yield* Effect.service(AnalyticsService);
    const canonicalEventLogger =
      options?.canonicalEventLogger ??
      (options?.canonicalEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
            stream: "canonical",
          })
        : undefined);

    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const recentlyExpiredApprovalRequests = new Map<string, number>();
    const recentlyExpiredUserInputRequests = new Map<string, number>();

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.succeed(event).pipe(
        Effect.tap((canonicalEvent) =>
          canonicalEventLogger
            ? canonicalEventLogger.write(canonicalEvent, null)
            : Effect.void,
        ),
        Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
        Effect.asVoid,
      );

    const pruneExpiredRequestCache = (cache: Map<string, number>, currentTimeMs: number) => {
      for (const [requestId, storedAtMs] of cache) {
        if (currentTimeMs - storedAtMs > RECENTLY_EXPIRED_REQUEST_TTL_MS) {
          cache.delete(requestId);
        }
      }
    };

    const rememberExpiredRequests = (cache: Map<string, number>, requestIds: ReadonlyArray<string>) => {
      if (requestIds.length === 0) {
        return;
      }
      const nowMs = Date.now();
      pruneExpiredRequestCache(cache, nowMs);
      for (const requestId of requestIds) {
        cache.set(requestId, nowMs);
      }
    };

    const wasRecentlyExpiredRequest = (cache: Map<string, number>, requestId: string): boolean => {
      const nowMs = Date.now();
      pruneExpiredRequestCache(cache, nowMs);
      const storedAtMs = cache.get(requestId);
      if (storedAtMs === undefined) {
        return false;
      }
      if (nowMs - storedAtMs > RECENTLY_EXPIRED_REQUEST_TTL_MS) {
        cache.delete(requestId);
        return false;
      }
      return true;
    };

    const updatePersistedPendingApprovalRequests = (input: {
      readonly threadId: ThreadId;
      readonly provider: ProviderRuntimeEvent["provider"];
      readonly update: (
        current: ReadonlyArray<PersistedPendingApprovalRequest>,
      ) => ReadonlyArray<PersistedPendingApprovalRequest>;
    }) =>
      directory.getBinding(input.threadId).pipe(
        Effect.flatMap((bindingOption) => {
          const binding = Option.getOrUndefined(bindingOption);
          const next = input.update(
            readPersistedPendingApprovalRequests(binding?.runtimePayload ?? null),
          );
          return directory.upsert({
            threadId: input.threadId,
            provider: input.provider,
            runtimePayload: {
              [PENDING_APPROVAL_REQUESTS_KEY]: next,
            },
          });
        }),
      );

    const updatePersistedPendingUserInputRequests = (input: {
      readonly threadId: ThreadId;
      readonly provider: ProviderRuntimeEvent["provider"];
      readonly update: (
        current: ReadonlyArray<PersistedPendingUserInputRequest>,
      ) => ReadonlyArray<PersistedPendingUserInputRequest>;
    }) =>
      directory.getBinding(input.threadId).pipe(
        Effect.flatMap((bindingOption) => {
          const binding = Option.getOrUndefined(bindingOption);
          const next = input.update(
            readPersistedPendingUserInputRequests(binding?.runtimePayload ?? null),
          );
          return directory.upsert({
            threadId: input.threadId,
            provider: input.provider,
            runtimePayload: {
              [PENDING_USER_INPUT_REQUESTS_KEY]: next,
            },
          });
        }),
      );

    const expirePersistedPendingInteractiveRequests = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly reason: "service-startup" | "session-recovery";
    }) =>
      Effect.gen(function* () {
        const pendingApprovalRequests = readPersistedPendingApprovalRequests(
          input.binding.runtimePayload,
        );
        const pendingUserInputRequests = readPersistedPendingUserInputRequests(
          input.binding.runtimePayload,
        );
        if (pendingApprovalRequests.length === 0 && pendingUserInputRequests.length === 0) {
          return;
        }

        yield* directory.upsert({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          runtimePayload: {
            [PENDING_APPROVAL_REQUESTS_KEY]: [],
            [PENDING_USER_INPUT_REQUESTS_KEY]: [],
          },
        });

        rememberExpiredRequests(
          recentlyExpiredApprovalRequests,
          pendingApprovalRequests.map((request) => request.requestId),
        );
        rememberExpiredRequests(
          recentlyExpiredUserInputRequests,
          pendingUserInputRequests.map((request) => request.requestId),
        );

        const createdAt = new Date().toISOString();
        const staleRequestEvents: Array<ProviderRuntimeEvent> = [
          ...pendingApprovalRequests.map(
            (request) =>
              ({
                eventId: EventId.makeUnsafe(randomUUID()),
                provider: input.binding.provider,
                threadId: input.binding.threadId,
                createdAt,
                ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
                requestId: RuntimeRequestId.makeUnsafe(request.requestId),
                type: "request.resolved",
                payload: {
                  requestType: request.requestType,
                  decision: "cancel",
                  resolution: {
                    decision: "cancel",
                    reason: "expired-after-restart",
                  },
                },
              }) satisfies ProviderRuntimeEvent,
          ),
          ...pendingUserInputRequests.map(
            (request) =>
              ({
                eventId: EventId.makeUnsafe(randomUUID()),
                provider: input.binding.provider,
                threadId: input.binding.threadId,
                createdAt,
                ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
                requestId: RuntimeRequestId.makeUnsafe(request.requestId),
                type: "user-input.resolved",
                payload: {
                  answers: {},
                },
              }) satisfies ProviderRuntimeEvent,
          ),
          {
            eventId: EventId.makeUnsafe(randomUUID()),
            provider: input.binding.provider,
            threadId: input.binding.threadId,
            createdAt,
            type: "runtime.warning",
            payload: {
              message:
                input.reason === "service-startup"
                  ? "Cleared stale interactive provider requests after service restart."
                  : "Cleared stale interactive provider requests while recovering the provider session.",
              detail: {
                reason: input.reason,
                approvalRequestIds: pendingApprovalRequests.map((request) => request.requestId),
                userInputRequestIds: pendingUserInputRequests.map((request) => request.requestId),
              },
            },
          } satisfies ProviderRuntimeEvent,
        ];

        yield* Queue.offerAll(runtimeEventQueue, staleRequestEvents).pipe(Effect.asVoid);
      });

    const persistRuntimeEventProjection = (event: ProviderRuntimeEvent) => {
      switch (event.type) {
        case "turn.started": {
          const model = toPersistedRuntimeModel(event.payload.model);
          return directory.upsert({
            threadId: event.threadId,
            provider: event.provider,
            runtimePayload: {
              ...(model ? { model } : {}),
              ...(event.turnId !== undefined ? { activeTurnId: event.turnId } : {}),
            },
          });
        }
        case "turn.completed":
        case "turn.aborted": {
          return directory.upsert({
            threadId: event.threadId,
            provider: event.provider,
            runtimePayload: {
              activeTurnId: null,
            },
          });
        }
        case "model.rerouted": {
          const model = toPersistedRuntimeModel(event.payload.toModel);
          return model
            ? directory.upsert({
                threadId: event.threadId,
                provider: event.provider,
                runtimePayload: {
                  model,
                },
              })
            : Effect.void;
        }
        case "request.opened": {
          if (event.requestId === undefined || event.payload.requestType === "tool_user_input") {
            return Effect.void;
          }
          return updatePersistedPendingApprovalRequests({
            threadId: event.threadId,
            provider: event.provider,
            update: (current) => [
              ...withoutPendingRequestId(current, String(event.requestId)),
              {
                requestId: String(event.requestId),
                requestType: normalizePersistedRequestType(event.payload.requestType),
                ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
              },
            ],
          });
        }
        case "request.resolved": {
          if (event.requestId === undefined || event.payload.requestType === "tool_user_input") {
            return Effect.void;
          }
          return updatePersistedPendingApprovalRequests({
            threadId: event.threadId,
            provider: event.provider,
            update: (current) => withoutPendingRequestId(current, String(event.requestId)),
          });
        }
        case "user-input.requested": {
          if (event.requestId === undefined) {
            return Effect.void;
          }
          return updatePersistedPendingUserInputRequests({
            threadId: event.threadId,
            provider: event.provider,
            update: (current) => [
              ...withoutPendingRequestId(current, String(event.requestId)),
              {
                requestId: String(event.requestId),
                ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
              },
            ],
          });
        }
        case "user-input.resolved": {
          if (event.requestId === undefined) {
            return Effect.void;
          }
          return updatePersistedPendingUserInputRequests({
            threadId: event.threadId,
            provider: event.provider,
            update: (current) => withoutPendingRequestId(current, String(event.requestId)),
          });
        }
        default:
          return Effect.void;
      }
    };

    const upsertSessionBinding = (
      session: ProviderSession,
      threadId: ThreadId,
      options?: {
        readonly modelOptions?: ProviderModelOptions;
        readonly providerOptions?: ProviderStartOptions;
      },
    ) =>
      directory.upsert({
        threadId,
        provider: session.provider,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, options),
      });

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) =>
      registry.getByProvider(provider),
    );

    const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      persistRuntimeEventProjection(event).pipe(
        Effect.catch((cause: unknown) =>
          Effect.logWarning("failed to persist provider runtime projection", {
            cause,
            threadId: event.threadId,
            provider: event.provider,
            eventType: event.type,
          }),
        ),
        Effect.andThen(publishRuntimeEvent(event)),
      );

    const worker = Effect.forever(
      Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
    );
    yield* worker.pipe(Effect.forkScoped({ startImmediately: true }));

    yield* Effect.forEach(adapters, (adapter) =>
      Stream.runForEach(adapter.streamEvents, (event) =>
        Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      ).pipe(Effect.forkScoped({ startImmediately: true })),
    ).pipe(Effect.asVoid);

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
    }) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(input.binding.provider);
        const persistedProviderOptions = readPersistedProviderStartOptions(input.binding.runtimePayload);
        const hasResumeCursor =
          input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
        const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
        if (hasActiveSession) {
          const activeSessions = yield* adapter.listSessions();
          const existing = activeSessions.find((session) => session.threadId === input.binding.threadId);
          if (existing) {
            yield* upsertSessionBinding(
              existing,
              input.binding.threadId,
              persistedProviderOptions ? { providerOptions: persistedProviderOptions } : undefined,
            );
            yield* analytics.record("provider.session.recovered", {
              provider: existing.provider,
              strategy: "adopt-existing",
              hasResumeCursor: existing.resumeCursor !== undefined,
            });
            return { adapter, session: existing } as const;
          }
        }

        yield* expirePersistedPendingInteractiveRequests({
          binding: input.binding,
          reason: "session-recovery",
        });

        if (!hasResumeCursor) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
          );
        }

        const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
        const persistedModel = readPersistedModel(input.binding.runtimePayload);
        const persistedActiveTurnId = readPersistedActiveTurnId(input.binding.runtimePayload);
        const persistedModelOptions = readPersistedProviderModelOptions(input.binding.runtimePayload);

        const resumed = yield* adapter.startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModel ? { model: persistedModel } : {}),
          ...(persistedModelOptions ? { modelOptions: persistedModelOptions } : {}),
          ...(persistedActiveTurnId !== undefined ? { activeTurnId: persistedActiveTurnId } : {}),
          ...(persistedProviderOptions ? { providerOptions: persistedProviderOptions } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        });
        if (resumed.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
          );
        }

        yield* upsertSessionBinding(
          resumed,
          input.binding.threadId,
          persistedProviderOptions ? { providerOptions: persistedProviderOptions } : undefined,
        );
        yield* analytics.record("provider.session.recovered", {
          provider: resumed.provider,
          strategy: "resume-thread",
          hasResumeCursor: resumed.resumeCursor !== undefined,
        });
        return { adapter, session: resumed } as const;
      });

    const clearUnrecoverableStartupRuntimeState = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly detail: string;
    }) =>
      Effect.gen(function* () {
        yield* directory.upsert({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            [PENDING_APPROVAL_REQUESTS_KEY]: [],
            [PENDING_USER_INPUT_REQUESTS_KEY]: [],
            lastError: input.detail,
          },
        });
        yield* Queue.offer(runtimeEventQueue, {
          eventId: EventId.makeUnsafe(randomUUID()),
          provider: input.binding.provider,
          threadId: input.binding.threadId,
          createdAt: new Date().toISOString(),
          type: "runtime.warning",
          payload: {
            message: input.detail,
          },
        } satisfies ProviderRuntimeEvent).pipe(Effect.asVoid);
      });

    const reconcilePersistedBindingsOnStartup = Effect.gen(function* () {
      const threadIds = yield* directory.listThreadIds();
      yield* Effect.forEach(
        threadIds,
        (threadId) =>
          directory.getBinding(threadId).pipe(
            Effect.flatMap((bindingOption) => {
              const binding = Option.getOrUndefined(bindingOption);
              if (!binding) {
                return Effect.void;
              }

              const hasPersistedActiveTurn =
                readPersistedActiveTurnId(binding.runtimePayload) !== undefined;
              const hasPendingRequests =
                readPersistedPendingApprovalRequests(binding.runtimePayload).length > 0 ||
                readPersistedPendingUserInputRequests(binding.runtimePayload).length > 0;

              if (!hasPersistedActiveTurn && !hasPendingRequests) {
                return Effect.void;
              }

              if (hasPersistedActiveTurn) {
                return recoverSessionForThread({
                  binding,
                  operation: "ProviderService.reconcilePersistedSessions",
                }).pipe(
                  Effect.asVoid,
                  Effect.catch((cause: unknown) => {
                    const detail =
                      cause instanceof Error
                        ? cause.message
                        : `Provider session recovery failed during startup: ${String(cause)}`;
                    return clearUnrecoverableStartupRuntimeState({
                      binding,
                      detail,
                    }).pipe(
                      Effect.andThen(
                        Effect.logWarning("failed to reconcile persisted provider session on startup", {
                          cause,
                          threadId: binding.threadId,
                          provider: binding.provider,
                        }),
                      ),
                    );
                  }),
                );
              }

              return expirePersistedPendingInteractiveRequests({
                binding,
                reason: "service-startup",
              }).pipe(
                Effect.catch((cause: unknown) =>
                  Effect.logWarning("failed to expire stale persisted provider requests on startup", {
                    cause,
                    threadId: binding.threadId,
                    provider: binding.provider,
                  }),
                ),
              );
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid);
    });

    const resolveRoutableSession = (input: {
      readonly threadId: ThreadId;
      readonly operation: string;
      readonly allowRecovery: boolean;
    }) =>
      Effect.gen(function* () {
        const bindingOption = yield* directory.getBinding(input.threadId);
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding) {
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
          );
        }
        const adapter = yield* registry.getByProvider(binding.provider);

        const hasRequestedSession = yield* adapter.hasSession(input.threadId);
        if (hasRequestedSession) {
          return { adapter, threadId: input.threadId, isActive: true } as const;
        }

        if (!input.allowRecovery) {
          return { adapter, threadId: input.threadId, isActive: false } as const;
        }

        const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
        return { adapter: recovered.adapter, threadId: input.threadId, isActive: true } as const;
      });

    const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.startSession",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          threadId,
          provider: parsed.provider ?? "codex",
        };
        const adapter = yield* registry.getByProvider(input.provider);
        const session = yield* adapter.startSession(input);

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* upsertSessionBinding(
          session,
          threadId,
          input.providerOptions !== undefined || input.modelOptions !== undefined
            ? {
                ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
                ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
              }
            : undefined,
        );
        yield* analytics.record("provider.session.started", {
          provider: session.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: session.resumeCursor !== undefined,
          hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
          hasModel: typeof input.model === "string" && input.model.trim().length > 0,
        });

        return session;
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.sendTurn",
          schema: ProviderSendTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: parsed.attachments ?? [],
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
        const turn = yield* routed.adapter.sendTurn(input);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            ...(input.model !== undefined ? { model: input.model } : {}),
            modelOptions: input.modelOptions ?? null,
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.sendTurn",
            lastRuntimeEventAt: new Date().toISOString(),
          },
        });
        yield* analytics.record("provider.turn.sent", {
          provider: routed.adapter.provider,
          model: input.model,
          interactionMode: input.interactionMode,
          attachmentCount: input.attachments.length,
          hasInput: typeof input.input === "string" && input.input.trim().length > 0,
        });
        return turn;
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.interruptTurn",
          schema: ProviderInterruptTurnInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      });

    const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToRequest",
          schema: ProviderRespondToRequestInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        if (wasRecentlyExpiredRequest(recentlyExpiredApprovalRequests, String(input.requestId))) {
          return;
        }
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      });

    const respondToUserInput: ProviderServiceShape["respondToUserInput"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToUserInput",
          schema: ProviderRespondToUserInputInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToUserInput",
          allowRecovery: true,
        });
        if (wasRecentlyExpiredRequest(recentlyExpiredUserInputRequests, String(input.requestId))) {
          return;
        }
        yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
      });

    const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* directory.remove(input.threadId);
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      });

    const stopSessionForProvider: ProviderServiceShape["stopSessionForProvider"] = (input) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(input.provider);
        const hasSession = yield* adapter.hasSession(input.threadId);
        if (!hasSession) {
          return;
        }
        yield* adapter.stopSession(input.threadId);
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.gen(function* () {
        const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) => adapter.listSessions());
        const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
        const persistedBindings = yield* directory
          .listThreadIds()
          .pipe(
            Effect.flatMap((threadIds) =>
              Effect.forEach(
                threadIds,
                (threadId) =>
                  directory.getBinding(threadId).pipe(
                    Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>()),
                  ),
                { concurrency: "unbounded" },
              ),
            ),
            Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
          );
        const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
        for (const bindingOption of persistedBindings) {
          const binding = Option.getOrUndefined(bindingOption);
          if (binding) {
            bindingsByThreadId.set(binding.threadId, binding);
          }
        }

        return activeSessions
          .filter((session) => {
            const binding = bindingsByThreadId.get(session.threadId);
            return binding !== undefined && binding.provider === session.provider;
          })
          .map((session) => {
            const binding = bindingsByThreadId.get(session.threadId);
            if (!binding) {
              return session;
            }

            const overrides: {
              resumeCursor?: ProviderSession["resumeCursor"];
              runtimeMode?: ProviderSession["runtimeMode"];
            } = {};
            if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
              overrides.resumeCursor = binding.resumeCursor;
            }
            if (binding.runtimeMode !== undefined) {
              overrides.runtimeMode = binding.runtimeMode;
            }
            return Object.assign({}, session, overrides);
          });
      });

    const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
      registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

    const reconcilePersistedSessions: ProviderServiceShape["reconcilePersistedSessions"] = () =>
      reconcilePersistedBindingsOnStartup.pipe(
        Effect.catch((cause: unknown) =>
          Effect.logWarning("failed to reconcile persisted provider sessions", {
            cause,
          }),
        ),
      );

    const rollbackConversation: ProviderServiceShape["rollbackConversation"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.rollbackConversation",
          schema: ProviderRollbackConversationInput,
          payload: rawInput,
        });
        if (input.numTurns === 0) {
          return;
        }
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.rollbackConversation",
          allowRecovery: true,
        });
        yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
        yield* analytics.record("provider.conversation.rolled_back", {
          provider: routed.adapter.provider,
          turns: input.numTurns,
        });
      });

    const runStopAll = () =>
      Effect.gen(function* () {
        const threadIds = yield* directory.listThreadIds();
        yield* Effect.forEach(threadIds, (threadId) =>
          directory.getProvider(threadId).pipe(
            Effect.flatMap((provider) =>
              directory.upsert({
                threadId,
                provider,
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  [PENDING_APPROVAL_REQUESTS_KEY]: [],
                  [PENDING_USER_INPUT_REQUESTS_KEY]: [],
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
        yield* analytics.record("provider.sessions.stopped_all", {
          sessionCount: threadIds.length,
        });
        yield* analytics.flush;
      });

    yield* Effect.addFinalizer(() =>
      Effect.catch(runStopAll(), (cause) =>
        Effect.logWarning("failed to stop provider service", { cause }),
      ),
    );

    return {
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopSessionForProvider,
      listSessions,
      getCapabilities,
      reconcilePersistedSessions,
      rollbackConversation,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
