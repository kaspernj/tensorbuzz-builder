# TensorBuzz Builder

Docker Compose setup for the TensorBuzz Docker build server.

The source and product name is `tensorbuzz-builder`. Existing runtime names are
intentionally retained for in-place compatibility; see
[Naming and runtime compatibility](docs/naming-and-runtime-compatibility.md).

## Topology configuration

Copy `.env.example` to `.env` and choose values appropriate for the deployment.
The defaults retain the existing subnet, service addresses, and ports, but no
particular physical network or machine is required:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `peakflow_builder` | Optional explicit operator override of the compatibility-preserving Compose project prefix |
| `BUILDER_NETWORK_NAME` | unset | Exact Docker network name when `docker-compose.network-name.yml` is selected |
| `BUILDER_NETWORK_SUBNET` | `58.0.0.0/24` | Non-overlapping subnet assigned to that network |
| `DOCKER_SERVER_IPV4_ADDRESS` | `58.0.0.2` | `docker-server` address inside the subnet |
| `REGISTRY_CACHE_IPV4_ADDRESS` | `58.0.0.3` | Local `registry-cache` address inside the subnet |
| `DOCKER_SERVER_TLS_PORT` | `8676` | TLS Docker API listener inside `docker-server` |
| `HOST_PORT` | `8676` | Host publication for the base TLS listener |
| `DOCKER_SERVER_SOCKETDUCT_PORT` | `2375` | Plaintext Docker API listener in Socketduct mode |
| `DOCKER_SERVER_MEMORY_LIMIT` | `20g` | Hard RAM and combined RAM-plus-swap ceiling for the DinD parent and every nested child |
| `REGISTRY_CACHE_HOST` | `registry-cache` | Cache hostname or address reached by the Docker daemon |
| `REGISTRY_CACHE_PORT` | `5000` | Cache listener and Docker daemon endpoint port |
| `REGISTRY_PROXY_REMOTEURL` | `https://registry-1.docker.io` | Upstream registry mirrored by a local cache |
| `REGISTRY_CACHE_BIND` | `127.0.0.1` | Host address used to publish a local cache |
| `REGISTRY_CACHE_BIND_PORT` | `5000` | Host port used to publish a local cache |

Both service addresses must belong to `BUILDER_NETWORK_SUBNET`. Choose a subnet
that does not overlap host routes or other Docker networks.

`docker-server`, `registry-cache`, and `peakflow-builder` remain stable logical
Compose identifiers because the override, service DNS, profile, and network
attachments use them as application contracts. They are not physical machine or
network names. The checked-in Compose default explicitly keeps the legacy
`peakflow_builder` project, regardless of checkout directory name, so the parent
container remains `peakflow_builder-docker-server-1` and the default network
remains `peakflow_builder_peakflow-builder`. An operator can still set
`COMPOSE_PROJECT_NAME` explicitly, but this rename rollout does not use that
override.

To assign an exact arbitrary Docker network name instead, add the tracked
exact-name override to the persisted mode and set `BUILDER_NETWORK_NAME`:

```env
COMPOSE_FILE=docker-compose.yml:docker-compose.network-name.yml
BUILDER_NETWORK_NAME=tensorbuzz-builder-net
```

`tensorbuzz-builder-net` is only an example. Use `registry-cache` as
`REGISTRY_CACHE_HOST` only when the local cache profile is enabled; otherwise
provide a resolvable external hostname or address.

## Memory containment

The checked-in default gives the complete `docker-server` cgroup a 20 GiB hard
RAM limit and the same 20 GiB combined RAM-plus-swap limit. One
`DOCKER_SERVER_MEMORY_LIMIT` value drives both Compose controls, so they cannot
drift and silently re-enable swap. The parent cgroup includes `dockerd`, all
nested build and service containers, nested filesystem page cache and slab, and
small management containers such as the Socketduct gateway.

TensorBuzz admission remains a separate 16 GiB estimated-use envelope. It sums
measured or configured estimates for each build and its services; those
reservations are scheduling guidance rather than kernel limits. The 20 GiB
parent ceiling is sized as that 16 GiB envelope plus a 4 GiB allowance for the
DinD daemon and kernel-accounted overhead. Large reclaimable layer/page caches
are reclaimed inside the parent instead of growing until the shared host
exhausts memory. Do not lower the TensorBuzz budget to compensate for parent
overhead, and do not raise the parent limit without rechecking the
controller-model peak plus host/OS margin.

Build and service containers retain their own hard limits. A child that exceeds
its limit is failed by Docker and reported by the build path; the parent limit is
the aggregate containment boundary that prevents all nested work and cache from
pressuring unrelated host services. Do not hide a contained failure with retries.

Before rollout, render the effective model and require both values to be equal:

```bash
docker compose config --format json
```

