import { randomUUID } from "node:crypto";

import {
  EventId,
  ProviderItemId,
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

interface CopilotSessionLike {
  readonly sessionId: string;
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
}

interface PendingApprovalRequest {
  readonly requestId: string;
  readonly runtimeRequestId: RuntimeRequestId;
  readonly turnId?: TurnId;
  readonly requestType: CanonicalRequestType;
  readonly request: CopilotPermissionRequest;
  readonly resolve: (result: CopilotPermissionResult) => void;
  readonly reject: (reason?: unknown) => void;
}

interface PendingUserInput {
  readonly requestId: string;
  readonly runtimeRequestId: RuntimeRequestId;
  readonly turnId?: TurnId;
  readonly request: CopilotUserInputRequest;
  readonly resolve: (result: CopilotUserInputResponse) => void;
  readonly reject: (reason?: unknown) => void;
}

interface ToolLifecycleState {
  readonly itemType: CanonicalItemType;
  readonly title?: string;
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
  lastUsage: Record<string, unknown> | undefined;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
      return asString(request.fullCommandText) ?? asString(request.intention);
    case "write":
      return asString(request.fileName) ?? asString(request.intention) ?? asString(request.diff);
    case "read":
      return asString(request.path) ?? asString(request.intention);
    case "mcp":
      return asString(request.toolTitle) ?? asString(request.toolName) ?? asString(request.serverName);
    case "url":
      return asString(request.url) ?? asString(request.intention);
    case "memory":
      return asString(request.subject) ?? asString(request.fact);
    case "custom-tool":
      return asString(request.toolDescription) ?? asString(request.toolName);
    default:
      return undefined;
  }
}

function inferToolItemType(toolName: string | undefined, data: Record<string, unknown>): CanonicalItemType {
  if (asString(data.mcpServerName)) {
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
  return asString(result?.detailedContent) ?? asString(result?.content);
}

function makeUserInputQuestions(request: CopilotUserInputRequest) {
  const choiceOptions = (request.choices ?? [])
    .map((choice) => asString(choice))
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
    const nestedAnswer = asString(answerRecord?.answer);
    if (nestedAnswer) {
      return nestedAnswer;
    }
  }

  return undefined;
}

