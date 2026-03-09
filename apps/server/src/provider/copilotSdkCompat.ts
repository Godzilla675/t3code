import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CopilotSdkModule = typeof import("@github/copilot-sdk");

const require = createRequire(import.meta.url);
const BUN_COMPAT_MARKER = ".ready";
const BUN_COMPAT_CACHE_DIR_MODE = 0o700;

let copilotSdkPromise: Promise<CopilotSdkModule> | undefined;

function resolveBunCompatCacheRoot(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  const baseCacheDir =
    xdgCacheHome && path.isAbsolute(xdgCacheHome)
      ? xdgCacheHome
      : path.join(os.homedir(), ".cache");
  return path.join(baseCacheDir, "t3code", "copilot-sdk-compat");
}

async function readCopilotSdkVersion(packageRoot: string): Promise<string> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJsonSource = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(packageJsonSource) as { version?: unknown };
  const version =
    typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : "unknown";
  return version;
}

async function ensureBunCompatibleSdkDist(packageRoot: string): Promise<string> {
  const packageVersion = await readCopilotSdkVersion(packageRoot);
  const compatCacheRoot = resolveBunCompatCacheRoot();
  const compatRootPath = path.join(compatCacheRoot, packageVersion);
  const compatDistPath = path.join(compatRootPath, "dist");
  const readyMarkerPath = path.join(compatRootPath, BUN_COMPAT_MARKER);

  try {
    await stat(readyMarkerPath);
    return compatDistPath;
  } catch {
    // Build the compat copy below.
  }

  const sourceDistPath = path.join(packageRoot, "dist");
  await mkdir(compatCacheRoot, { recursive: true, mode: BUN_COMPAT_CACHE_DIR_MODE });
  await mkdir(compatRootPath, { recursive: true, mode: BUN_COMPAT_CACHE_DIR_MODE });
  await cp(sourceDistPath, compatDistPath, { recursive: true, force: true });

  const sessionModulePath = path.join(compatDistPath, "session.js");
  const sessionModuleSource = await readFile(sessionModulePath, "utf8");
  const patchedSessionModuleSource = sessionModuleSource.replaceAll(
    '"vscode-jsonrpc/node"',
    '"vscode-jsonrpc/node.js"',
  );

  if (patchedSessionModuleSource !== sessionModuleSource) {
    await writeFile(sessionModulePath, patchedSessionModuleSource);
  }

  await writeFile(readyMarkerPath, "");
  return compatDistPath;
}

async function importCopilotSdk(): Promise<CopilotSdkModule> {
  if (process.versions.bun === undefined) {
    return import("@github/copilot-sdk");
  }

  const packageEntryPath = require.resolve("@github/copilot-sdk");
  const packageRoot = path.dirname(path.dirname(packageEntryPath));
  const compatDistPath = await ensureBunCompatibleSdkDist(packageRoot);
  const compatEntryUrl = pathToFileURL(path.join(compatDistPath, "index.js")).href;
  return (await import(compatEntryUrl)) as CopilotSdkModule;
}

export async function loadCopilotSdk(): Promise<CopilotSdkModule> {
  copilotSdkPromise ??= importCopilotSdk();
  return copilotSdkPromise;
}