A rollout requires draining accepted/running builds because recreating
`docker-server` interrupts its nested daemon. Reuse the existing Docker data
mount/volume so images, caches, volumes, and stopped nested state survive the
recreation. Afterward, verify the outer container's `HostConfig.Memory` and
`HostConfig.MemorySwap`, cgroup `memory.max`, zero `memory.swap.max`, nested
Docker API health, and Socketduct connectivity before returning the builder to
scheduling.

Rollback is the previous repository revision followed by the same drained
recreation and readback. That restores the previous unlimited parent model, so
use it only to recover a concrete incompatibility and keep the builder drained
until another safe containment plan is selected.

## Docker API modes

### Default: host-published TLS

The base `docker-compose.yml` is the secure default on any network. It keeps the
Unix socket and publishes a certificate-verified TCP listener from
`DOCKER_SERVER_TLS_PORT` to `HOST_PORT` on the host.

Persist this mode in `.env`:

```env
COMPOSE_FILE=docker-compose.yml
```

Then start or recreate `docker-server`:

```bash
docker compose up -d --remove-orphans docker-server
```

### Trusted private network: Socketduct reverse gateway

When the Socketduct gateway and builder share a trusted private Docker network,
layer the tracked override by replacing `COMPOSE_FILE` in `.env`:

```env
COMPOSE_FILE=docker-compose.yml:docker-compose.socketduct.yml
```

If this deployment also needs an exact Docker network name, include both
overrides and set the name explicitly:

```env
COMPOSE_FILE=docker-compose.yml:docker-compose.socketduct.yml:docker-compose.network-name.yml
BUILDER_NETWORK_NAME=tensorbuzz-builder-net
```

Then use the same start command:

```bash
docker compose up -d --remove-orphans docker-server
```

The override replaces the daemon command, disables the image's automatic TLS
setup, and clears the base file's published ports. The stock DinD entrypoint
still performs its normal initialization once, then starts the explicit
`dockerd` command without adding automatic listeners. The plaintext Docker API
is reachable at `docker-server:${DOCKER_SERVER_SOCKETDUCT_PORT}` by containers
attached to the logical `peakflow-builder` network, whose actual name is either
project-scoped or explicitly selected as described above. Never publish this
port on the host, and do not select this mode when that Docker network is
untrusted or shared.

The override inherits the base image and volume configuration unchanged,
including `/var/lib/docker` data-volume behavior, `/shared`, and the private
registry certificate mount at `/etc/docker/certs.d`.

Docker Compose automatically reads `COMPOSE_FILE` from `.env`, so the bare
commands in this README and the scripts in `scripts/` preserve the selected
mode. Recreating `docker-server` interrupts its nested Docker daemon and all
nested workloads, including running builds, so drain the builder first.

## Registry cache modes

The registry cache mode is independent of the Docker API mode.

### External cache

Leave the local profile disabled and set the cache endpoint to a hostname or IP
address reachable from `docker-server`:

```env
COMPOSE_PROFILES=
REGISTRY_CACHE_HOST=cache.example.net
REGISTRY_CACHE_PORT=5000
```

`cache.example.net` is an example and must be replaced for the deployment.
Start or recreate the Docker server with the selected Docker API mode:

```bash
docker compose up -d --remove-orphans docker-server
```

### Local cache

Enable the profile and use the stable service identifier as the cache host:

```env
COMPOSE_PROFILES=registry-cache
REGISTRY_CACHE_HOST=registry-cache
REGISTRY_CACHE_PORT=5000
REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io
REGISTRY_CACHE_BIND=127.0.0.1
REGISTRY_CACHE_BIND_PORT=5000
```

Then start both services:

```bash
docker compose up -d
```

Verify the cache through its configured host publication:

```bash
set -a
. ./.env
set +a
curl "http://${REGISTRY_CACHE_BIND}:${REGISTRY_CACHE_BIND_PORT}/v2/"
```

Expected response:

```json
{}
```

## Private registry certificates

The Docker daemon reads private-registry trust roots from the host-managed
directory mounted at `/etc/docker/certs.d`. The default source directory is:

```text
./shared/docker-certs.d
```

Install each public CA using Docker's registry-specific directory layout:

```text
shared/docker-certs.d/<registry-host>:<port>/ca.crt
```

For example:

```text
shared/docker-certs.d/registry.example:5001/ca.crt
```

The certificate files are host-specific and ignored by Git. Set
`DOCKER_REGISTRY_CERTS_DIR` in `.env` to mount a different host directory.

Validate the configuration before recreating the Docker server:

```bash
docker compose config --quiet
```

As noted above, recreating `docker-server` interrupts its nested workloads. To
install a CA without recreating `docker-server`, copy it on the host to
`DOCKER_REGISTRY_CERTS_DIR/<registry-host>:<port>/ca.crt` (using
`./shared/docker-certs.d` by default). The existing read-only bind exposes that
file at `/etc/docker/certs.d/<registry-host>:<port>/ca.crt` inside the running
container immediately. Do not copy into the container path itself; the mount is
read-only.
