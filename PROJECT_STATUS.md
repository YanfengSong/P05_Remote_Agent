# Project Status

Updated: 2026-09-18

## Current baseline

Version: V0.3 phase 1 (branch `feat/remote-agent-v03`)  
Canonical repository: `YanfengSong/P05_Remote_Agent`  
Validated on Windows with Node.js 22.23.1.

Completed:

- repository initialized and documented;
- open-source gateway benchmark completed;
- local MCP Server tool layer;
- downstream MCP Client + Registry;
- MATLAB downstream adapter scaffold;
- generic downstream tool discovery/call proxy;
- mock downstream MCP smoke test;
- clean-clone build and smoke test passed;
- **safe tool profiles**: every tool declared with a profile and risk, gated at
  registration, dangerous tools behind local unlock flags, unknown profile aborts
  startup;
- **protected-path policy**: `.git`, `.p05`, `.env`/credentials and key material are
  refused even inside an allowed root;
- **path resolution hardening**: UNC / `\\?\` / drive-relative / alternate-data-stream
  spellings refused, trailing dots and spaces canonicalised before protected-name
  matching, and the resolved real path re-checked so a symlink or junction inside a
  root cannot escape it.

Validation:

- `npm install`: pass;
- `npm run build`: pass;
- `npm run check`: pass;
- `npm run test:policy`: `POLICY_PROFILES_OK` (83 checks);
- `npm run test:exposure`: `PROFILE_EXPOSURE_OK` (88 checks);
- `npm run smoke:downstream`: `DOWNSTREAM_SMOKE_OK`.

Known residual risks (documented in `docs/architecture/TOOL-PROFILES.md`): hard links
are invisible to `realpath`, and a TOCTOU window exists between the path check and the
file operation.

## Architecture decision

P05 remains a lightweight local-first Gateway/Agent. It reuses the official MCP SDK and
downstream MCP implementations, while owning local policy, routing, batching, process
lifecycle and future remote ingress.

Tool exposure is now a first-class policy decision rather than a side effect of
registration — see ADR-0003.

## Next milestone: V0.3 (remaining)

1. Configure/install MathWorks MATLAB MCP and complete real downstream E2E test.
2. Add Streamable HTTP ingress.
3. Add initial bearer-token authentication.
4. Add structured audit log and approval hook for write/execute tools.
5. Add Git and batch-execution tools to reduce tool-call count.
6. Connect the OpenAI Secure MCP Tunnel runtime (`tunnel-client` v0.0.14 is vendored
   locally and git-ignored; a fetch script is still required).

## Workspace

Preferred local working tree: `F:\Project_Git\P05_Remote_Agent`

The legacy `D:\Project_Git\Remote_Agent` bootstrap directory no longer exists; `D:` is
not used by this project. Allowed roots default to `F:\Project_Git`.

## Blocking condition before any remote ingress

`shell_run` must not be reachable from a remote client while it depends on a
working-directory check plus a command blocklist rather than a real sandbox. It is
therefore unreachable by default (profile `full` **and** `P05_ENABLE_SHELL=1` are both
required), and must stay locked until the audit log and approval hook exist.
