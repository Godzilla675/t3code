import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CopilotSdkModule = typeof import("@github/copilot-sdk");

const BUN_COMPAT_MARKER = ".ready";
const BUN_COMPAT_CACHE_DIR_MODE = 0o700;
const BUN_COMPAT_CACHE_VERSION = "2";

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
    const readyMarker = await readFile(readyMarkerPath, "utf8");
    if (readyMarker.trim() === BUN_COMPAT_CACHE_VERSION) {
      return compatDistPath;
    }
  } catch {
    // Build the compat copy below.
  }

  const sourceDistPath = path.join(packageRoot, "dist");
  const copilotCliSdkEntryUrl = pathToFileURL(
    path.join(path.dirname(packageRoot), "copilot", "sdk", "index.js"),
  ).href;
  await mkdir(compatCacheRoot, { recursive: true, mode: BUN_COMPAT_CACHE_DIR_MODE });
  await mkdir(compatRootPath, { recursive: true, mode: BUN_COMPAT_CACHE_DIR_MODE });
  await cp(sourceDistPath, compatDistPath, { recursive: true, force: true });

  const clientModulePath = path.join(compatDistPath, "client.js");
  const clientModuleSource = await readFile(clientModulePath, "utf8");
  const patchedClientModuleSource = clientModuleSource.replace(
    'import.meta.resolve("@github/copilot/sdk")',
    JSON.stringify(copilotCliSdkEntryUrl),
  );

  if (patchedClientModuleSource !== clientModuleSource) {
    await writeFile(clientModulePath, patchedClientModuleSource);
  }

  const sessionModulePath = path.join(compatDistPath, "session.js");
  const sessionModuleSource = await readFile(sessionModulePath, "utf8");
  const patchedSessionModuleSource = sessionModuleSource.replaceAll(
    '"vscode-jsonrpc/node"',
    '"vscode-jsonrpc/node.js"',
  );

  if (patchedSessionModuleSource !== sessionModuleSource) {
    await writeFile(sessionModulePath, patchedSessionModuleSource);
  }

  await writeFile(readyMarkerPath, `${BUN_COMPAT_CACHE_VERSION}\n`);
  return compatDistPath;
}

function resolveCopilotSdkPackageRoot(): string {
  const packageEntryUrl = import.meta.resolve("@github/copilot-sdk");
  const packageEntryPath = fileURLToPath(packageEntryUrl);
  return path.dirname(path.dirname(packageEntryPath));
}

async function importCopilotSdk(): Promise<CopilotSdkModule> {
  const packageRoot = resolveCopilotSdkPackageRoot();
  const compatDistPath = await ensureBunCompatibleSdkDist(packageRoot);
  const compatEntryUrl = pathToFileURL(path.join(compatDistPath, "index.js")).href;
  return (await import(compatEntryUrl)) as CopilotSdkModule;
}

export async function loadCopilotSdk(): Promise<CopilotSdkModule> {
  copilotSdkPromise ??= importCopilotSdk();
  return copilotSdkPromise;
}
