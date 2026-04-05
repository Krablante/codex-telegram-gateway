import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSpawnCommand } from "../src/runtime/spawn-command.js";

async function writeWindowsCommandShim(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "@echo off\r\necho ok\r\n", "utf8");
}

test("buildSpawnCommand keeps direct spawning on non-Windows platforms", () => {
  const launch = buildSpawnCommand("codex", ["app-server"], {
    platform: "linux",
  });

  assert.equal(launch.command, "codex");
  assert.deepEqual(launch.args, ["app-server"]);
  assert.deepEqual(launch.spawnOptions, {});
});

test("buildSpawnCommand routes Windows .cmd shims through cmd.exe", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-spawn-command-win-"),
  );
  const binDir = path.join(tempRoot, "npm");
  const commandPath = path.join(binDir, "codex.cmd");
  const commandShellPath = "C:\\Windows\\System32\\cmd.exe";

  await writeWindowsCommandShim(commandPath);

  try {
    const launch = buildSpawnCommand(
      commandPath,
      ["app-server", "--listen", "ws://127.0.0.1:0"],
      {
        cwd: tempRoot,
        env: {
          PATH: binDir,
          PATHEXT: ".EXE;.CMD",
          ComSpec: commandShellPath,
        },
        platform: "win32",
      },
    );

    assert.equal(
      path.win32.normalize(launch.command),
      path.win32.normalize(commandShellPath),
    );
    assert.deepEqual(launch.args, [
      "/d",
      "/s",
      "/c",
      `${commandPath} app-server --listen ws://127.0.0.1:0`,
    ]);
    assert.equal(launch.spawnOptions.shell, undefined);
    assert.equal(launch.spawnOptions.windowsHide, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildSpawnCommand resolves Windows .cmd shims from a mixed-case Path entry", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-spawn-command-path-case-"),
  );
  const binDir = path.join(tempRoot, "npm");
  const commandPath = path.join(binDir, "codex.cmd");
  const commandShellPath = "C:\\Windows\\System32\\cmd.exe";

  await writeWindowsCommandShim(commandPath);

  try {
    const launch = buildSpawnCommand("codex", ["exec"], {
      cwd: tempRoot,
      env: {
        Path: binDir,
        PATHEXT: ".cmd",
        ComSpec: commandShellPath,
      },
      platform: "win32",
    });

    assert.equal(
      path.win32.normalize(launch.command),
      path.win32.normalize(commandShellPath),
    );
    assert.deepEqual(launch.args, [
      "/d",
      "/s",
      "/c",
      `${path.win32.normalize(commandPath)} exec`,
    ]);
    assert.equal(launch.spawnOptions.shell, undefined);
    assert.equal(launch.spawnOptions.windowsHide, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildSpawnCommand quotes Windows shim paths that contain spaces", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-spawn-command-spaces-"),
  );
  const binDir = path.join(tempRoot, "npm bins");
  const commandPath = path.join(binDir, "codex.cmd");
  const commandShellPath = "C:\\Windows\\System32\\cmd.exe";

  await writeWindowsCommandShim(commandPath);

  try {
    const launch = buildSpawnCommand(commandPath, ["exec"], {
      cwd: tempRoot,
      env: {
        PATH: binDir,
        PATHEXT: ".CMD",
        ComSpec: commandShellPath,
      },
      platform: "win32",
    });

    assert.equal(launch.command, commandShellPath);
    assert.deepEqual(launch.args, ["/d", "/s", "/c", `"${commandPath}" exec`]);
    assert.equal(launch.spawnOptions.shell, undefined);
    assert.equal(launch.spawnOptions.windowsHide, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildSpawnCommand quotes Windows shell args that contain spaces", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-spawn-command-args-"),
  );
  const binDir = path.join(tempRoot, "npm");
  const commandPath = path.join(binDir, "codex.cmd");
  const commandShellPath = "C:\\Windows\\System32\\cmd.exe";

  await writeWindowsCommandShim(commandPath);

  try {
    const launch = buildSpawnCommand(commandPath, [
      "-C",
      "O:/Users/Example User/Source Repos/gateway",
      "--flag",
      "plain",
    ], {
      cwd: tempRoot,
      env: {
        PATH: binDir,
        PATHEXT: ".CMD",
        ComSpec: commandShellPath,
      },
      platform: "win32",
    });

    assert.deepEqual(launch.args, [
      "/d",
      "/s",
      "/c",
      `${commandPath} -C "O:/Users/Example User/Source Repos/gateway" --flag plain`,
    ]);
    assert.equal(launch.spawnOptions.shell, undefined);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
