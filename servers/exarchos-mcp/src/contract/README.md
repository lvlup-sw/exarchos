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
| `contract-surface`     | `schema`   | `CONTRACT_SURFACE_VERSION` (P03-02)       | canonical `serializeContractSurface()` (P03-02)    |

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

## Relationship to `verbs/gates/contract-drift.ts`

Complementary, not overlapping. `contract-drift` detects *breaking schema
changes* between a merge-base and HEAD by running external codegen/diff tools.
This module is the **freeze** layer: it pins the authority versions/digests a
generator consumes and compares the live tree to an approved lock. Drift
compares two tree states; the freeze compares the tree to the approved snapshot.

---

# Total contract carriers (P03-02)

**Second link in the PROGRAM-03 chain.** Defines the *closed*, **total** contract
surface that P03-01 freezes and that P03-03 (contract compiler), P03-04 (MCP
binding generation), and P03-05 (CLI generation) generate against. "Total" is
the operative word: **every** failure in **every** layer — protocol,
authorization, task, handler, output, presenter — maps to a stable, enumerated
contract error code **and** a stable CLI exit code, and adding a failure family
without mapping it is a **compile error** (a `never` exhaustiveness check), not a
runtime surprise.

> Exit proof: *every protocol, authorization, task, handler, output, and
> presenter failure maps to a stable contract error and CLI exit.*

## Modules & public API surface

### `error-families.ts` — total result/error carriers

The exhaustive error-family union and its stable code/exit mapping. Totality is
enforced two ways: `FAMILY_DEFAULTS` is a `Record<FailureLayer, …>` (a missing
layer is a compile error), and the severity/classification switches end in
`assertNever(x)` so an unmapped variant fails to type-check.

```ts
FailureLayer                                    // 'protocol'|'authorization'|'task'|'handler'|'output'|'presenter'
FAILURE_LAYERS: readonly FailureLayer[]
CONTRACT_EXIT_CODES                             // { SUCCESS, INVALID_INPUT, HANDLER_ERROR, UNCAUGHT_EXCEPTION, WAIT_TIMEOUT, WAIT_FAILED }
ContractExitCode
RetryPolicy                                     // 'never'|'retryable'|'after-backoff'
FailureFamilyDescriptor                         // { layer, code, exitCode, retry, severity }
FAMILY_DEFAULTS: Record<FailureLayer, FailureFamilyDescriptor>   // ← totality by construction
failureFamily(layer): FailureFamilyDescriptor
layerSeverity(layer): Severity                  // never-switch
StableErrorSpec, StableErrorCode
STABLE_ERROR_REGISTRY: Record<StableErrorCode, StableErrorSpec>
stableErrorCodes(): StableErrorCode[]
layerCodes(layer): StableErrorCode[]
ContractError                                   // { layer, code, message, exitCode, retry, detail? }
ContractErrorOptions                            // { code?, retry?, exitCode?, detail? }
contractError(layer, message, opts?): ContractError
exitCodeForError(code): ContractExitCode
ContractErrorEnvelope
toErrorEnvelope(err): ContractErrorEnvelope      // { success:false, error:{…} }
assertNever(x: never): never                    // exhaustiveness helper
```

### `envelope.ts` — output carriers (baseline / capped / degraded / error)

Formalizes the *capped* and *degraded* carriers around the existing
`economyBudgetTokens` / `_perf.tokens` / `economyDegraded` seam without forking
the live `ToolResult` shape (re-exports the canonical envelope schemas).

```ts
OutputKind                                      // 'baseline'|'capped'|'degraded'|'error'
OUTPUT_KINDS: readonly OutputKind[]
OutputKindDescriptor, EconomyMarker             // 'truncated'|'economyDegraded'|null
classifyOutput(meta): OutputKind
describeOutputKind(kind): OutputKindDescriptor   // { success, economyMarker } — never-switch
hasConsistentEconomyState(meta): boolean        // capped ⊕ degraded are mutually exclusive
CappedData, CappedDataSchema                    // { summary, counts:{total,shown}, firstPage:[] }
OutputEnvelopeSchema(dataSchema)
// re-exports: SuccessEnvelopeSchema, ErrorEnvelopeSchema, CacheHintsSchema
```

