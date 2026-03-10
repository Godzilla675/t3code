import assert from "node:assert/strict";

import { ApprovalRequestId, ThreadId, TurnId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  PermissionRequest,
  PermissionRequestResult,
} from "@github/copilot-sdk";
import { it, vi } from "@effect/vitest";

import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

type FakePermissionResult = PermissionRequestResult;

type FakePermissionRequest = PermissionRequest;

type FakeUserInputRequest = {
  question: string;
  choices?: ReadonlyArray<string>;
  allowFreeform?: boolean;
};

type FakeUserInputResponse = {
  answer: string;
  wasFreeform: boolean;
};

type FakeSessionConfig = {
  sessionId?: string;
  clientName?: string;
  model?: string;
  reasoningEffort?: "xhigh" | "high" | "medium" | "low";
  configDir?: string;
  onPermissionRequest: (
    request: FakePermissionRequest,
    invocation: { sessionId: string },
  ) => Promise<FakePermissionResult> | FakePermissionResult;
  onUserInputRequest?: (
    request: FakeUserInputRequest,
    invocation: { sessionId: string },
  ) => Promise<FakeUserInputResponse> | FakeUserInputResponse;
  workingDirectory?: string;
  streaming?: boolean;
};

type FakeSessionEvent = {
  id: string;
  timestamp?: string;
  type: string;
  data?: Record<string, unknown>;
};

type FakeSessionMode = "interactive" | "plan" | "autopilot";

class FakeCopilotSession {
  private handlers = new Set<(event: FakeSessionEvent) => void>();
  private sessionMode: FakeSessionMode = "interactive";
  private planReadResult = {
    exists: false,
    content: null,
    path: null,
  } as {
    exists: boolean;
    content: string | null;
    path: string | null;
  };

  readonly sendImpl = vi.fn(
    async (_options: { prompt: string; attachments?: ReadonlyArray<unknown>; mode?: string }) =>
      "msg-1",
  );
  readonly abortImpl = vi.fn(async () => undefined);
  readonly setModelImpl = vi.fn(async (_model: string) => undefined);
  readonly getMessagesImpl = vi.fn(async () => [] as ReadonlyArray<FakeSessionEvent>);
  readonly disconnectImpl = vi.fn(async () => undefined);
  readonly getModeImpl = vi.fn(async () => ({ mode: this.sessionMode }));
  readonly setModeImpl = vi.fn(async ({ mode }: { mode: FakeSessionMode }) => {
    this.sessionMode = mode;
    return { mode };
  });
  readonly readPlanImpl = vi.fn(async () => this.planReadResult);
  readonly rpc = {
    mode: {
      get: () => this.getModeImpl(),
      set: (params: { mode: FakeSessionMode }) => this.setModeImpl(params),
    },
    plan: {
      read: () => this.readPlanImpl(),
    },
  };

  constructor(readonly sessionId: string) {}

  send(options: { prompt: string; attachments?: ReadonlyArray<unknown>; mode?: string }) {
    return this.sendImpl(options);
  }

  abort() {
    return this.abortImpl();
  }

  setModel(model: string) {
    return this.setModelImpl(model);
  }

  getMessages() {
    return this.getMessagesImpl();
  }

  disconnect() {
    return this.disconnectImpl();
  }

