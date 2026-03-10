import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { markThreadUnread, syncServerReadModel, type AppState } from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5-codex",
        expanded: true,
        scripts: [],
      },
    ],
    threads: [thread],
    threadsHydrated: true,
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5.3-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(
  thread: OrchestrationReadModel["threads"][number],
  projectOverrides: Partial<OrchestrationReadModel["projects"][number]> = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5.3-codex",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
        ...projectOverrides,
      },
    ],
    threads: [thread],
  };
}

class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

const mockLocalStorage = new MemoryStorage();
const originalWindow = globalThis.window;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: mockLocalStorage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  window.localStorage.clear();
});

afterAll(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });
});

describe("store read model sync", () => {
  it("falls back to the codex default for unsupported provider models without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "claude-opus-4-6",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves Copilot session provider and model during hydration", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "gpt-4.1",
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "copilot",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("gpt-4.1");
    expect(next.threads[0]?.session?.provider).toBe("copilot");
  });

  it("infers Copilot project defaults from Copilot model slugs", () => {
    const initialState: AppState = {
      projects: [],
      threads: [],
      threadsHydrated: false,
    };
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "claude-sonnet-4.6",
      }),
      {
        defaultModel: "claude-sonnet-4.6",
      },
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.model).toBe(DEFAULT_MODEL_BY_PROVIDER.copilot);
    expect(next.threads[0]?.model).toBe(DEFAULT_MODEL_BY_PROVIDER.copilot);
  });

  it("preserves saved custom Copilot models during hydration", () => {
    window.localStorage.setItem(
      "t3code:app-settings:v1",
      JSON.stringify({
        customCopilotModels: ["custom/copilot-model"],
      }),
    );
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "custom/copilot-model",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("custom/copilot-model");
  });
});
