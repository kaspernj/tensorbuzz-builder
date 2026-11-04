# Naming and runtime compatibility

`tensorbuzz-builder` is the canonical source and product name. The source rename
is deliberately separate from runtime migration: changing a Compose identifier
in place could create a second parent, network, or data volume instead of
upgrading the running builder.

## Exact legacy allowlist

Only these legacy names remain as compatibility or migration contracts:

- Compose project: `peakflow_builder`.
- Compose service: `docker-server`.
- Existing parent container: `peakflow_builder-docker-server-1`.
- Logical Compose network key: `peakflow-builder`.
- Default generated network: `peakflow_builder_peakflow-builder`.
- Existing checkout directories whose final component is `peakflow_builder`,
  including `/home/dev/peakflow_builder`; this source rename does not move them.
- Known host-tuning migration inputs:
  `/etc/sysctl.d/99-peakflow-builder.conf` and
  `/etc/security/limits.d/99-peakflow-builder.conf`. The host preparation script
  removes them only when their contents exactly match the previously managed
  files; an unknown or locally modified file fails loudly and remains untouched.

Future host preparation writes `/etc/sysctl.d/99-tensorbuzz-builder.conf` and
`/etc/security/limits.d/99-tensorbuzz-builder.conf`.

The existing `./shared:/shared`, registry-certificate bind at
`/etc/docker/certs.d`, and `./registry-data:/var/lib/registry` mounts remain
unchanged. So do environment files, health and restart behavior, ports, registry
trust and certificate paths, and Socketduct attachment to `peakflow-builder`.
These values are runtime contracts, not product branding.

The DinD data volume is the one mount contract that changed deliberately, and it
changed by ownership rather than by name: each builder keeps the volume it already
runs on, now declared `external` so no recreation path can strand it. The per-host
volume itself is the contract; the Compose key `docker-server-data` is only the
handle that resolves to it. See
[DinD data volume](../README.md#dind-data-volume).

## Rollout and rollback

Roll out the source-only change first while keeping the repository and live
runtime names above. Render the base Compose file and both supported overlays,
verify the fixed default identities, and deploy only through the existing
drain-and-recreate procedure. This change does not use the supported explicit
`COMPOSE_PROJECT_NAME` override.

Each builder pins its existing DinD data volume in its own `.env` before that
recreate. A builder that has not pinned one fails at `docker compose config` or
`up` instead of coming up on a second, empty data root.

If source-level validation fails, revert this source revision; no runtime-name
rollback is needed because those identities did not change. If a later deploy
reveals a concrete incompatibility, drain the builder and redeploy the previous
revision while preserving all existing mounts and data volumes.

## Future migration boundary

Removing any allowlisted legacy name requires separate approval and a drained
fleet plan. That plan must inventory and migrate parent containers, networks,
volumes, checkout paths, certificates, registry trust, environment files, and
Socketduct attachments; prove data reuse and connectivity; and define a tested
rollback before scheduling resumes. It is outside this source rename.
