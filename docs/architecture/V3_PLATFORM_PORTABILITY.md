# P05 V3 Platform Portability and Host Adapter Requirement

Status: Accepted V3 platform requirement
Scope: Core / Host integration
Target: Windows-first implementation with Linux-compatible architecture

## 1. Requirement

P05 V3 MUST keep Core platform-neutral.

Operating-system-specific behavior MUST be isolated behind explicit Host Adapter / Bootstrap contracts rather than embedded into Core business/control logic.

Windows remains the first fully implemented Host platform.

Linux support is a planned compatible Host implementation, not a separate P05 architecture.

## 2. Architectural principle

The target boundary is:

```text
                 P05 Core
                    |
             Host Abstraction
          +---------+---------+
          |                   |
      WindowsHost          LinuxHost
```

Core owns platform-neutral semantics such as:

- Connection;
- Routing;
- Health;
- Supervision;
- Recovery;
- Security;
- Workspace;
- Plugin/Optional Runtime control;
- resource/status contracts.

Host Adapter owns OS-specific mechanics.

## 3. Host Adapter responsibilities

The Host Adapter contract SHOULD cover only host-specific primitives required by Core and host-level runtime infrastructure.

Initial categories:

### Shell / command execution

Platform-neutral Core intent:

```text
host.shell.run(...)
```

Possible implementations:

- Windows: PowerShell;
- Linux: shell/bash or equivalent.

### Process supervision

Platform-neutral Core intent:

```text
host.process.start(...)
host.process.inspect(...)
host.process.terminateOwned(...)
```

Possible implementations:

- Windows: Windows process APIs / Job Object-backed supervision where appropriate;
- Linux: process groups, signals, systemd/cgroup integration where appropriate.

### Path / filesystem semantics

Core uses canonical path/security contracts.

Host Adapter handles:

- path normalization;
- path separator/case semantics;
- symlink/junction/reparse-point handling;
- host-specific permission metadata where required.

Security behavior MUST remain equivalent across platforms.

### Host lifecycle integration

Platform-neutral Core intent:

```text
host.lifecycle.requestRestart(...)
host.lifecycle.status(...)
```

Possible implementations:

- Windows: provisioned Scheduled Task / external broker;
- Linux: provisioned systemd unit or equivalent external broker.

The exact mechanism is host-specific, but authority must remain narrow and externally provisioned.

### Host diagnostics

Host Adapter may expose:

- OS identity;
- architecture;
- process/runtime metadata;
- service/runtime health;
- host-specific diagnostic facts.

Core status schema remains platform-neutral.

## 4. What MUST NOT leak into Core

Core MUST NOT rely directly on:

- PowerShell syntax;
- `.exe` assumptions;
- Windows registry;
- Scheduled Task names;
- drive-letter paths;
- Windows-only process APIs;
- systemd-specific semantics;
- POSIX-only paths or permission assumptions.

These belong to Host Adapter / Bootstrap implementations.

## 5. Cross-platform invariants

PORT-I01: Core control semantics are identical on Windows and Linux.

PORT-I02: Workspace authorization does not depend on platform-specific path strings alone.

PORT-I03: Host-specific shell/service/process mechanisms cannot bypass Core Policy/Approval.

PORT-I04: A missing Linux implementation may make a host capability unavailable, but it must not require redesigning Core contracts.

PORT-I05: Optional Runtime and Plugin contracts MUST NOT assume Windows unless the Plugin explicitly declares a Windows-only host requirement.

PORT-I06: Core diagnostics identify the Host platform and implementation capability without changing the meaning of Core status states.

PORT-I07: Platform-specific capabilities are explicit and queryable; unsupported operations fail as unsupported rather than through hidden fallback behavior.

## 6. Plugin / Component compatibility

A Plugin or Component may declare host requirements such as:

```text
platforms:
  - windows
```

or:

```text
platforms:
  - windows
  - linux
```

Platform support is a compatibility constraint, not an authority grant.

Core/Optional Runtime should refuse incompatible activation explicitly.

## 7. Multi-slot model

The V2 A/B multi-Runtime behavior is preserved on all supported Hosts.

Conceptually:

```text
Linux Host
  +-- Slot A -> Workspace A
  +-- Slot B -> Workspace B

Windows Host
  +-- Slot A -> Workspace A
  +-- Slot B -> Workspace B
```

Portability MUST NOT collapse independent Slot/Workspace isolation.

## 8. Deployment / Bootstrap

Bootstrap is platform-specific, but the desired resulting P05 topology is platform-neutral.

Windows may use:

- PowerShell installation scripts;
- Task Scheduler or equivalent broker;
- Windows service/process conventions.

Linux may use:

- shell installation scripts;
- systemd/user-service or equivalent broker;
- POSIX process/service conventions.

Bootstrap implementation differences MUST terminate at the Host Adapter/Host supervisor boundary.

## 9. Current implementation strategy

V3 does NOT require immediate full Linux delivery.

Accepted sequence:

1. define platform-neutral Core contracts;
2. preserve/refactor the existing Windows implementation behind WindowsHost/Host Adapter boundaries;
3. remove unnecessary Windows assumptions from Core modules;
4. add platform capability discovery;
5. implement LinuxHost later without changing Core behavior contracts;
6. run the same Core contract/acceptance suite on each supported Host.

## 10. Acceptance criteria for architecture

The V3 architecture is acceptable only if:

1. a Core module does not need to know whether command execution uses PowerShell or Bash;
2. Core lifecycle semantics do not depend on Scheduled Task specifically;
3. Core process supervision semantics do not depend on Windows-only APIs;
4. Workspace/security contracts remain valid on both Windows and POSIX-style filesystems;
5. a future LinuxHost can be added without changing public Core MCP contracts;
6. Windows-specific implementation remains fully usable during the migration.

## 11. Non-goals

This requirement does not commit V3 to:

- identical OS feature sets;
- GUI automation parity;
- Windows-only engineering application support on Linux;
- immediate Linux release;
- abstracting domain tools that are inherently OS-specific.

The requirement is architectural portability of Core, not forced portability of every Plugin.

## 12. Final rule

> Core semantics are platform-neutral. Host mechanics are platform-specific.

Windows is the first Host Adapter.
Linux is a future compatible Host Adapter.