  on(handler: (event: FakeSessionEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: FakeSessionEvent) {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  setPlanReadResult(result: { exists: boolean; content: string | null; path: string | null }) {
    this.planReadResult = result;
  }
}

class FakeCopilotClient {
  currentSession: FakeCopilotSession | undefined;
  lastCreateConfig: FakeSessionConfig | undefined;
  lastResumeConfig: FakeSessionConfig | undefined;
  lastResumeSessionId: string | undefined;

  readonly startImpl = vi.fn(async () => undefined);
  readonly stopImpl = vi.fn(async () => [] as ReadonlyArray<Error>);
  readonly createSessionImpl = vi.fn(async (config: FakeSessionConfig) => {
    this.lastCreateConfig = config;
    const session = new FakeCopilotSession(config.sessionId ?? "generated-session");
    this.currentSession = session;
    return session;
  });
  readonly resumeSessionImpl = vi.fn(async (sessionId: string, config: FakeSessionConfig) => {
    this.lastResumeSessionId = sessionId;
    this.lastResumeConfig = config;
    const session = new FakeCopilotSession(sessionId);
    this.currentSession = session;
    return session;
  });

  reset() {
    this.currentSession = undefined;
    this.lastCreateConfig = undefined;
    this.lastResumeConfig = undefined;
    this.lastResumeSessionId = undefined;
    this.startImpl.mockClear();
    this.stopImpl.mockClear();
    this.createSessionImpl.mockClear();
    this.resumeSessionImpl.mockClear();
  }

  start() {
    return this.startImpl();
  }

  createSession(config: FakeSessionConfig) {
    return this.createSessionImpl(config);
  }

  resumeSession(sessionId: string, config: FakeSessionConfig) {
    return this.resumeSessionImpl(sessionId, config);
  }

  stop() {
    return this.stopImpl();
  }
}

const client = new FakeCopilotClient();
const resolvedAttachmentPaths = new Map<string, string>();
const existingAttachmentPaths = new Set<string>();

const layer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => client,
    resolveAttachmentPath: ({ attachment }) => resolvedAttachmentPaths.get(attachment.id) ?? null,
    fileExists: (path) => existingAttachmentPaths.has(path),
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const drainStartupEvents = (adapter: { readonly streamEvents: Stream.Stream<unknown> }) =>
  Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(Effect.asVoid);

const resetSharedAdapter = () =>
  Effect.gen(function* () {
    const adapter = yield* CopilotAdapter;
    yield* adapter.stopAll();
    client.reset();
    resolvedAttachmentPaths.clear();
    existingAttachmentPaths.clear();
    return adapter;
  });

layer("CopilotAdapterLive", (it) => {
  it.effect("starts sessions through the SDK and uses threadId as the session id", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-1"),
        cwd: "/workspaces/t3code",
        model: "gpt-4.1",
        modelOptions: {
          copilot: {
            reasoningEffort: "medium",
          },
        },
        runtimeMode: "approval-required",
        providerOptions: {
          copilot: {
            cliUrl: "http://127.0.0.1:8123",
            configDir: "/tmp/copilot-config",
          },
        },
      });

      assert.equal(client.startImpl.mock.calls.length, 1);
      assert.equal(client.createSessionImpl.mock.calls.length, 1);
      assert.equal(client.resumeSessionImpl.mock.calls.length, 0);
      assert.equal(client.lastCreateConfig?.sessionId, "thread-1");
      assert.equal(client.lastCreateConfig?.model, "gpt-4.1");
      assert.equal(client.lastCreateConfig?.reasoningEffort, "medium");
      assert.equal(client.lastCreateConfig?.configDir, "/tmp/copilot-config");
      assert.equal(client.lastCreateConfig?.workingDirectory, "/workspaces/t3code");
      assert.equal(client.lastCreateConfig?.streaming, true);
      assert.equal(session.provider, "copilot");
      assert.equal(session.threadId, "thread-1");
      assert.equal(session.resumeCursor, "thread-1");

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.provider, "copilot");
      assert.equal(sessions[0]?.threadId, "thread-1");
    }),
  );

  it.effect("resumes existing Copilot sessions from a persisted resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-resume"),
        resumeCursor: "copilot-session-123",
        modelOptions: {
          copilot: {
            reasoningEffort: "low",
          },
        },
        runtimeMode: "full-access",
      });

      assert.equal(client.createSessionImpl.mock.calls.length, 0);
      assert.equal(client.resumeSessionImpl.mock.calls.length, 1);
      assert.equal(client.lastResumeSessionId, "copilot-session-123");
      assert.equal(client.lastResumeConfig?.reasoningEffort, "low");
      assert.equal(session.resumeCursor, "copilot-session-123");
    }),
  );

  it.effect("keeps recovered active turn identity across resume until turn end arrives", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-resume-active-turn"),
        resumeCursor: "copilot-session-active",
        activeTurnId: TurnId.makeUnsafe("turn-recovered"),
        runtimeMode: "full-access",
      });

      assert.equal(session.activeTurnId, "turn-recovered");
      assert.equal(session.status, "running");
      yield* drainStartupEvents(adapter);

      const currentSession = client.currentSession;
      assert.ok(currentSession);

      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1)).pipe(
        Effect.forkChild,
      );
      currentSession.emit({
        id: "evt-turn-end",
        type: "assistant.turn_end",
        data: {},
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "turn.completed");
      if (events[0]?.type === "turn.completed") {
        assert.equal(events[0].turnId, "turn-recovered");
      }

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "ready");
      assert.equal(sessions[0]?.activeTurnId, undefined);
    }),
  );

  it.effect("switches the active model before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-send"),
        model: "gpt-4.1",
        runtimeMode: "full-access",
      });

      const session = client.currentSession;
      assert.ok(session);
      session.setModelImpl.mockClear();
      session.sendImpl.mockClear();

      const result = yield* adapter.sendTurn({
        threadId: asThreadId("thread-send"),
        input: "Explain the pending diff",
        model: "gpt-5.1",
        attachments: [],
      });

      assert.equal(session.setModelImpl.mock.calls.length, 1);
      assert.equal(session.setModelImpl.mock.calls[0]?.[0], "gpt-5.1");
      assert.deepEqual(session.sendImpl.mock.calls[0]?.[0], {
        prompt: "Explain the pending diff",
      });
      assert.equal(result.threadId, "thread-send");
      assert.equal(result.resumeCursor, "thread-send");
      assert.equal(typeof result.turnId, "string");
    }),
  );

  it.effect("maps stored image attachments to Copilot file attachments", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-send-with-attachment"),
        model: "gpt-5.4",
        runtimeMode: "full-access",
      });

      const session = client.currentSession;
      assert.ok(session);
      session.sendImpl.mockClear();

      resolvedAttachmentPaths.set("attachment-1", "C:\\attachments\\diagram.png");
      existingAttachmentPaths.add("C:\\attachments\\diagram.png");

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-send-with-attachment"),
        input: "Describe this diagram",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      });

      assert.deepEqual(session.sendImpl.mock.calls[0]?.[0], {
        prompt: "Describe this diagram",
        attachments: [
          {
            type: "file",
            path: "C:\\attachments\\diagram.png",
            displayName: "diagram.png",
          },
        ],
      });
    }),
  );

  it.effect("syncs the Copilot session mode before sending plan and default turns", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-plan-mode"),
        model: "gpt-5.4",
        runtimeMode: "full-access",
      });
      yield* drainStartupEvents(adapter);

      const session = client.currentSession;
      assert.ok(session);
      session.setModeImpl.mockClear();

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-plan-mode"),
        input: "Draft an implementation plan",
        attachments: [],
        interactionMode: "plan",
      });
      session.emit({
        id: "evt-plan-turn-end",
        type: "assistant.turn_end",
        data: {},
      });
      yield* adapter.sendTurn({
        threadId: asThreadId("thread-plan-mode"),
        input: "Now implement it",
        attachments: [],
        interactionMode: "default",
      });
      session.emit({
        id: "evt-default-turn-end",
        type: "assistant.turn_end",
        data: {},
      });

      assert.deepEqual(session.setModeImpl.mock.calls.map((call) => call[0]), [
        { mode: "plan" },
        { mode: "interactive" },
      ]);
    }),
  );

  it.effect("preserves the active turn when Copilot plan snapshots resolve after turn end", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-plan-bridge"),
        model: "gpt-5.4",
        runtimeMode: "full-access",
      });
      yield* drainStartupEvents(adapter);

      const session = client.currentSession;
      assert.ok(session);

      let resolvePlanRead:
        | ((result: { exists: boolean; content: string | null; path: string | null }) => void)
        | undefined;
      const planReadPromise = new Promise<{
        exists: boolean;
        content: string | null;
        path: string | null;
      }>((resolve) => {
        resolvePlanRead = resolve;
      });
      session.readPlanImpl.mockImplementationOnce(() => planReadPromise);

      const observedEvents: Array<{
        type: string;
        turnId?: string;
        payload?: {
          planMarkdown?: string;
        };
      }> = [];

      let resolveProposedEvent:
        | ((event: (typeof observedEvents)[number]) => void)
        | undefined;
      let rejectProposedEvent: ((error: Error) => void) | undefined;
      const proposedEventPromise = new Promise<(typeof observedEvents)[number]>((resolve, reject) => {
        resolveProposedEvent = resolve;
        rejectProposedEvent = reject;
      });
      const timeoutHandle = setTimeout(
        () => rejectProposedEvent?.(new Error("Timed out waiting for the Copilot proposed-plan bridge.")),
        1_000,
      );

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          const observedEvent = event as (typeof observedEvents)[number];
          observedEvents.push(observedEvent);
          if (observedEvent.type === "turn.proposed.completed") {
            resolveProposedEvent?.(observedEvent);
          }
        }),
      ).pipe(Effect.forkChild);

      const result = yield* adapter.sendTurn({
        threadId: asThreadId("thread-plan-bridge"),
        input: "Draft a rollout plan",
        attachments: [],
        interactionMode: "plan",
      });

      session.emit({
        id: "evt-plan-changed",
        type: "session.plan_changed",
        data: {},
      });
      session.emit({
        id: "evt-plan-turn-end",
        type: "assistant.turn_end",
        data: {},
      });
      resolvePlanRead?.({
        exists: true,
        content: "## Rollout plan\n\n- capture turn state\n- persist proposal",
        path: "C:\\plan.md",
      });

      const proposedEvent = yield* Effect.promise(() =>
        proposedEventPromise.finally(() => clearTimeout(timeoutHandle)),
      );
      yield* Fiber.interrupt(eventsFiber);

      assert.equal(proposedEvent.type, "turn.proposed.completed");
      assert.equal(proposedEvent.turnId, result.turnId);
      assert.equal(
        proposedEvent.payload?.planMarkdown,
        "## Rollout plan\n\n- capture turn state\n- persist proposal",
      );
      assert.ok(
        observedEvents.some(
          (event) => event.type === "turn.completed" && event.turnId === result.turnId,
        ),
      );
    }),
  );

  it.effect("keeps the previous model when switching the Copilot model fails", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-set-model-failure"),
        model: "gpt-4.1",
        runtimeMode: "full-access",
      });
      yield* drainStartupEvents(adapter);

      const session = client.currentSession;
      assert.ok(session);
      session.setModelImpl.mockImplementation(async () => {
        throw new Error("simulated model switch failure");
      });

      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1)).pipe(
        Effect.forkChild,
      );
      const failure = yield* Effect.result(
        adapter.sendTurn({
          threadId: asThreadId("thread-set-model-failure"),
          input: "Try the alternate model",
          model: "gpt-5.1",
          attachments: [],
        }),
      );
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(failure._tag, "Failure");
      assert.equal(events[0]?.type, "turn.completed");
      if (events[0]?.type === "turn.completed") {
        assert.equal(events[0].payload.state, "failed");
      }

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.model, "gpt-4.1");
    }),
  );

  it.effect("keeps the active Copilot session when replacement startup fails", () => {
    const firstClient = new FakeCopilotClient();
    const replacementClient = new FakeCopilotClient();
    replacementClient.createSessionImpl.mockImplementation(async () => {
      throw new Error("simulated replacement failure");
    });
    const clients = [firstClient, replacementClient];

    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-restart-failure"),
        model: "gpt-4.1",
        runtimeMode: "full-access",
      });

      const failure = yield* Effect.result(
        adapter.startSession({
          provider: "copilot",
          threadId: asThreadId("thread-restart-failure"),
          model: "gpt-5.1",
          runtimeMode: "full-access",
        }),
      );

      assert.equal(failure._tag, "Failure");
      assert.equal(firstClient.stopImpl.mock.calls.length, 0);
      assert.equal(replacementClient.stopImpl.mock.calls.length, 1);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.threadId, "thread-restart-failure");
      assert.equal(sessions[0]?.model, "gpt-4.1");
    }).pipe(
      Effect.provide(
        makeCopilotAdapterLive({
          clientFactory: () => {
            const next = clients.shift();
            assert.ok(next);
            return next;
          },
        }),
      ),
    );
  });

  it.effect("keeps the replacement session when prior Copilot cleanup reports shutdown errors", () => {
    const firstClient = new FakeCopilotClient();
    const replacementClient = new FakeCopilotClient();
    firstClient.stopImpl.mockImplementation(async () => [new Error("stale client shutdown failed")]);
    const clients = [firstClient, replacementClient];

    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-restart-warning"),
        model: "gpt-4.1",
        runtimeMode: "full-access",
      });

      const replacement = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-restart-warning"),
        model: "gpt-5.1",
        runtimeMode: "full-access",
      });

      assert.equal(firstClient.stopImpl.mock.calls.length, 1);
      assert.equal(replacementClient.stopImpl.mock.calls.length, 0);
      assert.equal(replacement.model, "gpt-5.1");

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.threadId, "thread-restart-warning");
      assert.equal(sessions[0]?.model, "gpt-5.1");
    }).pipe(
      Effect.provide(
        makeCopilotAdapterLive({
          clientFactory: () => {
            const next = clients.shift();
            assert.ok(next);
            return next;
          },
        }),
      ),
    );
  });

  it.effect("bridges approval requests into canonical request events", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-approval"),
        runtimeMode: "approval-required",
      });
      yield* drainStartupEvents(adapter);

      const config = client.lastCreateConfig;
      assert.ok(config);

      const openedFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const decisionPromise = Promise.resolve(
        config.onPermissionRequest(
          {
            kind: "shell",
            fullCommandText: "git status",
            intention: "Inspect repository status",
          },
          { sessionId: "thread-approval" },
        ),
      );

      const opened = yield* Fiber.join(openedFiber);
      assert.equal(opened._tag, "Some");
      if (opened._tag !== "Some") {
        return;
      }
      assert.equal(opened.value.type, "request.opened");
      if (opened.value.type !== "request.opened") {
        return;
      }
      assert.equal(opened.value.payload.requestType, "command_execution_approval");
      assert.equal(opened.value.payload.detail, "git status");
      const approvalRequestId = opened.value.requestId;
      assert.ok(approvalRequestId);

      const resolvedFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* adapter.respondToRequest(
        asThreadId("thread-approval"),
        ApprovalRequestId.makeUnsafe(approvalRequestId),
        "accept",
      );
      const resolved = yield* Fiber.join(resolvedFiber);
      const decision = yield* Effect.promise(() => decisionPromise);

      assert.deepEqual(decision, { kind: "approved" });
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.payload.requestType, "command_execution_approval");
      assert.equal(resolved.value.payload.decision, "accept");
    }),
  );

  it.effect("bridges ask-user requests into canonical user-input events", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-user-input"),
        runtimeMode: "approval-required",
      });
      yield* drainStartupEvents(adapter);

      const config = client.lastCreateConfig;
      assert.ok(config);
      assert.ok(config.onUserInputRequest);

      const openedFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const answerPromise = Promise.resolve(
        config.onUserInputRequest!(
          {
            question: "Proceed with the refactor?",
            choices: ["Yes", "No"],
            allowFreeform: true,
          },
          { sessionId: "thread-user-input" },
        ),
      );

      const opened = yield* Fiber.join(openedFiber);
      assert.equal(opened._tag, "Some");
      if (opened._tag !== "Some") {
        return;
      }
      assert.equal(opened.value.type, "user-input.requested");
      if (opened.value.type !== "user-input.requested") {
        return;
      }
      assert.equal(opened.value.payload.questions[0]?.id, "response");
      assert.equal(opened.value.payload.questions[0]?.question, "Proceed with the refactor?");
      const userInputRequestId = opened.value.requestId;
      assert.ok(userInputRequestId);

      const resolvedFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* adapter.respondToUserInput(
        asThreadId("thread-user-input"),
        ApprovalRequestId.makeUnsafe(userInputRequestId),
        { response: "Yes" },
      );
      const resolved = yield* Fiber.join(resolvedFiber);
      const answer = yield* Effect.promise(() => answerPromise);

      assert.deepEqual(answer, {
        answer: "Yes",
        wasFreeform: false,
      });
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "user-input.resolved");
      if (resolved.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolved.value.payload.answers, {
        response: "Yes",
      });
    }),
  );

  it.effect("keeps freeform-only ask-user requests freeform", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-freeform"),
        runtimeMode: "approval-required",
      });
      yield* drainStartupEvents(adapter);

      const config = client.lastCreateConfig;
      assert.ok(config);
      assert.ok(config.onUserInputRequest);

      const openedFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const answerPromise = Promise.resolve(
        config.onUserInputRequest!(
          {
            question: "Why should we take this path?",
            allowFreeform: true,
          },
          { sessionId: "thread-freeform" },
        ),
      );

      const opened = yield* Fiber.join(openedFiber);
      assert.equal(opened._tag, "Some");
      if (opened._tag !== "Some") {
        return;
      }
      assert.equal(opened.value.type, "user-input.requested");
      if (opened.value.type !== "user-input.requested") {
        return;
      }
      assert.deepEqual(opened.value.payload.questions[0]?.options, []);
      const userInputRequestId = opened.value.requestId;
      assert.ok(userInputRequestId);

      const resolvedFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* adapter.respondToUserInput(
        asThreadId("thread-freeform"),
        ApprovalRequestId.makeUnsafe(userInputRequestId),
        { response: "Because it is the safer migration." },
      );
      const resolved = yield* Fiber.join(resolvedFiber);
      const answer = yield* Effect.promise(() => answerPromise);

      assert.deepEqual(answer, {
        answer: "Because it is the safer migration.",
        wasFreeform: true,
      });
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "user-input.resolved");
    }),
  );

  it.effect("maps Copilot session events into canonical runtime events without trimming content whitespace", () =>
    Effect.gen(function* () {
      const adapter = yield* resetSharedAdapter();

      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-events"),
        model: "gpt-4.1",
        runtimeMode: "full-access",
      });
      yield* drainStartupEvents(adapter);

      const result = yield* adapter.sendTurn({
        threadId: asThreadId("thread-events"),
        input: "Summarize the recent changes",
        attachments: [],
      });

      const session = client.currentSession;
      assert.ok(session);

      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
        Effect.forkChild,
      );

      session.emit({
        id: "evt-message-delta",
        type: "assistant.message_delta",
        data: {
          messageId: "msg-1",
          deltaContent: "Hello ",
        },
      });
      session.emit({
        id: "evt-message",
        type: "assistant.message",
        data: {
          messageId: "msg-1",
          content: "Hello world",
        },
      });
      session.emit({
        id: "evt-turn-end",
        type: "assistant.turn_end",
        data: {
          turnId: "provider-turn-1",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "turn.started");
      if (events[0]?.type === "turn.started") {
        assert.equal(events[0].turnId, result.turnId);
      }

      assert.equal(events[1]?.type, "content.delta");
      if (events[1]?.type === "content.delta") {
        assert.equal(events[1].payload.streamKind, "assistant_text");
        assert.equal(events[1].payload.delta, "Hello ");
      }

      assert.equal(events[2]?.type, "item.completed");
      if (events[2]?.type === "item.completed") {
        assert.equal(events[2].payload.itemType, "assistant_message");
        assert.equal(events[2].payload.detail, "Hello world");
      }

      assert.equal(events[3]?.type, "turn.completed");
      if (events[3]?.type === "turn.completed") {
        assert.equal(events[3].turnId, result.turnId);
        assert.equal(events[3].payload.state, "completed");
      }
    }),
  );

});
