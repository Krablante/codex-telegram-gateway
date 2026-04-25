import process from "node:process";
import path from "node:path";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { runHostBootstrapRuntime } from "../hosts/host-bootstrap-runtime.js";
import { HostRegistryService } from "../hosts/host-registry-service.js";
import { ensureStateLayout } from "../state/layout.js";

function parseArgs(argv) {
  let hostId = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--host") {
      hostId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    throw new Error(`Unknown host-bootstrap-runtime arg: ${arg}`);
  }

  return {
    hostId,
    json,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const registryService = new HostRegistryService({
    registryPath: config.hostRegistryPath,
    currentHostId: config.currentHostId,
  });
  const result = await runHostBootstrapRuntime({
    connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
    currentHostId: config.currentHostId,
    hostsRoot: layout.hosts,
    registryService,
    sourceBinPath: path.isAbsolute(config.codexBinPath)
      ? config.codexBinPath
      : null,
    sourceCodexRoot: path.dirname(config.codexConfigPath),
    targetHostId: args.hostId,
    sourceWorkspaceRoot: config.workspaceRoot,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${result.host_id}: ${result.status}`);
  console.log(`node: ${result.probe.node_version || "missing"}`);
  console.log(`codex: ${result.probe.codex_path || "missing"}`);
}

main().catch((error) => {
  console.error(`host runtime bootstrap failed: ${error.message}`);
  process.exitCode = 1;
});
