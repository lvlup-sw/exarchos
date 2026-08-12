# Zod v4 Migration — Decision Record

**Date:** 2026-05-13
**Phase:** PR-C / C-W1 (audit)
**Tracking issue:** #1366
**Source brief:** `docs/followups/2026-05-13-pr-c-1366-zod-v4-migration.md`
**Companion audit:** `docs/research/2026-05-13-zod-v4-breaking-changes.md`

Three decisions required before C-W2 (foundation phase) dispatches. Each
captures: the question, the options, the recommendation, and the
dependencies/risks. The audit document is the supporting evidence.

---

## Decision 1 — Target Zod version

### Question

Which `zod@^4.x` line should `servers/exarchos-mcp` pin?

### Background

Per the renovate gate (project convention captured in earlier waves), the
chosen package version MUST be at least 7 days old at the time of the
migration commit. As of 2026-05-13:

| Version | Released | Age (days) | Renovate gate |
|---|---|---|---|
| 4.4.3 | 2026-05-04 | 9 | ✅ passes |
| 4.4.2 | 2026-05-01 | 12 | ✅ passes |
| 4.4.1 | 2026-04-29 | 14 | ✅ passes |
| 4.4.0 | 2026-04-29 | 14 | ✅ passes |
| 4.3.6 | 2026-01-22 | 111 | ✅ passes |
| 4.0.0 | 2025-07-09 | 308 | ✅ passes (oldest stable v4) |

(Verification: `npm view zod time --json` plus filter to `4.*` non-prerelease.)

### Options

**Option A — Pin to latest stable: `zod@^4.4.3`**

- Pros: latest bug fixes; aligns with the natural future-update path
  (caret allows automatic patch/minor pickup); 4.4 line is the most-tested
  by upstream consumers as of audit date.
- Cons: only 9 days old → minimal field-test surface; if a 4.4.3-only
  regression surfaces, blast radius is the entire MCP server.

**Option B — Pin to a long-tail LTS: `zod@^4.3.6`**

- Pros: 111 days old at audit time → battle-tested by the broader
  ecosystem; `^4.3.6` still gets caret patch-bumps within 4.x.
- Cons: misses 4.4 features (none we care about, but worth checking);
  may diverge from where the wider ecosystem (SDK, downstream consumers)
  is converging.

**Option C — Pin exactly to a 4.0.x for maximum stability: `zod@~4.0.x`**

- Pros: 308 days old; most-conservative; lowest churn risk during migration.
- Cons: misses ~10 months of improvements (including the v4.1
  `z.toJSONSchema` API tightening per the changelog); locks us out of
  bug fixes that may already address issues in our migration path.

### Recommendation

**Option A — `zod@^4.4.3`** (the latest stable as of audit).

**Rationale:**

1. The renovate-gate convention exists to filter the "released this hour"
   class of regression. At 9 days old, `4.4.3` clears that bar — three
   weekends of public exposure is sufficient signal for a dependency
   this widely deployed.
2. PR-C's primary acceptance criterion is *true 2020-12 emission*, which
   relies on `z.toJSONSchema(..., { target: 'draft-2020-12' })`. That API
   is the v4 selling point and is heavily exercised on the 4.4 line.
3. Caret (`^4.4.3`) lets renovate keep us current across 4.x without a
   manual PR cadence; that's the lower-friction path post-migration.
4. The MCP SDK at `1.26.0` already speaks v4 via the compat shim (audit
   §9), so SDK-side compatibility is independent of our specific v4
   minor.

### Risks / mitigations

- **If a 4.4.x regression breaks the migration mid-flight:** drop to
  `^4.3.6` and continue. The audit-identified breaking changes are all
  in the v4.0 release surface, so 4.3 has the same API shape; only patch-
  level fixes are at stake.
- **Future v5 caret-bump:** caret `^4.4.3` is correctly constrained to
  the 4.x line, so a hypothetical v5 won't auto-pull.

### Dependencies

- No dependencies on Decisions 2 or 3; this is the first lever to
  pull in C-W2.

---

## Decision 2 — Wrapper-vs-strip for `adapters/json-schema.ts`

### Question

Should `adapters/json-schema.ts` continue to exist as a thin wrapper over
`z.toJSONSchema`, or should it be removed and replaced with a lint rule
enforcing direct `z.toJSONSchema(..., { target: 'draft-2020-12' })` calls?

### Background

Today, `adapters/json-schema.ts` is a 95-line wrapper that:

1. Defaults the target (currently `'jsonSchema2019-09'` + relabel; post-
   migration it would be `'draft-2020-12'` direct).
2. Centralises every "Zod → JSON Schema" call in the codebase to a single
   choke-point that lint / review can require.
3. Exports `JSON_SCHEMA_2020_12_URI` (this export drops post-migration).

Post-migration, the wrapper collapses to roughly:

