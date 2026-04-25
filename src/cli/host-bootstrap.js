import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import {
  buildFleetPreset,
  mergeFleetPresetHosts,
  EXAMPLE_HOME_FLEET_PRESET,
} from "../hosts/fleet-preset.js";
import { HostRegistryService } from "../hosts/host-registry-service.js";

function parseArgs(argv) {
  let preset = EXAMPLE_HOME_FLEET_PRESET;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--preset") {
      preset = argv[index + 1] || preset;
      index += 1;
      continue;
    }

    throw new Error(`Unknown host-bootstrap arg: ${arg}`);
  }

  return {
    json,
    preset,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig();
  const registryService = new HostRegistryService({
    registryPath: config.hostRegistryPath,
    currentHostId: config.currentHostId,
  });
  const existingHosts = await registryService.listHosts();
  const presetHosts = buildFleetPreset(args.preset);
  await registryService.replaceHosts(
    mergeFleetPresetHosts(presetHosts, existingHosts),
  );
  const hosts = await registryService.listHosts();

  if (args.json) {
    console.log(JSON.stringify({
      preset: args.preset,
      hosts,
    }, null, 2));
    return;
  }

  console.log(`preset: ${args.preset}`);
  console.log(`hosts: ${hosts.map((host) => host.host_id).join(", ")}`);
}

main().catch((error) => {
  console.error(`host bootstrap failed: ${error.message}`);
  process.exitCode = 1;
});
