# P05 Remote Agent — Execution Plan

> Repository: `YanfengSong/P05_Remote_Agent`  
> Local workspace example: `F:\Project_Git\P05_Remote_Agent`  
> Purpose: build a self-controlled remote Windows agent that can progressively replace Remote Desktop Commander while reducing ChatGPT ↔ local-machine tool-call count.

---

## 1. Target Architecture

```text
ChatGPT
   │
   │ Custom MCP Plugin
   ▼
OpenAI Secure MCP Tunnel
   │
   │ outbound HTTPS only
   ▼
tunnel-client
   │
   ▼
P05 Remote Agent
   │
   ├─ Device
   ├─ Files
   ├─ Git
   ├─ Process
   ├─ Command Policy
   ├─ Batch / Task
   └─ Downstream MCP
          └─ MATLAB MCP
```

The long-term goal is not just remote file access. P05 should become a local execution gateway that can:

- identify and ping the current computer;
- read/list/search/write project files inside controlled roots;
- inspect and operate Git repositories;
- start and manage long-running processes;
- run approved commands;
- execute multiple local steps in one MCP call;
- expose higher-level `run_task` workflows;
- proxy downstream MCP servers such as MATLAB MCP;
- keep audit logs and enforce explicit risk policies.

---

## 2. Current Baseline

Already completed:

- repository created and used as project source of truth;
- local MCP server builds successfully;
- downstream MCP client framework exists;
- MATLAB downstream adapter scaffold exists;
- stable local device identity exists;
- `device_info` works;
- `ping` works;
- stdio MCP works;
- Streamable HTTP bridge works at local level;
- `/healthz` works;
- HTTP MCP `device_info` call has been verified.

Current local MCP shape:

```text
P05 stdio
   ↓
Supergateway
   ↓
http://127.0.0.1:8765/mcp
```

Do not rewrite this transport layer until there is a concrete reason. The currently working path is more valuable than introducing a theoretically cleaner transport too early.

---

## 3. Core Engineering Rules

### 3.1 GitHub is the canonical source

All controlled project assets must live in:

```text
YanfengSong/P05_Remote_Agent
```

This includes:

```text
src/
docs/
scripts/
tests/
configuration examples
ADRs
README
PROJECT_STATUS.md
```

Do not keep production-only scripts on Desktop, Downloads, Temp, or untracked folders.

### 3.2 Never commit secrets

Never commit:

```text
CONTROL_PLANE_API_KEY
OPENAI_API_KEY
OPENAI_ADMIN_KEY
OAuth secrets
access tokens
.env
runtime credentials
```

Only variable names and safe placeholders may appear in `.env.example`.

### 3.3 Keep device identity local

The stable device identity file under `.p05/` must remain local and ignored by Git.

Do not hardcode a specific device ID into source code or documentation.

### 3.4 Fail closed

When configuration, authorization, path validation, tool policy, or downstream behavior is uncertain, the operation must fail rather than silently broaden access.

### 3.5 Do not treat raw PowerShell as a sandbox

The current `shell_run` implementation is not a complete security boundary. Restrict or hide it before remote access is enabled.

---

## 4. Recommended Repository Structure

Target structure:

```text
P05_Remote_Agent/
│
├─ src/
│  ├─ device/
│  │  └─ identity.ts
│  │
│  ├─ policy/
│  │  ├─ tool-profile.ts
│  │  ├─ path-policy.ts
│  │  └─ command-policy.ts
│  │
│  ├─ tools/
│  │  ├─ device.ts
│  │  ├─ files.ts
│  │  ├─ git.ts
│  │  ├─ process.ts
│  │  ├─ batch.ts
│  │  └─ task.ts
│  │
│  ├─ process/
│  │  ├─ manager.ts
│  │  └─ session.ts
│  │
│  ├─ downstream/
│  │  ├─ client.ts
│  │  ├─ registry.ts
│  │  └─ matlab.ts
│  │
│  ├─ audit/
│  │  └─ logger.ts
│  │
│  └─ index.ts
│
├─ scripts/
│  ├─ start-local.ps1
│  ├─ verify.ps1
│  └─ tunnel/
│     ├─ doctor.ps1
│     └─ start-tunnel.ps1
│
├─ docs/
│  ├─ architecture/
│  ├─ adr/
│  ├─ deployment/
│  ├─ security/
│  ├─ research/
│  └─ roadmap/
│
├─ .env.example
├─ .gitignore
├─ PROJECT_STATUS.md
├─ README.md
└─ package.json
```