```ts
import type { z } from 'zod';

export function zodToJsonSchema(
  schema: z.ZodType,
  opts?: Parameters<typeof import('zod')['toJSONSchema']>[1],
): ReturnType<typeof import('zod')['toJSONSchema']> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', ...opts });
}
```

The brief recommends keeping the wrapper for lint-discoverability. The
audit (§2) confirms the wrapper collapses to ~3 lines of substance.

### Options

**Option A — Keep the wrapper as a conformance chokepoint (brief's
recommendation)**

- Pros: lint rule `no-direct-z-toJSONSchema-import` becomes trivial — flag
  any `import { toJSONSchema } from 'zod'` outside the wrapper. Future
  spec changes (draft-2021-x, etc.) flow through one file. Source-comment
  conveys *why* this exists to drive-by readers.
- Cons: one extra layer of indirection for a one-line passthrough.

**Option B — Strip the wrapper; use a lint rule to enforce the target
parameter**

- Pros: removes ~95 lines (post-migration) of code. Direct call sites
  read more naturally.
- Cons: lint rule must inspect AST for the *option* value, not just the
  import — more complex to write and maintain. The "default to
  draft-2020-12" semantic dissolves into 10+ call sites that each have
  to remember to pass `{ target: 'draft-2020-12' }`.

### Recommendation

**Option A — Keep the wrapper** (per the brief).

**Rationale:**

1. The wrapper's *job* is now legitimate again post-migration: it
   centralises the "default target = draft-2020-12" policy. A direct
   `z.toJSONSchema(...)` call defaults to `'draft-2020-12'` only because
   v4 chose that default; if a future minor changes the default, the
   wrapper insulates us. The lint rule `no-default-import-of-zod-toJSONSchema`
   is one-line ESLint config.
2. Lint discoverability matters for an agent-first codebase. New
   contributors (human or LLM) reading the wrapper's source comment learn
   the *why* (MCP 2025-11-25 spec, draft-2020-12 default) without having
   to chase down a lint rule's docstring.
3. The wrapper survives spec evolution: when draft-2021-X drops, we touch
   one file, not 10.

### Risks / mitigations

- **Trivial-passthrough criticism (LGTM-with-shrug PRs deleting "useless
  wrappers"):** the source comment must clearly state the *why* (centralised
  policy, lint chokepoint). Audit-document this in the source comment as
  part of C2.4.
- **Lint rule must actually exist:** add an ESLint rule (or markdown rule)
  in the same commit as the wrapper rewrite (C2.4) so the chokepoint is
  enforced from day one of v4.

### Dependencies

- Depends on Decision 1 being ratified (Zod v4 version pinned).
- Independent of Decision 3.

---

## Decision 3 — LCD reactivation strategy

### Question

Once we migrate to Zod v4, should `adapters/mcp.ts`'s `LCD_OUTPUT_SCHEMA`
revert to the canonical `EnvelopeSchema(z.unknown())` discriminated union,
or remain as the passthrough `ZodObject` workaround?

### Background

Today (`adapters/mcp.ts:37-43`):

```ts
const LCD_OUTPUT_SCHEMA = z
  .object({
    success: z.boolean(),
    _meta: z.record(z.unknown()),
    _perf: PerfMetricsSchema,
  })
  .passthrough();
```

This is a workaround. The canonical envelope shape is the discriminated
union `EnvelopeSchema(z.unknown())` from `contract/schemas/envelope.ts:153-…`:

```ts
return z.discriminatedUnion('success', [
  SuccessEnvelopeSchema(dataSchema),
  ErrorEnvelopeSchema,
]);
```

The reason for the workaround is documented in `adapters/mcp.ts:23-36`:
the MCP SDK's `validateToolOutput` (and `tools/list`) routes the
registered `outputSchema` through `normalizeObjectSchema`, which only
recognises `ZodObject` inputs and returns `undefined` for
`ZodDiscriminatedUnion`. That dropped value causes a `TypeError` on every
successful call.

### Audit finding (companion §11)

The SDK's `normalizeObjectSchema` at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js:79-121`:

```js
if (isZ4Schema(schema)) {
    const def = v4Schema._zod?.def;
    if (def && (def.type === 'object' || def.shape !== undefined)) {
        return schema;
    }
}
```

For a v4 discriminated union, `_zod.def.type === 'union'` (with the
class being a subclass `ZodDiscriminatedUnion extends ZodUnion`). The
`'object'`-only check does NOT match, so `normalizeObjectSchema` still
returns `undefined`, and `mcp.js:88-96` silently drops the outputSchema
from `tools/list`.

**Verdict: the SDK has NOT improved this code path between Zod v3 and v4.**
The LCD passthrough-object workaround is still required.

### Options

**Option A — Reactivate canonical discriminated-union LCD
(`EnvelopeSchema(z.unknown())`)**

