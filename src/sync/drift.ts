import { collectGoldenState, goldenStateComparable } from "./collector.js";
import { canonicalJson } from "./canonical.js";
import type { GoldenState, GoldenStateDrift } from "./types.js";

function diffValues(
  desired: unknown,
  local: unknown,
  prefix = ""
): GoldenStateDrift["changes"] {
  if (canonicalJson(desired) === canonicalJson(local)) return [];

  if (
    desired &&
    local &&
    typeof desired === "object" &&
    typeof local === "object" &&
    !Array.isArray(desired) &&
    !Array.isArray(local)
  ) {
    const d = desired as Record<string, unknown>;
    const l = local as Record<string, unknown>;
    const keys = new Set([...Object.keys(d), ...Object.keys(l)]);
    return [...keys].sort().flatMap((key) =>
      diffValues(d[key], l[key], prefix ? `${prefix}.${key}` : key)
    );
  }

  return [{
    path: prefix || "$",
    ...(desired !== undefined ? { desired } : {}),
    ...(local !== undefined ? { local } : {})
  }];
}

export function checkGoldenStateDrift(
  desired: GoldenState,
  local = collectGoldenState()
): GoldenStateDrift {
  const changes = diffValues(
    goldenStateComparable(desired),
    goldenStateComparable(local)
  );

  return {
    status: changes.length === 0 ? "in_sync" : "drift",
    desiredRevision: desired.revision,
    localRevision: local.revision,
    changes
  };
}
