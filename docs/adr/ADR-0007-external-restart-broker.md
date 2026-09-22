# ADR-0007 — External Restart Broker

Status: Retired / Superseded
Date: 2026-09-20
Retired: 2026-09-22

## Context

P05 originally needed a restart mechanism that could survive termination of the
runtime process tree. Early experiments either remained coupled to the process
being replaced or required administrator authority to create a Scheduled Task
at call time.

## Historical decision

The V1/V2 transition used a pre-provisioned Windows Scheduled Task named
`P05-RestartBroker`.

The remotely reachable runtime could only request the fixed task:

    schtasks.exe /Run /TN P05-RestartBroker

The MCP `runtime_restart` tool remained zero-argument and could not choose an
arbitrary task, command, path, credential or elevation flag.

## Why this ADR is retired

The current V2 runtime no longer invokes the Scheduled Task broker.

`runtime_restart` now resolves the current Runtime slot from
`P05_RUNTIME_SLOT` and invokes the fixed repo-local request script:

    scripts/deployment/request-restart-runtime-slot.ps1 -Slot A|B

That script launches a delayed detached call to:

    scripts/deployment/restart-runtime-slot.ps1 -Slot A|B

The restart remains slot-scoped and the MCP tool still accepts no caller-supplied
command/path/task parameters.

Normal Bootstrap and Runtime operation require no RestartBroker task.

## Migration / cleanup

- `scripts/deployment/install-host-tasks.ps1` no longer creates
  `P05-RestartBroker`.
- The standalone `scripts/install-restart-broker.ps1` installer has been
  removed.
- `scripts/deployment/uninstall-host-tasks.ps1` still removes the historical
  `P05-RestartBroker` name (and an old configured
  `P05_OPERATOR_RESTART_TASK`) as upgrade cleanup only.
- Historical handoff/research documents may still mention RestartBroker as part
  of the earlier implementation and should be read as historical context.

## Current security boundary

Repo-local restart is a fixed lifecycle operation, not a general host command
broker. It does not authorize arbitrary host/system mutation.

Broader host effects such as services, firewall, registry, system packages or
privileged configuration remain outside the ordinary structured developer
surface and still require an explicit approval/broker/OS-level control as
appropriate.

## Regression requirements

- `runtime_restart` remains zero-argument at MCP level.
- Runtime slot is constrained to `A` or `B`.
- Invocation remains the fixed repo-local
  `request-restart-runtime-slot.ps1` path.
- Current deployment must not install or depend on `P05-RestartBroker`.
