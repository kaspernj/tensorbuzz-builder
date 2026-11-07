# Crash core capture

TensorBuzz builds that die from a fatal signal (glibc heap corruption,
segfault) leave core files that the backend crash-capture path turns into
gdb backtraces and build artifacts. The DinD host must let those cores be
written.

## Mechanism

- `scripts/prepare-docker-server-host.sh` writes
  `kernel.core_pattern = /tmp/cores/core.%e.%p.%t` into
  `/etc/sysctl.d/99-tensorbuzz-builder.conf` and applies it with
  `sysctl --system`.
- The kernel resolves a file core pattern against the **crashing process's
  own root filesystem**. Cores from nested build containers therefore land in
  that container's `/tmp/cores` — the TensorBuzz crash-capture service creates
  the directory inside the container before the build script runs and requests
  an unlimited core rlimit when it creates the container. Cores from host
  processes land in the host's `/tmp/cores`, which the prepare script creates.
- `kernel.core_pattern` is a per-init-user-namespace sysctl. The `docker-server`
  container is privileged and shares the host's init user namespace, so the
  pattern is a **host-wide** setting: it applies to every container and process
  on the host, including unrelated workloads. Replacing the pattern also
  replaces the distribution's default core handler (for example Ubuntu's
  apport), which stops collecting host cores from that moment on.
- The prepare script installs
  `/etc/cron.d/tensorbuzz-builder-cores`, which deletes host-level core files
  older than 24 hours. Build-container cores live in ephemeral containers and
  are removed with the container.

## Rollout notes

- Run the prepare script (as root) on each host before or after recreating
  `docker-server`; it is idempotent and overwrites only its own managed files.
  Hosts that predate the script get the core pattern only after it runs.
- Verify with `sysctl kernel.core_pattern` and `ls -ld /tmp/cores` after the
  script completes.
- A crash with no core file in a build container usually means the container
  has no `/tmp/cores` (capture did not arm) or its core rlimit is not
  unlimited (TensorBuzz build-container creation), not a host misconfiguration.
