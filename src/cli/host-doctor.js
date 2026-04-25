import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { runHostDoctor } from "../hosts/host-doctor.js";
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

    throw new Error(`Unknown host-doctor arg: ${arg}`);
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
  const results = await runHostDoctor({
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
    const failedCheck = Array.isArray(result.snapshot.checks)
      ? result.snapshot.checks.find((check) => check.ok === false)
      : null;
    const detail = failedCheck?.detail ? ` - ${failedCheck.detail}` : "";
    console.log(
      `${result.snapshot.host_id}: ${result.snapshot.status} (${result.snapshot.failure_reason || "ok"})${detail}`,
    );
  }
}

main().catch((error) => {
  console.error(`host doctor failed: ${error.message}`);
  process.exitCode = 1;
});
