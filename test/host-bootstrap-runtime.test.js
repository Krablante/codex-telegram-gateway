import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runHostBootstrapRuntime } from "../src/hosts/host-bootstrap-runtime.js";
import { HostRegistryService } from "../src/hosts/host-registry-service.js";

function createExecFileRecorder() {
  const calls = [];
  let capturedConfigText = null;
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args });
    if (command === "npm") {
      callback(null, JSON.stringify({
        dependencies: {
          "@openai/codex": { version: "0.121.0" },
        },
      }), "");
      return;
    }
    if (command === "ssh") {
      const script = Array.isArray(args) ? args.at(-1) : "";
      if (script.includes("node_path=")) {
        callback(
          null,
          [
            "home_path=/home/worker-a",
            "node_path=/usr/bin/node",
            "node_version=v18.19.1",
            "npm_path=/usr/bin/npm",
            "npm_version=9.2.0",
            "codex_path=/usr/local/bin/codex",
            "configured_codex_present=1",
            "configured_codex_path=/home/worker-a/workspace/state/oss/forks/codex/bin/codex",
            "docker_path=/usr/bin/docker",
            "workspace_root_exists=1",
            "repo_root_exists=1",
            "runtime_root_exists=1",
            "config_present=1",
            "auth_present=1",
          ].join("\n"),
          "",
        );
        return;
      }
      callback(null, "", "");
      return;
    }
    if (command === "rsync") {
      const destination = Array.isArray(args) ? args.at(-1) : "";
      if (destination === "worker-a:~/.codex/config.toml") {
        const localPath = args.at(-2);
        capturedConfigText = fsSync.readFileSync(localPath, "utf8");
      }
      callback(null, "", "");
      return;
    }

    callback(null, "", "");
  };

  return {
    calls,
    getCapturedConfigText() {
      return capturedConfigText;
    },
    execFileImpl,
  };
}

