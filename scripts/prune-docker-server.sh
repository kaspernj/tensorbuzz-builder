#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

# Prunes inside the nested daemon only: compose exec runs docker system prune
# inside the docker-server container. Never run docker system prune, docker volume
# prune or docker rm -v against the host daemon of a DinD builder - that is the
# daemon that owns the builder's /var/lib/docker data volume, and pruning there
# deletes the whole nested daemon root.
docker compose exec docker-server docker system prune -a -f --volumes

echo "Docker system prune completed on docker-server."
