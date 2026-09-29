# V2 Branch Baseline Handoff — 2026-09-29

Status: verified implementation baseline  
Source branch: `feature/shell-approval-gate`  
Long-lived development branch after handoff: `V2`

## Purpose

This document records the exact implementation baseline that is committed on
`feature/shell-approval-gate` and then copied to the long-lived `V2` branch.
Subsequent V2 development should branch from and return to `V2` unless an explicit
release/integration decision says otherwise.

## Baseline behavior

### Workspace authority

- The active Workspace is the authorized engineering boundary.
- Structured reads and structured Workspace-local writes are ALLOW.
- `fs_write`, `apply_patch`, `git_add`, `git_commit` and `git_branch` do not require redundant confirmation when their existing structured guards keep the effect inside the active Workspace.
- Static Workspace-local Shell file operations may ALLOW only after path/link checks prove the target stays inside the active Workspace.
- Structured cross-Workspace access is denied.
- External persistent mutations remain confirmation-gated.

### MATLAB / downstream

- Known read-only MATLAB/Simulink subtools are ALLOW.
- Workspace-scoped structured `model_edit` is ALLOW because the plugin's Workspace boundary remains authoritative.
- Arbitrary MATLAB code, behavioral execution and unclassified downstream behavior remain CONFIRM.
- Generic downstream `mcp_call_tool` remains CONFIRM.

### Audit / Operator

- Persistent Audit includes an optional bounded sanitized `inputSummary`.
- Raw argument payloads and file contents are not persisted by this field.
- Known secret forms are redacted; SSH `-i` identity-file arguments are rendered as `<redacted>`.
- Operator approval IDs use higher-visibility styling for manual confirmation.

### Remote reads

`remote_read(target, operation)` is a typed read-only capability for fixed H1/J1
maintenance queries.

Caller-controlled fields are intentionally limited to:
- target: `h1 | j1`;
- operation: a fixed enum.

Host, user, key path and remote command text are local configuration, not caller input.

### Behavior-aware SSH policy

SSH transport is not itself classified as mutation.

Static SSH may ALLOW only when:
- SSH options are in the non-mutating allowlist;
- there is a concrete remote command;
- the entire remote command is provably read-only;
- nested H1 -> J1 execution also satisfies the same rule.

Verified/read-classified examples include:
- `hostname`, `uptime`, `whoami`, `date`;
- read-only `ip` network queries;
- read-only `systemctl` status/query operations;
- `passwd -S`;
- `lsblk`, `df`, `findmnt`, `free`, `ps`, `ss`, `stat`;
- read-only `nvidia-smi`;
- selected read-only `kubectl` / `k3s kubectl` operations;
- `dpkg` / `dpkg-query` status/list/search;
- `grep` constrained to `/etc/apt` for APT configuration diagnosis.

Still CONFIRM:
- bare interactive SSH;
- port forwarding;
- host-key trust mutation such as `StrictHostKeyChecking=accept-new`;
- dynamic or compound remote syntax;
- unknown remote commands;
- remote file/system mutations such as `touch`, package installation, service restart or firewall changes.

Catastrophic local destructive patterns remain DENY.

## Live acceptance evidence

Runtime A live checks on 2026-09-29 verified direct execution without approval for:
- H1 `hostname`;
- H1 -> J1 `hostname`;
- J1 `sudo -n passwd -S vaesadmin`;
- J1 `ip route` and interface status queries;
- J1 `systemctl is-active ...`;
- J1 `dpkg -s nftables`;
- J1 APT-config search under `/etc/apt`.

A remote `touch` probe remained in CONFIRM and was not approved.
A structured write targeting another Workspace was denied.

## Independent upstream safety boundary

P05 Local Operator approval is not the only possible execution gate.

An upstream client/platform safety layer can independently refuse a high-risk arbitrary
Shell action even after P05 approval. This was observed for a nested SSH +
`sudo apt-get install` workflow: P05 approval did not create a Runtime `execute`
event because the retry was blocked before reaching Runtime A.

V2 must not attempt to bypass that layer. Repeated maintenance mutations should move
toward typed maintenance capabilities with fixed targets, fixed operations and explicit
effect metadata.

## Key implementation files

- `src/policy/permission.ts` — common ALLOW / CONFIRM / DENY decisions.
- `src/shell/policy.ts` — local Shell and behavior-aware SSH classification.
- `src/monitor/live-activity.ts` — bounded/sanitized input summaries.
- `src/audit/types.ts`, `src/runtime/execution.ts` — persistent audit summary field.
- `src/tools/remote-read.ts` — typed H1/J1 fixed read operations.
- `src/tools/register-execution.ts` — execution-tool exposure.
- `src/tools/register-control.ts` — audit output contract.
- `src/capability/registry.ts` — canonical capability metadata.
- `src/operator/ui.ts` — approval presentation.
- `src/test/foundation.ts`, `src/test/policy-profiles.ts`,
  `src/test/profile-exposure.ts`, `src/test/operator-console.ts` — regression coverage.

## Configuration additions

`.env.example` documents optional local-only remote-read configuration:
- `P05_REMOTE_READ_SSH_PATH`;
- `P05_REMOTE_READ_H1_HOST`;
- `P05_REMOTE_READ_H1_USER`;
- `P05_REMOTE_READ_H1_IDENTITY`;
- `P05_REMOTE_READ_J1_HOST`;
- `P05_REMOTE_READ_J1_USER`;
- `P05_REMOTE_READ_J1_IDENTITY_ON_H1`.

No machine-specific values or private key material belong in Git.

## Validation gate

Before this handoff, the complete repository `command_run(action=verify)` gate passed
after the permission, audit, Workspace-write and SSH-classifier changes.

The final commit should be followed by:
1. one final full verify;
2. push of `feature/shell-approval-gate`;
3. creation of `V2` from the exact verified commit;
4. push of `V2`;
5. continued V2 work on `V2`.

## V3 documents in this baseline

The repository also includes the V3 technical solution and its GitHub research snapshot:
- `docs/architecture/P05_V3_TECHNICAL_SOLUTION.md`;
- `docs/research/P05_V3_GITHUB_REFERENCE_SNAPSHOT.json`.

They are design/research inputs and do not mean the V3 target architecture is fully implemented.
