/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import {
  CODEX_REASONING_EFFORT_OPTIONS,
  type CodexReasoningEffort,
  type ModelOption,
  type ServerProviderAuthStatus,
  type ServerProviderStatus,
  type ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { loadCopilotSdk } from "../copilotSdkCompat.ts";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;
const COPILOT_PROVIDER = "copilot" as const;

// ── Pure helpers ────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const REASONING_EFFORT_VALUES = new Set<CodexReasoningEffort>(
  CODEX_REASONING_EFFORT_OPTIONS as ReadonlyArray<CodexReasoningEffort>,
);

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("command not found: codex") ||
    lower.includes("spawn codex enoent") ||
    lower.includes("enoent") ||
    lower.includes("notfound")
  );
}

function isCopilotUnavailableCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("enoent") ||
    lower.includes("notfound") ||
    lower.includes("not found") ||
    lower.includes("failed to start") ||
    lower.includes("unavailable")
  );
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function extractAuthStatusString(value: unknown): ServerProviderAuthStatus | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthStatusString(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (
      lower.includes("unauthenticated") ||
      lower.includes("not authenticated") ||
      lower.includes("not logged in") ||
      lower.includes("signed out") ||
      lower.includes("signed_out") ||
      lower.includes("logged_out") ||
      lower.includes("login required")
    ) {
      return "unauthenticated";
    }
    if (
      lower.includes("authenticated") ||
      lower.includes("logged in") ||
      lower.includes("signed in")
    ) {
      return "authenticated";
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authStatus", "status", "state"] as const) {
    const nested = extractAuthStatusString(record[key]);
    if (nested !== undefined) return nested;
  }
  for (const key of ["auth", "session", "account", "user"] as const) {
    const nested = extractAuthStatusString(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

export function parseCopilotAuthStatus(authStatus: unknown): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const booleanAuth = extractAuthBoolean(authStatus);
  const stringAuth = extractAuthStatusString(authStatus);
  const resolvedAuth =
    booleanAuth === true
      ? "authenticated"
      : booleanAuth === false
        ? "unauthenticated"
        : stringAuth;

  if (resolvedAuth === "authenticated") {
    return { status: "ready", authStatus: "authenticated" };
  }

  if (resolvedAuth === "unauthenticated") {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "GitHub Copilot is not authenticated. Sign in to Copilot and restart T3 Code.",
    };
  }

  return {
    status: "warning",
    authStatus: "unknown",
    message: "Could not verify GitHub Copilot authentication status.",
  };
}

export interface CopilotHealthClient {
  readonly start: () => Promise<unknown>;
  readonly stop: () => Promise<unknown>;
  readonly getAuthStatus: () => Promise<unknown>;
  readonly listModels?: () => Promise<unknown>;
}

function normalizeCopilotAvailableModels(value: unknown): ReadonlyArray<ModelOption> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const slug = nonEmptyTrimmed(typeof record.id === "string" ? record.id : undefined);
    const name =
      nonEmptyTrimmed(typeof record.name === "string" ? record.name : undefined) ?? slug;
    const capabilities =
      record.capabilities !== null && typeof record.capabilities === "object"
        ? (record.capabilities as Record<string, unknown>)
        : undefined;
    const supports =
      capabilities?.supports !== null && typeof capabilities?.supports === "object"
        ? (capabilities.supports as Record<string, unknown>)
        : undefined;
    const supportsVision = typeof supports?.vision === "boolean" ? supports.vision : undefined;
    const supportsReasoningEffort = supports?.reasoningEffort === true;
    const supportedReasoningEfforts = Array.isArray(record.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts.filter(
          (candidate): candidate is CodexReasoningEffort =>
            typeof candidate === "string" &&
            REASONING_EFFORT_VALUES.has(candidate as CodexReasoningEffort),
        )
      : [];
    const defaultReasoningEffort =
      typeof record.defaultReasoningEffort === "string" &&
      REASONING_EFFORT_VALUES.has(record.defaultReasoningEffort as CodexReasoningEffort)
        ? (record.defaultReasoningEffort as CodexReasoningEffort)
        : undefined;
    if (!slug || !name || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    models.push({
      slug,
      name,
      ...(supportsVision !== undefined ? { supportsVision } : {}),
      ...(supportsReasoningEffort && supportedReasoningEfforts.length > 0
        ? { supportedReasoningEfforts }
        : {}),
      ...(defaultReasoningEffort &&
      (supportedReasoningEfforts.length === 0 ||
        supportedReasoningEfforts.includes(defaultReasoningEffort))
        ? { defaultReasoningEffort }
        : {}),
    });
  }

  return models.length > 0 ? models : undefined;
}

const makeCopilotHealthClient = async (): Promise<CopilotHealthClient> => {
  const sdk = await loadCopilotSdk();
  return new sdk.CopilotClient({ autoStart: false });
};

class CopilotHealthProbeError extends Schema.TaggedErrorClass<CopilotHealthProbeError>()(
  "CopilotHealthProbeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const toCopilotHealthProbeError = (
  operation: string,
  detail: string,
  cause?: unknown,
): CopilotHealthProbeError =>
  new CopilotHealthProbeError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });

const stopCopilotHealthClient = (client: CopilotHealthClient): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => client.stop().then(() => undefined),
    catch: (cause) =>
      toCopilotHealthProbeError(
        "stop",
        `Failed to stop GitHub Copilot health probe client: ${
          cause instanceof Error ? cause.message : String(cause)
        }.`,
        cause,
      ),
  }).pipe(Effect.catchTag("CopilotHealthProbeError", (error) => Effect.logWarning(error.message)));

const probeCopilotHealthClient = (
  client: CopilotHealthClient,
  checkedAt: string,
): Effect.Effect<ServerProviderStatus> =>
  Effect.gen(function* () {
    const startProbe = yield* Effect.tryPromise({
      try: () => client.start(),
      catch: (cause) =>
        toCopilotHealthProbeError(
          "start",
          `Failed to start GitHub Copilot health check: ${toError(cause).message}.`,
          cause,
        ),
    }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(startProbe)) {
      const error = startProbe.failure;
      return {
        provider: COPILOT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCopilotUnavailableCause(error)
          ? "GitHub Copilot is unavailable. Install or repair the Copilot CLI backend and restart T3 Code."
          : `Failed to start GitHub Copilot health check: ${
              error instanceof Error ? error.message : String(error)
            }.`,
      };
    }

    if (Option.isNone(startProbe.success)) {
      return {
        provider: COPILOT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "GitHub Copilot health check timed out while starting the client.",
      };
    }

    const authProbe = yield* Effect.tryPromise({
      try: () => client.getAuthStatus(),
      catch: (cause) =>
        toCopilotHealthProbeError(
          "auth",
          `Could not verify GitHub Copilot authentication status: ${toError(cause).message}.`,
          cause,
        ),
    }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: COPILOT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: `Could not verify GitHub Copilot authentication status: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: COPILOT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Could not verify GitHub Copilot authentication status. Timed out while querying Copilot.",
      };
    }

    const parsed = parseCopilotAuthStatus(authProbe.success.value);
    const availableModels =
      parsed.authStatus === "authenticated" && typeof client.listModels === "function"
        ? yield* Effect.tryPromise({
            try: () => client.listModels!(),
            catch: (cause) =>
              toCopilotHealthProbeError(
                "models",
                `Could not list GitHub Copilot models: ${toError(cause).message}.`,
                cause,
              ),
          }).pipe(
            Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
            Effect.result,
            Effect.map((modelsProbe) =>
              Result.isSuccess(modelsProbe) && Option.isSome(modelsProbe.success)
                ? normalizeCopilotAvailableModels(modelsProbe.success.value)
                : undefined,
            ),
          )
        : undefined;
    return {
      provider: COPILOT_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
      ...(availableModels ? { availableModels } : {}),
    } satisfies ServerProviderStatus;
  });

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const runCodexCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("codex", [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

// ── Health check ────────────────────────────────────────────────────

export const checkCodexProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  // Probe 1: `codex --version` — is the CLI reachable?
  const versionProbe = yield* runCodexCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error)
        ? "Codex CLI (`codex`) is not installed or not on PATH."
        : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  if (Option.isNone(versionProbe.success)) {
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Codex CLI is installed but failed to run. Timed out while running command.",
    };
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Codex CLI is installed but failed to run. ${detail}`
        : "Codex CLI is installed but failed to run.",
    };
  }

  const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: formatCodexCliUpgradeMessage(parsedVersion),
    };
  }

  // Probe 2: `codex login status` — is the user authenticated?
  const authProbe = yield* runCodexCommand(["login", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return {
      provider: CODEX_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message:
        error instanceof Error
          ? `Could not verify Codex authentication status: ${error.message}.`
          : "Could not verify Codex authentication status.",
    };
  }

  if (Option.isNone(authProbe.success)) {
    return {
      provider: CODEX_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Could not verify Codex authentication status. Timed out while running command.",
    };
  }

  const parsed = parseAuthStatusFromOutput(authProbe.success.value);
  return {
    provider: CODEX_PROVIDER,
    status: parsed.status,
    available: true,
    authStatus: parsed.authStatus,
    checkedAt,
    ...(parsed.message ? { message: parsed.message } : {}),
  } satisfies ServerProviderStatus;
});

export const checkCopilotProviderStatus = (options?: {
  readonly clientFactory?: () => CopilotHealthClient | Promise<CopilotHealthClient>;
}): Effect.Effect<ServerProviderStatus> =>
  Effect.tryPromise({
    try: () => Promise.resolve((options?.clientFactory ?? makeCopilotHealthClient)()),
    catch: (cause) =>
      toCopilotHealthProbeError(
        "init",
        `Failed to initialize GitHub Copilot health check: ${toError(cause).message}.`,
        cause,
      ),
  }).pipe(
    Effect.flatMap((client) =>
      Effect.acquireUseRelease(
        Effect.succeed(client),
        (readyClient) => probeCopilotHealthClient(readyClient, new Date().toISOString()),
        stopCopilotHealthClient,
      ),
    ),
    Effect.catchTag("CopilotHealthProbeError", (error) =>
      Effect.succeed({
        provider: COPILOT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt: new Date().toISOString(),
        message: `Failed to initialize GitHub Copilot health check: ${error.message}.`,
      } satisfies ServerProviderStatus),
    ),
  );

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const codexStatus = yield* checkCodexProviderStatus;
    const copilotStatus = yield* checkCopilotProviderStatus();
    return {
      getStatuses: Effect.succeed([codexStatus, copilotStatus]),
    } satisfies ProviderHealthShape;
  }),
);