---

## 5. Development Order

Do not implement all capabilities at once.

Use the following order:

```text
V0.3-A  Device Discovery
V0.3-B  Local HTTP
V0.3-C  Secure Tunnel
V0.4    Read-only Remote Agent
V0.5    Developer Agent
V0.6    Efficient Agent
V0.7    MATLAB Integration
```

Each stage must pass its own DoD before the next begins.

---

# 6. TASK-001 — Tool Profile Safety

## Objective

Before exposing P05 remotely, introduce a tool-profile layer so a remote client cannot automatically discover dangerous tools.

Add:

```text
P05_TOOL_PROFILE
```

Supported values:

```text
discovery
readonly
developer
full
```

Default:

```text
discovery
```

## Required behavior

### discovery

Only:

```text
device_info
ping
```

### readonly

```text
device_info
ping
fs_read
fs_list
fs_search
git_status
git_diff
git_log
```

### developer

Readonly plus controlled mutation/development tools:

```text
fs_write
apply_patch
process_start
process_wait
process_output
process_stop
approved Git mutations
approved downstream MCP wrappers
batch_execute
```

### full

Developer plus explicitly high-risk operations.

The `full` profile must never be the default.

## Suggested implementation

Create:

```text
src/policy/tool-profile.ts
```

Possible contract:

```ts
export type ToolProfile =
  | "discovery"
  | "readonly"
  | "developer"
  | "full";

export function isToolAllowed(
  profile: ToolProfile,
  toolName: string
): boolean;
```

Register tools conditionally rather than registering everything and checking only at execution time.

## TASK-001 DoD

With:

```text
P05_TOOL_PROFILE=discovery
```

`tools/list` must return only:

```text
device_info
ping
```

The following must not appear:

```text
shell_run
fs_write
mcp_call_tool
```

Validation:

```text
npm run check
npm run build
npm run smoke:downstream
profile-specific tests
```

Stop after TASK-001. Do not automatically continue to TASK-002.

---

# 7. TASK-002 — Local Startup Standardization

## Objective

Make local startup reproducible and visible.

Create:

```text
scripts/start-local.ps1
```

The script must:

1. verify Node.js;
2. verify dependencies;
3. build the project;
4. apply a safe default profile;
5. start the local HTTP MCP gateway;
6. print runtime information.

Expected console summary:

```text
P05 Remote Agent

Device:
  hostname: <hostname>
  deviceId: <local stable id>

Tool profile:
  discovery

MCP:
  http://127.0.0.1:8765/mcp

Health:
  http://127.0.0.1:8765/healthz
```

Do not expose the MCP server directly on a public interface.

---

# 8. TASK-003 — Secure Tunnel Integration

## Objective

Connect the local MCP endpoint to ChatGPT through OpenAI Secure MCP Tunnel without opening inbound router/firewall ports.

Current local target:

```text
http://127.0.0.1:8765/mcp
```

## Runtime expectations

Tunnel client is an external runtime dependency and should not be committed as a large binary.

Add ignore patterns for downloaded tunnel-client archives/binaries.

Suggested scripts:

```text
scripts/tunnel/doctor.ps1
scripts/tunnel/start-tunnel.ps1
```

These scripts must read credentials only from environment variables.

Never write API keys into source-controlled scripts.

## Tunnel concepts

Keep these separate:

```text
Tunnel ID
Runtime API Key
Admin API Key
```

