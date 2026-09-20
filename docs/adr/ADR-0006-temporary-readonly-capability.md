# ADR-0006: A temporary, gated read-only layer for remote document review

Status: Accepted (temporary by intent — see Deletion)
Date: 2026-09-20

## Context

A remote client needs to read this repository's documents and source in order to review them.
The permanent answer to that need is the Security Broker (policy file, ALLOW / REQUIRE_APPROVAL /
DENY, approval tokens, audit log) specified in
`D:\Project_Git\_p05_deploy\BOOTSTRAP_V1_DESIGN.md`, which is a separate phase and not approved
for implementation yet.

Two constraints shaped this decision:

- The review need is read-only. Granting anything else to satisfy it would be gratuitous.
- The greatest risk in a read capability is not that it changes files, but that it leaks
  credentials: this machine holds a runtime API key, and the repository sits next to other
  projects. A filter for credential-shaped paths therefore has to ship *with* the capability, not
  after it.

## Decision

Ship a temporary read-only layer with exactly two tools — `list_directory` and `read_file` — and
no other capability:

1. **Off by default, opt-in per machine.** The tools are declared in `src/policy/tool-profile.ts`
   with `gate: "temp-readonly"`, and the gate is checked before the profile rank. Unless
   `P05_TEMP_READONLY_ROOT` is set, both tools are reported as suppressed and `tools/list` is
   unchanged, so the TASK-001 discovery contract (`device_info` + `ping` only) still holds.
2. **The temporary root only narrows.** `REMOTE_AGENT_ALLOWED_ROOTS` remains required and
   authoritative; a relative `P05_TEMP_READONLY_ROOT`, or one outside those roots, aborts startup.
   A blank value means the layer is off.
3. **Two guards, not one.** Every path first passes the existing `assertAccessiblePath` guard
   (path shape, allowed root, protected names, write-side code-execution paths, resolved real
   path) and is then re-checked against the temporary root, including its real path, so `..`, a
   junction pointing out of the root, and a sibling directory inside the allowed roots are all
   refused.
4. **Credential filter on top of the guard.** `.env*` (documented templates excepted), `.key`,
   `.pem`, `.pfx`, `.p12`, `.kdbx`, `.jks`, `.keystore`, `.ppk`, `.asc`, `.crt`, `.der`,
   `secrets`/`credentials` segments, and separator-anchored `token`/`secret`/`password`/`api-key`
   file names are refused. Refusals echo the caller's input, never the root or a link target, and
   never contain the withheld content.
5. **Bounded output.** Reads are capped at 1 MB and binary (NUL-containing) files are refused;
   listings withhold protected entries and report how many were withheld.
6. **Read-only in the strongest sense available here.** The module contains no write, delete,
   move or process-spawning code path, and the test suite snapshots the fixture directory
   (names, content hash, size, mtime) before and after exercising both tools to prove nothing
   moved.

## Alternatives rejected

- **Lower `fs_read`/`fs_list` to `discovery`.** It would widen the documented profile ladder and
  ship the older tools' surface (2 MB cap, no extra credential filter) as the review capability,
  instead of a layer whose whole purpose is read-only review.
- **Wait for the Security Broker.** Correct eventually, but it blocks a read-only need on a
  multi-stage build; the temporary layer is small, gated, and provably deleted.
- **Add the tools without a gate.** It would silently change the TASK-001 discovery surface for
  every install, including ones that never asked for it.
- **Serve files over the HTTP gateway shape used earlier.** That topology is retired; it needed a
  listening port and a separate bridge process to achieve what stdio already provides.

## Consequence

- `npm run verify:win` gains a step (`TEMP_READONLY_OK`, 48 checks) that covers both gate states,
  root confinement, the credential filter, the size cap, the no-side-effects snapshot, and the
  fail-closed startup cases.
- `src/env.ts` now holds `readOwnEnv` and the opt-in variable name, because the policy layer must
  read that variable *without* importing `src/config.ts` (whose import validates configuration as
  a side effect — which broke `test:policy`'s import order when the gate imported config
  directly).
- The layer is a stop-gap, and the code says so in the places a future reader will look: the
  module header, the spec block, and the README bullet.

## Deletion

When the Security Broker lands, delete `src/tools/temp-readonly.ts`, the two spec entries in
`src/policy/tool-profile.ts`, the two `exposer.expose` blocks in `src/index.ts`, the
`test:temp-readonly` script and its `scripts/verify.ps1` step, `src/test/temp-readonly.ts`, and the
`P05_TEMP_READONLY_ROOT` line from `.env`. Nothing in this layer is intended to survive it: the
gate exists to keep the default surface honest while it lives, not to become a second permission
model.
