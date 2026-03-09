import type { CodexReasoningEffort, ProviderModelOptions } from "@t3tools/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  switch (value) {
    case "xhigh":
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return undefined;
  }
}

export function normalizeProviderModelOptions(value: unknown): ProviderModelOptions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const codexSource = isRecord(value.codex) ? value.codex : undefined;
  const copilotSource = isRecord(value.copilot) ? value.copilot : undefined;
  const codexReasoningEffort = codexSource
    ? toReasoningEffort(codexSource.reasoningEffort)
    : undefined;
  const copilotReasoningEffort = copilotSource
    ? toReasoningEffort(copilotSource.reasoningEffort)
    : undefined;

  const codex = codexSource
    ? (() => {
        const next: {
          reasoningEffort?: CodexReasoningEffort;
          fastMode?: true;
        } = {};
        if (codexReasoningEffort) {
          next.reasoningEffort = codexReasoningEffort;
        }
        if (codexSource.fastMode === true) {
          next.fastMode = true;
        }
        return next;
      })()
    : undefined;

  const copilot = copilotSource
    ? (() => {
        const next: {
          reasoningEffort?: CodexReasoningEffort;
        } = {};
        if (copilotReasoningEffort) {
          next.reasoningEffort = copilotReasoningEffort;
        }
        return next;
      })()
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

export function readPersistedProviderModelOptions(
  runtimePayload: unknown,
): ProviderModelOptions | undefined {
  if (!isRecord(runtimePayload)) {
    return undefined;
  }
  return normalizeProviderModelOptions(runtimePayload.modelOptions);
}

export function providerModelOptionsEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(normalizeProviderModelOptions(left) ?? null) ===
    JSON.stringify(normalizeProviderModelOptions(right) ?? null)
  );
}
