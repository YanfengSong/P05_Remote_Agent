# ADR-0019 — Workspace-Aware Shell Approval Gate

Status: Superseded by ADR-0020 (historical record only)

> Current V2 authority is ADR-0020 — V2 Common Tool Permission Broker.
> The AUTO / APPROVAL_REQUIRED terminology and Shell-specific approval architecture
> below describe the superseded prototype. The retained requirements are:
> fail closed, Runtime/Workspace-bound one-shot approval, short expiry, Local
> Operator ownership, human-readable purpose, and conservative Shell handling.
Date: 2026-09-23

## Context

P05 needs normal developer shell ergonomics without repeating the failure mode where
an arbitrary remote PowerShell command can persistently modify files outside the
human-authorized Active Workspace.

A blanket rule that requires approval for every shell command is safe but too
expensive for normal development. A path-only string scan is convenient but unsafe:
PowerShell can construct paths dynamically, invoke child interpreters, use .NET APIs,
pipelines, redirection or repository code that hides the eventual filesystem effect.

## Decision

Expose `shell_run` at the normal `developer` profile, but route every call through a
Workspace-aware shell gate before PowerShell starts.

The gate has two outcomes:

1. **AUTO** — execute immediately only when P05 can conservatively prove that the
   command belongs to the supported automatic command set and every relevant static
   filesystem path is inside the Active Workspace and passes the existing realpath,
   junction/symlink and protected-path checks.
2. **APPROVAL_REQUIRED** — do not execute when the command is external, dynamic,
   compound, ambiguous, launches arbitrary code, or otherwise cannot be proven safe.

The policy is fail closed: uncertainty means approval, not execution.

## One-time approval

An approval request is written only to Runtime-private P05 state.

The request binds:

- Runtime slot;
- Workspace identity and root;
- resolved cwd;
- exact command string;
- reason;
- SHA-256 fingerprint;
- expiry.

The Local Operator shows pending requests and owns the approve/deny endpoint.
Each request also shows a plain-language purpose, the policy reason, execution context and the original command. If the parser cannot explain the command confidently, the UI says that clearly instead of guessing.
The remote Runtime cannot approve its own request.

An approval:

- expires after 15 minutes;
- applies only to the exact fingerprint;
- is consumed before the approved command executes;
- cannot be reused;
- does not silently authorize a changed command or cwd.

After local approval, the remote caller retries the exact same `shell_run` once.

## Automatic V1 command set

V1 intentionally keeps the automatic set narrow.

Examples that may auto-run when their paths are statically inside the Active Workspace:

- simple diagnostics such as `Write-Output`, `Get-Location`, `Get-Date`;
- selected read-only PowerShell commands, including Workspace-scoped `Get-FileHash`;
- selected static-path file operations;
- read-only Git operations without `-C`, `--git-dir` or `--work-tree`.

Examples that require approval:

- any outside-Workspace path;
- variable/subexpression/script-block/.NET path construction;
- grouping/nested-expression/list syntax that can hide extra PowerShell execution;
- pipelines, redirection and multi-command composition;
- explicit executable paths such as `.\\tool.exe`, child shells/interpreters or unrecognized commands;
- Git path/config/output overrides and helper-enabling options that can escape the Workspace or create external effects;
- `New-Item` link/special item types and writes through an existing multi-link file;
- `git push`;
- `npm` execution, because package/repository scripts can execute arbitrary code.

Approval mode also fails closed if the Runtime does not have an explicit `A` or `B`
slot identity, because an unbound request cannot be safely presented as a
Runtime-specific Local Operator decision.

The existing destructive-command blocklist remains only a defense-in-depth guard
rail and is not treated as the security boundary.

## Consequences

Positive:

- common provably Workspace-local shell operations remain low-friction;
- outside/ambiguous shell effects require local human approval;
- approval is exact, short-lived and one-shot;
- the Runtime cannot approve itself;
- the design can grow by adding proven-safe command families without weakening the
  fail-closed default.

Limitations:

- V1 is a conservative static policy, not a general PowerShell semantic verifier;
- commands that are safe but too complex to prove will still require approval;
- full OS isolation remains stronger than static analysis plus approval;
- other execution surfaces must be reviewed separately if they can execute mutable
  repository code.

## Verification requirements

- developer advertises `shell_run`;
- a recognized diagnostic executes directly;
- a static Workspace-local write executes directly;
- an outside-Workspace write creates an approval and has no side effect;
- local approval permits exactly one retry;
- consumed approval cannot be reused;
- dynamic path construction requires approval;
- parenthesized/list syntax cannot smuggle a second operation past the classifier;
- explicit executable paths and risky Git overrides require approval;
- link creation and existing hard-link write targets require approval;
- approval mode fails closed without Runtime slot identity;
- cwd junction escape is refused;
- Operator renders a plain-language purpose and approval reason before the raw command;
- Operator uses a token-protected approve/deny endpoint;
- full repository verification remains green.
