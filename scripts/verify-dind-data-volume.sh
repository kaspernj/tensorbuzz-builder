#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
CONTAINER="${BUILDER_CONTAINER_NAME:-peakflow_builder-docker-server-1}"
DATA_ROOT="${DIND_DATA_ROOT:-/var/lib/docker/volumes}"

# Read-only inventory. This script reports what the running builder owns and what
# is left unreferenced; it never removes, prunes, restarts, or repairs anything.
# Removal is an operator decision on one exact volume id, taken only after the
# mount table, the container mounts, the engine-id inside the data root, and the
# newest mtime in it all agree that the volume is dead.
main() {
  local container_volume
  container_volume="$(docker inspect "${CONTAINER}" \
    --format '{{range .Mounts}}{{if eq .Destination "/var/lib/docker"}}{{.Name}}{{end}}{{end}}')"

  if [[ -z "${container_volume}" ]]; then
    echo "${CONTAINER} has no volume mount at /var/lib/docker." >&2
    exit 1
  fi

  echo "Data volume owned by ${CONTAINER}: ${container_volume}"

  local container_ids
  container_ids="$(docker ps -aq)"

  local referenced=""
  if [[ -n "${container_ids}" ]]; then
    referenced="$(printf '%s\n' "${container_ids}" | xargs -r docker inspect \
      --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}')"
  fi

  if [[ ! -d "${DATA_ROOT}" ]]; then
    echo "Data root ${DATA_ROOT} is not readable here; run this as root on the builder host." >&2
    exit 1
  fi

  local unreferenced_count=0
  local data_root_count=0

  while IFS= read -r volume; do
    [[ -z "${volume}" ]] && continue
    data_root_count=$((data_root_count + 1))

    if printf '%s\n' "${referenced}" | grep -qx -- "${volume}"; then
      continue
    fi

    unreferenced_count=$((unreferenced_count + 1))
    local engine_id="unknown"
    if [[ -f "${DATA_ROOT}/${volume}/_data/engine-id" ]]; then
      engine_id="$(tr -d '\n' <"${DATA_ROOT}/${volume}/_data/engine-id")"
    fi
    echo "Unreferenced data-root volume: ${volume} engine-id=${engine_id}"
  done < <(find "${DATA_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')

  echo "Data-root directories: ${data_root_count}, unreferenced: ${unreferenced_count}"

  if [[ "${unreferenced_count}" -ne 0 ]]; then
    echo "Report only. Do not prune; an unreferenced data-root volume is removed by exact name or not at all." >&2
    exit 1
  fi

  echo "Completed by ${SCRIPT_NAME}."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
