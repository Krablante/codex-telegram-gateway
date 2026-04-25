import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { HostRegistryService } from "../hosts/host-registry-service.js";
import { runHostSync } from "../hosts/host-sync.js";
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

    throw new Error(`Unknown host-sync arg: ${arg}`);
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
  const results = await runHostSync({
    codexSpaceRoot: layout.codexSpace,
    connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
    currentHostId: config.currentHostId,
    hostsRoot: layout.hosts,
    registryService,
    targetHostId: args.hostId,
  });

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const result of results) {
    console.log(`${result.host_id}: ${result.status} (${result.reason || "ok"})`);
  }
}

main().catch((error) => {
  console.error(`host sync failed: ${error.message}`);
  process.exitCode = 1;
});
