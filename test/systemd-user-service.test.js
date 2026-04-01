import test from "node:test";
import assert from "node:assert/strict";

import {
  SYSTEMD_USER_SERVICE_NAME,
  buildUserServiceUnit,
  getUserServiceUnitPath,
} from "../src/runtime/systemd-user-service.js";

test("buildUserServiceUnit renders a direct node user systemd wrapper", () => {
  const unit = buildUserServiceUnit({
    repoRoot: "/repo",
    envFilePath: "/state/runtime.env",
    nodePath: "/nvm/bin/node",
    codexBinPath: "/nvm/bin/codex",
    pathEntries: ["/nvm/bin", "/usr/bin", "/bin"],
  });

  assert.match(unit, /Description=Codex Telegram Gateway/u);
  assert.match(unit, /WorkingDirectory=\/repo/u);
  assert.match(unit, /Environment="ENV_FILE=\/state\/runtime\.env"/u);
  assert.match(unit, /Environment="NODE=\/nvm\/bin\/node"/u);
  assert.match(unit, /Environment="CODEX_BIN_PATH=\/nvm\/bin\/codex"/u);
  assert.match(unit, /Environment="PATH=\/nvm\/bin:\/usr\/bin:\/bin"/u);
  assert.match(unit, /ExecStart=\/nvm\/bin\/node src\/cli\/run\.js/u);
  assert.match(unit, /Restart=always/u);
  assert.match(unit, /KillMode=control-group/u);
  assert.match(unit, /WantedBy=default\.target/u);
});

test("getUserServiceUnitPath targets the standard user-unit directory", () => {
  assert.equal(
    getUserServiceUnitPath("/home/bloob"),
    "/home/bloob/.config/systemd/user/codex-telegram-gateway.service",
  );
  assert.equal(SYSTEMD_USER_SERVICE_NAME, "codex-telegram-gateway.service");
});
