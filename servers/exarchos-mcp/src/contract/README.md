# Contract authority freeze (P03-01)

**Head of the PROGRAM-03 dependency chain.** Freezes the authorities that every
downstream generator (P03-02 contract compiler, P03-03 MCP binding generation,
P03-04 CLI generation, P03-05 shared admission IR, P03-06 standard artifacts,
P03-07 extension trust, P03-08/09 independent oracle) must build against, so
generation and release are pinned to an **approved** snapshot rather than
whatever floats in at build time.

> Exit proof: *floating or unapproved authority digests block generation and
> release.*

## The authority set

| Authority id           | kind       | version                                   | digest                                             |
| ---------------------- | ---------- | ----------------------------------------- | -------------------------------------------------- |
| `strategos-contracts`  | `schema`   | exarchos-mcp package version              | `src/architecture/invariant-schema.ts` (stand-in)  |
| `mcp-protocol`         | `protocol` | `LATEST_PROTOCOL_VERSION` (SDK)           | — (version-only)                                   |
| `mcp-sdk`              | `package`  | `@modelcontextprotocol/sdk` dependency    | — (version-only; must be an **exact** pin)         |
| `action-id-registry`   | `registry` | — (digest-only)                           | sorted `<tool>.<action>` ActionIds from `registry` |
| `compatibility-policy` | `policy`   | `COMPATIBILITY_POLICY_VERSION`            | `src/lib/plugin-compat.ts`                         |
| `invariant-catalog`    | `catalog`  | `.exarchos/invariants.md` `schema-version`| `.exarchos/invariants.md`                          |

Each authority is one of: **version-only** (`digest: null`), **digest-only**
(`version: null`), or **both**.

## Content-addressed digests

`authority-digest.ts` computes a deterministic `sha256:<hex>` over the
**canonical** content. `canonicalizeText` normalizes `\r\n`/`\r` → `\n` and
strips trailing newlines *before* hashing, so a digest is byte-identical on
Windows (CRLF working tree) and Linux CI (LF) regardless of `core.autocrlf`.
`digestIdentifierSet` dedupes + sorts before hashing so the ActionId digest is
order-independent.

## The lockfile

`contract-authority.lock.json` (co-located in this directory) records the
approved snapshot. Shape (`AuthorityLockSchema`, Zod-validated on load):

```jsonc
{
  "lockVersion": 1,
  "approved": true,              // whole-lock approval marker
  "approvedBy": "P03-01",
  "note": "…regeneration instructions…",
  "authorities": {
    "<authority-id>": {
      "kind": "schema|protocol|package|registry|policy|catalog",
      "version": "…" | null,
      "versionSpec": "…" | null, // raw spec, used for floating detection
      "digest": "sha256:…" | null,
      "source": "…provenance…",
      "approved": true           // per-authority approval marker
    }
  }
}
```

An **unapproved** pin (`approved: false` at either level) is distinguishable
from an approved one and fails the freeze.

## Fail-closed freeze rule

`verifyAuthorities(live, lock)` (pure) / `verifyContractAuthority()` (reads the
tree) return `{ ok, violations, report }` and fail **closed** on:

- **floating** — no pin, or a version *range*/dist-tag instead of an exact pin
  (e.g. `^1.29.0`, `1.x`, `latest`);
- **unapproved** — the lock, or an individual pin, is not `approved: true`;
- **mismatch** — the live digest/version differs from the locked one;
- **missing** — no pin exists for a required authority, or the lockfile itself
  is absent/invalid.

`ok === true` is the release/generation green light.

## Public API (for P03-02 … P03-09)

```ts
// authority-digest.ts — pure content addressing
canonicalizeText(text): string
digestText(text): string                        // sha256:<hex>
digestParts(parts): string                      // order-sensitive
digestIdentifierSet(ids): string                // order-independent
isFloatingVersionSpec(spec): boolean
isExactVersionPin(spec): boolean

// authority-pin.ts — pure model + verification
AUTHORITY_IDS, AuthorityId, AuthorityKind
AuthorityValue, AuthorityInputs
AuthorityPinSchema, AuthorityLockSchema, AuthorityLock, AuthorityPin
computeAuthorities(inputs): AuthorityValue[]
verifyAuthorities(live, lock): AuthorityVerdict // { ok, violations, report }
buildAuthorityLock(live, { approvedBy, note?, approved? }): AuthorityLock

// authority-collector.ts — reads the real tree (impure)
COMPATIBILITY_POLICY_VERSION
defaultSourcePaths(): AuthoritySourcePaths       // all paths overridable
collectAuthorityInputs(paths?): AuthorityInputs
collectLiveAuthorities(paths?): AuthorityValue[]
loadAuthorityLock(lockFile?): AuthorityLock
verifyContractAuthority(paths?): AuthorityVerdict  // THE block point
flattenActionIds(): string[]
```

A generator/consumer targets another tree by passing an `AuthoritySourcePaths`.
Gate your generator on `verifyContractAuthority().ok` before emitting anything.

## Regenerating / re-approving the lock

After any **intentional** change to a frozen authority the verify test goes red.
Review the change, then re-approve by regenerating the lock:

```sh
# from servers/exarchos-mcp
npx tsx src/contract/authority-lock-cli.ts
```

Running the generator **is** the approval gesture (it writes `approved: true` at
the current digests). Commit the updated `contract-authority.lock.json`.

## Relationship to `orchestrate/contract-drift.ts`

Complementary, not overlapping. `contract-drift` detects *breaking schema
changes* between a merge-base and HEAD by running external codegen/diff tools.
This module is the **freeze** layer: it pins the authority versions/digests a
generator consumes and compares the live tree to an approved lock. Drift
compares two tree states; the freeze compares the tree to the approved snapshot.