### `request-context.ts` — authenticated context + replay identity

Consumes the P01-07 `CallerAuthorizationSnapshot` model (identity derived from
transport/dispatch, never caller payload). Callers **cannot** self-assert
issuer, role, or timestamp: `sanitizeUntrustedHints` strips every
`PROTECTED_CONTEXT_FIELD` from caller-supplied `_meta`. Replay identity returns
the canonical stored result on a true replay and a **typed conflict** (never a
silently different second execution) when a different subject reuses an
idempotency key.

```ts
PROTECTED_CONTEXT_FIELDS: readonly string[]
ProtectedContextField
isProtectedContextField(key): boolean
sanitizeUntrustedHints(meta): Record<string, unknown>   // strips protected fields, frozen
AuthenticatedRequestContext
deriveRequestContext(snapshot, hints?): AuthenticatedRequestContext
contextSubjectId(ctx): string
canonicalJson(value): string                    // deterministic, recursively key-sorted
requestDigest(actionId, input, subjectId): string
ReplayIdentity
deriveReplayIdentity(...): ReplayIdentity
ReplayOutcome                                   // { status:'fresh' } | {'replayed',result} | {'conflict',error}
ReplayLedger                                    // claim/resolve; subject-conflict → typed ContractError
```

### `compatibility.ts` — version negotiation + directional migration

Explicit, testable negotiation over a client `VersionRange`; migration that
**declares** its direction (`forward`/`backward`) from semver precedence rather
than assuming it; cross-major is `incompatible`. `requiresMixedVersionRefusal`
gates mixed-version fan-out.

```ts
CONTRACT_SURFACE_VERSION: '1.0.0'
majorVersion(v), minorVersion(v)
VersionRange                                    // { min, max }
NegotiationOutcome                              // {'agreed',version} | {'unsupported',error}
negotiateVersion(clientRange, serverSupported): NegotiationOutcome
MigrationDirection                              // 'forward'|'backward'
MigrationPlan                                   // {'identity'} | {'migrate',direction,from,to} | {'incompatible',error}
planMigration(from, to): MigrationPlan
CompatibilityClass, classifyVersionChange(from, to): CompatibilityClass
CONTRACT_CHANGE_CLASSES, ChangeClass, changeClassSeverity(cls)   // never-switch
requiresMixedVersionRefusal(versions): boolean
```

### `contract-surface.ts` — the frozen structural digest source

`serializeContractSurface()` is the deterministic, content-addressable
serialization of the whole closed surface (families, codes, exits, retries,
output kinds, change classes, protected fields, surface version). The
`contract-surface` authority digests exactly this string, so any structural
change to the contract trips the P03-01 freeze and demands re-approval via the
lock CLI. Doc-comment edits do **not** trip it — only structure is captured.

```ts
contractSurface(): Record<string, unknown>      // structural, key-order-independent
serializeContractSurface(): string              // canonicalJson(contractSurface())
```

## Totality is a compile-time guarantee

- `FAMILY_DEFAULTS: Record<FailureLayer, …>` — omitting a layer is `TS2741`.
- `layerSeverity`, `describeOutputKind`, `changeClassSeverity` end their
  switch in `assertNever(x)` — adding a variant without a case fails to compile.
- `error-families.type-test.ts` carries four type-level totality proofs that
  `tsc --noEmit` enforces (no runtime).
- The six-layer *exit proof* in `error-families.test.ts` asserts each seeded
  layer failure maps to the expected stable code **and** the expected CLI exit,
  cross-checked against `adapters/cli.ts`'s own exit table.

## How P03-02 hooks into the P03-01 freeze

The `contract-surface` authority was registered **additively** into P03-01's
model (`authority-pin.ts` / `authority-collector.ts`) and the lock re-approved
(`approvedBy: "P03-02"`). Downstream generators keep gating on
`verifyContractAuthority().ok`; if the closed surface drifts from the approved
digest the freeze blocks, exactly as for every other authority.
