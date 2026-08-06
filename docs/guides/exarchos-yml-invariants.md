# `.exarchos.yml` — `invariants` block

This page documents the `invariants` block of `.exarchos.yml`. The block lets
a **consumer** bring their own invariants and tune which shipped ones gate. It
is the user-extensibility surface — see the [authoring guide](authoring-invariants.md)
for a worked walkthrough.

The block is **default-disabled / opt-in**: when omitted, no user catalogs are
loaded. There is no auto-detection.

## Schema

```yaml
# .exarchos.yml
invariants:
  catalogs:                      # consumer-authored catalog files (explicit; no auto-detect)
    - .exarchos/invariants.yml   # string: defaults to tier 'user'
    - { path: design.md, tier: dev }   # object: explicit tier
  overrides:                     # tune shipped invariants by id (tier-bounded)
    SDLC-3: { severity: advisory }
    SDLC-7: { enabled: false }   # clamped to advisory if the invariant's floor forbids disable
  enforcement:
    review: blocking             # or: advisory — whether invariant findings gate the review verdict
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `invariants.catalogs` | `(string \| { path, tier? })[]` | `[]` | List of consumer-authored catalog files. Bare string → `tier: 'user'`; object with `{ path, tier }` → explicit tier. **Explicit listing only** — a file present on disk is not auto-loaded. |
| `invariants.overrides` | `Record<id, { severity?, enabled? }>` | `{}` | Tune a shipped (`SDLC-*`) invariant's severity, or disable it. Bounded by the invariant's `integrity-class` floor (see below). |
| `invariants.enforcement.review` | enum `blocking \| advisory` | `blocking` | When the key is omitted the gate treats findings as `blocking`. When `advisory`, invariant-conformance findings are reported but do not drive the review verdict to NEEDS_FIXES/BLOCKED. |

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
| `substrate` | nothing (immutable) | Protects runtime integrity *within its own catalog's audience*. Exarchos's substrate invariants are internal and never reach a consumer, so this only ever binds a consumer to *their own* declared-substrate invariants. |
| `sdlc` / `authoring` | downgrade to `advisory` | Tunable but never silently removable — `enabled: false` clamps to `advisory` (with a warning) when the floor forbids disable. Mirrors how `review.dimensions` lets you set blocking/advisory but not invent or delete dimensions. |
| `user` | anything (fully owned) | A consumer's own invariants in their own catalog. |

A consumer **cannot** disable an Exarchos `substrate` invariant because it is
never present in their resolved catalog — not because of a permission check.

## Registering catalogs

Add catalog files to the `catalogs:` list to surface your own invariants:

```yaml
invariants:
  catalogs:
    - .exarchos/invariants.yml      # bare string → tier defaults to 'user'
    - { path: team-standards.md, tier: user }   # explicit format
```

Listing is explicit by design (no auto-detection). Multiple files may be listed
and merge in order. Each entry in the list can be:
- A **bare string** (path) → defaults to `tier: 'user'`
- An **object** with `{ path, tier? }` → explicit tier (optional; defaults to `'user'`)

The `tier` field controls override authority (see §1.1 below). For
consumer-authored catalogs, always use `tier: 'user'`.

## Authoring your own invariants

To define project-specific invariants (e.g. "every handler must emit an audit
event"), list a catalog file under `catalogs:` and author entries against the
v3 schema. The merged effective catalog flows through the *same* surfacing →
projection → `check_invariant_conformance` gate machinery Exarchos uses on
itself. See **[Authoring invariants](authoring-invariants.md)** for the schema,
the check DSL, and a worked example.

## See also

- **[Authoring invariants](authoring-invariants.md)** — consumer-facing how-to.
- Design: [`docs/designs/archive/2026-05-23-invariants-projection-and-extensibility.md`](../designs/archive/2026-05-23-invariants-projection-and-extensibility.md).
- v2 framing: [`docs/proposals/2026-05-20-invariants-catalog-v2-spec.md`](../proposals/2026-05-20-invariants-catalog-v2-spec.md) §1.1, §4.0.
- Catalog: [`.exarchos/invariants.md`](../../.exarchos/invariants.md).
- Loader: [`servers/exarchos-mcp/src/architecture/invariants-loader.ts`](../../servers/exarchos-mcp/src/architecture/invariants-loader.ts).
- Effective-catalog resolver: [`servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts`](../../servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts).
- Contract seam: [`docs/architecture/invariants-v3-contract-seam.md`](../architecture/invariants-v3-contract-seam.md).
