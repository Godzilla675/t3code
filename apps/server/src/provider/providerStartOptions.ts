import type { ProviderStartOptions } from "@t3tools/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeProviderStartOptions(value: unknown): ProviderStartOptions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const codexSource = isRecord(value.codex) ? value.codex : undefined;
  const copilotSource = isRecord(value.copilot) ? value.copilot : undefined;

  const codex = codexSource
    ? {
        ...(toNonEmptyString(codexSource.binaryPath)
          ? { binaryPath: toNonEmptyString(codexSource.binaryPath) }
          : {}),
        ...(toNonEmptyString(codexSource.homePath)
          ? { homePath: toNonEmptyString(codexSource.homePath) }
          : {}),
      }
    : undefined;
  const copilot = copilotSource
    ? {
        ...(toNonEmptyString(copilotSource.cliUrl) ? { cliUrl: toNonEmptyString(copilotSource.cliUrl) } : {}),
        ...(toNonEmptyString(copilotSource.configDir)
          ? { configDir: toNonEmptyString(copilotSource.configDir) }
          : {}),
      }
    : undefined;

  const normalizedCodex = codex && Object.keys(codex).length > 0 ? codex : undefined;
  const normalizedCopilot = copilot && Object.keys(copilot).length > 0 ? copilot : undefined;

  return normalizedCodex || normalizedCopilot
    ? {
        ...(normalizedCodex ? { codex: normalizedCodex } : {}),
        ...(normalizedCopilot ? { copilot: normalizedCopilot } : {}),
      }
    : undefined;
}

export function readPersistedProviderStartOptions(
  runtimePayload: unknown,
): ProviderStartOptions | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  return normalizeProviderStartOptions(runtimePayload.providerOptions);
}

export function providerStartOptionsEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(normalizeProviderStartOptions(left) ?? null) ===
    JSON.stringify(normalizeProviderStartOptions(right) ?? null)
  );
}
