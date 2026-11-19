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
changed by ownership. The volume is Compose-owned with a name derived from the
Compose project (`<project>_docker-server_data`), created on the first `up` and
reused by every recreation. It is not declared `external`, and its name is not a
Docker-generated 64-character id: Merovingian ran the `external` plus hex-id shape
and lost the builder when the pinned volume disappeared, because Compose then
refuses to create any container at all. The derived name is the contract; the
Compose key `docker-server-data` is only the handle that resolves to it. See
[DinD data volume](../README.md#dind-data-volume).

`docker volume prune`, `docker system prune --volumes`, `docker rm -v` and
`docker compose down -v` are forbidden against the host daemon and host Compose
project of a DinD builder: that daemon owns the builder's `/var/lib/docker` volume.
Pruning inside the nested daemon remains the allowed operation.

## Rollout and rollback

Roll out the source-only change first while keeping the repository and live
runtime names above. Render the base Compose file and both supported overlays,
verify the fixed default identities, and deploy only through the existing
drain-and-recreate procedure. This change does not use the supported explicit
`COMPOSE_PROJECT_NAME` override.

Each builder renders the derived volume name with no per-host pin. A builder still
on a generated anonymous id adopts it during its own migration window, and a builder
that does not migrate takes either the cold re-pull or the drained copy: both are
documented in the README, and both are recorded per host. No builder is allowed to
need a generated id in order to boot.

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