function isChoiceAnswer(request: CopilotUserInputRequest, answer: string): boolean {
  return (request.choices ?? []).some((choice) => choice === answer);
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
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const entries = new Map<ThreadId, CopilotRuntimeEntry>();
    const clientFactory = options?.clientFactory ?? makeCopilotClientFactory;
    const now = options?.now ?? (() => new Date().toISOString());
    const generateId = options?.generateId ?? randomUUID;
    const nativeEventLogger = options?.nativeEventLogger;

    const runDetached = (effect: Effect.Effect<unknown>) => {
      void Effect.runPromise(effect).catch(() => undefined);
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

    const stopEntry = (
      entry: CopilotRuntimeEntry,
      options: { readonly emitExit: boolean; readonly reason: string; readonly exitKind: "graceful" | "error" },
    ) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          try {
            entry.unsubscribe();
          } catch {
            // Ignore listener cleanup issues during shutdown.
          }
        });

        for (const pending of entry.pendingApprovals.values()) {
          pending.reject(new Error("Copilot session stopped before the approval request was resolved."));
        }
        for (const pending of entry.pendingUserInputs.values()) {
          pending.reject(new Error("Copilot session stopped before the input request was resolved."));
        }
        entry.pendingApprovals.clear();
        entry.pendingUserInputs.clear();
        entry.toolCalls.clear();

        const errors = yield* Effect.tryPromise({
          try: () => entry.client.stop(),
          catch: (cause) => toProcessError(entry.threadId, "Failed to stop Copilot client.", cause),
        });

        if (errors.length > 0) {
          return yield* toProcessError(
            entry.threadId,
            errors.map((error) => error.message).join("; "),
            errors[0],
          );
        }

        if (entries.get(entry.threadId) === entry) {
          entries.delete(entry.threadId);
        }
        touchSession(entry, { status: "closed", activeTurnId: undefined }, now());

        if (options.emitExit) {
          yield* emitSessionShutdown(entry, options.reason, options.exitKind);
        }
      });

    const mapSessionEvent = (
      entry: CopilotRuntimeEntry,
      event: CopilotSessionEvent,
    ): ReadonlyArray<ProviderRuntimeEvent> => {
      const createdAt = normalizeIsoTimestamp(event.timestamp, now);
      const raw = buildSdkRaw(event);
      const eventData = event.data ?? {};
      const activeTurnId = entry.activeTurnId;
      const activeProviderTurnId = entry.activeProviderTurnId;

      switch (event.type) {
        case "assistant.turn_start": {
          const providerTurnId = asString(eventData.turnId);
          if (providerTurnId) {
            entry.activeProviderTurnId = providerTurnId;
          }
          if (entry.activeTurnId !== undefined) {
            return [];
          }
          const createdTurnId = TurnId.makeUnsafe(generateId());
          entry.activeTurnId = createdTurnId;
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
          const intent = asString(eventData.intent);
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
          const reasoningId = asString(eventData.reasoningId);
          const delta = asString(eventData.deltaContent);
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
          const reasoningId = asString(eventData.reasoningId);
          const content = asString(eventData.content);
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
          const messageId = asString(eventData.messageId);
          const delta = asString(eventData.deltaContent);
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
          const messageId = asString(eventData.messageId);
          const content = asString(eventData.content);
          if (!messageId || !content) {
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
          touchSession(entry, { status: "ready", activeTurnId: undefined, lastError: undefined }, createdAt);
          entry.activeTurnId = undefined;
          entry.activeProviderTurnId = undefined;
          entry.toolCalls.clear();
          const usage = entry.lastUsage;
          entry.lastUsage = undefined;
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                providerTurnId: activeProviderTurnId,
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
          const toolCallId = asString(eventData.toolCallId);
          if (!toolCallId) {
            return [];
          }
          const title = asString(eventData.toolName);
          const itemType = inferToolItemType(title, eventData);
          const detail = safeJsonStringify(eventData.arguments);
          entry.toolCalls.set(toolCallId, {
            itemType,
            ...(title ? { title } : {}),
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
          const toolCallId = asString(eventData.toolCallId);
          const summary = asString(eventData.progressMessage);
          if (!toolCallId || !summary) {
            return [];
          }
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
          const toolCallId = asString(eventData.toolCallId);
          const partialOutput = asString(eventData.partialOutput);
          if (!toolCallId || !partialOutput) {
            return [];
          }
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
          const toolCallId = asString(eventData.toolCallId);
          if (!toolCallId) {
            return [];
          }
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
                data: eventData,
              },
            },
          ];
        }
        case "session.idle": {
          touchSession(entry, { status: "ready" }, createdAt);
          return [
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
        case "session.warning": {
          const message = asString(eventData.message);
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
          const message = asString(eventData.message);
          if (!message) {
            return [];
          }
          touchSession(entry, { status: "error", lastError: message }, createdAt);
          return [
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                providerTurnId: activeProviderTurnId,
                raw,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: toRuntimeErrorClass(asString(eventData.errorType)),
                detail: eventData,
              },
            },
            {
              ...makeRuntimeEventBase({
                threadId: entry.threadId,
                createdAt,
                turnId: activeTurnId,
                providerTurnId: activeProviderTurnId,
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
        case "session.title_changed": {
          const title = asString(eventData.title);
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
          const pending: PendingApprovalRequest = {
            requestId,
            runtimeRequestId,
            ...(entry.activeTurnId !== undefined ? { turnId: entry.activeTurnId } : {}),
            requestType: toRequestType(request),
            request,
            resolve: deferred.resolve,
            reject: deferred.reject,
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
          const pending: PendingUserInput = {
            requestId,
            runtimeRequestId,
            ...(entry.activeTurnId !== undefined ? { turnId: entry.activeTurnId } : {}),
            request,
            resolve: deferred.resolve,
            reject: deferred.reject,
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
          ...(configDir !== undefined ? { configDir } : {}),
          onPermissionRequest: permissionHandler,
          onUserInputRequest: userInputHandler,
          ...(input.cwd !== undefined ? { workingDirectory: input.cwd } : {}),
          streaming: true,
        };
        const resumedSessionId = asString(input.resumeCursor);

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
                  writeNativeEvent(entry.threadId, event).pipe(Effect.andThen(emitRuntimeEvents(mapped))),
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
                lastUsage: undefined,
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
        if ((input.attachments ?? []).length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue:
              "Copilot SDK attachments require file, directory, or selection paths; T3 image attachments are not yet supported.",
          });
        }

        const prompt = asString(input.input);
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
                  payload: input.model !== undefined ? { model: input.model } : {},
                },
              ]),
            ),
            Effect.andThen(
              Effect.tryPromise({
                try: () =>
                  entry.session.send({
                    prompt,
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
        yield* Effect.tryPromise({
          try: () => entry.session.abort(),
          catch: (cause) => toRequestError("session.abort", "Failed to interrupt Copilot turn.", cause),
        });
        if (entry.activeTurnId !== undefined) {
          const turnId = entry.activeTurnId;
          entry.activeTurnId = undefined;
          entry.activeProviderTurnId = undefined;
          entry.toolCalls.clear();
          touchSession(entry, { status: "ready", activeTurnId: undefined }, now());
          yield* emitRuntimeEvents([
            {
              ...makeRuntimeEventBase({
                threadId,
                createdAt: now(),
                turnId,
              }),
              type: "turn.aborted",
              payload: {
                reason: "Copilot turn interrupted",
              },
            },
          ]);
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

        entry.pendingUserInputs.delete(requestId);
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
            const providerTurnId = asString(eventData.turnId) ?? generateId();
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
              id: TurnId.makeUnsafe(`history:${turns.length + 1}:${generateId()}`),
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
