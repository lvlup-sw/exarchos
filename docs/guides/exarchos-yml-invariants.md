# `.exarchos.yml` — `invariants` block

This page documents the `invariants` block of `.exarchos.yml`. The block has
two distinct jobs:

1. **`devCatalog`** gates whether Exarchos's *internal* architectural-invariants
   catalog (`docs/architecture/invariants.md`) is surfaced to your sessions at
   `/exarchos:ideate` Phase 0 and consulted by the vocabulary-lint scanner.
2. **`catalogs` / `overrides` / `enforcement`** (schema v3) let a **consumer**
   bring their *own* invariants and tune which shipped ones gate. These are the
   user-extensibility surface — see the
   [authoring guide](authoring-invariants.md) for a worked walkthrough.

The block is **default-disabled / opt-in**: when omitted, the dev catalog
loader returns no entries and no user catalogs are loaded. There is no
auto-detection.

## Schema

```yaml
# .exarchos.yml
invariants:
  devCatalog: enabled            # or: disabled (the default)

  # --- user extensibility (schema v3, all optional) ---
  catalogs:                      # consumer-authored catalog files (explicit; no auto-detect)
    - .exarchos/invariants.yml
  overrides:                     # tune shipped invariants by id (tier-bounded)
    SDLC-3: { severity: advisory }
    SDLC-7: { enabled: false }   # clamped to advisory if the invariant's floor forbids disable
  enforcement:
    review: blocking             # or: advisory — whether invariant findings gate the review verdict
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `invariants.devCatalog` | enum `enabled \| disabled` | `disabled` | When `enabled`, Exarchos's dev-internal catalog is surfaced. Consumers leave this off. |
| `invariants.catalogs` | `string[]` | `[]` | Paths to consumer-authored catalog files. **Explicit listing only** — a file present on disk is not auto-loaded. |
| `invariants.overrides` | `Record<id, { severity?, enabled? }>` | `{}` | Tune a shipped (`SDLC-*`) invariant's severity, or disable it. Bounded by the invariant's `integrity-class` floor (see below). |
| `invariants.enforcement.review` | enum `blocking \| advisory` | (gate default) | When `advisory`, invariant-conformance findings are reported but do not drive the review verdict to NEEDS_FIXES/BLOCKED. |

The schema is enforced by `InvariantsConfigSchema`
(`servers/exarchos-mcp/src/config/exarchos-config-schema.ts`), reused by
`ProjectConfigSchema`. Unknown fields under `invariants:` (and under each
`overrides` entry) are rejected (`.strict()`), so typos surface as validation
errors instead of being silently ignored.

## Override authority — `integrity-class` floors

Each invariant declares an `integrity-class` that governs **who may override it**.
This is *per-catalog-audience* authority, not a global privilege ladder:

| `integrity-class` | Consumer may… | Rationale |
|---|---|---|
| `substrate` | nothing (immutable) | Protects runtime integrity *within its own catalog's audience*. Exarchos's substrate invariants are `devCatalog`-gated and never reach a consumer, so this only ever binds a consumer to *their own* declared-substrate invariants. |
| `sdlc` / `authoring` | downgrade to `advisory` | Tunable but never silently removable — `enabled: false` clamps to `advisory` (with a warning) when the floor forbids disable. Mirrors how `review.dimensions` lets you set blocking/advisory but not invent or delete dimensions. |
| `user` | anything (fully owned) | A consumer's own invariants in their own catalog. |

A consumer **cannot** disable an Exarchos `substrate` invariant because it is
never present in their resolved catalog — not because of a permission check.

## When to enable `devCatalog`

Set `invariants.devCatalog: enabled` if you are **contributing to Exarchos
itself** (the committed `.exarchos.yml` declares it, so contributors inherit
the opt-in) or **running internal evals / vocabulary lints** that need the
typed catalog entries. Leave it unset/`disabled` when **using Exarchos as a
plugin in a non-Exarchos project** — the dev-internal invariants are scoped to
Exarchos's own runtime design and would be misleading noise elsewhere.

## Authoring your own invariants

To define project-specific invariants (e.g. "every handler must emit an audit
event"), list a catalog file under `catalogs:` and author entries against the
v3 schema. The merged effective catalog flows through the *same* surfacing →
projection → `check_invariant_conformance` gate machinery Exarchos uses on
itself. See **[Authoring invariants](authoring-invariants.md)** for the schema,
the check DSL, and a worked example.

## See also

- **[Authoring invariants](authoring-invariants.md)** — consumer-facing how-to.
- Design: [`docs/designs/2026-05-23-invariants-projection-and-extensibility.md`](../designs/2026-05-23-invariants-projection-and-extensibility.md).
- v2 framing: [`docs/proposals/2026-05-20-invariants-catalog-v2-spec.md`](../proposals/2026-05-20-invariants-catalog-v2-spec.md) §1.1, §4.0.
- Catalog: [`docs/architecture/invariants.md`](../architecture/invariants.md).
- Loader: [`servers/exarchos-mcp/src/architecture/invariants-loader.ts`](../../servers/exarchos-mcp/src/architecture/invariants-loader.ts).
- Effective-catalog resolver: [`servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts`](../../servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts).
- Contract seam: [`docs/architecture/invariants-v3-contract-seam.md`](../architecture/invariants-v3-contract-seam.md).
