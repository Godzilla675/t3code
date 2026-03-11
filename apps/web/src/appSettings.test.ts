import { describe, expect, it } from "vitest";

import {
  EMPTY_RUNTIME_MODEL_OPTIONS_BY_PROVIDER,
  getProviderStartOptions,
  getAppModelOptions,
  getRuntimeModelOptionsByProvider,
  getSlashModelOptions,
  inferProviderForAppModel,
  normalizeCustomModelSlugs,
  resolveAppModelSelection,
} from "./appSettings";

describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });

  it("filters built-in Copilot models from custom entries", () => {
    expect(normalizeCustomModelSlugs([" gpt-4.1 ", "custom/copilot-model"], "copilot")).toEqual([
      "custom/copilot-model",
    ]);
  });
});

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      isCustom: true,
    });
  });

  it("returns Copilot built-ins before custom Copilot models", () => {
    const options = getAppModelOptions("copilot", ["custom/copilot-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "claude-sonnet-4.6",
      "claude-sonnet-4.5",
      "claude-haiku-4.5",
      "claude-opus-4.6",
      "claude-opus-4.6-fast",
      "claude-opus-4.5",
      "claude-sonnet-4",
      "gemini-3-pro-preview",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.2",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex",
      "gpt-5.1",
      "gpt-5.1-codex-mini",
      "gpt-5-mini",
      "gpt-4.1",
      "custom/copilot-model",
    ]);
  });

  it("prefers runtime Copilot models over the static built-in fallback", () => {
    const options = getAppModelOptions(
      "copilot",
      ["custom/copilot-model"],
      undefined,
      [
        {
          slug: "claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
          supportsVision: true,
          supportedReasoningEfforts: ["medium", "low"],
          defaultReasoningEffort: "medium",
        },
        { slug: "gpt-5.4", name: "GPT-5.4", supportsVision: false },
      ],
    );

    expect(options.map((option) => option.slug)).toEqual([
      "claude-sonnet-4.6",
      "gpt-5.4",
      "custom/copilot-model",
    ]);
    expect(options[0]).toMatchObject({
      supportsVision: true,
      supportedReasoningEfforts: ["medium", "low"],
      defaultReasoningEffort: "medium",
    });
    expect(options[1]).toMatchObject({
      supportsVision: false,
    });
  });
});

describe("getRuntimeModelOptionsByProvider", () => {
  it("uses live provider statuses when runtime model metadata is present", () => {
    expect(
      getRuntimeModelOptionsByProvider([
        {
          provider: "copilot",
          availableModels: [
            {
              slug: "claude-sonnet-4.6",
              name: "Claude Sonnet 4.6",
              supportedReasoningEfforts: ["medium", "low"],
              defaultReasoningEffort: "medium",
            },
          ],
        },
      ]),
    ).toEqual({
      codex: [],
      copilot: [
        {
          slug: "claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
          supportedReasoningEfforts: ["medium", "low"],
          defaultReasoningEffort: "medium",
        },
      ],
    });
  });

  it("falls back to cached runtime model metadata when the current provider status omits models", () => {
    expect(
      getRuntimeModelOptionsByProvider([], {
        ...EMPTY_RUNTIME_MODEL_OPTIONS_BY_PROVIDER,
        copilot: [
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            supportedReasoningEfforts: ["high", "medium", "low"],
            defaultReasoningEffort: "medium",
          },
        ],
      }),
    ).toEqual({
      codex: [],
      copilot: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          supportedReasoningEfforts: ["high", "medium", "low"],
          defaultReasoningEffort: "medium",
        },
      ],
    });
  });

  it("merges cached Copilot reasoning metadata into degraded live model entries", () => {
    expect(
      getRuntimeModelOptionsByProvider(
        [
          {
            provider: "copilot",
            availableModels: [{ slug: "gpt-5.4", name: "GPT-5.4", supportsVision: false }],
          },
        ],
        {
          ...EMPTY_RUNTIME_MODEL_OPTIONS_BY_PROVIDER,
          copilot: [
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              supportsVision: false,
              supportedReasoningEfforts: ["high", "medium", "low"],
              defaultReasoningEffort: "medium",
            },
          ],
        },
      ),
    ).toEqual({
      codex: [],
      copilot: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          supportsVision: false,
          supportedReasoningEfforts: ["high", "medium", "low"],
          defaultReasoningEffort: "medium",
        },
      ],
    });
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(resolveAppModelSelection("codex", ["galapagos-alpha"], "galapagos-alpha")).toBe(
      "galapagos-alpha",
    );
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", [], "")).toBe("gpt-5.4");
    expect(resolveAppModelSelection("copilot", [], "")).toBe("claude-sonnet-4.6");
  });

  it("falls back to the first runtime Copilot model when one is available", () => {
    expect(
      resolveAppModelSelection(
        "copilot",
        [],
        "",
        [
          { slug: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { slug: "gpt-5.4", name: "GPT-5.4" },
        ],
      ),
    ).toBe("claude-sonnet-4.6");
  });
});

describe("inferProviderForAppModel", () => {
  it("recognizes built-in provider models", () => {
    expect(
      inferProviderForAppModel(
        { customCodexModels: [], customCopilotModels: [] },
        "claude-sonnet-4.6",
      ),
    ).toBe("copilot");
    expect(
      inferProviderForAppModel(
        { customCodexModels: [], customCopilotModels: [] },
        "gpt-5.3-codex-spark",
      ),
    ).toBe("codex");
  });

  it("recognizes saved custom Copilot models", () => {
    expect(
      inferProviderForAppModel(
        { customCodexModels: [], customCopilotModels: ["custom/copilot-model"] },
        "custom/copilot-model",
      ),
    ).toBe("copilot");
  });
});

describe("getProviderStartOptions", () => {
  it("maps Codex runtime overrides into provider start options", () => {
    expect(
      getProviderStartOptions(
        {
          codexBinaryPath: " /usr/local/bin/codex ",
          codexHomePath: " /tmp/codex-home ",
          copilotCliUrl: "",
          copilotConfigDir: "",
        },
        "codex",
      ),
    ).toEqual({
      codex: {
        binaryPath: "/usr/local/bin/codex",
        homePath: "/tmp/codex-home",
      },
    });
  });

  it("maps Copilot runtime overrides into provider start options", () => {
    expect(
      getProviderStartOptions(
        {
          codexBinaryPath: "",
          codexHomePath: "",
          copilotCliUrl: " http://127.0.0.1:8123 ",
          copilotConfigDir: " /tmp/copilot-config ",
        },
        "copilot",
      ),
    ).toEqual({
      copilot: {
        cliUrl: "http://127.0.0.1:8123",
        configDir: "/tmp/copilot-config",
      },
    });
  });
});

describe("getSlashModelOptions", () => {
  it("includes saved custom model slugs for /model command suggestions", () => {
    const options = getSlashModelOptions(
      "codex",
      ["custom/internal-model"],
      "",
      "gpt-5.3-codex",
    );

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions(
      "codex",
      ["openai/gpt-oss-120b"],
      "oss",
      "gpt-5.3-codex",
    );

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });
});
