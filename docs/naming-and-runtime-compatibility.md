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
unchanged. So do the DinD data-volume behavior, environment files, health and
restart behavior, ports, registry trust and certificate paths, and Socketduct
attachment to `peakflow-builder`. These values are runtime contracts, not
product branding.

## Rollout and rollback

Roll out the source-only change first while keeping the repository and live
runtime names above. Render the base Compose file and both supported overlays,
verify the fixed default identities, and deploy only through the existing
drain-and-recreate procedure. This change does not use the supported explicit
`COMPOSE_PROJECT_NAME` override.

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
