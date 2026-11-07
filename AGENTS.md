# Repository invariants

- `tensorbuzz-builder` is the canonical source and product identity.
- Tests must use `@velocious/testing` and run through `velocious-test`; do not replace the framework or runner.
- Keep the live legacy Compose project, container, network, volume, and checkout-path identities unchanged until a separately approved, drained-fleet migration.