test("runHostBootstrapRuntime mirrors the usable Codex profile subset and optional custom binary", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-host-bootstrap-runtime-"),
  );
  const hostsRoot = path.join(stateRoot, "hosts");
  const registryService = new HostRegistryService({
    registryPath: path.join(hostsRoot, "registry.json"),
    currentHostId: "controller",
  });
  await registryService.upsertHost({
    host_id: "controller",
    label: "controller",
    ssh_target: "controller",
    enabled: true,
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });
  await registryService.upsertHost({
    host_id: "worker-a",
    label: "worker-a",
    ssh_target: "worker-a",
    enabled: true,
    workspace_root: "~/workspace",
    repo_root: "~/workspace/codex-telegram-gateway",
    worker_runtime_root: "~/.local/state/codex-telegram-gateway",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });

  const localHomeRoot = path.join(stateRoot, "home", "operator");
  const sourceWorkspaceRoot = path.join(localHomeRoot, "workspace");
  const codexRoot = path.join(localHomeRoot, ".codex");
  await fs.mkdir(path.join(codexRoot, "skills", "vercel-deploy"), { recursive: true });
  await fs.mkdir(path.join(codexRoot, "sessions"), { recursive: true });
  const configPath = path.join(codexRoot, "config.toml");
  const authPath = path.join(codexRoot, "auth.json");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.4"',
      '',
      `[projects."${sourceWorkspaceRoot}"]`,
      'trust_level = "trusted"',
      '',
      '[[skills.config]]',
      `path = "${path.join(codexRoot, "skills", "vercel-deploy", "SKILL.md")}"`,
      'enabled = true',
      '',
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(authPath, '{"token":"secret"}\n', "utf8");
  await fs.writeFile(
    path.join(codexRoot, "skills", "vercel-deploy", "SKILL.md"),
    "# skill\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(codexRoot, "sessions", "skip-me.json"),
    "{}\n",
    "utf8",
  );
  const customBinPath = path.join(
    sourceWorkspaceRoot,
    "state",
    "oss",
    "forks",
    "codex",
    "bin",
    "codex",
  );
  await fs.mkdir(path.dirname(customBinPath), { recursive: true });
  await fs.writeFile(customBinPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  const recorder = createExecFileRecorder();

  const result = await runHostBootstrapRuntime({
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    execFileImpl: recorder.execFileImpl,
    hostsRoot,
    registryService,
    sourceBinPath: customBinPath,
    sourceCodexRoot: codexRoot,
    sourceAuthPath: authPath,
    sourceConfigPath: configPath,
    sourceWorkspaceRoot,
    targetHostId: "worker-a",
  });

  assert.equal(result.host_id, "worker-a");
  assert.equal(result.codex_npm_spec, "@openai/codex@0.121.0");
  assert.equal(
    result.probe.codex_path,
    "/home/worker-a/workspace/state/oss/forks/codex/bin/codex",
  );
  assert.equal(result.remote_bin_path, "~/workspace/state/oss/forks/codex/bin/codex");
  assert.match(recorder.getCapturedConfigText(), /model = "gpt-5\.4"/u);
  assert.match(recorder.getCapturedConfigText(), /\[projects\."\/home\/worker-a\/workspace"\]/u);
  assert.match(recorder.getCapturedConfigText(), /path = "\/home\/worker-a\/\.codex\/skills\/vercel-deploy\/SKILL\.md"/u);
  assert.equal(
    recorder.calls.some((call) => call.command === "npm"),
    true,
  );
  assert.equal(
    recorder.calls.filter((call) => call.command === "rsync").length,
    4,
  );
  assert.equal(
    recorder.calls.filter((call) =>
      call.command === "rsync"
      && call.args.includes("-s")
      && call.args.includes("-e")
      && call.args.includes("'ssh' '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=5'")).length,
    4,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.includes("worker-a:~/.codex/")
      && call.args.includes("--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=")
      && call.args.includes("--exclude")
      && call.args.includes("sessions/")),
    true,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.at(-1) === "worker-a:~/workspace/state/oss/forks/codex/bin/codex"),
    true,
  );
  assert.equal(
    await fs
      .access(path.join(hostsRoot, "worker-a-bootstrap-config.toml"))
      .then(() => true)
      .catch(() => false),
    false,
  );
  assert.equal(
    await fs
      .access(path.join(hostsRoot, "bootstrap-last-run.json"))
      .then(() => true)
      .catch(() => false),
    true,
  );
});

test("runHostBootstrapRuntime rejects ranged Codex npm specs without a copied binary", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-host-bootstrap-runtime-"),
  );
  const hostsRoot = path.join(stateRoot, "hosts");
  const registryService = new HostRegistryService({
    registryPath: path.join(hostsRoot, "registry.json"),
    currentHostId: "controller",
  });
  await registryService.upsertHost({
    host_id: "controller",
    label: "controller",
    ssh_target: "controller",
    enabled: true,
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });
  await registryService.upsertHost({
    host_id: "worker-a",
    label: "worker-a",
    ssh_target: "worker-a",
    enabled: true,
    workspace_root: "~/workspace",
    repo_root: "~/workspace/codex-telegram-gateway",
    worker_runtime_root: "~/.local/state/codex-telegram-gateway",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });

  const codexRoot = path.join(stateRoot, "home", "operator", ".codex");
  await fs.mkdir(codexRoot, { recursive: true });
  const configPath = path.join(codexRoot, "config.toml");
  const authPath = path.join(codexRoot, "auth.json");
  await fs.writeFile(configPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(authPath, '{"token":"secret"}\n', "utf8");

  await assert.rejects(
    () => runHostBootstrapRuntime({
      codexNpmSpec: "@openai/codex@^0.124.0",
      connectTimeoutSecs: 5,
      currentHostId: "controller",
      execFileImpl: (command, args, options, callback) => {
        callback(new Error(`unexpected command: ${command}`), "", "");
      },
      hostsRoot,
      registryService,
      sourceAuthPath: authPath,
      sourceCodexRoot: codexRoot,
      sourceConfigPath: configPath,
      targetHostId: "worker-a",
    }),
    /pinned codexNpmSpec/u,
  );
});