- Pros: aligns advertised tool schema with the actual envelope contract
  (single source of truth).
- Cons: **breaks `tools/list` emission and `validateToolOutput` parsing**
  per the audit. Per the SDK source at `mcp.js:88-96`, the outputSchema
  is silently dropped — clients calling `tools/list` won't see an
  output schema at all for any tool. Discovery and contract validation
  both degrade.

**Option B — Keep the passthrough-ZodObject workaround + file an SDK
issue**

- Pros: status quo preservation. Tests stay green. The per-action D.5
  validation (`registry.ts` outputSchema enforcement in
  `validateAgainstActionSchema`) continues to provide the tight
  envelope contract at runtime; the LCD is purely a tools/list-advertised
  surface.
- Cons: divergence between the advertised schema and the canonical
  envelope persists.

**Option C — Reactivate the canonical LCD but patch the SDK locally
(`patch-package`)**

- Pros: gets us to the canonical shape without waiting on upstream.
- Cons: forks the SDK; ongoing maintenance burden; conflicts on every
  SDK bump.

### Recommendation

**Option B — Keep the passthrough workaround + file an SDK issue.**

**Rationale:**

1. The audit (§11) demonstrates that the SDK's compat shim does NOT
   accept discriminated unions on either Zod v3 or v4. PR-C cannot fix
   this; it's an upstream concern.
2. The CURRENT D.5 enforcement (per-action `outputSchema.safeParse(env)`
   at `adapters/mcp.ts:150`) provides the tight contract at runtime,
   independent of the LCD shape. So the user-facing guarantee
   (envelope-shape correctness) is unaffected by the LCD's looseness.
3. Forking the SDK (Option C) raises the maintenance bar for a cosmetic
   improvement.

### Action items if approved

1. Keep `LCD_OUTPUT_SCHEMA` as a `z.object({...}).passthrough()` in
   `adapters/mcp.ts`, but update the comment to reference the audit
   finding from this decision record.
2. **Migrate the `z.record(z.unknown())` in `LCD_OUTPUT_SCHEMA` line 40
   to the two-arg form** as part of C-W6's `z.record` sweep (audit §6).
3. File an upstream issue against `@modelcontextprotocol/sdk` titled
   *"normalizeObjectSchema should accept ZodDiscriminatedUnion on both
   v3 and v4 paths"* with a link to `adapters/mcp.ts:15-43` as a real-
   world consumer reference. Track the issue number in this decision
   record once filed.
4. If the SDK lands a fix in a later 1.x release, file a follow-up
   issue *"Reactivate canonical LCD output schema once SDK accepts
   discriminated unions"* and assess feasibility.

### Risks / mitigations

- **Tests asserting the LCD shape on `tools/list`** (if any exist) will
  still pass — passthrough ZodObject doesn't change v4 emission shape
  in a way that breaks 2020-12 conformance.
- **Doc drift:** the source comment block at `adapters/mcp.ts:15-43`
  must be updated to cite this decision record so future readers know
  the workaround is intentional and recently re-verified under Zod v4.

### Dependencies

- Decisions 1 and 2 ratified.
- Independent of upstream SDK fix.

---

## 14. Cross-decision summary

| Decision | Recommendation | Blocker for | Risk |
|---|---|---|---|
| 1. Zod target version | `zod@^4.4.3` | C2.1 (dep bump) | Low — 9-day-old release, caret allows graceful downgrade |
| 2. Wrapper vs. strip | Keep wrapper | C2.4 (adapter rewrite) | Low — re-affirms brief recommendation |
| 3. LCD reactivation | Keep passthrough + file upstream | C5.1 (adapters migration) | Low — preserves status quo; D.5 still enforces tight contract |

**Acceptance-criterion adjustment** (proposed; flagged to user for
ratification):

- The brief's acceptance bullet — *"`tools/list` over MCP advertises
  `$schema: https://json-schema.org/draft/2020-12/schema` natively
  (verified by live integration test)"* — needs **relaxation**.
  The SDK's `tools/list` path calls `toJsonSchemaCompat(obj, { ... })`
  WITHOUT a `target` option (audit §10), so even on Zod v4 it falls
  back to draft-7. The wrapper-emitted schemas (describe handlers,
  fingerprint, runbooks) WILL be true 2020-12, but the SDK-mediated
  `tools/list` emission requires an upstream fix.

  Proposed replacement: *"All Exarchos-emitted JSON Schemas
  (via `adapters/json-schema.ts`) advertise `$schema:
  https://json-schema.org/draft/2020-12/schema` natively; the
  SDK-mediated `tools/list` boundary is structurally compatible with
  2020-12 (draft-7 is a subset for the constructs we emit), and an
  upstream SDK issue is filed to add `target: 'draft-2020-12'`
  passthrough."*
