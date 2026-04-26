import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  auditSystemdUserGateway,
  extractExecStartAbsolutePaths,
} from "../src/runtime/systemd-user-doctor.js";
import {
  MIN_SYSTEMD_EXIT_TYPE_CGROUP_VERSION,
  SYSTEMD_USER_SERVICE_NAME,
  buildServicePathEntries,
  buildUnsupportedSystemdUserMessage,
  buildUserServiceUnit,
  getUserServiceUnitPath,
  isSystemdUserSupported,
  parseSystemdVersion,
  supportsExitTypeCgroup,
} from "../src/runtime/systemd-user-service.js";

async function writeExecutable(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

test("buildUserServiceUnit renders a direct node user systemd wrapper", () => {
  const unit = buildUserServiceUnit({
    repoRoot: "/repo",
    envFilePath: "/state/runtime.env",
    nodePath: "/nvm/bin/node",
    codexBinPath: "/nvm/bin/codex",
    codexConfigPath: "/home/operator/.codex/config.toml",
    pathEntries: ["/nvm/bin", "/usr/bin", "/bin"],
    exitType: "cgroup",
  });

  assert.match(unit, /Description=Codex Telegram Gateway/u);
  assert.match(unit, /ExitType=cgroup/u);
  assert.match(unit, /UMask=0077/u);
  assert.match(unit, /WorkingDirectory=\/repo/u);
  assert.match(unit, /Environment="ENV_FILE=\/state\/runtime\.env"/u);
  assert.match(unit, /Environment="NODE=\/nvm\/bin\/node"/u);
  assert.match(unit, /Environment="CODEX_BIN_PATH=\/nvm\/bin\/codex"/u);
  assert.match(
    unit,
    /Environment="CODEX_CONFIG_PATH=\/home\/operator\/\.codex\/config\.toml"/u,
  );
  assert.match(unit, /Environment="PATH=\/nvm\/bin:\/usr\/bin:\/bin"/u);
  assert.match(unit, /ExecStart="\/nvm\/bin\/node" "\/repo\/src\/cli\/run\.js"/u);
  assert.match(unit, /Restart=always/u);
  assert.match(unit, /KillMode=control-group/u);
  assert.match(unit, /TimeoutStopSec=infinity/u);
  assert.match(unit, /WantedBy=default\.target/u);
});

test("buildUserServiceUnit quotes paths with spaces for WorkingDirectory and ExecStart", () => {
  const unit = buildUserServiceUnit({
    repoRoot: "/repo with spaces",
    envFilePath: "/state/runtime.env",
    nodePath: "/opt/node versions/node",
    codexBinPath: "/opt/node versions/codex",
    codexConfigPath: "/home/operator/.codex/config.toml",
    pathEntries: ["/opt/node versions", "/usr/bin"],
  });

  assert.match(unit, /WorkingDirectory=\/repo\\ with\\ spaces/u);
  assert.match(
    unit,
    /ExecStart="\/opt\/node versions\/node" "\/repo with spaces\/src\/cli\/run\.js"/u,
  );
});

test("buildServicePathEntries preserves the current PATH ahead of Linux defaults", () => {
  assert.deepEqual(
    buildServicePathEntries({
      nodePath: "/opt/node/bin/node",
      currentPath: "/home/operator/.local/bin:/home/operator/bin:/usr/bin",
    }),
    [
      "/opt/node/bin",
      "/home/operator/.local/bin",
      "/home/operator/bin",
      "/usr/bin",
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/sbin",
      "/bin",
    ],
  );
});

test("parseSystemdVersion reads the standard systemctl --version banner", () => {
  assert.equal(
    parseSystemdVersion("systemd 255 (255.4-1ubuntu8.6)\n+PAM -AUDIT\n"),
    255,
  );
  assert.equal(parseSystemdVersion("unexpected"), null);
});

test("supportsExitTypeCgroup gates the Spike service to modern systemd builds", () => {
  assert.equal(
    supportsExitTypeCgroup(MIN_SYSTEMD_EXIT_TYPE_CGROUP_VERSION - 1),
    false,
  );
  assert.equal(
    supportsExitTypeCgroup(MIN_SYSTEMD_EXIT_TYPE_CGROUP_VERSION),
    true,
  );
});

test("getUserServiceUnitPath targets the standard user-unit directory", () => {
  assert.equal(
    getUserServiceUnitPath("/home/operator"),
    path.posix.join(
      "/home/operator",
      ".config",
      "systemd",
      "user",
      "codex-telegram-gateway.service",
    ),
  );
  assert.equal(SYSTEMD_USER_SERVICE_NAME, "codex-telegram-gateway.service");
});

test("isSystemdUserSupported is false outside Linux", () => {
  assert.equal(isSystemdUserSupported("linux"), true);
  assert.equal(isSystemdUserSupported("win32"), false);
  assert.equal(isSystemdUserSupported("darwin"), false);
});

test("buildUnsupportedSystemdUserMessage points Windows users at the wrapper scripts", () => {
  assert.match(
    buildUnsupportedSystemdUserMessage(),
    /scripts\\windows\\install\.cmd/u,
  );
  assert.match(
    buildUnsupportedSystemdUserMessage(),
    /scripts\\windows\\install-codex\.cmd/u,
  );
  assert.match(
    buildUnsupportedSystemdUserMessage(),
    /scripts\\windows\\doctor\.cmd/u,
  );
  assert.match(
    buildUnsupportedSystemdUserMessage(),
    /scripts\\windows\\run\.cmd/u,
  );
});

test("extractExecStartAbsolutePaths reads quoted systemd command paths", () => {
  assert.deepEqual(
    extractExecStartAbsolutePaths('[Service]\nExecStart="/opt/node versions/node" "/repo path/src/cli/run.js"\n'),
    ["/opt/node versions/node", "/repo path/src/cli/run.js"],
  );
});

test("auditSystemdUserGateway reports obsolete and stale user units", async () => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-systemd-doctor-"),
  );
  const repoRoot = path.join(home, "repo");
  const stateRoot = path.join(home, "state");
  const nodePath = path.join(home, "bin", "node");
  const codexPath = path.join(home, "bin", "codex");
  const unitDir = path.join(home, ".config", "systemd", "user");

  await writeExecutable(nodePath);
  await writeExecutable(codexPath);
  await fs.mkdir(path.join(repoRoot, "src", "cli"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "cli", "run.js"), "\n", "utf8");

  const freshUnit = buildUserServiceUnit({
    repoRoot,
    envFilePath: path.join(stateRoot, "runtime.env"),
    nodePath,
    codexBinPath: codexPath,
    codexConfigPath: path.join(home, ".codex", "config.toml"),
    pathEntries: [path.dirname(nodePath), "/usr/bin"],
    description: "Codex Telegram Gateway",
    scriptPath: "src/cli/run.js",
    exitType: "cgroup",
  });
  await fs.mkdir(unitDir, { recursive: true });
  await fs.writeFile(
    path.join(unitDir, SYSTEMD_USER_SERVICE_NAME),
    freshUnit.replace("UMask=0077\n", ""),
    "utf8",
  );
  await fs.writeFile(
    path.join(unitDir, "codex-telegram-gateway-omni.service"),
    buildUserServiceUnit({
      repoRoot,
      envFilePath: path.join(stateRoot, "runtime.env"),
      nodePath,
      codexBinPath: codexPath,
      codexConfigPath: path.join(home, ".codex", "config.toml"),
      pathEntries: [path.dirname(nodePath), "/usr/bin"],
      description: "Codex Telegram Gateway Retired",
      scriptPath: "src/cli/run-omni.js",
    }),
    "utf8",
  );

  const report = await auditSystemdUserGateway({
    config: {
      repoRoot,
      envFilePath: path.join(stateRoot, "runtime.env"),
      codexBinPath: codexPath,
      codexConfigPath: path.join(home, ".codex", "config.toml"),
    },
    homeDirectory: home,
    nodePath,
    platform: "linux",
  });

  assert.equal(report.main_unit.installed, true);
  assert.equal(report.main_unit.fresh, false);
  assert.deepEqual(report.main_unit.mismatches, ["Service.UMask"]);
  assert.deepEqual(
    report.stale_units.map((unit) => unit.name).sort(),
    [
      "codex-telegram-gateway-omni.service",
      "codex-telegram-gateway.service",
    ],
  );
  assert.equal(
    report.stale_units.some((unit) =>
      unit.reasons.some((reason) => reason.startsWith("missing-exec-target:"))),
    true,
  );
});
