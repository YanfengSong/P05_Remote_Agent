import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { componentHostConfigSchema, type ComponentHostConfig } from "./contracts.js";
import { verifyConfigurationProtection, verifyStateProtection } from "../protection.js";

function recursivePaths(value: string): string[] {
  const resolved = path.resolve(value);
  return [resolved, path.join(resolved, "*")];
}

export function componentHostPermissionPreflightDigest(configFile: string, bytes: Buffer): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    configFile: path.resolve(configFile),
    configDigest: createHash("sha256").update(bytes).digest("hex")
  })).digest("hex");
}

export function componentHostPermissionExecArgv(input: {
  configFile: string;
  runtimeRoot: string;
  config: ComponentHostConfig;
}): string[] {
  const read = new Set<string>();
  for (const value of [input.runtimeRoot, input.config.stateDir, input.config.installationRoot, input.config.workspaceRoot]) {
    for (const allowed of recursivePaths(value)) read.add(allowed);
  }
  read.add(path.resolve(input.configFile));
  const write = new Set<string>();
  for (const allowed of recursivePaths(input.config.stateDir)) write.add(allowed);
  if (input.config.capabilities.some(item => item.effect === "E1")) {
    for (const allowed of recursivePaths(input.config.workspaceRoot)) write.add(allowed);
  }
  return [
    "--permission",
    ...[...read].map(value => "--allow-fs-read=" + value),
    ...[...write].map(value => "--allow-fs-write=" + value)
  ];
}

export async function preparePermissionIsolatedComponentHost(input: {
  configFile: string;
  runtimeRoot: string;
}): Promise<{ execArgv: string[]; preflightDigest: string; config: ComponentHostConfig }> {
  const configFile = path.resolve(input.configFile);
  const bytes = fs.readFileSync(configFile);
  const config = componentHostConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (config.isolationMode !== "node-permission") throw new Error("COMPONENT_PERMISSION_MODE_REQUIRED");
  const checks = await Promise.all([
    verifyStateProtection(path.dirname(configFile)),
    verifyConfigurationProtection(configFile),
    verifyStateProtection(config.stateDir),
    verifyStateProtection(config.installationRoot)
  ]);
  if (checks.some(check => !check.verified)) throw new Error("COMPONENT_PERMISSION_PREFLIGHT_FAILED");
  return {
    execArgv: componentHostPermissionExecArgv({ configFile, runtimeRoot: input.runtimeRoot, config }),
    preflightDigest: componentHostPermissionPreflightDigest(configFile, bytes),
    config
  };
}