Runtime API key is used by the long-running tunnel runtime.

Admin key is only for tunnel CRUD and must not be used by the daemon.

## Setup flow

```text
P05 local MCP
    ↓
tunnel-client init
    ↓
tunnel-client doctor
    ↓
tunnel-client run
    ↓
ChatGPT plugin
```

Example local target configuration:

```text
--mcp-server-url http://127.0.0.1:8765/mcp
```

## TASK-003 DoD

The stage is complete only when:

```text
tunnel-client doctor PASS
tunnel-client run remains stable
ChatGPT can discover device_info
ChatGPT can call ping
```

At this point the project reaches:

```text
REMOTE_DISCOVERY_COMPLETE
```

---

# 9. TASK-004 — Read-only Remote Agent

## Objective

Safely expose project inspection capabilities.

Implement:

```text
fs_read
fs_list
fs_search
git_status
git_diff
git_diff_stat
git_log
git_branch
```

No writes yet.

## Allowed roots

Do not hardcode an old workstation path.

Use environment configuration.

Example:

```text
REMOTE_AGENT_ALLOWED_ROOTS=F:\Project_Git
REMOTE_AGENT_DEFAULT_CWD=F:\Project_Git
```

Do not allow whole-disk roots by default.

## Path safety

A simple `path.resolve + startsWith(root)` check is insufficient.

Add canonical/real-path validation and handle:

```text
symlinks
junctions
reparse points
path traversal
```

A path that resolves outside an allowed root must be denied.

## TASK-004 DoD

Remote ChatGPT can:

- list a repository directory;
- read an allowed text file;
- search inside an allowed workspace;
- inspect Git status/diff/log;

while attempts to escape allowed roots are denied.

---

# 10. TASK-005 — Git Tool Layer

## Objective

Stop routing normal Git operations through raw PowerShell.

Create:

```text
src/tools/git.ts
```

Use:

```ts
execFile("git", args, { cwd })
```

rather than shell interpolation.

## Read-only actions

Implement first:

```text
git_status
git_diff
git_diff_stat
git_log
git_branch
```

## Controlled mutations

Only after read-only tools are stable:

```text
git_checkout
git_add
git_commit
git_restore
```

Do not expose by default:

```text
git reset --hard
git clean -fd
force push
```

All repository paths must pass the allowed-root policy.

---

# 11. TASK-006 — Process Manager

## Objective

Replace high-frequency polling with local lifecycle management.

Create:

```text
src/process/manager.ts
src/process/session.ts
```

Expose:

```text
process_start
process_wait
process_output
process_status
process_stop
```

## process_start

Example:

```json
{
  "command": "npm test",
  "cwd": "F:\\Project_Git\\Example",
  "timeoutMs": 600000
}
```

Return:

```json
{
  "sessionId": "...",
  "pid": 12345,
  "status": "running"
}
```

## process_wait

This is a key optimization.

Instead of forcing ChatGPT to call `read_process_output` repeatedly, P05 should wait locally.

Example:

```json
{
  "sessionId": "...",
  "waitMs": 30000,
  "until": [
    "exit",
    "new_output",
    "prompt"
  ]
}
```

Return only useful deltas:

```json
{
  "status": "finished",
  "exitCode": 0,
  "stdoutDelta": "...",
  "stderrDelta": "..."
}
```

Maintain bounded buffers, output cursors, stale-session cleanup, and explicit timeout handling.

---

# 12. TASK-007 — Batch Execute

## Objective

Reduce the number of ChatGPT ↔ P05 tool round trips.

Implement:

```text
batch_execute
```

Example:

```json
{
  "steps": [
    {
      "op": "fs_read",
      "path": "..."
    },
    {
      "op": "git_status",
      "repo": "..."
    },
    {
      "op": "process_run",
      "command": "npm test",
      "cwd": "..."
    }
  ],
  "stopOnError": true
}
```

Required limits:

```text
maximum step count
maximum total runtime
maximum output bytes
per-step timeout
explicit allowed operation set
```

The batch engine must not become a generic bypass around tool policy.

---

# 13. TASK-008 — High-level run_task

## Objective

Move common engineering workflows into P05 so the model sends one high-level request instead of dozens of small requests.

Example:

```json
{
  "task": "validate_repo",
  "workspace": "F:\\Project_Git\\Example"
}
```

P05 may internally perform:

```text
git status
↓
dependency/check step
↓
build
↓
tests
↓
git diff
↓
compact summary
```

Return:

```json
{
  "status": "FAILED",
  "phase": "test",
  "summary": "...",
  "errors": [],
  "gitDiffSummary": "...",
  "suggestedNextAction": "..."
}
```

This is the main mechanism for exceeding Remote Desktop Commander efficiency.

---

# 14. TASK-009 — Command Policy / Raw Shell Reduction

## Objective

Gradually remove unrestricted shell as the default execution mechanism.

Preferred approved command families:

```text
git
node
npm
npx
python
python3
dotnet
cmake
approved MATLAB launchers
approved project scripts
```

Avoid default exposure of:

```text
powershell -Command <arbitrary content>
cmd /c <arbitrary content>
```

If raw shell remains, it must require:

```text
P05_TOOL_PROFILE=full
+
explicit high-risk approval
```

---

# 15. TASK-010 — Audit Logging

## Objective

Record what the remote agent did without leaking secrets or large content.

Store local logs under:

```text
.p05/logs/
```

Use JSONL.

Example:

```json
{
  "time": "...",
  "deviceId": "...",
  "tool": "fs_read",
  "cwd": "...",
  "status": "success",
  "durationMs": 42
}
```

Do not log:

```text
API keys
OAuth tokens
credentials
full file bodies
full sensitive command payloads
```

Redact sensitive fields.

---

# 16. TASK-011 — Output Limits

Every tool must have explicit output bounds.

Recommended controls:

```text
max stdout bytes
max stderr bytes
max file-read bytes
max tool-result bytes
max search matches
```

When truncated:

```json
{
  "truncated": true,
  "totalBytes": 8241224,
  "returnedBytes": 1048576
}
```

This protects the ChatGPT context window and reduces unnecessary token/tool usage.

---

# 17. TASK-012 — Approval Model

High-risk operations must be blocked by default.

Examples:

```text
fs_delete
git_reset_hard
process_kill_tree
raw_shell
registry edits
service changes
system configuration changes
```

Later, introduce an approval mechanism.

Do not implement a design where the same AI that requested a high-risk action can silently approve its own request.

---

# 18. TASK-013 — MATLAB MCP Integration

## Objective

Reuse MathWorks MATLAB MCP instead of reimplementing MATLAB control.

Architecture:

```text
ChatGPT
   ↓
P05
   ↓ MCP Client
MathWorks MATLAB MCP
   ↓
MATLAB / Simulink
```

Initial wrappers:

```text
matlab_status
matlab_list_tools
matlab_eval
matlab_run_file
matlab_test
simulink_update
simulink_build
simulink_run
```

Prefer curated high-level tools over exposing every low-level MATLAB MCP tool directly.

Target pattern:

```text
ChatGPT
   ↓ one external MCP call
simulink_verify()
   ↓
P05
   ├─ update model
   ├─ build
   ├─ simulate
   ├─ run tests
   └─ collect diagnostics
```

---

# 19. TASK-014 — Windows Auto-start

Do this only after security and remote behavior are stable.

Preferred first implementation:

```text
Windows Task Scheduler
```

Two tasks:

```text
P05 Remote Agent
P05 Tunnel Client
```

Start after user login.

Do not implement a Windows Service in the first production iteration unless there is a clear operational need.

---

# 20. Verification Pipeline

Create:

```text
npm run verify
```

It should include:

```text
npm run check
npm run build
npm run test
npm run smoke:downstream
```

Additional automated tests must verify:

