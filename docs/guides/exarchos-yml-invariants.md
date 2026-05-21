# `.exarchos.yml` — `invariants` block

This page documents the `invariants` block of `.exarchos.yml`. The block
gates whether Exarchos's internal architectural-invariants catalog
(`docs/architecture/invariants.md`) is surfaced to your sessions at
`/exarchos:ideate` Phase 0 and consulted by the vocabulary-lint scanner.

The block is **default-disabled**: when omitted, the loader returns no
entries regardless of any `scope` argument. The committed `.exarchos.yml`
in the Exarchos repo declares the flag explicitly — that is how Exarchos
contributors inherit the catalog when working inside this repo. There is
no auto-detection.

## Schema

```yaml
# .exarchos.yml
invariants:
  devCatalog: enabled    # or: disabled (the default)
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `invariants.devCatalog` | enum `enabled \| disabled` | `disabled` | When `enabled`, the invariants catalog is surfaced. Any other state (omitted block, `disabled`, missing key) collapses to default-disabled at the loader. |

The schema is enforced by both `ExarchosConfigSchema`
(`servers/exarchos-mcp/src/config/exarchos-config-schema.ts`) and
`ProjectConfigSchema` (`servers/exarchos-mcp/src/config/yaml-schema.ts`) so
the same `.exarchos.yml` parses cleanly under either validator. Unknown
fields under `invariants:` are rejected (`.strict()`) so typos like
`devcatalog` (lowercase) surface as validation errors instead of being
silently ignored.

## When to enable

Set `invariants.devCatalog: enabled` if you are:

- **Contributing to Exarchos itself** — the committed `.exarchos.yml` in
  the Exarchos repo declares this, so contributors who clone the repo
  inherit the opt-in automatically.
- **Running internal evaluations or vocabulary lints** that need the
  catalog's typed entries (e.g. the `lint:invariants` workflow).

## When to leave disabled

Leave the flag unset (or `disabled`) if you are:

- **Using Exarchos as a plugin in a project that is NOT Exarchos** —
  the dev-internal invariants are scoped to Exarchos's own runtime
  design and are intentionally invisible to plugin consumers. Surfacing
  them at `/ideate` for an unrelated project would be misleading noise.
- **Working on Exarchos but want to suppress the catalog locally** —
  set `disabled` explicitly to override a parent committed file.

## Why default-disabled even inside Exarchos

The flag is a **declarative statement of intent** — "surface dev-internal
invariants to me." Surfacing them by default — even via auto-detection
based on repo identity — risks a future where a consumer's `.exarchos.yml`
accidentally triggers detection and they suddenly see Exarchos's
internals at every `/ideate`. Explicit opt-in eliminates that failure
mode entirely.

## See also

- Design proposal:
  [`docs/proposals/2026-05-20-invariants-catalog-v2-spec.md`](../proposals/2026-05-20-invariants-catalog-v2-spec.md)
  §1.1 (consumer-vs-dev catalog framing) and §4.0 (gating mechanism).
- Catalog: [`docs/architecture/invariants.md`](../architecture/invariants.md).
- Loader:
  [`servers/exarchos-mcp/src/architecture/invariants-loader.ts`](../../servers/exarchos-mcp/src/architecture/invariants-loader.ts).
- Implementation plan:
  [`docs/plans/2026-05-20-invariants-catalog-v2-implementation.md`](../plans/2026-05-20-invariants-catalog-v2-implementation.md)
  Wave B (gating mechanism).
