import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { ensureP05StateDir, p05StatePath } from "../state.js";

type StoredIdentity = {
  deviceId: string;
  createdAt: string;
};

const stateDir = ensureP05StateDir();
const identityPath = p05StatePath("device.json");
const startedAt = new Date().toISOString();

function loadOrCreateStoredIdentity(): StoredIdentity {
  fs.mkdirSync(stateDir, { recursive: true });

  if (fs.existsSync(identityPath)) {
    const parsed = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Partial<StoredIdentity>;
    if (!parsed.deviceId || !parsed.createdAt) {
      throw new Error(`Invalid device identity file: ${identityPath}`);
    }
    return {
      deviceId: parsed.deviceId,
      createdAt: parsed.createdAt
    };
  }

  const identity: StoredIdentity = {
    deviceId: `p05-${randomUUID()}`,
    createdAt: new Date().toISOString()
  };

  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2) + "\n", "utf8");
  return identity;
}

const stored = loadOrCreateStoredIdentity();

export function getDeviceInfo() {
  return {
    deviceId: stored.deviceId,
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    agentVersion: config.version,
    status: "online",
    identityCreatedAt: stored.createdAt,
    startedAt
  };
}

export function getPingInfo() {
  return {
    ok: true,
    deviceId: stored.deviceId,
    hostname: os.hostname(),
    status: "online",
    timestamp: new Date().toISOString()
  };
}