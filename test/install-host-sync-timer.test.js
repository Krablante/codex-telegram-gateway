import test from "node:test";
import assert from "node:assert/strict";

import { buildHostSyncServiceUnit } from "../src/cli/install-host-sync-timer.js";

test("buildHostSyncServiceUnit renders a private oneshot user service", () => {
  const unit = buildHostSyncServiceUnit({
    repoRoot: "/repo with spaces",
    envFilePath: "/config/runtime.env",
    nodePath: "/opt/node/bin/node",
    pathEntries: ["/opt/node/bin", "/usr/bin"],
  });

  assert.match(unit, /Description=Codex Telegram Gateway Host Sync/u);
  assert.match(unit, /Type=oneshot/u);
  assert.match(unit, /UMask=0077/u);
  assert.match(unit, /WorkingDirectory=\/repo\\ with\\ spaces/u);
  assert.match(unit, /Environment="ENV_FILE=\/config\/runtime\.env"/u);
  assert.match(unit, /Environment="PATH=\/opt\/node\/bin:\/usr\/bin"/u);
  assert.match(
    unit,
    /ExecStart="\/opt\/node\/bin\/node" "\/repo with spaces\/src\/cli\/host-sync\.js"/u,
  );
});
