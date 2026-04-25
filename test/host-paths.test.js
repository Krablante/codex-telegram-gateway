import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveBindingRelativeCwd,
  resolveExecutionCwd,
  translateWorkspacePathForHost,
} from "../src/hosts/host-paths.js";

test("resolveBindingRelativeCwd prefers stored relative path", () => {
  assert.equal(
    resolveBindingRelativeCwd({
      cwd_relative_to_workspace_root: "projects/gateway",
      cwd: "/srv/codex-workspace/other",
      workspace_root: "/srv/codex-workspace",
    }),
    "projects/gateway",
  );
});

test("resolveBindingRelativeCwd derives relative cwd from workspace root", () => {
  assert.equal(
    resolveBindingRelativeCwd({
      cwd: "/srv/codex-workspace/projects/gateway",
      workspace_root: "/srv/codex-workspace",
    }),
    "projects/gateway",
  );
});

test("resolveExecutionCwd translates remote cwd from host workspace root", () => {
  assert.equal(
    resolveExecutionCwd({
      workspaceBinding: {
        cwd: "/srv/codex-workspace",
        workspace_root: "/srv/codex-workspace",
        cwd_relative_to_workspace_root: ".",
      },
      host: {
        host_id: "worker-a",
        workspace_root: "~/workspace",
      },
      currentHostId: "controller",
    }),
    "~/workspace",
  );
});

test("translateWorkspacePathForHost keeps local paths unchanged", () => {
  assert.equal(
    translateWorkspacePathForHost(
      "/srv/codex-workspace/projects/gateway",
      {
        workspaceBinding: {
          workspace_root: "/srv/codex-workspace",
        },
        host: {
          host_id: "controller",
          workspace_root: "~/workspace",
        },
        currentHostId: "controller",
      },
    ),
    "/srv/codex-workspace/projects/gateway",
  );
});

test("translateWorkspacePathForHost returns null when path escapes workspace root", () => {
  assert.equal(
    translateWorkspacePathForHost(
      "/tmp/outside.txt",
      {
        workspaceBinding: {
          workspace_root: "/srv/codex-workspace",
        },
        host: {
          host_id: "worker-a",
          workspace_root: "~/workspace",
        },
        currentHostId: "controller",
      },
    ),
    null,
  );
});
