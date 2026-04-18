import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

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

test("buildUserServiceUnit renders a direct node user systemd wrapper", () => {
  const unit = buildUserServiceUnit({
    repoRoot: "/repo",
    envFilePath: "/state/runtime.env",
    nodePath: "/nvm/bin/node",
    codexBinPath: "/nvm/bin/codex",
    codexConfigPath: "/home/bloob/.codex/config.toml",
    pathEntries: ["/nvm/bin", "/usr/bin", "/bin"],
    exitType: "cgroup",
  });

  assert.match(unit, /Description=Codex Telegram Gateway/u);
  assert.match(unit, /ExitType=cgroup/u);
  assert.match(unit, /WorkingDirectory=\/repo/u);
  assert.match(unit, /Environment="ENV_FILE=\/state\/runtime\.env"/u);
  assert.match(unit, /Environment="NODE=\/nvm\/bin\/node"/u);
  assert.match(unit, /Environment="CODEX_BIN_PATH=\/nvm\/bin\/codex"/u);
  assert.match(
    unit,
    /Environment="CODEX_CONFIG_PATH=\/home\/bloob\/\.codex\/config\.toml"/u,
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
    codexConfigPath: "/home/bloob/.codex/config.toml",
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
      currentPath: "/home/bloob/.local/bin:/home/bloob/bin:/usr/bin",
    }),
    [
      "/opt/node/bin",
      "/home/bloob/.local/bin",
      "/home/bloob/bin",
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
    getUserServiceUnitPath("/home/bloob"),
    path.posix.join(
      "/home/bloob",
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
  assert.match(
    buildUnsupportedSystemdUserMessage({ omniVariant: true }),
    /scripts\\windows\\run-omni\.cmd/u,
  );
});
