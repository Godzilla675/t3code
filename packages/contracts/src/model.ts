import { Schema } from "effect";
import { ProviderKind } from "./orchestration";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
const ReasoningEffortSchema = Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS);

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(ReasoningEffortSchema),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const CopilotModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(ReasoningEffortSchema),
});
export type CopilotModelOptions = typeof CopilotModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  copilot: Schema.optional(CopilotModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const ModelOption = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  supportsVision: Schema.optional(Schema.Boolean),
  supportedReasoningEfforts: Schema.optional(Schema.Array(ReasoningEffortSchema)),
  defaultReasoningEffort: Schema.optional(ReasoningEffortSchema),
});
export type ModelOption = typeof ModelOption.Type;

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      supportedReasoningEfforts: CODEX_REASONING_EFFORT_OPTIONS,
      defaultReasoningEffort: "high",
    },
    {
      slug: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      supportedReasoningEfforts: CODEX_REASONING_EFFORT_OPTIONS,
      defaultReasoningEffort: "high",
    },
    {
      slug: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      supportedReasoningEfforts: CODEX_REASONING_EFFORT_OPTIONS,
      defaultReasoningEffort: "high",
    },
    {
      slug: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      supportedReasoningEfforts: CODEX_REASONING_EFFORT_OPTIONS,
      defaultReasoningEffort: "high",
    },
    {
      slug: "gpt-5.2",
      name: "GPT-5.2",
      supportedReasoningEfforts: CODEX_REASONING_EFFORT_OPTIONS,
      defaultReasoningEffort: "high",
    },
  ],
  copilot: [{ slug: "gpt-5", name: "GPT-5" }],
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = ModelOptionsByProvider[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
  copilot: "gpt-5",
} as const satisfies Record<ProviderKind, ModelSlug>;

export const MODEL_SLUG_ALIASES_BY_PROVIDER = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  copilot: {},
} as const satisfies Record<ProviderKind, Record<string, ModelSlug>>;

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  copilot: [] as const,
} as const satisfies Record<ProviderKind, readonly CodexReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  copilot: null,
} as const satisfies Record<ProviderKind, CodexReasoningEffort | null>;
