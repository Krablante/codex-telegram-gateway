import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { HostRegistryService } from "../hosts/host-registry-service.js";
import { runHostRemoteSmoke } from "../hosts/host-remote-smoke.js";
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

    throw new Error(`Unknown host-remote-smoke arg: ${arg}`);
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
  const result = await runHostRemoteSmoke({
    autoCompactTokenLimit: config.codexAutoCompactTokenLimit,
    connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
    contextWindow: config.codexContextWindow,
    currentHostId: config.currentHostId,
    hostsRoot: layout.hosts,
    model: config.codexModel,
    reasoningEffort: config.codexReasoningEffort || "low",
    registryService,
    targetHostId: args.hostId,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${result.host_id}: ${result.status}`);
  console.log(`last_message: ${result.smoke.last_message}`);
  console.log(`session_path: ${result.smoke.after_session || "missing"}`);
}

main().catch((error) => {
  console.error(`host remote smoke failed: ${error.message}`);
  process.exitCode = 1;
});
