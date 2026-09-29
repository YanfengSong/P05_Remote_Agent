# Local PTY experiment (M4 / P06)

This module runs real node-pty 1.1.0 pseudoterminals. Verified locally with Node
24.19.0, Windows x64 and bundled ConPTY. No pipe fallback is used. Linux, another
Windows identity, production packaging and OS process-tree containment remain
unverified. This is a trusted-host **E4 execution entry point**, not an OS sandbox.
Its processes can access everything allowed to the hosting OS account. A fixed
working directory and a cleaned environment are not filesystem/network isolation.

## Dependency and process ownership

The project pins `node-pty` to `1.1.0`; upstream is
https://github.com/microsoft/node-pty (MIT, license retained in the installed
package). Its Windows prebuilt addon loaded under the project's Node 24 runtime.
No Electron ABI binary is reused. Build normally before running this module.

The local feasibility probe found that node-pty 1.1.0 can report a real child exit
while its Windows Conout worker still keeps the Node event loop alive. Both system
and bundled ConPTY reproduced that behavior. We therefore put **each PTY in one
independent Node runner process**. After its real onExit callback, the runner sends
the receipt and explicitly exits after IPC flush; it does not modify node-pty or
call private native APIs. Native addon resources cannot accumulate inside Core or
the long-lived Terminal Host. The worker uses bundled ConPTY to avoid the system
backend's PID-list-based kill helper. The runner's command channel is private IPC;
the actual user program is attached to ConPTY, not to those IPC pipes.

Core/RPC disconnect does not stop a session. Explicit Terminal Host shutdown asks
owned PTYs to close, waits a bounded interval, then stops remaining owned runners.
If the Host dies, runner IPC disconnect asks the PTY to close. Neither path proves
all descendants stopped: **treeTermination is always unconfirmed**. Restart marks
REGISTERED/RUNNING/CANCEL_REQUESTED sessions UNKNOWN and never respawns them. There
is no terminal state reconstruction after Terminal Host restart.

## Deployment configuration

Compile with `npm run build`. Start the separate executable using
`P05_V3_TERMINAL_CONFIG=<absolute protected JSON path>` and
`node dist/v3-terminal-host.js`. The config, containing directory, state directory,
and token files must pass the existing platform protection checks. All control
files and state must be outside the Workspace, including canonical realpath
checks against ancestor junctions. The starter does not create private directories
or generate tokens; use the project's protected setup workflow first.

```json
{
  "stateDir": "C:\\P05Private\\terminal-state",
  "workspaceRoot": "D:\\Workspaces\\example",
  "slot": "local-development",
  "principal": "local-client",
  "authorizationRevision": "1",
  "securityMode": "trusted-host",
  "clientTokenFile": "C:\\P05Private\\terminal-client.token",
  "operatorTokenFile": "C:\\P05Private\\terminal-operator.token",
  "port": 0,
  "maxOutputBytes": 1048576,
  "maxSessions": 64,
  "maxConcurrent": 4,
  "maxLifetimeMs": 1800000
}
```

The authenticated loopback endpoint is written to protected `stateDir/endpoint.json`.
Tokens must be distinct, 32–512 safe characters; never put them into child argv,
Workspace files or execution payload. The dedicated client token is a privileged
internal authority for this fixed owner/Slot. Do not expose it to an MCP agent.
The operator token has no terminal mutation routes. Requests cannot supply or
change principal, Slot, cwd, env, security mode or policy revision. Database binding
rejects reopening with a different identity or workspace. The child environment
contains only SYSTEMROOT/WINDIR/SYSTEMDRIVE/TEMP/TMP; it excludes Core credentials,
NODE_OPTIONS, inherited loader flags, PATH, user profiles and proxy settings.

## API and approval integration boundary

`new TerminalHost(options)` is an internal API; its caller must establish private
filesystem protection. `handle(method, input, role)` is used behind the shared
authenticated Local RPC server. All registered methods require client role.

| Method | Input / result |
| --- | --- |
| terminal_open | `{executable:absolutePath,args:string[],cols,rows,intentId,authorizationRef}` → TerminalView |
| terminal_status / terminal_attach | `{id}` → TerminalView; read-only and no terminal replay |
| terminal_output | `{id,offset?:0,limit?:49152}` → `{offset,nextOffset,dataBase64,availableBytes,observedBytes,truncated,stream:"terminal"}` |
| terminal_input | `{id,data,intentId,authorizationRef}` → durable effect dispatch state |
| terminal_resize | `{id,cols,rows,intentId,authorizationRef}` → durable effect dispatch state |
| terminal_cancel | `{id,intentId,authorizationRef}` → durable effect dispatch state |
| terminal_intent_status | `{id,intentId}` → `{operation,state,at,digest}` |
| terminal_health | execution availability, storage fault, active count and binding digest |

**Input is code execution, never a read operation.** Open, input, resize and cancel
each require a distinct, audited authorization intent from the trusted gateway.
`authorizationRef` is persisted evidence supplied by that gateway; the Terminal
Host does not independently validate a DurableKernel approval. Core integration
must obtain the required E4 approval for the exact immutable request, revalidate
current policy/owner immediately before dispatch, and use the pinned Host binding.
The Terminal Host alone must not be advertised as providing an approval gate.

Intent IDs are unique across the Host. Identical retries return the existing
session or intent; changed payloads/authorization refs conflict. No write, resize
or cancellation is repeated on retry, including when ACK was lost. States are
DISPATCHING, ACCEPTED, UNKNOWN. ACCEPTED only means the runner accepted the request;
it does not prove a command finished, a resize has become observable, or a process
tree was terminated. Query the session receipt/output for the actual result.

The session's host boot ID, expiry, open digest, output counters, cancellation flag
and optional receipt persist in SQLite. Intent payloads are plaintext and include
commands/input, so **do not send secrets**. Private ACLs do not provide encryption.
Schema creation/version and initial recovery use one transaction; the separate
SQLite exclusive ownership lock prevents two Host instances from sharing a store.
SQLite failure stops new mutations. A receipt failure remains uncertainty on restart.

## Bounds and verification

Each input is at most 4096 UTF-8 bytes; each session accepts at most 256 ordinary
intents plus cancellation. Dimensions are 2–500 columns and 2–300 rows. Default
session lifetime is 30 minutes, maximum one hour. Expiry requests cancellation;
if exit is unconfirmed after 1.5 seconds the runner is stopped and the session
remains UNKNOWN. Capacity is at most 16 active sessions and 1024 retained sessions
(defaults 4/64). No automatic retention deletion is performed.

Output stores a prefix up to the per-session quota (default 1 MiB, maximum 8 MiB),
with a 64 MiB Host-wide quota and 4096-byte SQLite pages. Later output is discarded
without blocking exit handling; counters and truncation remain explicit. Runner
IPC output queues are capped at 256 KiB, with discarded-byte accounting. Output
pages use byte offsets and base64, preserving split UTF-8/ANSI sequences. At most
49152 raw bytes are returned in one page. Treat output as untrusted bytes; no HTML,
OSC clipboard, automatic link or terminal UI rendering is included.

Run `npm run build` then `node dist/test/v3-terminal.js`. The test exercises real
TTY identity, UTF-8 byte paging, input dedup/conflict, asynchronous resize, bounded
output, private RPC detach, confirmed direct exit after cancellation, runner
cleanup, SQLite reopen and binding rejection. It also forcibly kills a real Host
child process, reopens the database, verifies UNKNOWN and confirms no repeated
external write. Tests do not establish OS sandboxing or descendant termination.
