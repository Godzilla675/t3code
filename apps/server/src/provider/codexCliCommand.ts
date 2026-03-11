import { statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

export interface CodexCliLaunchSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
  readonly extraEnv?: NodeJS.ProcessEnv;
}

interface CodexCliLaunchInput {
  readonly args: ReadonlyArray<string>;
  readonly binaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolvePathEnvironmentKey(env: NodeJS.ProcessEnv): "PATH" | "Path" | "path" {
  if ("PATH" in env) return "PATH";
  if ("Path" in env) return "Path";
  return "path";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) {
    return fallback;
  }

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveCommandCandidates(
  command: string,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (
    extension.length > 0 &&
    (windowsPathExtensions.includes(normalizedExtension) || normalizedExtension === ".PS1")
  ) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates = [command, `${command}.ps1`, `${command}.PS1`];
  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function resolveFirstWindowsCommandPath(binaryPath: string, env: NodeJS.ProcessEnv): string | undefined {
  const normalizedBinaryPath = stripWrappingQuotes(binaryPath.trim());
  const windowsPathExtensions = resolveWindowsPathExtensions(env);

  if (
    isAbsolute(normalizedBinaryPath) ||
    normalizedBinaryPath.includes("\\") ||
    normalizedBinaryPath.includes("/")
  ) {
    if (isFile(normalizedBinaryPath)) {
      return normalizedBinaryPath;
    }

    const parentDir = dirname(normalizedBinaryPath);
    const commandName = basename(normalizedBinaryPath);
    for (const candidate of resolveCommandCandidates(commandName, windowsPathExtensions)) {
      const candidatePath = join(parentDir, candidate);
      if (isFile(candidatePath)) {
        return candidatePath;
      }
    }
    return undefined;
  }

  const commandCandidates = resolveCommandCandidates(normalizedBinaryPath, windowsPathExtensions);
  const pathEntries = resolvePathEnvironmentVariable(env)
    .split(";")
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      const candidatePath = join(pathEntry, candidate);
      if (isFile(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

function resolveCodexManagedByEnvVar(
  env: NodeJS.ProcessEnv,
  codexPackageRoot: string,
): "CODEX_MANAGED_BY_BUN" | "CODEX_MANAGED_BY_NPM" {
  const userAgent = env.npm_config_user_agent ?? "";
  if (/\bbun\//i.test(userAgent)) {
    return "CODEX_MANAGED_BY_BUN";
  }

  const execPath = env.npm_execpath ?? "";
  if (execPath.toLowerCase().includes("bun")) {
    return "CODEX_MANAGED_BY_BUN";
  }

  const lowerPackageRoot = codexPackageRoot.toLowerCase();
  if (
    lowerPackageRoot.includes(".bun\\install\\global") ||
    lowerPackageRoot.includes(".bun/install/global")
  ) {
    return "CODEX_MANAGED_BY_BUN";
  }

  return "CODEX_MANAGED_BY_NPM";
}

function resolveWindowsCodexPlatformPackage(arch: NodeJS.Architecture): {
  readonly targetTriple: string;
  readonly packageName: string;
} | null {
  switch (arch) {
    case "x64":
      return {
        targetTriple: "x86_64-pc-windows-msvc",
        packageName: "codex-win32-x64",
      };
    case "arm64":
      return {
        targetTriple: "aarch64-pc-windows-msvc",
        packageName: "codex-win32-arm64",
      };
    default:
      return null;
  }
}

function resolveWindowsNativeCodexLaunchSpecFromVendor(
  vendorRoot: string,
  targetTriple: string,
  env: NodeJS.ProcessEnv,
  args: ReadonlyArray<string>,
): CodexCliLaunchSpec | undefined {
  const bundledCodexExePath = join(vendorRoot, targetTriple, "codex", "codex.exe");
  if (!isFile(bundledCodexExePath)) {
    return undefined;
  }

  const extraEnv: NodeJS.ProcessEnv = {};
  const pathDir = join(vendorRoot, targetTriple, "path");
  const pathDirRgPath = join(pathDir, "rg.exe");
  if (isFile(pathDirRgPath)) {
    extraEnv[resolvePathEnvironmentKey(env)] = `${pathDir};${resolvePathEnvironmentVariable(env)}`;
  }

  return {
    command: bundledCodexExePath,
    args,
    shell: false,
    ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
  };
}

function resolveWindowsCodexPackageRoot(commandPath: string): string | undefined {
  const wrapperDir = dirname(commandPath);
  const packageRoot = join(wrapperDir, "node_modules", "@openai", "codex");
  return isFile(join(packageRoot, "bin", "codex.js")) ? packageRoot : undefined;
}

function resolveWindowsCodexNativeLaunchSpec(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  arch: NodeJS.Architecture,
  args: ReadonlyArray<string>,
): CodexCliLaunchSpec | undefined {
  const resolvedCommandPath = resolveFirstWindowsCommandPath(binaryPath, env);
  if (!resolvedCommandPath) {
    return undefined;
  }

  const lowerCommandPath = resolvedCommandPath.toLowerCase();
  const platformPackage = resolveWindowsCodexPlatformPackage(arch);
  if (!platformPackage) {
    return undefined;
  }

  if (lowerCommandPath.endsWith("\\codex.exe")) {
    const codexDir = dirname(resolvedCommandPath);
    const targetTripleDir = dirname(codexDir);
    const vendorRoot = dirname(targetTripleDir);
    const targetTriple = lowerCommandPath.includes(`\\${platformPackage.targetTriple.toLowerCase()}\\codex\\codex.exe`)
      ? platformPackage.targetTriple
      : basename(targetTripleDir);
    return resolveWindowsNativeCodexLaunchSpecFromVendor(vendorRoot, targetTriple, env, args);
  }

  const codexPackageRoot = resolveWindowsCodexPackageRoot(resolvedCommandPath);
  if (!codexPackageRoot) {
    return undefined;
  }

  const managedByEnvVar = resolveCodexManagedByEnvVar(env, codexPackageRoot);
  const vendorRoots = [
    join(codexPackageRoot, "node_modules", "@openai", platformPackage.packageName, "vendor"),
    join(dirname(dirname(codexPackageRoot)), platformPackage.packageName, "vendor"),
  ];

  for (const vendorRoot of vendorRoots) {
    const launch = resolveWindowsNativeCodexLaunchSpecFromVendor(
      vendorRoot,
      platformPackage.targetTriple,
      env,
      args,
    );
    if (launch) {
      return {
        ...launch,
        extraEnv: {
          ...(launch.extraEnv ?? {}),
          [managedByEnvVar]: "1",
        },
      };
    }
  }

  const bundledCodexJsPath = join(codexPackageRoot, "bin", "codex.js");
  const wrapperDir = dirname(resolvedCommandPath);
  const bundledNodePath = join(wrapperDir, "node.exe");
  return {
    command: isFile(bundledNodePath) ? bundledNodePath : "node",
    args: [bundledCodexJsPath, ...args],
    shell: false,
  };
}

export function getCodexCliLaunchSpec(input: CodexCliLaunchInput): CodexCliLaunchSpec {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const arch = input.arch ?? process.arch;
  const binaryPath = input.binaryPath?.trim() || "codex";

  if (platform !== "win32") {
    return {
      command: binaryPath,
      args: input.args,
      shell: false,
    };
  }

  const nativeLaunch = resolveWindowsCodexNativeLaunchSpec(binaryPath, env, arch, input.args);
  if (nativeLaunch) {
    return nativeLaunch;
  }

  return {
    command: binaryPath,
    args: input.args,
    shell: true,
  };
}
