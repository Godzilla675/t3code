import {
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type CodexReasoningEffort,
  type ModelOption,
  type ModelSlug,
  type ProviderKind,
} from "@t3tools/contracts";

const MODEL_SLUG_SET_BY_PROVIDER: Record<ProviderKind, ReadonlySet<ModelSlug>> = {
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  copilot: new Set(MODEL_OPTIONS_BY_PROVIDER.copilot.map((option) => option.slug)),
};

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = aliases[trimmed];
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<CodexReasoningEffort> {
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getReasoningEffortOptionsForModel(
  provider: ProviderKind,
  model: Pick<ModelOption, "supportedReasoningEfforts"> | null | undefined,
): ReadonlyArray<CodexReasoningEffort> {
  const supportedReasoningEfforts = model?.supportedReasoningEfforts;
  if (supportedReasoningEfforts && supportedReasoningEfforts.length > 0) {
    return supportedReasoningEfforts;
  }
  return getReasoningEffortOptions(provider);
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): CodexReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): CodexReasoningEffort | null {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export function getDefaultReasoningEffortForModel(
  provider: ProviderKind,
  model: Pick<ModelOption, "supportedReasoningEfforts" | "defaultReasoningEffort"> | null | undefined,
): CodexReasoningEffort | null {
  if ((model?.supportedReasoningEfforts?.length ?? 0) > 0) {
    return model?.defaultReasoningEffort ?? model?.supportedReasoningEfforts?.[0] ?? null;
  }
  return getDefaultReasoningEffort(provider);
}

export { CODEX_REASONING_EFFORT_OPTIONS };
