import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildExecutableCandidatePaths,
  getExecutableSearchPathValue,
  resolveExecutablePath,
} from "../src/runtime/executable-path.js";

const HOST_EXECUTABLE_TEST_PLATFORM = process.platform === "win32"
  ? "win32"
  : "linux";

function getHostExecutableFileName(baseName = "codex") {
  return HOST_EXECUTABLE_TEST_PLATFORM === "win32"
    ? `${baseName}.cmd`
    : baseName;
}

function getHostExecutableEnv() {
  return HOST_EXECUTABLE_TEST_PLATFORM === "win32"
    ? { PATHEXT: ".cmd" }
    : undefined;
}

async function makeExecutable(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(filePath, 0o755);
}

test("buildExecutableCandidatePaths prefers explicitly provided directories before PATH", () => {
  const candidates = buildExecutableCandidatePaths("codex", {
    cwd: "/repo",
    platform: "linux",
    preferredDirectories: ["/nvm/bin"],
    pathValue: "/usr/local/bin:/usr/bin:/bin",
  });

  assert.deepEqual(candidates, [
    "/nvm/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    "/bin/codex",
  ]);
});

test("buildExecutableCandidatePaths resolves relative executable paths from cwd", () => {
  const candidates = buildExecutableCandidatePaths("./vendor/bin/codex", {
    cwd: "/repo",
    platform: "linux",
  });

  assert.deepEqual(candidates, ["/repo/vendor/bin/codex"]);
});

test("buildExecutableCandidatePaths expands PATHEXT variants on win32", () => {
  const candidates = buildExecutableCandidatePaths("codex", {
    cwd: "C:\\workspace",
    platform: "win32",
    preferredDirectories: ["C:\\Users\\bloob\\AppData\\Roaming\\npm"],
    pathValue: "C:\\Windows\\System32",
    env: {
      PATHEXT: ".EXE;.CMD",
    },
  });

  assert.deepEqual(candidates, [
    "C:\\Users\\bloob\\AppData\\Roaming\\npm\\codex",
    "C:\\Users\\bloob\\AppData\\Roaming\\npm\\codex.EXE",
    "C:\\Users\\bloob\\AppData\\Roaming\\npm\\codex.CMD",
    "C:\\Windows\\System32\\codex",
    "C:\\Windows\\System32\\codex.EXE",
    "C:\\Windows\\System32\\codex.CMD",
  ]);
});

test("getExecutableSearchPathValue treats Windows Path keys case-insensitively", () => {
  assert.equal(
    getExecutableSearchPathValue(
      {
        Path: "C:\\Users\\bloob\\AppData\\Roaming\\npm",
      },
      "win32",
    ),
    "C:\\Users\\bloob\\AppData\\Roaming\\npm",
  );
});

test("resolveExecutablePath prefers the node-adjacent directory before PATH", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-executable-path-"),
  );
  const preferredDir = path.join(tempRoot, "preferred");
  const pathDir = path.join(tempRoot, "path");
  const executableFileName = getHostExecutableFileName();
  const preferredExecutable = path.join(preferredDir, executableFileName);
  const pathExecutable = path.join(pathDir, executableFileName);

  await makeExecutable(preferredExecutable);
  await makeExecutable(pathExecutable);

  try {
    const resolved = await resolveExecutablePath("codex", {
      platform: HOST_EXECUTABLE_TEST_PLATFORM,
      preferredDirectories: [preferredDir],
      pathValue: pathDir,
      env: getHostExecutableEnv(),
    });

    assert.equal(resolved, preferredExecutable);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveExecutablePath accepts repo-relative executable paths without a shell", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-executable-relative-"),
  );
  const executablePath = path.join(
    tempRoot,
    "vendor",
    "bin",
    getHostExecutableFileName(),
  );

  await makeExecutable(executablePath);

  try {
    const resolved = await resolveExecutablePath("./vendor/bin/codex", {
      cwd: tempRoot,
      platform: HOST_EXECUTABLE_TEST_PLATFORM,
      pathValue: "",
      env: getHostExecutableEnv(),
    });

    assert.equal(resolved, executablePath);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveExecutablePath fails clearly when the executable cannot be found", async () => {
  await assert.rejects(
    () =>
      resolveExecutablePath("missing-codex", {
        platform: "linux",
        preferredDirectories: [],
        pathValue: "",
      }),
    /Unable to resolve executable: missing-codex/u,
  );
});
