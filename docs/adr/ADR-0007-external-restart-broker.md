# ADR-0007 — External Restart Broker

Status: Accepted
Date: 2026-09-20

## Context

P05 needs to rebuild and restart itself to close the autonomous development loop. A first implementation spawned
PowerShell from the running Agent and invoked the existing restart script. The MCP call returned successfully, but
the runtime did not actually restart: the helper remained coupled to the process tree it was trying to replace.

A second implementation tried to create a one-shot Scheduled Task at call time. Windows task creation required
administrator authority, which the normal P05 runtime intentionally does not have.

## Decision

Use a pre-provisioned Windows Scheduled Task named P05-RestartBroker.

The task is installed out-of-band by an administrator with a fixed action that invokes the approved P05 restart
script. The remotely reachable runtime can only execute:

schtasks.exe /Run /TN P05-RestartBroker

The MCP tool runtime_restart has an empty input schema. It accepts no command, path, task name, credentials,
arguments or elevation switches.

## Consequences

Positive:
- restart execution survives termination of the current P05/tunnel process tree;
- ordinary P05 runtime remains non-admin;
- the self-modifying workspace cannot parameterize the host-level action;
- restart authority is separated from source-code authority;
- the development loop can continue after build without human restart assistance.

Cost:
- one administrator provisioning step is required per host;
- broker configuration lives outside the normal Agent runtime and must be maintained separately;
- changing the broker action is a host-policy change and requires explicit human authorization.

## Verification

End-to-end acceptance on 2026-09-20:
- runtime_restart returned RESTART_SCHEDULED;
- device startedAt changed from 2026-09-20T07:01:02.776Z to 2026-09-20T07:01:40.398Z;
- the device reconnected and ping returned ok=true;
- post-restart command_run(check) passed;
- post-restart policy suite passed 179 checks.

Regression requirements:
- runtime_restart remains zero-argument at MCP level;
- internal invocation remains exactly schtasks.exe /Run /TN P05-RestartBroker;
- no task creation/elevation/credential argument is reachable from the MCP call.
