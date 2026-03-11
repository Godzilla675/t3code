import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import {
  type ChatAttachment,
  type CodexReasoningEffort,
  EventId,
  ProviderItemId,
  type ProviderInteractionMode,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type RuntimeErrorClass,
  type RuntimeItemStatus,
} from "@t3tools/contracts";
import type { PermissionRequestResult } from "@github/copilot-sdk";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { resolveAttachmentPath as defaultResolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { loadCopilotSdk } from "../copilotSdkCompat.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

type CopilotPermissionResult = PermissionRequestResult;

type CopilotPermissionRequest = {
  kind: "shell" | "write" | "mcp" | "read" | "url" | "memory" | "custom-tool";
  toolCallId?: string;
  [key: string]: unknown;
};

type CopilotUserInputRequest = {
  question: string;
  choices?: ReadonlyArray<string>;
  allowFreeform?: boolean;
};

type CopilotUserInputResponse = {
  answer: string;
  wasFreeform: boolean;
};

type CopilotSessionEvent = {
  id: string;
  timestamp?: string;
  type: string;
  parentId?: string | null;
  ephemeral?: boolean;
  data?: Record<string, unknown>;
};

type CopilotMessageAttachment =
  | {
      type: "file";
      path: string;
      displayName?: string;
    }
  | {
      type: "directory";
      path: string;
      displayName?: string;
    }
  | {
      type: "selection";
      filePath: string;
      displayName: string;
      selection?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      text?: string;
    };

type CopilotSendMode = "enqueue" | "immediate";
type CopilotSessionMode = "interactive" | "plan" | "autopilot";

type CopilotPlanReadResult = {
  exists: boolean;
  content: string | null;
  path: string | null;
};

interface CopilotSessionRpcLike {
  readonly mode?: {
    get(): Promise<{ mode: CopilotSessionMode }>;
    set(params: { mode: CopilotSessionMode }): Promise<{ mode: CopilotSessionMode }>;
  };
  readonly plan?: {
    read(): Promise<CopilotPlanReadResult>;
  };
}

interface CopilotSessionLike {
  readonly sessionId: string;
  readonly rpc?: CopilotSessionRpcLike;
  send(options: {
    prompt: string;
    attachments?: ReadonlyArray<CopilotMessageAttachment>;
    mode?: CopilotSendMode;
  }): Promise<string>;
  abort(): Promise<void>;
  setModel(model: string): Promise<void>;
  getMessages(): Promise<ReadonlyArray<CopilotSessionEvent>>;
  disconnect(): Promise<void>;
  on(handler: (event: CopilotSessionEvent) => void): () => void;
}

interface CopilotClientLike {
  start(): Promise<void>;
  createSession(config: {
    sessionId?: string;
    clientName?: string;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    configDir?: string;
    onPermissionRequest: (
      request: CopilotPermissionRequest,
      invocation: { sessionId: string },
    ) => Promise<CopilotPermissionResult> | CopilotPermissionResult;
    onUserInputRequest?: (
      request: CopilotUserInputRequest,
      invocation: { sessionId: string },
    ) => Promise<CopilotUserInputResponse> | CopilotUserInputResponse;
    workingDirectory?: string;
    streaming?: boolean;
  }): Promise<CopilotSessionLike>;
  resumeSession(
    sessionId: string,
    config: {
      clientName?: string;
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
      configDir?: string;
      onPermissionRequest: (
        request: CopilotPermissionRequest,
        invocation: { sessionId: string },
      ) => Promise<CopilotPermissionResult> | CopilotPermissionResult;
      onUserInputRequest?: (
        request: CopilotUserInputRequest,
        invocation: { sessionId: string },
      ) => Promise<CopilotUserInputResponse> | CopilotUserInputResponse;
      workingDirectory?: string;
      streaming?: boolean;
    },
  ): Promise<CopilotSessionLike>;
  stop(): Promise<ReadonlyArray<Error>>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export interface CopilotClientFactoryOptions {
  readonly threadId: ThreadId;
  readonly cwd?: string;
  readonly cliUrl?: string;
}

export interface CopilotAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly clientFactory?: (
    options: CopilotClientFactoryOptions,
  ) => CopilotClientLike | Promise<CopilotClientLike>;
  readonly now?: () => string;
  readonly generateId?: () => string;
  readonly resolveAttachmentPath?: (input: {
    readonly stateDir: string;
    readonly attachment: ChatAttachment;
  }) => string | null;
  readonly fileExists?: (path: string) => boolean;
  readonly interactiveRequestTimeoutMs?: number;
}

interface PendingApprovalRequest {
  readonly requestId: string;
  readonly runtimeRequestId: RuntimeRequestId;
  readonly turnId?: TurnId;
  readonly requestType: CanonicalRequestType;
  readonly request: CopilotPermissionRequest;
  readonly resolve: (result: CopilotPermissionResult) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface PendingUserInput {
  readonly requestId: string;
  readonly runtimeRequestId: RuntimeRequestId;
  readonly turnId?: TurnId;
  readonly request: CopilotUserInputRequest;
  readonly resolve: (result: CopilotUserInputResponse) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface ToolLifecycleState {
  readonly itemType: CanonicalItemType;
  readonly title?: string;
  readonly arguments?: unknown;
}

interface CopilotRuntimeEntry {
  readonly threadId: ThreadId;
  readonly client: CopilotClientLike;
  readonly session: CopilotSessionLike;
  readonly pendingApprovals: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputs: Map<string, PendingUserInput>;
  readonly toolCalls: Map<string, ToolLifecycleState>;
  readonly unsubscribe: () => void;
  providerSession: ProviderSession;
  activeTurnId: TurnId | undefined;
  activeProviderTurnId: string | undefined;
  sessionMode: CopilotSessionMode | undefined;
  lastPlanTurnId: TurnId | undefined;
  lastPlanMarkdown: string | undefined;
  lastUsage: Record<string, unknown> | undefined;
  activeTurnHadToolActivity: boolean;
  activeTurnHadCompletedAssistantMessage: boolean;
  pendingToolOnlyCompletionTimer: ReturnType<typeof setTimeout> | undefined;
}

interface SessionPatch {
  readonly status?: ProviderSession["status"];
  readonly model?: ProviderSession["model"] | undefined;
  readonly activeTurnId?: ProviderSession["activeTurnId"] | undefined;
  readonly lastError?: ProviderSession["lastError"] | undefined;
}

const PROVIDER = "copilot" as const;
const CLIENT_NAME = "t3code";
const DEFAULT_QUESTION_ID = "response";
const TOOL_ONLY_TURN_COMPLETION_GRACE_MS = 250;
const INTERACTIVE_REQUEST_TIMEOUT_MS = 5 * 60_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRawString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function normalizeIsoTimestamp(value: string | undefined, now: () => string): string {
  if (!value) {
    return now();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? now() : parsed.toISOString();
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function touchSession(entry: CopilotRuntimeEntry, patch: SessionPatch, updatedAt: string): void {
  const {
    model: _existingModel,
    activeTurnId: _existingActiveTurnId,
    lastError: _existingLastError,
    ...baseSession
  } = entry.providerSession;

  entry.providerSession = {
    ...baseSession,
    updatedAt,
    ...(patch.status !== undefined ? { status: patch.status } : { status: entry.providerSession.status }),
    ...("model" in patch
      ? patch.model !== undefined
        ? { model: patch.model }
        : {}
      : entry.providerSession.model !== undefined
        ? { model: entry.providerSession.model }
        : {}),
    ...("activeTurnId" in patch
      ? patch.activeTurnId !== undefined
        ? { activeTurnId: patch.activeTurnId }
        : {}
      : entry.providerSession.activeTurnId !== undefined
        ? { activeTurnId: entry.providerSession.activeTurnId }
        : {}),
    ...("lastError" in patch
      ? patch.lastError !== undefined
        ? { lastError: patch.lastError }
        : {}
      : entry.providerSession.lastError !== undefined
        ? { lastError: entry.providerSession.lastError }
        : {}),
  };
}

function cancelPendingToolOnlyCompletion(entry: CopilotRuntimeEntry): void {
  if (entry.pendingToolOnlyCompletionTimer === undefined) {
    return;
  }
  clearTimeout(entry.pendingToolOnlyCompletionTimer);
  entry.pendingToolOnlyCompletionTimer = undefined;
}

function buildSdkRaw(event: CopilotSessionEvent): ProviderRuntimeEvent["raw"] {
  return {
    source: "copilot.sdk.event",
    messageType: event.type,
    payload: event,
  };
}

function toRuntimeErrorClass(_errorType: string | undefined): RuntimeErrorClass {
  return "provider_error";
}

function clearPendingTimeout(
  pending: Pick<PendingApprovalRequest, "timeoutHandle"> | Pick<PendingUserInput, "timeoutHandle">,
): void {
  if (pending.timeoutHandle !== undefined) {
    clearTimeout(pending.timeoutHandle);
  }
}

function makeDeterministicHistoryTurnId(
  event: Pick<CopilotSessionEvent, "id">,
  turnIndex: number,
): TurnId {
  const eventId = asTrimmedString(event.id);
  return TurnId.makeUnsafe(eventId ? `history:${turnIndex}:${eventId}` : `history:${turnIndex}`);
}

function toRequestType(request: CopilotPermissionRequest): CanonicalRequestType {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "write":
      return "file_change_approval";
    case "mcp":
    case "custom-tool":
    case "url":
    case "memory":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

function describePermissionRequest(request: CopilotPermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return asTrimmedString(request.fullCommandText) ?? asTrimmedString(request.intention);
    case "write":
      return (
        asTrimmedString(request.fileName) ??
        asTrimmedString(request.intention) ??
        asTrimmedString(request.diff)
      );
    case "read":
      return asTrimmedString(request.path) ?? asTrimmedString(request.intention);
    case "mcp":
      return (
        asTrimmedString(request.toolTitle) ??
        asTrimmedString(request.toolName) ??
        asTrimmedString(request.serverName)
      );
    case "url":
      return asTrimmedString(request.url) ?? asTrimmedString(request.intention);
    case "memory":
      return asTrimmedString(request.subject) ?? asTrimmedString(request.fact);
    case "custom-tool":
      return asTrimmedString(request.toolDescription) ?? asTrimmedString(request.toolName);
    default:
      return undefined;
  }
}

function inferToolItemType(toolName: string | undefined, data: Record<string, unknown>): CanonicalItemType {
  if (asTrimmedString(data.mcpServerName)) {
    return "mcp_tool_call";
  }

  switch (toolName) {
    case "bash":
    case "shell":
    case "exec":
    case "terminal":
      return "command_execution";
    case "apply_patch":
    case "edit":
    case "write":
    case "create":
    case "delete":
      return "file_change";
    case "web_fetch":
    case "web_search":
    case "search_web":
      return "web_search";
    case "view_image":
    case "image":
      return "image_view";
    default:
      return "dynamic_tool_call";
  }
}

function inferToolCompletionStatus(success: unknown): RuntimeItemStatus {
  return success === true ? "completed" : "failed";
}

function extractToolResultDetail(data: Record<string, unknown>): string | undefined {
  const result = asRecord(data.result);
  return asTrimmedString(result?.detailedContent) ?? asTrimmedString(result?.content);
}

function makeUserInputQuestions(request: CopilotUserInputRequest) {
  const choiceOptions = (request.choices ?? [])
    .map((choice) => asTrimmedString(choice))
    .filter((choice): choice is string => choice !== undefined)
    .map((choice) => ({
      label: choice,
      description: choice,
    }));

  return [
    {
      id: DEFAULT_QUESTION_ID,
      header: "Agent input required",
      question: request.question,
      options: choiceOptions,
      ...(typeof request.allowFreeform === "boolean"
        ? { allowFreeform: request.allowFreeform }
        : {}),
    },
  ] as const;
}

function extractUserInputAnswer(answers: ProviderUserInputAnswers): string | undefined {
  const direct = answers[DEFAULT_QUESTION_ID];
  if (typeof direct === "string") {
    const trimmed = direct.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  for (const value of Object.values(answers)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      continue;
    }

    if (Array.isArray(value)) {
      const firstString = value.find((entry): entry is string => typeof entry === "string");
      if (firstString) {
        const trimmed = firstString.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
      continue;
    }

    const answerRecord = asRecord(value);
    const nestedAnswer = asTrimmedString(answerRecord?.answer);
    if (nestedAnswer) {
      return nestedAnswer;
    }
  }

  return undefined;
}

function isChoiceAnswer(request: CopilotUserInputRequest, answer: string): boolean {
  return (request.choices ?? []).some((choice) => choice === answer);
}

function allowsFreeformAnswer(request: CopilotUserInputRequest): boolean {
  return request.allowFreeform !== false;
}

function cloneSession(session: ProviderSession): ProviderSession {
  return { ...session };
}

function toRequestDecision(decision: ProviderApprovalDecision): CopilotPermissionResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
    case "cancel":
    default:
      return { kind: "denied-interactively-by-user" };
  }
}

function toProcessError(
  threadId: ThreadId,
  detail: string,
  cause?: unknown,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toRequestError(
  method: string,
  detail: string,
  cause?: unknown,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function missingSessionError(threadId: ThreadId) {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

function toCopilotSessionMode(
  interactionMode: ProviderInteractionMode | undefined,
): Extract<CopilotSessionMode, "interactive" | "plan"> {
  return interactionMode === "plan" ? "plan" : "interactive";
}

function asCopilotSessionMode(value: unknown): CopilotSessionMode | undefined {
  return value === "interactive" || value === "plan" || value === "autopilot" ? value : undefined;
}

function makeProviderSession(input: {
  readonly threadId: ThreadId;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly cwd?: string;
  readonly model?: string;
  readonly resumeCursor?: unknown;
  readonly activeTurnId?: TurnId;
  readonly now: string;
}): ProviderSession {
  return {
    provider: PROVIDER,
    status: input.activeTurnId !== undefined ? "running" : "ready",
    runtimeMode: input.runtimeMode,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    threadId: input.threadId,
    ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
    ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  } satisfies ProviderSession;
}

const makeCopilotClientFactory = async (
  options: CopilotClientFactoryOptions,
): Promise<CopilotClientLike> => {
  const sdk = await loadCopilotSdk();
  return new sdk.CopilotClient({
    autoStart: false,
    ...(options.cliUrl !== undefined ? { cliUrl: options.cliUrl } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
};

const makeCopilotAdapter = (options?: CopilotAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* Effect.service(ServerConfig);
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const entries = new Map<ThreadId, CopilotRuntimeEntry>();
    const clientFactory = options?.clientFactory ?? makeCopilotClientFactory;
    const now = options?.now ?? (() => new Date().toISOString());
    const generateId = options?.generateId ?? randomUUID;
    const nativeEventLogger = options?.nativeEventLogger;
    const resolveAttachmentPath = options?.resolveAttachmentPath ?? defaultResolveAttachmentPath;
    const fileExists = options?.fileExists ?? existsSync;
    const interactiveRequestTimeoutMs =
      options?.interactiveRequestTimeoutMs ?? INTERACTIVE_REQUEST_TIMEOUT_MS;

    const runDetached = (effect: Effect.Effect<unknown>) => {
      void Effect.runPromise(effect).catch((error) => {
        console.error("[CopilotAdapter] runDetached failure", error);
      });
    };

    const writeNativeEvent = (threadId: ThreadId, event: unknown) =>
      nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void;

    const emitRuntimeEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      Effect.gen(function* () {
        if (events.length === 0) {
          return;
        }
        yield* Queue.offerAll(runtimeEventQueue, events);
      });

    const emitCopilotPlanSnapshot = (entry: CopilotRuntimeEntry, event: CopilotSessionEvent) =>
      Effect.gen(function* () {
        if (event.type !== "session.plan_changed" && event.type !== "exit_plan_mode.completed") {
          return;
        }

        const createdAt = normalizeIsoTimestamp(event.timestamp, now);
        const raw = buildSdkRaw(event);
        const turnId = entry.activeTurnId;
        const providerTurnId = entry.activeProviderTurnId;
        const eventData = event.data ?? {};
        const fallbackPlanMarkdown = asRawString(eventData.planContent)?.trim();
        const planReader = entry.session.rpc?.plan?.read;
        const planResult = planReader
          ? yield* Effect.tryPromise({
              try: () => planReader(),
              catch: (cause) =>
                toRequestError("session.rpc.plan.read", "Failed to read the Copilot session plan.", cause),
            }).pipe(
              Effect.catch((error: unknown) =>
                emitRuntimeEvents([
                  {
                    ...makeRuntimeEventBase({
                      threadId: entry.threadId,
                      createdAt,
                      ...(turnId !== undefined ? { turnId } : {}),
                      ...(providerTurnId !== undefined ? { providerTurnId } : {}),
                      raw,
                    }),
                    type: "runtime.warning",
                    payload: {
                      message:
                        Schema.is(ProviderAdapterRequestError)(error) && error.detail
                          ? error.detail
                          : "Failed to read the Copilot session plan.",
                      detail: eventData,
                    },
                  },
                ]).pipe(Effect.as<CopilotPlanReadResult | undefined>(undefined)),
              ),
            )
          : undefined;

        const planMarkdown = (planResult?.content ?? fallbackPlanMarkdown)?.trim();
        if (!planMarkdown) {
          entry.lastPlanTurnId = undefined;
          entry.lastPlanMarkdown = undefined;
          return;
        }

        if (entry.lastPlanTurnId === turnId && entry.lastPlanMarkdown === planMarkdown) {
          return;
        }

        entry.lastPlanTurnId = turnId;
        entry.lastPlanMarkdown = planMarkdown;

        yield* emitRuntimeEvents([
          {
            ...makeRuntimeEventBase({
              threadId: entry.threadId,
              createdAt,
              ...(turnId !== undefined ? { turnId } : {}),
              ...(providerTurnId !== undefined ? { providerTurnId } : {}),
              raw,
            }),
            type: "turn.proposed.completed",
            payload: {
              planMarkdown,
            },
          },
        ]);
      });

    const makeRuntimeEventBase = (input: {
      readonly threadId: ThreadId;
      readonly createdAt: string;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: RuntimeItemId | undefined;
      readonly requestId?: RuntimeRequestId | undefined;
      readonly providerTurnId?: string | undefined;
      readonly providerItemId?: ProviderItemId | undefined;
      readonly providerRequestId?: string | undefined;
      readonly raw?: ProviderRuntimeEvent["raw"] | undefined;
    }) => ({
      eventId: EventId.makeUnsafe(generateId()),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: input.createdAt,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.providerTurnId !== undefined ||
      input.providerItemId !== undefined ||
      input.providerRequestId !== undefined
        ? {
            providerRefs: {
              ...(input.providerTurnId !== undefined
                ? { providerTurnId: input.providerTurnId }
                : {}),
              ...(input.providerItemId !== undefined
                ? { providerItemId: input.providerItemId }
                : {}),
              ...(input.providerRequestId !== undefined
                ? { providerRequestId: input.providerRequestId }
                : {}),
            },
          }
        : {}),
      ...(input.raw !== undefined ? { raw: input.raw } : {}),
    });

    const emitSessionShutdown = (
      entry: CopilotRuntimeEntry,
      reason: string,
      exitKind: "graceful" | "error",
    ) =>
      emitRuntimeEvents([
        {
          ...makeRuntimeEventBase({
            threadId: entry.threadId,
            createdAt: now(),
          }),
          type: "session.exited",
          payload: {
            reason,
            exitKind,
            ...(exitKind === "error" ? { recoverable: true } : {}),
          },
          },
        ]);

    const removeEntry = (entry: CopilotRuntimeEntry) => {
      if (entry.pendingToolOnlyCompletionTimer !== undefined) {
        clearTimeout(entry.pendingToolOnlyCompletionTimer);
        entry.pendingToolOnlyCompletionTimer = undefined;
      }
      try {
        entry.unsubscribe();
      } catch {
        // Ignore listener cleanup issues during shutdown.
      }
      if (entries.get(entry.threadId) === entry) {
        entries.delete(entry.threadId);
      }
    };

    const clearTurnState = (
      entry: CopilotRuntimeEntry,
      patch: SessionPatch,
      updatedAt: string,
    ): { readonly turnId: TurnId | undefined; readonly providerTurnId: string | undefined } => {
      cancelPendingToolOnlyCompletion(entry);
      const turnId = entry.activeTurnId;
      const providerTurnId = entry.activeProviderTurnId;
      entry.activeTurnId = undefined;
      entry.activeProviderTurnId = undefined;
      entry.toolCalls.clear();
      entry.activeTurnHadToolActivity = false;
      entry.activeTurnHadCompletedAssistantMessage = false;
      touchSession(
        entry,
        {
          ...patch,
          activeTurnId: undefined,
        },
        updatedAt,
      );
      return { turnId, providerTurnId };
    };

    const cancelPendingInteractiveRequests = (input: {
      readonly entry: CopilotRuntimeEntry;
      readonly createdAt: string;
      readonly reason: string;
    }): ReadonlyArray<ProviderRuntimeEvent> => {
      const events: ProviderRuntimeEvent[] = [];

      for (const pending of input.entry.pendingApprovals.values()) {
        clearPendingTimeout(pending);
        pending.reject(new Error(input.reason));
        events.push({
          ...makeRuntimeEventBase({
            threadId: input.entry.threadId,
            createdAt: input.createdAt,
            turnId: pending.turnId,
            requestId: pending.runtimeRequestId,
            raw: {
              source: "copilot.sdk.permission-request",
              payload: {
                request: pending.request,
                reason: input.reason,
              },
            },
          }),
          type: "request.resolved",
          payload: {
            requestType: pending.requestType,
            decision: "cancel",
            resolution: {
              decision: "cancel",
              reason: input.reason,
            },
          },
        });
      }

      for (const pending of input.entry.pendingUserInputs.values()) {
        clearPendingTimeout(pending);
        pending.reject(new Error(input.reason));
        events.push({
          ...makeRuntimeEventBase({
            threadId: input.entry.threadId,
            createdAt: input.createdAt,
            turnId: pending.turnId,
            requestId: pending.runtimeRequestId,
            raw: {
              source: "copilot.sdk.user-input-request",
              payload: {
                request: pending.request,
                reason: input.reason,
              },
            },
          }),
          type: "user-input.resolved",
          payload: {
            answers: {},
          },
        });
      }

      input.entry.pendingApprovals.clear();
      input.entry.pendingUserInputs.clear();
      return events;
    };

    const scheduleToolOnlyTurnCompletion = (input: {
      readonly entry: CopilotRuntimeEntry;
      readonly raw: ProviderRuntimeEvent["raw"];
      readonly emitIdleState: boolean;
    }) => {
      cancelPendingToolOnlyCompletion(input.entry);
      const pendingTurnId = input.entry.activeTurnId;
      if (pendingTurnId === undefined) {
        return;
      }

      input.entry.pendingToolOnlyCompletionTimer = setTimeout(() => {
        const currentEntry = entries.get(input.entry.threadId);
        if (!currentEntry || currentEntry !== input.entry) {
          return;
        }
        currentEntry.pendingToolOnlyCompletionTimer = undefined;
        if (
          currentEntry.activeTurnId !== pendingTurnId ||
          currentEntry.activeTurnHadCompletedAssistantMessage
        ) {
          return;
        }

        const completedAt = now();
        const cancelledEvents = cancelPendingInteractiveRequests({
          entry: currentEntry,
          createdAt: completedAt,
          reason: "Copilot turn completed before the interactive request was resolved.",
        });
        const { turnId, providerTurnId } = clearTurnState(
          currentEntry,
          { status: "ready", lastError: undefined },
          completedAt,
        );
        const usage = currentEntry.lastUsage;
        currentEntry.lastUsage = undefined;

        const completionEvents: Array<ProviderRuntimeEvent> = [
          ...cancelledEvents,
          {
            ...makeRuntimeEventBase({
              threadId: currentEntry.threadId,
              createdAt: completedAt,
              turnId,
              providerTurnId,
              raw: input.raw,
            }),
            type: "turn.completed",
            payload: {
              state: "completed",
              ...(usage !== undefined ? { usage } : {}),
            },
          },
        ];

        if (input.emitIdleState) {
          completionEvents.push({
            ...makeRuntimeEventBase({
              threadId: currentEntry.threadId,
              createdAt: completedAt,
              raw: input.raw,
            }),
            type: "thread.state.changed",
            payload: {
              state: "idle",
              detail: {},
            },
          });
        }

        runDetached(emitRuntimeEvents(completionEvents));
      }, TOOL_ONLY_TURN_COMPLETION_GRACE_MS);
    };

    const stopEntry = (
      entry: CopilotRuntimeEntry,
      options: { readonly emitExit: boolean; readonly reason: string; readonly exitKind: "graceful" | "error" },
    ) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => removeEntry(entry));
        const createdAt = now();
        const cancelledEvents = cancelPendingInteractiveRequests({
          entry,
          createdAt,
          reason: "Copilot session stopped before the interactive request was resolved.",
        });
        entry.toolCalls.clear();

        let stopError: ProviderAdapterProcessError | undefined;
        const errors = yield* Effect.tryPromise({
          try: () => entry.client.stop(),
          catch: (cause) => toProcessError(entry.threadId, "Failed to stop Copilot client.", cause),
        }).pipe(
          Effect.catch((error: ProviderAdapterProcessError) =>
            Effect.sync(() => {
              stopError = error;
              return [] as ReadonlyArray<Error>;
            }),
          ),
        );

        if (!stopError && errors.length > 0) {
          stopError = toProcessError(
            entry.threadId,
            errors.map((error) => error.message).join("; "),
            errors[0],
          );
        }

        touchSession(
          entry,
          {
            status: stopError ? "error" : "closed",
            activeTurnId: undefined,
            ...(stopError ? { lastError: stopError.detail } : {}),
          },
          now(),
        );

        if (options.emitExit) {
          if (cancelledEvents.length > 0) {
            yield* emitRuntimeEvents(cancelledEvents);
          }
          yield* emitSessionShutdown(
            entry,
            stopError?.detail ?? options.reason,
            stopError ? "error" : options.exitKind,
          );
        }

        if (stopError) {
          return yield* stopError;
        }
      });

    const mapSessionEvent = (
      entry: CopilotRuntimeEntry,
      event: CopilotSessionEvent,
    ): ReadonlyArray<ProviderRuntimeEvent> => {
      const createdAt = normalizeIsoTimestamp(event.timestamp, now);
      const raw = buildSdkRaw(event);
      const eventData = event.data ?? {};
      cancelPendingToolOnlyCompletion(entry);
      const activeTurnId = entry.activeTurnId;
      const activeProviderTurnId = entry.activeProviderTurnId;

      switch (event.type) {
        case "assistant.turn_start": {
          const providerTurnId = asTrimmedString(eventData.turnId);
          if (providerTurnId) {
            entry.activeProviderTurnId = providerTurnId;
          }
          if (entry.activeTurnId !== undefined) {
            return [];
          }
          const createdTurnId = TurnId.makeUnsafe(generateId());
          entry.activeTurnId = createdTurnId;
          entry.activeTurnHadToolActivity = false;
          entry.activeTurnHadCompletedAssistantMessage = false;
          touchSession(entry, { status: "running", activeTurnId: createdTurnId }, createdAt);
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: createdTurnId,
                providerTurnId,
                raw,
              }),
              type: "turn.started",
              payload:
                entry.providerSession.model !== undefined
                  ? { model: entry.providerSession.model }
                  : {},
            },
          ];
        }
        case "assistant.intent": {
          const intent = asTrimmedString(eventData.intent);
          if (!intent || activeTurnId === undefined) {
            return [];
          }
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                providerTurnId: activeProviderTurnId,
                raw,
              }),
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(activeTurnId),
                description: intent,
              },
            },
          ];
        }
        case "assistant.reasoning_delta": {
          const reasoningId = asTrimmedString(eventData.reasoningId);
          const delta = asRawString(eventData.deltaContent);
          if (!reasoningId || !delta) {
            return [];
          }
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                itemId: RuntimeItemId.makeUnsafe(reasoningId),
                providerTurnId: activeProviderTurnId,
                providerItemId: ProviderItemId.makeUnsafe(reasoningId),
                raw,
              }),
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text",
                delta,
              },
            },
          ];
        }
        case "assistant.reasoning": {
          const reasoningId = asTrimmedString(eventData.reasoningId);
          const content = asRawString(eventData.content);
          if (!reasoningId || !content) {
            return [];
          }
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                itemId: RuntimeItemId.makeUnsafe(reasoningId),
                providerTurnId: activeProviderTurnId,
                providerItemId: ProviderItemId.makeUnsafe(reasoningId),
                raw,
              }),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Reasoning",
                detail: content,
                data: eventData,
              },
            },
          ];
        }
        case "assistant.message_delta": {
          const messageId = asTrimmedString(eventData.messageId);
          const delta = asRawString(eventData.deltaContent);
          if (!messageId || !delta) {
            return [];
          }
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                itemId: RuntimeItemId.makeUnsafe(messageId),
                providerTurnId: activeProviderTurnId,
                providerItemId: ProviderItemId.makeUnsafe(messageId),
                raw,
              }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta,
              },
            },
          ];
        }
        case "assistant.message": {
          const messageId = asTrimmedString(eventData.messageId);
          const content = asRawString(eventData.content);
          if (!messageId || !content) {
            return [];
          }
          entry.activeTurnHadCompletedAssistantMessage = true;
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                itemId: RuntimeItemId.makeUnsafe(messageId),
                providerTurnId: activeProviderTurnId,
                providerItemId: ProviderItemId.makeUnsafe(messageId),
                raw,
              }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant",
                detail: content,
                data: eventData,
              },
            },
          ];
        }
        case "assistant.usage": {
          entry.lastUsage = eventData;
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                providerTurnId: activeProviderTurnId,
                raw,
              }),
              type: "thread.token-usage.updated",
              payload: {
                usage: eventData,
              },
            },
          ];
        }
        case "assistant.turn_end": {
          if (activeTurnId === undefined) {
            return [];
          }
          if (entry.activeTurnHadToolActivity && !entry.activeTurnHadCompletedAssistantMessage) {
            scheduleToolOnlyTurnCompletion({
              entry,
              raw,
              emitIdleState: false,
            });
            return [];
          }
          const cancelledEvents = cancelPendingInteractiveRequests({
            entry,
            createdAt,
            reason: "Copilot turn completed before the interactive request was resolved.",
          });
          const { turnId, providerTurnId } = clearTurnState(
            entry,
            { status: "ready", lastError: undefined },
            createdAt,
          );
          const usage = entry.lastUsage;
          entry.lastUsage = undefined;
          return [
            ...cancelledEvents,
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId,
                providerTurnId,
                raw,
              }),
              type: "turn.completed",
              payload: {
                state: "completed",
                ...(usage !== undefined ? { usage } : {}),
              },
            },
          ];
        }
        case "tool.execution_start": {
          const toolCallId = asTrimmedString(eventData.toolCallId);
          if (!toolCallId) {
            return [];
          }
          entry.activeTurnHadToolActivity = true;
          const title = asTrimmedString(eventData.toolName);
          const itemType = inferToolItemType(title, eventData);
          const detail = safeJsonStringify(eventData.arguments);
          entry.toolCalls.set(toolCallId, {
            itemType,
            ...(title ? { title } : {}),
            ...(eventData.arguments !== undefined ? { arguments: eventData.arguments } : {}),
          });
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                itemId: RuntimeItemId.makeUnsafe(toolCallId),
                providerTurnId: activeProviderTurnId,
                providerItemId: ProviderItemId.makeUnsafe(toolCallId),
                raw,
              }),
              type: "item.started",
              payload: {
                itemType,
                status: "inProgress",
                ...(title ? { title } : {}),
                ...(detail ? { detail } : {}),
                data: eventData,
              },
            },
          ];
        }
        case "tool.execution_progress": {
          const toolCallId = asTrimmedString(eventData.toolCallId);
          const summary = asTrimmedString(eventData.progressMessage);
          if (!toolCallId || !summary) {
            return [];
          }
          entry.activeTurnHadToolActivity = true;
          const state = entry.toolCalls.get(toolCallId);
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                itemId: RuntimeItemId.makeUnsafe(toolCallId),
                providerTurnId: activeProviderTurnId,
                providerItemId: ProviderItemId.makeUnsafe(toolCallId),
                raw,
              }),
              type: "tool.progress",
              payload: {
                toolUseId: toolCallId,
                ...(state?.title ? { toolName: state.title } : {}),
                summary,
              },
            },
          ];
        }
        case "tool.execution_partial_result": {
          const toolCallId = asTrimmedString(eventData.toolCallId);
          const partialOutput = asTrimmedString(eventData.partialOutput);
          if (!toolCallId || !partialOutput) {
            return [];
          }
          entry.activeTurnHadToolActivity = true;
          const state = entry.toolCalls.get(toolCallId);
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                itemId: RuntimeItemId.makeUnsafe(toolCallId),
                providerTurnId: activeProviderTurnId,
                providerItemId: ProviderItemId.makeUnsafe(toolCallId),
                raw,
              }),
              type: "item.updated",
              payload: {
                itemType: state?.itemType ?? "dynamic_tool_call",
                status: "inProgress",
                ...(state?.title ? { title: state.title } : {}),
                detail: partialOutput,
                data: eventData,
              },
            },
          ];
        }
        case "tool.execution_complete": {
          const toolCallId = asTrimmedString(eventData.toolCallId);
          if (!toolCallId) {
            return [];
          }
          entry.activeTurnHadToolActivity = true;
          const state = entry.toolCalls.get(toolCallId);
          entry.toolCalls.delete(toolCallId);
          const detail = extractToolResultDetail(eventData);
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                itemId: RuntimeItemId.makeUnsafe(toolCallId),
                providerTurnId: activeProviderTurnId,
                providerItemId: ProviderItemId.makeUnsafe(toolCallId),
                raw,
              }),
              type: "item.completed",
              payload: {
                itemType: state?.itemType ?? "dynamic_tool_call",
                status: inferToolCompletionStatus(eventData.success),
                ...(state?.title ? { title: state.title } : {}),
                ...(detail ? { detail } : {}),
                data:
                  state?.arguments !== undefined
                    ? {
                        ...eventData,
                        arguments: state.arguments,
                      }
                    : eventData,
              },
            },
          ];
        }
        case "session.idle": {
          if (entry.activeTurnHadToolActivity && !entry.activeTurnHadCompletedAssistantMessage) {
            scheduleToolOnlyTurnCompletion({
              entry,
              raw,
              emitIdleState: true,
            });
            return [];
          }
          const activeTurnStillOpen = entry.activeTurnId !== undefined;
          const cancelledEvents = activeTurnStillOpen
            ? cancelPendingInteractiveRequests({
                entry,
                createdAt,
                reason: "Copilot session became idle before the interactive request was resolved.",
              })
            : [];
          const { turnId, providerTurnId } = activeTurnStillOpen
            ? clearTurnState(entry, { status: "ready", lastError: undefined }, createdAt)
            : { turnId: undefined, providerTurnId: undefined };
          const usage = entry.lastUsage;
          entry.lastUsage = undefined;
          if (!activeTurnStillOpen) {
            touchSession(entry, { status: "ready" }, createdAt);
          }
          return [
            ...cancelledEvents,
            ...(turnId !== undefined
              ? [
                  {
                    ...makeRuntimeEventBase({
                      threadId: entry.threadId,
                      createdAt,
                      turnId,
                      providerTurnId,
                      raw,
                    }),
                    type: "turn.completed" as const,
                    payload: {
                      state: "completed" as const,
                      ...(usage !== undefined ? { usage } : {}),
                    },
                  },
                ]
              : []),
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                raw,
              }),
              type: "thread.state.changed",
              payload: {
                state: "idle",
                detail: eventData,
              },
            },
          ];
        }
        case "exit_plan_mode.requested": {
          const planMarkdown = asRawString(eventData.planContent)?.trim();
          if (!planMarkdown) {
            return [];
          }
          if (entry.lastPlanTurnId === activeTurnId && entry.lastPlanMarkdown === planMarkdown) {
            return [];
          }
          entry.lastPlanTurnId = activeTurnId;
          entry.lastPlanMarkdown = planMarkdown;
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
                ...(activeProviderTurnId !== undefined
                  ? { providerTurnId: activeProviderTurnId }
                  : {}),
                raw,
              }),
              type: "turn.proposed.completed",
              payload: {
                planMarkdown,
              },
            },
          ];
        }
        case "session.mode_changed": {
          entry.sessionMode = asCopilotSessionMode(eventData.newMode);
          return [];
        }
        case "session.warning": {
          const message = asTrimmedString(eventData.message);
          if (!message) {
            return [];
          }
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                providerTurnId: activeProviderTurnId,
                raw,
              }),
              type: "runtime.warning",
              payload: {
                message,
                detail: eventData,
              },
            },
          ];
        }
        case "session.error": {
          const message = asTrimmedString(eventData.message);
          if (!message) {
            return [];
          }
          const cancelledEvents = cancelPendingInteractiveRequests({
            entry,
            createdAt,
            reason: message,
          });
          const { turnId, providerTurnId } = clearTurnState(
            entry,
            { status: "error", lastError: message },
            createdAt,
          );
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId,
                providerTurnId,
                raw,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: toRuntimeErrorClass(asTrimmedString(eventData.errorType)),
                detail: eventData,
              },
            },
            ...cancelledEvents,
            ...(turnId !== undefined
              ? [
                  {
                    ...makeRuntimeEventBase({
                      threadId: entry.threadId,
                      createdAt,
                      turnId,
                      providerTurnId,
                      raw,
                    }),
                    type: "turn.completed" as const,
                    payload: {
                      state: "failed" as const,
                      errorMessage: message,
                    },
                  },
                ]
              : []),
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId,
                providerTurnId,
                raw,
              }),
              type: "session.state.changed",
              payload: {
                state: "error",
                reason: message,
                detail: eventData,
              },
            },
          ];
        }
        case "session.shutdown": {
          const shutdownType =
            asTrimmedString(eventData.shutdownType) ??
            asTrimmedString(eventData.type) ??
            asTrimmedString(eventData.kind);
          const exitKind = shutdownType === "routine" ? "graceful" : "error";
          const reason =
            asTrimmedString(eventData.message) ??
            asTrimmedString(eventData.reason) ??
            (exitKind === "graceful"
              ? "Copilot session shut down."
              : "Copilot session shut down unexpectedly.");
          const cancelledEvents = cancelPendingInteractiveRequests({
            entry,
            createdAt,
            reason,
          });
          const { turnId, providerTurnId } = clearTurnState(
            entry,
            {
              status: exitKind === "error" ? "error" : "closed",
              ...(exitKind === "error" ? { lastError: reason } : {}),
            },
            createdAt,
          );
          removeEntry(entry);
          return [
            ...cancelledEvents,
            ...(turnId !== undefined
              ? [
                  {
                    ...makeRuntimeEventBase({
                      threadId: entry.threadId,
                      createdAt,
                      turnId,
                      providerTurnId,
                      raw,
                    }),
                    type: "turn.completed" as const,
                    payload: exitKind === "error"
                      ? {
                          state: "failed" as const,
                          errorMessage: reason,
                        }
                      : {
                          state: "cancelled" as const,
                        },
                  },
                ]
              : []),
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId,
                providerTurnId,
                raw,
              }),
              type: "session.exited",
              payload: {
                reason,
                exitKind,
                ...(exitKind === "error" ? { recoverable: true } : {}),
              },
            },
          ];
        }
        case "session.title_changed": {
          const title = asTrimmedString(eventData.title);
          if (!title) {
            return [];
          }
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                raw,
              }),
              type: "thread.metadata.updated",
              payload: {
                name: title,
              },
            },
          ];
        }
        default:
          return [];
      }
    };

    const requireEntry = (
      threadId: ThreadId,
    ): Effect.Effect<CopilotRuntimeEntry, ProviderAdapterSessionNotFoundError> => {
      const entry = entries.get(threadId);
      return entry ? Effect.succeed(entry) : Effect.fail(missingSessionError(threadId));
    };

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const existing = entries.get(input.threadId);

        const startedAt = now();
        const cliUrl = input.providerOptions?.copilot?.cliUrl;
        const configDir = input.providerOptions?.copilot?.configDir;
        const client = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              clientFactory({
                threadId: input.threadId,
                ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
                ...(cliUrl !== undefined ? { cliUrl } : {}),
              }),
            ),
          catch: (cause) =>
            toProcessError(input.threadId, "Failed to initialize Copilot client.", cause),
        });

        let entryRef: CopilotRuntimeEntry | undefined;

        const permissionHandler = (
          request: CopilotPermissionRequest,
          _invocation: { sessionId: string },
        ): Promise<CopilotPermissionResult> | CopilotPermissionResult => {
          const entry = entryRef;
          if (!entry) {
            return {
              kind: "denied-no-approval-rule-and-could-not-request-from-user",
            };
          }

          if (entry.providerSession.runtimeMode === "full-access") {
            return { kind: "approved" };
          }

          const requestId = generateId();
          const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
          const deferred = makeDeferred<CopilotPermissionResult>();
          let pending!: PendingApprovalRequest;
          const timeoutReason = "Copilot approval request timed out before the user responded.";
          const timeoutHandle = setTimeout(() => {
            const currentEntry = entryRef;
            if (!currentEntry) {
              return;
            }
            const activePending = currentEntry.pendingApprovals.get(requestId);
            if (activePending !== pending) {
              return;
            }
            currentEntry.pendingApprovals.delete(requestId);
            clearPendingTimeout(activePending);
            activePending.reject(new Error(timeoutReason));
            const createdAt = now();
            runDetached(
              writeNativeEvent(currentEntry.threadId, {
                source: "copilot.sdk.permission-request",
                payload: {
                  request,
                  reason: timeoutReason,
                },
              }).pipe(
                Effect.andThen(
                  emitRuntimeEvents([
                    {
                      ...makeRuntimeEventBase({
                        threadId: currentEntry.threadId,
                        createdAt,
                        turnId: activePending.turnId,
                        requestId: runtimeRequestId,
                        raw: {
                          source: "copilot.sdk.permission-request",
                          payload: {
                            request,
                            reason: timeoutReason,
                          },
                        },
                      }),
                      type: "request.resolved",
                      payload: {
                        requestType: activePending.requestType,
                        decision: "cancel",
                        resolution: {
                          decision: "cancel",
                          reason: timeoutReason,
                        },
                      },
                    },
                  ]),
                ),
              ),
            );
          }, interactiveRequestTimeoutMs);
          pending = {
            requestId,
            runtimeRequestId,
            ...(entry.activeTurnId !== undefined ? { turnId: entry.activeTurnId } : {}),
            requestType: toRequestType(request),
            request,
            resolve: deferred.resolve,
            reject: deferred.reject,
            timeoutHandle,
          };
          entry.pendingApprovals.set(requestId, pending);

          const createdAt = now();
          runDetached(
            writeNativeEvent(entry.threadId, {
              source: "copilot.sdk.permission-request",
              payload: request,
            }).pipe(
              Effect.andThen(
                emitRuntimeEvents([
                  {
                    ...makeRuntimeEventBase({
                      threadId: entry.threadId,
                      createdAt,
                      turnId: entry.activeTurnId,
                      requestId: runtimeRequestId,
                      raw: {
                        source: "copilot.sdk.permission-request",
                        payload: request,
                      },
                    }),
                    type: "request.opened",
                    payload: {
                      requestType: pending.requestType,
                      ...(describePermissionRequest(request)
                        ? { detail: describePermissionRequest(request) }
                        : {}),
                      args: request,
                    },
                  },
                ]),
              ),
            ),
          );

          return deferred.promise;
        };

        const userInputHandler = (
          request: CopilotUserInputRequest,
          _invocation: { sessionId: string },
        ): Promise<CopilotUserInputResponse> => {
          const entry = entryRef;
          if (!entry) {
            return Promise.reject(new Error("Copilot user input requested before session was ready."));
          }

          const requestId = generateId();
          const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
          const deferred = makeDeferred<CopilotUserInputResponse>();
          let pending!: PendingUserInput;
          const timeoutReason = "Copilot user input request timed out before the user responded.";
          const timeoutHandle = setTimeout(() => {
            const currentEntry = entryRef;
            if (!currentEntry) {
              return;
            }
            const activePending = currentEntry.pendingUserInputs.get(requestId);
            if (activePending !== pending) {
              return;
            }
            currentEntry.pendingUserInputs.delete(requestId);
            clearPendingTimeout(activePending);
            activePending.reject(new Error(timeoutReason));
            const createdAt = now();
            runDetached(
              writeNativeEvent(currentEntry.threadId, {
                source: "copilot.sdk.user-input-request",
                payload: {
                  request,
                  reason: timeoutReason,
                },
              }).pipe(
                Effect.andThen(
                  emitRuntimeEvents([
                    {
                      ...makeRuntimeEventBase({
                        threadId: currentEntry.threadId,
                        createdAt,
                        turnId: activePending.turnId,
                        requestId: runtimeRequestId,
                        raw: {
                          source: "copilot.sdk.user-input-request",
                          payload: {
                            request,
                            reason: timeoutReason,
                          },
                        },
                      }),
                      type: "user-input.resolved",
                      payload: {
                        answers: {},
                      },
                    },
                  ]),
                ),
              ),
            );
          }, interactiveRequestTimeoutMs);
          pending = {
            requestId,
            runtimeRequestId,
            ...(entry.activeTurnId !== undefined ? { turnId: entry.activeTurnId } : {}),
            request,
            resolve: deferred.resolve,
            reject: deferred.reject,
            timeoutHandle,
          };
          entry.pendingUserInputs.set(requestId, pending);

          const createdAt = now();
          runDetached(
            writeNativeEvent(entry.threadId, {
              source: "copilot.sdk.user-input-request",
              payload: request,
            }).pipe(
              Effect.andThen(
                emitRuntimeEvents([
                  {
                    ...makeRuntimeEventBase({
                      threadId: entry.threadId,
                      createdAt,
                      turnId: entry.activeTurnId,
                      requestId: runtimeRequestId,
                      raw: {
                        source: "copilot.sdk.user-input-request",
                        payload: request,
                      },
                    }),
                    type: "user-input.requested",
                    payload: {
                      questions: makeUserInputQuestions(request),
                    },
                  },
                ]),
              ),
            ),
          );

          return deferred.promise;
        };

        const connectConfig = {
          sessionId: input.threadId,
          clientName: CLIENT_NAME,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.modelOptions?.copilot?.reasoningEffort !== undefined
            ? { reasoningEffort: input.modelOptions.copilot.reasoningEffort }
            : {}),
          ...(configDir !== undefined ? { configDir } : {}),
          onPermissionRequest: permissionHandler,
          onUserInputRequest: userInputHandler,
          ...(input.cwd !== undefined ? { workingDirectory: input.cwd } : {}),
          streaming: true,
        };
        const resumedSessionId = asTrimmedString(input.resumeCursor);

        return yield* Effect.tryPromise({
          try: () => client.start(),
          catch: (cause) => toProcessError(input.threadId, "Failed to start Copilot client.", cause),
        }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () =>
                resumedSessionId
                  ? client.resumeSession(resumedSessionId, connectConfig)
                  : client.createSession(connectConfig),
              catch: (cause) =>
                toProcessError(
                  input.threadId,
                  resumedSessionId
                    ? `Failed to resume Copilot session '${resumedSessionId}'.`
                    : "Failed to create Copilot session.",
                  cause,
                ),
            }),
          ),
          Effect.flatMap((session) =>
            Effect.gen(function* () {
              const providerSession = makeProviderSession({
                threadId: input.threadId,
                runtimeMode: input.runtimeMode,
                ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
                resumeCursor: session.sessionId,
                ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
                now: startedAt,
              });

              const unsubscribe = session.on((event) => {
                const entry = entryRef;
                if (!entry) {
                  return;
                }
                const mapped = mapSessionEvent(entry, event);
                runDetached(
                  writeNativeEvent(entry.threadId, event).pipe(
                    Effect.andThen(emitRuntimeEvents(mapped)),
                    Effect.andThen(emitCopilotPlanSnapshot(entry, event)),
                  ),
                );
              });

              const entry: CopilotRuntimeEntry = {
                threadId: input.threadId,
                client,
                session,
                pendingApprovals: new Map(),
                pendingUserInputs: new Map(),
                toolCalls: new Map(),
                unsubscribe,
                providerSession,
                activeTurnId: input.activeTurnId,
                activeProviderTurnId: undefined,
                sessionMode: undefined,
                lastPlanTurnId: undefined,
                lastPlanMarkdown: undefined,
                lastUsage: undefined,
                activeTurnHadToolActivity: false,
                activeTurnHadCompletedAssistantMessage: false,
                pendingToolOnlyCompletionTimer: undefined,
              };
              entryRef = entry;
              if (existing) {
                yield* stopEntry(existing, {
                  emitExit: false,
                  reason: "Replacing existing Copilot session",
                  exitKind: "graceful",
                }).pipe(
                  Effect.catch((cause: unknown) =>
                    Effect.logWarning("failed to stop previous Copilot session during replacement", {
                      cause,
                      threadId: input.threadId,
                    }),
                  ),
                );
              }
              entries.set(input.threadId, entry);

              yield* writeNativeEvent(input.threadId, {
                source: "copilot.sdk.event",
                messageType: resumedSessionId ? "session.resume" : "session.create",
                payload: {
                  sessionId: session.sessionId,
                  ...(resumedSessionId ? { resumedFrom: resumedSessionId } : {}),
                },
              });
              yield* emitRuntimeEvents([
                {
                  ...makeRuntimeEventBase({
                    threadId: input.threadId,
                    createdAt: startedAt,
                  }),
                  type: "session.started",
                  payload: {
                    message: resumedSessionId ? "Copilot session resumed" : "Copilot session started",
                    ...(resumedSessionId ? { resume: input.resumeCursor } : {}),
                  },
                },
                {
                  ...makeRuntimeEventBase({
                    threadId: input.threadId,
                    createdAt: startedAt,
                  }),
                  type: "thread.started",
                  payload: {
                    providerThreadId: session.sessionId,
                  },
                },
                {
                  ...makeRuntimeEventBase({
                    threadId: input.threadId,
                    createdAt: startedAt,
                  }),
                  type: "session.state.changed",
                  payload: {
                    state: input.activeTurnId !== undefined ? "running" : "ready",
                  },
                },
              ]);

              return cloneSession(providerSession);
            }),
          ),
          Effect.catch((error: unknown) =>
            Effect.tryPromise({
              try: () => client.stop().catch(() => [] as ReadonlyArray<Error>),
              catch: (cause) =>
                toProcessError(
                  input.threadId,
                  "Failed to clean up Copilot client after startup failure.",
                  cause,
                ),
            }).pipe(
              Effect.flatMap((cleanup) => {
                const startupError =
                  Schema.is(ProviderAdapterProcessError)(error)
                    ? error
                    : toProcessError(input.threadId, "Failed to initialize Copilot session.", error);
                return Effect.fail(
                  cleanup.length > 0
                    ? toProcessError(
                        input.threadId,
                        `${startupError.detail} Cleanup also reported: ${cleanup
                          .map((entry) => entry.message)
                          .join("; ")}`,
                        startupError,
                      )
                    : startupError,
                );
              }),
            ),
          ),
        );
      });

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const entry = yield* requireEntry(input.threadId);
        const copilotAttachments = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                stateDir: serverConfig.stateDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: `Attachment '${attachment.name}' could not be resolved from local storage.`,
                });
              }
              if (!fileExists(attachmentPath)) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: `Attachment '${attachment.name}' is missing from local storage.`,
                });
              }
              return {
                type: "file" as const,
                path: attachmentPath,
                displayName: attachment.name,
              };
            }),
          { concurrency: 1 },
        );

        const prompt = asTrimmedString(input.input);
        if (!prompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Copilot turns currently require non-empty text input.",
          });
        }

        if (entry.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Thread '${input.threadId}' already has an active Copilot turn.`,
          });
        }

        const desiredSessionMode = toCopilotSessionMode(input.interactionMode);
        const modeRpc = entry.session.rpc?.mode;
        if (desiredSessionMode === "plan" && !modeRpc?.set) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "The installed GitHub Copilot SDK does not expose plan mode session controls.",
          });
        }
        if (modeRpc?.set && entry.sessionMode !== desiredSessionMode) {
          yield* Effect.tryPromise({
            try: () => modeRpc.set({ mode: desiredSessionMode }),
            catch: (cause) =>
              toRequestError(
                "session.rpc.mode.set",
                `Failed to switch Copilot session mode to '${desiredSessionMode}'.`,
                cause,
              ),
          }).pipe(Effect.tap(() => Effect.sync(() => (entry.sessionMode = desiredSessionMode))));
        }

        const previousModel = entry.providerSession.model;
        const turnId = TurnId.makeUnsafe(generateId());
        const createdAt = now();
        entry.activeTurnId = turnId;
        entry.activeProviderTurnId = undefined;
        touchSession(
          entry,
          {
            status: "running",
            activeTurnId: turnId,
            lastError: undefined,
          },
          createdAt,
        );

        const nextModel = input.model;
        let emittedTurnStarted = false;
        const sendTurnEffect =
          (nextModel !== undefined && nextModel !== previousModel
            ? Effect.tryPromise({
                try: () => entry.session.setModel(nextModel),
                catch: (cause) =>
                  toRequestError("session.setModel", `Failed to switch Copilot model to '${nextModel}'.`, cause),
              }).pipe(Effect.andThen(Effect.sync(() => touchSession(entry, { model: nextModel }, createdAt))))
            : Effect.void
          ).pipe(
            Effect.andThen(
              emitRuntimeEvents([
                {
                  ...makeRuntimeEventBase({
                    threadId: input.threadId,
                    createdAt,
                    turnId,
                  }),
                  type: "turn.started",
                  payload: {
                    ...(input.model !== undefined ? { model: input.model } : {}),
                    ...(input.assistantDeliveryMode !== undefined
                      ? { assistantDeliveryMode: input.assistantDeliveryMode }
                      : {}),
                  },
                },
              ]).pipe(Effect.tap(() => Effect.sync(() => (emittedTurnStarted = true)))),
            ),
            Effect.andThen(
              Effect.tryPromise({
                try: () =>
                  entry.session.send({
                    prompt,
                    ...(copilotAttachments.length > 0 ? { attachments: copilotAttachments } : {}),
                  }),
                catch: (cause) => toRequestError("session.send", "Failed to send Copilot turn.", cause),
              }),
            ),
            Effect.as({
              threadId: input.threadId,
              turnId,
              resumeCursor: entry.session.sessionId,
            } satisfies ProviderTurnStartResult),
          );

        return yield* sendTurnEffect.pipe(
          Effect.catch((error: unknown) =>
            Effect.gen(function* () {
              entry.activeTurnId = undefined;
              entry.activeProviderTurnId = undefined;
              entry.toolCalls.clear();
              const detail = Schema.is(ProviderAdapterRequestError)(error)
                ? error.detail
                : "Failed to send Copilot turn.";
              touchSession(entry, { status: "error", activeTurnId: undefined, lastError: detail }, now());
              if (emittedTurnStarted) {
                yield* emitRuntimeEvents([
                  {
                    ...makeRuntimeEventBase({
                      threadId: input.threadId,
                      createdAt: now(),
                      turnId,
                    }),
                    type: "turn.completed",
                    payload: {
                      state: "failed",
                      errorMessage: detail,
                    },
                  },
                ]);
              }
              return yield* (Schema.is(ProviderAdapterRequestError)(error)
                ? error
                : toRequestError("session.send", detail, error));
            }),
          ),
        );
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId, _turnId) =>
      Effect.gen(function* () {
        const entry = yield* requireEntry(threadId);
        if (
          _turnId !== undefined &&
          (entry.activeTurnId === undefined || String(entry.activeTurnId) !== String(_turnId))
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "interruptTurn",
            issue: `Cannot interrupt turn '${String(_turnId)}' because it is not the active Copilot turn.`,
          });
        }
        let abortError: ProviderAdapterRequestError | undefined;
        yield* Effect.tryPromise({
          try: () => entry.session.abort(),
          catch: (cause) => toRequestError("session.abort", "Failed to interrupt Copilot turn.", cause),
        }).pipe(
          Effect.catch((error: ProviderAdapterRequestError) =>
            Effect.sync(() => {
              abortError = error;
            }),
          ),
        );
        const createdAt = now();
        const cancelledEvents = cancelPendingInteractiveRequests({
          entry,
          createdAt,
          reason: "Copilot turn interrupted before the interactive request was resolved.",
        });
        const runtimeEvents: ProviderRuntimeEvent[] = [];
        if (entry.activeTurnId !== undefined) {
          const { turnId, providerTurnId } = clearTurnState(entry, { status: "ready" }, createdAt);
          runtimeEvents.push(
            ...cancelledEvents,
            {
              ...makeRuntimeEventBase({
                threadId,
                createdAt,
                turnId,
                providerTurnId,
              }),
              type: "turn.aborted",
              payload: {
                reason: "Copilot turn interrupted",
              },
            },
          );
        } else {
          runtimeEvents.push(...cancelledEvents);
        }

        if (runtimeEvents.length > 0) {
          yield* emitRuntimeEvents(runtimeEvents);
        }

        if (abortError) {
          return yield* abortError;
        }
      });

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const entry = yield* requireEntry(threadId);
        const pending = entry.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* toRequestError(
            "permissions.handlePendingPermissionRequest",
            `Unknown pending Copilot approval request '${requestId}'.`,
          );
        }

        entry.pendingApprovals.delete(requestId);
        clearPendingTimeout(pending);
        pending.resolve(toRequestDecision(decision));

        yield* emitRuntimeEvents([
          {
            ...makeRuntimeEventBase({
              threadId,
              createdAt: now(),
              turnId: pending.turnId,
              requestId: pending.runtimeRequestId,
              raw: {
                source: "copilot.sdk.permission-request",
                payload: {
                  request: pending.request,
                  decision,
                },
              },
            }),
            type: "request.resolved",
            payload: {
              requestType: pending.requestType,
              decision,
              resolution: {
                decision,
                result: toRequestDecision(decision),
              },
            },
          },
        ]);
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const entry = yield* requireEntry(threadId);
        const pending = entry.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* toRequestError(
            "session.userInput",
            `Unknown pending Copilot user input request '${requestId}'.`,
          );
        }

        const answer = extractUserInputAnswer(answers);
        if (!answer) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: `No response was provided for Copilot user input request '${requestId}'.`,
          });
        }

        if (!isChoiceAnswer(pending.request, answer) && !allowsFreeformAnswer(pending.request)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: `Copilot user input request '${requestId}' only accepts one of the provided choices.`,
          });
        }

        entry.pendingUserInputs.delete(requestId);
        clearPendingTimeout(pending);
        pending.resolve({
          answer,
          wasFreeform: !isChoiceAnswer(pending.request, answer),
        });

        yield* emitRuntimeEvents([
          {
            ...makeRuntimeEventBase({
              threadId,
              createdAt: now(),
              turnId: pending.turnId,
              requestId: pending.runtimeRequestId,
              raw: {
                source: "copilot.sdk.user-input-request",
                payload: {
                  request: pending.request,
                  answers,
                },
              },
            }),
            type: "user-input.resolved",
            payload: {
              answers: {
                [DEFAULT_QUESTION_ID]: answer,
              },
            },
          },
        ]);
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const entry = yield* requireEntry(threadId);
        yield* stopEntry(entry, {
          emitExit: true,
          reason: "Copilot session stopped",
          exitKind: "graceful",
        });
      });

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(entries.values(), (entry) => cloneSession(entry.providerSession)));

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => entries.has(threadId));

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const entry = yield* requireEntry(threadId);
        const events = yield* Effect.tryPromise({
          try: () => entry.session.getMessages(),
          catch: (cause) => toRequestError("session.getMessages", "Failed to read Copilot thread history.", cause),
        });

        const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
        let currentTurn: { id: TurnId; items: Array<unknown> } | undefined;

        for (const event of events) {
          const eventData = event.data ?? {};
          if (event.type === "assistant.turn_start") {
            const providerTurnId =
              asTrimmedString(eventData.turnId) ??
              String(makeDeterministicHistoryTurnId(event, turns.length + 1));
            if (currentTurn && currentTurn.items.length > 0) {
              turns.push(currentTurn);
            }
            currentTurn = {
              id: TurnId.makeUnsafe(providerTurnId),
              items: [event],
            };
            continue;
          }

          if (!currentTurn) {
            currentTurn = {
              id: makeDeterministicHistoryTurnId(event, turns.length + 1),
              items: [],
            };
          }

          currentTurn.items.push(event);

          if (event.type === "assistant.turn_end") {
            turns.push(currentTurn);
            currentTurn = undefined;
          }
        }

        if (currentTurn && currentTurn.items.length > 0) {
          turns.push(currentTurn);
        }

        return {
          threadId,
          turns: turns.map((turn) => ({
            id: turn.id,
            items: turn.items,
          })),
        } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (_threadId, _numTurns) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Copilot SDK does not currently expose a public rollback API.",
        }),
      );

    const stopAllInternal = (emitExit: boolean) =>
      Effect.gen(function* () {
        const activeEntries = Array.from(entries.values());
        for (const entry of activeEntries) {
          yield* stopEntry(entry, {
            emitExit,
            reason: "Copilot adapter shutdown",
            exitKind: "graceful",
          }).pipe(
            Effect.catch((error: unknown) =>
              emitExit
                ? emitSessionShutdown(
                    entry,
                    error instanceof Error ? error.message : String(error),
                    "error",
                  )
                : Effect.void,
            ),
          );
        }
      });

    const stopAll: CopilotAdapterShape["stopAll"] = () => stopAllInternal(false);

    yield* Effect.addFinalizer(() =>
      stopAllInternal(false).pipe(
        Effect.andThen(Queue.shutdown(runtimeEventQueue).pipe(Effect.asVoid)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CopilotAdapterShape;
  });

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
