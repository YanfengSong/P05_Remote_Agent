# ADR-0004: Fail closed on links, and treat write targets as an execution surface

Status: Accepted  
Date: 2026-09-18

## Context

An adversarial review of the tool-profile gate (independent reviewer, real NTFS fixtures,
raw JSON-RPC client) confirmed the gate itself holds — fuzzed profile values, suppressed-tool
call attempts, duplicate JSON-RPC keys and type confusion all fail closed — but broke the
path policy around it in three ways, all reproduced with real commands:

1. **A dangling junction skipped the containment check.** `resolveRealPath` fell back to the
   unresolved path when the walk up the tree ended without a canonicalisable component.
   A junction whose target does not exist therefore produced `real === resolved`, the
   `real !== resolved` guard never ran, and a write was allowed to land outside the allowed
   roots once the target came into existence.
2. **`fs_write` could overwrite code.** `dist/**`, `node_modules/**`, `package.json`,
   `tsconfig.json`, `.vscode/tasks.json` and `.mcp.json` were all writable. Since
   `developer` grants `fs_write`, a remote client could plant code that runs on the next
   start, next install or next workspace open — writing the agent's own code is the same
   capability as executing it, without any second gate.
3. **`shell_run`'s `cwd` was string-checked only.** A junction inside an allowed root was
   accepted as `cwd`, and the command then ran outside the roots, contradicting the
   documented "runs in an allowed working directory" claim.

Two lesser findings were also accepted: refusals echoed absolute paths, the process working
directory and link targets back to the remote (free enumeration), and `process.env` was read
with inherited properties, so a polluted prototype could answer for `P05_TOOL_PROFILE`.

## Decision

1. **Links fail closed.** The first component of a path that exists must canonicalise. If it
   cannot — a dangling junction — the request is refused instead of falling back to the
   unresolved path. No fallback may ever produce `real === resolved` for an unverified path.
2. **Write targets are an execution surface.** A write is refused inside `node_modules`,
   `dist`, `.vscode`, and to `package.json`, `package-lock.json`, `tsconfig.json`,
   `.mcp.json`, `.gitmodules`. Reads stay allowed: a build artefact holds no secret, and
   refusing reads would break ordinary work.
3. **One guard for every path.** `shell_run`'s `cwd` goes through the same guard as the fs
   tools. (This constrains where a command starts, not what it may then write — `shell_run`
   is still not a sandbox.)
4. **Refusals are terse.** Error text echoes the caller's own input plus the rule that
   refused it, never the resolved path, the working directory or a link target.
5. **Environment reads use own properties** (`Object.hasOwn`).

## Consequences

Positive:

- the two escape classes that were reproduced are closed, and each is now asserted by a test
  that builds the real fixture (dangling junction, junction as `cwd`, write to each protected
  target, with a check that nothing landed where it should not);
- a remote client can no longer learn the machine layout from error text;
- the write-side list makes "the agent may edit its own source" an explicit decision rather
  than an accident: legitimate `package.json`/`tsconfig.json` edits are a local action today,
  and an approval path (TASK-012) is where a remote one would belong.

Trade-offs:

- the agent can no longer update its own manifests or dependencies remotely; that has to be
  done locally or through a future approved path;
- an ordinary remote write into a directory literally named `dist` is refused even when it
  is unrelated to a build;
- hard links remain invisible to `realpath`. The reviewer reproduced a hard link inside an
  allowed root reading a `.env` and a private key. Detecting them requires `fstat().nlink`
  on an open handle, which also breaks legitimate hard-link toolchains (pnpm stores), so this
  stays a documented residual risk rather than a blanket refusal;
- the TOCTOU window between the check and the caller's `open()` is unchanged; closing it
  needs open-then-verify-by-handle semantics.

## Follow-up

- TASK-009: real command policy; the blocklist is an accident guard, not a boundary.
- TASK-010: audit log, so refusals are visible locally even though the remote sees a terse
  message.
- TASK-012: approval model, the intended path for manifest writes and for the plan's
  "approved Git mutations" wording.
