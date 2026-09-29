# P05 SSH Gate (V2 hot patch prototype)

This is a deliberately small OpenSSH forced-command gate for H1. It is a V2
operational hot patch, not the V3 authorization architecture.

## Client contract

A dedicated SSH key is bound in `authorized_keys` to
`/usr/local/sbin/p05-ssh-gate`. The client sends only one fixed verb:

```text
inventory
apt-update
install-nvidia-toolkit 1.20.1-1
k3s-phase1-start
k3s-phase1-status
service-status chrony
service-status ssh
service-status nftables
evidence
```

Unknown commands are denied. The gate never uses `eval`, never executes an
arbitrary script path, and does not expose disk-write verbs.

## Server installation shape

1. Install `p05-ssh-gate.sh` as `/usr/local/sbin/p05-ssh-gate`, owned by
   root and mode 0755.
2. Install `p05-ssh-gate.sudoers` as `/etc/sudoers.d/p05-ssh-gate`, mode
   0440, then validate it with `visudo -cf /etc/sudoers.d/p05-ssh-gate`.
3. Use a **dedicated P05 gate key**, not the normal interactive admin key.
4. Add that public key to `~vaesadmin/.ssh/authorized_keys` with a forced
   command:

```text
restrict,command="/usr/local/sbin/p05-ssh-gate" ssh-ed25519 <PUBLIC_KEY> p05-h1-gate
```

Keep the existing interactive admin key unchanged so the gate cannot lock out
manual recovery access.

## Evidence

`evidence` writes only:

```text
/var/tmp/vaes-phase1-evidence/inventory-after-bootstrap.txt
```

The file contains OS, kernel, CPU, memory, block-device inventory, network
addresses, swap, time-sync status, and status for ssh/chrony/nftables.

## Fixed package mutation

The only package installation verb is:

```text
install-nvidia-toolkit 1.20.1-1
```

It expands server-side to the exact four NVIDIA Container Toolkit packages at
version `1.20.1-1`. Arbitrary package names, package versions and raw
`apt install` commands are not exposed through the gate.

## Long-running K3s job

`k3s-phase1-start` is the only gate verb that can start the fixed Phase-1 K3s
installer. It launches exactly:

```text
/usr/bin/bash /home/vaesadmin/04_h1_k3s_install.sh /home/vaesadmin/phase1.env
```

The gate detaches that process and returns immediately, so the P05 MCP request
does not sit on a ten-minute SSH timeout. The state is persisted under
`/var/tmp/p05-k3s-phase1`; repeated start calls while the job is running, or
after it has reached a terminal state, only return the existing state and do not
start another installer.

`k3s-phase1-status` is read-only and reports only the job state, timestamps,
PID and exit code. The install log is deliberately not exposed by this verb,
because the underlying script may print sensitive configuration.

## Non-goals

No reboot, shutdown, arbitrary package install/upgrade, arbitrary systemctl
action, arbitrary file write, arbitrary shell script execution, partitioning,
formatting, dd, wipefs, or other raw block-device mutation is exposed by this
prototype.
