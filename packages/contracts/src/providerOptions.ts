import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyStringSchema),
  homePath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type CodexProviderStartOptions = typeof CodexProviderStartOptions.Type;

export const CopilotProviderStartOptions = Schema.Struct({
  cliUrl: Schema.optional(TrimmedNonEmptyStringSchema),
  configDir: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type CopilotProviderStartOptions = typeof CopilotProviderStartOptions.Type;

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
  copilot: Schema.optional(CopilotProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;
