import { useCallback, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import {
  type CodexReasoningEffort,
  type ModelOption,
  type ProviderKind,
  type ProviderServiceTier,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const APP_SERVICE_TIER_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    description: "Use Codex defaults without forcing a service tier.",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Request the fast service tier when the model supports it.",
  },
  {
    value: "flex",
    label: "Flex",
    description: "Request the flex service tier when the model supports it.",
  },
] as const;
export type AppServiceTier = (typeof APP_SERVICE_TIER_OPTIONS)[number]["value"];
const AppServiceTierSchema = Schema.Literals(["auto", "fast", "flex"]);
const MODELS_WITH_FAST_SUPPORT = new Set(["gpt-5.4"]);
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  copilot: new Set(getModelOptions("copilot").map((option) => option.slug)),
};

const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  copilotCliUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  copilotConfigDir: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  codexServiceTier: AppServiceTierSchema.pipe(Schema.withConstructorDefault(() => Option.some("auto"))),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customCopilotModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export type AppProviderModelSettings = Pick<AppSettings, "customCodexModels" | "customCopilotModels">;
export type AppProviderRuntimeSettings = Pick<
  AppSettings,
  "codexBinaryPath" | "codexHomePath" | "copilotCliUrl" | "copilotConfigDir"
>;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
  supportsVision?: boolean;
  supportedReasoningEfforts?: ReadonlyArray<CodexReasoningEffort>;
  defaultReasoningEffort?: CodexReasoningEffort;
}

type RuntimeModelOption = Omit<ModelOption, never>;

function normalizeOptionalProviderSetting(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveAppServiceTier(serviceTier: AppServiceTier): ProviderServiceTier | null {
  return serviceTier === "auto" ? null : serviceTier;
}

export function shouldShowFastTierIcon(
  model: string | null | undefined,
  serviceTier: AppServiceTier,
): boolean {
  const normalizedModel = normalizeModelSlug(model);
  return (
    resolveAppServiceTier(serviceTier) === "fast" &&
    normalizedModel !== null &&
    MODELS_WITH_FAST_SUPPORT.has(normalizedModel)
  );
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customCopilotModels: normalizeCustomModelSlugs(settings.customCopilotModels, "copilot"),
  };
}

export function getCustomModelsForProvider(
  settings: AppProviderModelSettings,
  provider: ProviderKind,
): readonly string[] {
  switch (provider) {
    case "copilot":
      return settings.customCopilotModels;
    case "codex":
    default:
      return settings.customCodexModels;
  }
}

export function patchCustomModelsForProvider(
  provider: ProviderKind,
  models: string[],
): Partial<AppSettings> {
  switch (provider) {
    case "copilot":
      return { customCopilotModels: models };
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

export function getProviderStartOptions(
  settings: AppProviderRuntimeSettings,
  provider: ProviderKind,
): ProviderStartOptions {
  switch (provider) {
    case "copilot": {
      const cliUrl = normalizeOptionalProviderSetting(settings.copilotCliUrl);
      const configDir = normalizeOptionalProviderSetting(settings.copilotConfigDir);
      return {
        copilot: {
          ...(cliUrl ? { cliUrl } : {}),
          ...(configDir ? { configDir } : {}),
        },
      };
    }
    case "codex":
    default: {
      const binaryPath = normalizeOptionalProviderSetting(settings.codexBinaryPath);
      const homePath = normalizeOptionalProviderSetting(settings.codexHomePath);
      return {
        codex: {
          ...(binaryPath ? { binaryPath } : {}),
          ...(homePath ? { homePath } : {}),
        },
      };
    }
  }
}

export function inferProviderForAppModel(
  settings: AppProviderModelSettings,
  model: string | null | undefined,
): ProviderKind {
  const normalizedCopilot = normalizeModelSlug(model, "copilot");
  if (
    normalizedCopilot &&
    (BUILT_IN_MODEL_SLUGS_BY_PROVIDER.copilot.has(normalizedCopilot) ||
      getCustomModelsForProvider(settings, "copilot").includes(normalizedCopilot))
  ) {
    return "copilot";
  }

  const normalizedCodex = normalizeModelSlug(model, "codex");
  if (
    normalizedCodex &&
    (BUILT_IN_MODEL_SLUGS_BY_PROVIDER.codex.has(normalizedCodex) ||
      getCustomModelsForProvider(settings, "codex").includes(normalizedCodex))
  ) {
    return "codex";
  }

  return "codex";
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
  runtimeModels: readonly RuntimeModelOption[] = [],
): AppModelOption[] {
  const baseModels: readonly RuntimeModelOption[] =
    runtimeModels.length > 0 ? runtimeModels : getModelOptions(provider);
  const options: AppModelOption[] = baseModels.map(
    ({ slug, name, supportsVision, supportedReasoningEfforts, defaultReasoningEffort }) => {
      const option: AppModelOption = {
        slug,
        name,
        isCustom: false,
      };
      if (supportsVision !== undefined) {
        option.supportsVision = supportsVision;
      }
      if (supportedReasoningEfforts) {
        option.supportedReasoningEfforts = supportedReasoningEfforts;
      }
      if (defaultReasoningEffort) {
        option.defaultReasoningEffort = defaultReasoningEffort;
      }
      return option;
    },
  );
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
  runtimeModels: readonly RuntimeModelOption[] = [],
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel, runtimeModels);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return options[0]?.slug ?? getDefaultModel(provider);
  }

  return options.find((option) => option.slug === normalizedSelectedModel)?.slug ?? options[0]?.slug ?? getDefaultModel(provider);
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
  runtimeModels: readonly RuntimeModelOption[] = [],
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel, runtimeModels);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_APP_SETTINGS;
    }
    return normalizeAppSettings(
      Schema.decodeSync(AppSettingsSchema)({
        ...DEFAULT_APP_SETTINGS,
        ...parsed,
      }),
    );
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeAppSettings(
      Schema.decodeSync(AppSettingsSchema)({
        ...getAppSettingsSnapshot(),
        ...patch,
      }),
    );
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
