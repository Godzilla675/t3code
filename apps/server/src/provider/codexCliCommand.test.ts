import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import { getCodexCliLaunchSpec } from "./codexCliCommand";

describe("getCodexCliLaunchSpec", () => {
  function withTempDir(run: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-codex-cli-"));
    try {
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function writeBundledCodexJs(dir: string): string {
    const scriptPath = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, 'console.log("codex");\n', "utf8");
    return scriptPath;
  }

  function writeBundledNativeCodexExe(dir: string): {
    readonly nativeExePath: string;
    readonly pathDir: string;
  } {
    const nativeExePath = path.join(
      dir,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    const pathDir = path.join(
      dir,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "path",
    );
    fs.mkdirSync(path.dirname(nativeExePath), { recursive: true });
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(nativeExePath, "", "utf8");
    fs.writeFileSync(path.join(pathDir, "rg.exe"), "", "utf8");
    return { nativeExePath, pathDir };
  }

  it("prefers the bundled native codex.exe for bare codex commands on win32", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "codex.ps1"), "Write-Output 'codex'\n", "utf8");
      writeBundledCodexJs(dir);
      const { nativeExePath, pathDir } = writeBundledNativeCodexExe(dir);

      const launch = getCodexCliLaunchSpec({
        platform: "win32",
        env: { PATH: dir },
        args: ["--version"],
      });

      assert.equal(launch.command, nativeExePath);
      assert.deepEqual(launch.args, ["--version"]);
      assert.equal(launch.shell, false);
      assert.equal(launch.extraEnv?.CODEX_MANAGED_BY_NPM, "1");
      assert.equal(launch.extraEnv?.PATH, `${pathDir};${dir}`);
    });
  });

  it("prefers the bundled native codex.exe next to an explicit cmd path on win32", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "codex.cmd"), "@echo off\r\n", "utf8");
      writeBundledCodexJs(dir);
      const { nativeExePath, pathDir } = writeBundledNativeCodexExe(dir);

      const launch = getCodexCliLaunchSpec({
        platform: "win32",
        env: { PATH: dir },
        args: ["app-server"],
        binaryPath: path.join(dir, "codex.cmd"),
      });

      assert.equal(launch.command, nativeExePath);
      assert.deepEqual(launch.args, ["app-server"]);
      assert.equal(launch.shell, false);
      assert.equal(launch.extraEnv?.CODEX_MANAGED_BY_NPM, "1");
      const pathEnvValue = launch.extraEnv?.PATH ?? launch.extraEnv?.Path ?? launch.extraEnv?.path;
      assert.ok(typeof pathEnvValue === "string" && pathEnvValue.startsWith(`${pathDir};`));
    });
  });

  it("falls back to the configured binary when no bundled codex js exists on win32", () => {
    withTempDir((firstDir) => {
      withTempDir((secondDir) => {
        fs.writeFileSync(path.join(firstDir, "codex.cmd"), "@echo off\r\n", "utf8");
        fs.writeFileSync(path.join(secondDir, "codex.ps1"), "Write-Output 'real'\n", "utf8");

        const launch = getCodexCliLaunchSpec({
          platform: "win32",
          env: { PATH: `${firstDir};${secondDir}`, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
          args: ["--version"],
          binaryPath: "codex",
        });

        assert.equal(launch.command, "C:\\Windows\\System32\\cmd.exe");
        assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
        assert.equal(launch.args[3]?.toLowerCase(), path.join(firstDir, "codex.cmd").toLowerCase());
        assert.deepEqual(launch.args.slice(4), ["--version"]);
        assert.equal(launch.shell, false);
      });
    });
  });

  it("runs discovered cmd wrappers without shell mode on win32", () => {
    withTempDir((dir) => {
      const cmdPath = path.join(dir, "codex.cmd");
      fs.writeFileSync(cmdPath, "@echo off\r\n", "utf8");

      const launch = getCodexCliLaunchSpec({
        platform: "win32",
        env: { PATH: dir, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        args: ["exec", "--help"],
        binaryPath: "codex",
      });

      assert.equal(launch.command, "C:\\Windows\\System32\\cmd.exe");
      assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.equal(launch.args[3]?.toLowerCase(), cmdPath.toLowerCase());
      assert.deepEqual(launch.args.slice(4), ["exec", "--help"]);
      assert.equal(launch.shell, false);
    });
  });

  it("runs discovered powershell wrappers without shell mode on win32", () => {
    withTempDir((dir) => {
      const scriptPath = path.join(dir, "codex.ps1");
      fs.writeFileSync(scriptPath, "Write-Output 'codex'\n", "utf8");

      const launch = getCodexCliLaunchSpec({
        platform: "win32",
        env: { PATH: dir },
        args: ["--version"],
        binaryPath: "codex",
      });

      assert.ok(launch.command.toLowerCase().endsWith("powershell.exe"));
      assert.deepEqual(launch.args, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "--version",
      ]);
      assert.equal(launch.shell, false);
    });
  });

  it("runs direct codex.exe paths without shell mode on win32", () => {
    withTempDir((dir) => {
      const spacedDir = path.join(dir, "with space");
      fs.mkdirSync(spacedDir, { recursive: true });
      const exePath = path.join(spacedDir, "codex.exe");
      fs.writeFileSync(exePath, "", "utf8");

      const launch = getCodexCliLaunchSpec({
        platform: "win32",
        env: { PATH: "" },
        args: ["app-server"],
        binaryPath: exePath,
      });

      assert.equal(launch.command, exePath);
      assert.deepEqual(launch.args, ["app-server"]);
      assert.equal(launch.shell, false);
    });
  });
});
