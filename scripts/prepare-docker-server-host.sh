#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SYSCTL_FILE="/etc/sysctl.d/99-tensorbuzz-builder.conf"
LIMITS_FILE="/etc/security/limits.d/99-tensorbuzz-builder.conf"
LEGACY_SYSCTL_FILE="/etc/sysctl.d/99-peakflow-builder.conf"
LEGACY_LIMITS_FILE="/etc/security/limits.d/99-peakflow-builder.conf"

SYSCTL_CONTENT="$(cat <<'EOF'
# TensorBuzz builder host tuning for a process-heavy Docker-in-Docker service.
fs.file-max = 2097152
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 1048576
kernel.pid_max = 4194304
vm.max_map_count = 262144
EOF
)"

LIMITS_CONTENT="$(cat <<'EOF'
# Raise login-session limits so large container ulimits are not blocked by the host.
* soft nofile 262144
* hard nofile 524288
* soft nproc 65535
* hard nproc 65535
root soft nofile 262144
root hard nofile 524288
root soft nproc 65535
root hard nproc 65535
EOF
)"

LEGACY_SYSCTL_CONTENT="$(cat <<'EOF'
# Peakflow builder host tuning for a process-heavy Docker-in-Docker service.
fs.file-max = 2097152
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 1048576
kernel.pid_max = 4194304
vm.max_map_count = 262144
EOF
)"

LEGACY_LIMITS_CONTENT="${LIMITS_CONTENT}"

fail() {
  echo "$*" >&2
  return 1
}

validate_known_legacy_tuning_file() {
  local legacy_file="$1"
  local expected_content="$2"

  if [[ ! -e "${legacy_file}" && ! -L "${legacy_file}" ]]; then
    return 0
  fi

  if [[ -L "${legacy_file}" || ! -f "${legacy_file}" ]] ||
    ! cmp --silent -- "${legacy_file}" <(printf '%s\n' "${expected_content}"); then
    fail "Refusing to remove modified or unknown legacy tuning file: ${legacy_file}"
  fi
}

validate_managed_tuning_file() {
  local managed_file="$1"

  if [[ -L "${managed_file}" || ( -e "${managed_file}" && ! -f "${managed_file}" ) ]]; then
    fail "Refusing to overwrite non-regular managed tuning file: ${managed_file}"
  fi
}

migrate_known_legacy_tuning_files() {
  local legacy_sysctl_file="$1"
  local legacy_limits_file="$2"
  local managed_sysctl_file="$3"
  local managed_limits_file="$4"

  validate_known_legacy_tuning_file \
    "${legacy_sysctl_file}" "${LEGACY_SYSCTL_CONTENT}" || return 1
  validate_known_legacy_tuning_file \
    "${legacy_limits_file}" "${LEGACY_LIMITS_CONTENT}" || return 1
  validate_managed_tuning_file "${managed_sysctl_file}" || return 1
  validate_managed_tuning_file "${managed_limits_file}" || return 1

  if [[ -e "${legacy_sysctl_file}" ]]; then
    rm -- "${legacy_sysctl_file}"
  fi
  if [[ -e "${legacy_limits_file}" ]]; then
    rm -- "${legacy_limits_file}"
  fi
}

write_managed_tuning_file() {
  local managed_file="$1"
  local content="$2"

  validate_managed_tuning_file "${managed_file}" || return 1
  printf '%s\n' "${content}" >"${managed_file}"
}

main() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run as root: sudo $0"
    exit 1
  fi

  if [[ ! -e /dev/kvm ]]; then
    echo "Missing /dev/kvm on the host. Enable KVM before starting docker-server."
    exit 1
  fi

  migrate_known_legacy_tuning_files \
    "${LEGACY_SYSCTL_FILE}" \
    "${LEGACY_LIMITS_FILE}" \
    "${SYSCTL_FILE}" \
    "${LIMITS_FILE}"
  write_managed_tuning_file "${SYSCTL_FILE}" "${SYSCTL_CONTENT}"
  write_managed_tuning_file "${LIMITS_FILE}" "${LIMITS_CONTENT}"

  sysctl --system

  cat <<EOF
Prepared host settings for tensorbuzz-builder.

Files written:
  ${SYSCTL_FILE}
  ${LIMITS_FILE}

Next steps:
  1. Restart any long-lived shell or service session that should inherit the new limits.
  2. Recreate the Compose stack:
       ./scripts/recreate-docker-server.sh
  3. Verify inside the container:
       docker compose exec docker-server sh -lc 'ulimit -n && ulimit -u && df -h /dev/shm && ls -l /dev/kvm'

If you want different limits, adjust these environment variables in your shell or Compose env file before starting:
  DOCKER_SERVER_SHM_SIZE
  DOCKER_SERVER_NOFILE_SOFT
  DOCKER_SERVER_NOFILE_HARD
  DOCKER_SERVER_NPROC

Completed by ${SCRIPT_NAME}.
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
