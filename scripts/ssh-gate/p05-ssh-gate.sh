#!/usr/bin/env bash
set -euo pipefail

EVIDENCE_DIR="/var/tmp/vaes-phase1-evidence"
EVIDENCE_FILE="$EVIDENCE_DIR/inventory-after-bootstrap.txt"
K3S_JOB_DIR="/var/tmp/p05-k3s-phase1"
K3S_STATE_FILE="$K3S_JOB_DIR/state"
K3S_PID_FILE="$K3S_JOB_DIR/pid"
K3S_LOG_FILE="$K3S_JOB_DIR/install.log"
K3S_SCRIPT="/home/vaesadmin/04_h1_k3s_install.sh"
K3S_ENV="/home/vaesadmin/phase1.env"
SELF="/usr/local/sbin/p05-ssh-gate"

deny() {
  printf 'p05-ssh-gate: command denied\n' >&2
  exit 126
}

service_status() {
  case "${1:-}" in
    chrony|ssh|nftables) ;;
    *) deny ;;
  esac

  printf 'service=%s\n' "$1"
  /usr/bin/systemctl is-active "$1" || true
  /usr/bin/systemctl is-enabled "$1" || true
}

inventory() {
  printf '=== timestamp ===\n'
  /usr/bin/date --iso-8601=seconds

  printf '\n=== os ===\n'
  if [[ -r /etc/os-release ]]; then
    /usr/bin/cat /etc/os-release
  fi

  printf '\n=== kernel ===\n'
  /usr/bin/uname -a

  printf '\n=== cpu ===\n'
  /usr/bin/lscpu

  printf '\n=== memory ===\n'
  /usr/bin/free -h

  printf '\n=== block devices ===\n'
  /usr/bin/lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS,MODEL,SERIAL

  printf '\n=== network ===\n'
  /usr/sbin/ip -brief address

  printf '\n=== swap ===\n'
  /usr/sbin/swapon --show || true

  printf '\n=== time sync ===\n'
  /usr/bin/timedatectl status || true

  printf '\n=== services ===\n'
  for svc in ssh chrony nftables; do
    service_status "$svc"
  done
}

write_evidence() {
  /usr/bin/install -d -m 0750 "$EVIDENCE_DIR"
  umask 027
  inventory > "$EVIDENCE_FILE"
  printf '%s\n' "$EVIDENCE_FILE"
}

k3s_phase1_status() {
  if [[ ! -r "$K3S_STATE_FILE" ]]; then
    printf 'state=idle\n'
    return 0
  fi

  /usr/bin/cat "$K3S_STATE_FILE"
  if /usr/bin/grep -qx 'state=running' "$K3S_STATE_FILE"; then
    if [[ -r "$K3S_PID_FILE" ]]; then
      local pid
      pid="$(/usr/bin/cat "$K3S_PID_FILE")"
      if [[ "$pid" =~ ^[0-9]+$ ]] && /usr/bin/kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
    fi
    printf 'runner=not-active\n'
  fi
}

k3s_phase1_runner() {
  /usr/bin/install -d -m 0750 "$K3S_JOB_DIR"
  set +e
  /usr/bin/sudo -n /usr/bin/bash "$K3S_SCRIPT" "$K3S_ENV" >"$K3S_LOG_FILE" 2>&1
  local rc=$?
  local finished
  finished="$(/usr/bin/date --iso-8601=seconds)"
  local state="failed"
  if [[ "$rc" -eq 0 ]]; then
    state="succeeded"
  fi

  local temp="$K3S_STATE_FILE.tmp.$$"
  {
    printf 'state=%s\n' "$state"
    printf 'exit_code=%s\n' "$rc"
    printf 'finished_at=%s\n' "$finished"
  } >"$temp"
  /usr/bin/mv -f "$temp" "$K3S_STATE_FILE"
  /usr/bin/rm -f "$K3S_PID_FILE"
  return 0
}

k3s_phase1_start() {
  /usr/bin/install -d -m 0750 "$K3S_JOB_DIR"

  if [[ -r "$K3S_STATE_FILE" ]]; then
    local current
    current="$(/usr/bin/head -n 1 "$K3S_STATE_FILE")"
    if [[ "$current" == "state=running" || "$current" == "state=succeeded" || "$current" == "state=failed" ]]; then
      k3s_phase1_status
      return 0
    fi
  fi

  if [[ ! -r "$K3S_SCRIPT" || ! -r "$K3S_ENV" ]]; then
    printf 'state=blocked\nreason=missing-fixed-script-or-env\n'
    return 0
  fi

  local started
  started="$(/usr/bin/date --iso-8601=seconds)"
  /usr/bin/nohup "$SELF" --internal-k3s-run </dev/null >/dev/null 2>&1 &
  local pid=$!

  printf '%s\n' "$pid" >"$K3S_PID_FILE"
  {
    printf 'state=running\n'
    printf 'started_at=%s\n' "$started"
    printf 'pid=%s\n' "$pid"
  } >"$K3S_STATE_FILE"

  printf 'state=running\nstarted_at=%s\npid=%s\n' "$started" "$pid"
}

if [[ "${1:-}" == "--internal-k3s-run" ]]; then
  k3s_phase1_runner
  exit 0
fi

original="${SSH_ORIGINAL_COMMAND:-}"

case "$original" in
  inventory)
    inventory
    ;;
  apt-update)
    exec /usr/bin/sudo -n /usr/bin/apt-get update
    ;;
  "install-nvidia-toolkit 1.20.1-1")
    exec /usr/bin/sudo -n /usr/bin/apt-get install -y \
      nvidia-container-toolkit=1.20.1-1 \
      nvidia-container-toolkit-base=1.20.1-1 \
      libnvidia-container-tools=1.20.1-1 \
      libnvidia-container1=1.20.1-1
    ;;
  k3s-phase1-start)
    k3s_phase1_start
    ;;
  k3s-phase1-status)
    k3s_phase1_status
    ;;
  "service-status chrony")
    service_status chrony
    ;;
  "service-status ssh")
    service_status ssh
    ;;
  "service-status nftables")
    service_status nftables
    ;;
  evidence)
    write_evidence
    ;;
  *)
    deny
    ;;
esac