```text
stable device identity
discovery profile exposes only device_info + ping
readonly profile contains no mutation tools
allowed-root escape is denied
symlink/junction escape is denied
dangerous command is denied
process session cleanup works
output caps work
batch operation limits work
```

---

# 21. Version DoD

## V0.3-A — Device Discovery

Required:

```text
device_info PASS
ping PASS
stable local device identity PASS
```

Status: already demonstrated.

## V0.3-B — Local HTTP

Required:

```text
/mcp PASS
/healthz PASS
HTTP device_info PASS
```

Status: already demonstrated.

## V0.3-C — Secure Tunnel

Required:

```text
tunnel-client doctor PASS
tunnel-client run stable
ChatGPT discovers device_info
ChatGPT calls ping successfully
```

## V0.4 — Read-only Remote Agent

Required:

```text
fs_read
fs_list
fs_search
git_status
git_diff
git_log
```

All must work remotely with root/path policy enforced.

## V0.5 — Developer Agent

Required:

```text
fs_write
apply_patch
process manager
controlled Git mutations
audit log
command policy
```

## V0.6 — Efficient Agent

Required:

```text
batch_execute
run_task
```

The project should demonstrate a real workflow that uses materially fewer external tool calls than the equivalent Remote Desktop Commander sequence.

## V0.7 — MATLAB

Required:

```text
P05 → MATLAB MCP connection
MATLAB execution
Simulink operation
build/test workflow
compact diagnostics
```

---

# 22. Local AI Agent Execution Contract

The local AI Agent must not interpret this document as permission to implement every stage at once.

For each task:

1. inspect current Git state;
2. read relevant project files;
3. produce a short implementation plan;
4. change only the scope of the current task;
5. run build/tests;
6. inspect diff;
7. update documentation/status;
8. commit;
9. stop.

Required result format:

```text
TASK-XXX RESULT

Status:
PASS / FAIL

Changed:
...

Validation:
...

Risks:
...

Commit:
...

Next recommended task:
TASK-YYY ...
```

Do not automatically enter the next task.

---

# 23. Immediate Next Task

The next task is:

```text
TASK-001 — Tool Profile Safety
```

Execution:

```text
1. git status
2. git pull --ff-only
3. create/switch to feat/remote-agent-v03
4. implement P05_TOOL_PROFILE
5. default to discovery
6. make discovery expose only device_info + ping
7. add profile tests
8. npm run check
9. npm run build
10. npm run smoke:downstream
11. update README
12. update PROJECT_STATUS.md
13. inspect git diff
14. commit
15. STOP
```

DoD:

```text
P05_TOOL_PROFILE=discovery

tools/list:
- device_info
- ping

must NOT include:
- shell_run
- fs_write
- mcp_call_tool
```

---

# 24. Stop Conditions

The local AI Agent must stop and report instead of guessing when any of the following occurs:

```text
API key required
Admin key required
user file deletion required
firewall modification required
administrator privileges required
Windows Registry modification required
system service installation required
public port exposure required
unknown Git workspace changes exist
merge/rebase conflict exists
test failure root cause is unclear
security boundary is ambiguous
```

Secrets must always be entered or managed by the user. The AI Agent must not search browser caches, Credential Manager, shell history, logs, or unrelated files for credentials.

---

# 25. End-state

The intended mature system is:

```text
                    ChatGPT
                       │
                       │ MCP
                       ▼
              Secure Remote Link
                       │
                       ▼
                P05 Remote Agent
                       │
          ┌────────────┼─────────────┐
          │            │             │
        Files         Git         Process
          │            │             │
          └───────┬────┴──────┬──────┘
                  │           │
             batch_execute   run_task
                  │
                  ▼
             Downstream MCP
                  │
                MATLAB
```

If the OpenAI Secure MCP Tunnel is later replaced by a self-hosted P05 Relay, the Agent/tool/policy layers should remain largely unchanged. Transport must stay separable from local execution logic.
