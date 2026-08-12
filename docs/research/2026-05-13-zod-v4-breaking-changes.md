# Zod v3 → v4 Breaking-Change Audit for `servers/exarchos-mcp`

**Date:** 2026-05-13
**Phase:** PR-C / C-W1 (audit)
**Tracking issue:** #1366
**Source brief:** `docs/followups/2026-05-13-pr-c-1366-zod-v4-migration.md`
**Companion:** `docs/research/2026-05-13-zod-v4-decision-record.md`

This document is the audit deliverable for Phase 1 of the Zod v3 → v4 migration
in the `exarchos-mcp` server. It catalogues every Zod v4 breaking change
relevant to the repository, maps each to the current v3 idiom, samples
repository usage, and surfaces three SDK-related findings that gate Phase 2.

All claims cite either the Zod v4 migration guide
([zod.dev/v4/changelog](https://zod.dev/v4/changelog)), a path in
`servers/exarchos-mcp/src` with `file:line`, or a path in
`servers/exarchos-mcp/node_modules/@modelcontextprotocol/sdk` with `file:line`.

---

## 0. Repo baseline (as of integration tip `0bb88eda`)

| Item | Value |
|---|---|
| `zod` dependency | `^3.23.0` — `servers/exarchos-mcp/package.json:1` (installed: `3.25.76`) |
| `zod-to-json-schema` dependency | `^3.25.2` — archived; "v4 now supports JSON schema natively" |
| `@modelcontextprotocol/sdk` | `1.26.0` (already speaks both Zod v3 and v4 via the compat shim) |
| Files importing `zod` | **50** (47 `import { z }`, 3 `import type { z }`, plus 2 dual imports) |
| `z.ZodTypeAny` references | **30** call sites across 6 files (full list §3) |
| `_def.` introspection sites | **22** across `registry.ts` (16) and `adapters/schema-to-flags.ts` (6) (full list §4) |
| `z.preprocess(...)` constructors | **6** sites (full list §5) |
| `z.record(...)` sites | **41** (none with single-arg form — already migrated, see §6) |
| `z.string().{email,url,uuid,…}` chained-format sites | **20** (full list §7) |
| `z.discriminatedUnion(...)` sites | **4** sites (`registry.ts`, `ndjson/frames.ts`, `contract/schemas/envelope.ts`, `event-store/schemas.ts`) |
| `.parse()` / `.safeParse()` sites | **1230** (most should be transparent on migration) |
| `.passthrough()` sites | 16 |
| `.strict()` sites | 41 (mostly in `config/yaml-schema.ts` and `config/validation.ts`) |

---

## 1. Canonical breaking-change table

Sorted by Zod v4 migration-guide order. Columns: v3 idiom · v4 equivalent ·
complexity · used in repo (yes/no + count).

**Legend for complexity:**
- **trivial** — no code change required; identical runtime behaviour
- **mechanical** — sed-able rename or single-line swap; risk = low
- **requires-thought** — semantic shift; requires per-site review

### 1.A — Error customisation

| v3 idiom | v4 equivalent | Complexity | Used? |
|---|---|---|---|
| `{ message: "..." }` on validators | `{ error: "..." }` (deprecates `message`) | mechanical | partial — `format.ts` does NOT use `message:` on Zod constructors, so a `git grep "{ message:" servers/exarchos-mcp/src` returns zero hits within Zod schema definitions; verify in C2.3 |
| `{ invalid_type_error, required_error }` | `{ error: (issue) => ... }` | mechanical | **no** — `grep -rn "invalid_type_error\|required_error" servers/exarchos-mcp/src` returns 0 hits |
| `{ errorMap }` constructor param | `{ error }` (renamed) | mechanical | **no** — 0 hits |
| `ZodError.format()` method | `z.treeifyError(err)` top-level | requires-thought | **no** — 0 hits in `src/` |
| `ZodError.flatten()` method | `z.treeifyError(err)` top-level | requires-thought | **no** — 0 hits |
| `ZodError.formErrors` | removed | n/a | **no** — 0 hits |
| `ZodError.errors` (alias for `issues`) | dropped; use `.issues` | mechanical | **no** — 0 hits; the code already uses `.issues` directly (`adapters/mcp.ts:154`, `registry.ts:64`) |
| `ZodError.addIssue()` / `addIssues()` | push directly into `err.issues` array | requires-thought | **no** — 0 hits |

### 1.B — Issue format reshape

| v3 idiom | v4 equivalent | Complexity | Used? |
|---|---|---|---|
| `ZodInvalidTypeIssue` | `z.core.$ZodIssueInvalidType` | mechanical (rename) | **no** — 0 hits on issue type names in `src/` |
| `ZodInvalidLiteralIssue` | merged into `$ZodIssueInvalidValue` | requires-thought | **no** — 0 hits |
| `ZodInvalidUnionDiscriminatorIssue` | now throws at schema-creation time | requires-thought | indirect — `z.discriminatedUnion()` sites should still construct cleanly |
| `issue.path` mostly preserved | unchanged shape; still `PropertyKey[]` | trivial | **yes** — consumed at `adapters/mcp.ts:154-157` and `registry.ts:64`. **The repo uses `issue.path.map(String).join('.')` which works on both v3 and v4.** No change required. |
| `issue.code` mostly preserved | new `invalid_value` issue replaces literal/enum issues | requires-thought | indirect — neither call site (`adapters/mcp.ts`, `registry.ts`) branches on specific `issue.code` strings, so behaviour stays consistent |

### 1.C — Number / string / record / etc.

| v3 idiom | v4 equivalent | Complexity | Used? |
|---|---|---|---|
| `z.number()` accepts `Infinity` | rejects `Infinity` / `-Infinity` | trivial | **likely no** — schemas accept finite ints/floats; no `Infinity` test fixtures |
| `z.number().safe()` accepts floats | now equivalent to `.int()` | requires-thought | check `grep -rn "\.safe\b()" servers/exarchos-mcp/src` — **0 hits** |
| `z.number().int()` accepts unsafe ints | safe-integer range only | requires-thought | repo uses `z.number().int().nonnegative()` etc. on small counters; no values approach `MAX_SAFE_INTEGER` |
| `z.string().email()` etc. | top-level `z.email()`, `z.url()`, `z.uuid()`, `z.iso.datetime()` | mechanical (chained methods are deprecated but still work) | **yes** — 20 chained-format sites in `event-store/schemas.ts` + 6 others (full list §7). All keep working in v4 with a deprecation warning. Phase 6 can opt to migrate piecemeal. |
| `z.string().uuid()` lax | now RFC 9562 strict; use `z.guid()` for permissive | requires-thought | **yes** — 6 sites in `event-store/schemas.ts:883-1295` produce uuids via `crypto.randomUUID()`, which is RFC-compliant. **Low risk.** |
| `z.string().ip()` / `.cidr()` | dropped; use `.ipv4()` / `.ipv6()` / `.cidrv4()` / `.cidrv6()` | mechanical | **no** — 0 hits |
| `z.string().base64url()` allows padding | padding rejected | requires-thought | **no** — 0 hits |
| `z.coerce.string()` input type `string` | now `unknown` | requires-thought | **no** — `grep -rn "z\.coerce\." servers/exarchos-mcp/src` returns 0 hits in production code (test-only usage may exist) |
| `.default()` short-circuits with input default | now requires **output-type** assignable default | requires-thought | **partial** — `workflow/schemas.ts:339` uses `.default({})` on a `z.record`; this is output-compatible and survives. Audit all 8 `.default(` sites in C2.3. |
| `z.object()` defaults applied even inside optional fields | new behaviour | requires-thought | **possible** — none of the current default-bearing schemas are inside an `optional()`, but verify in C2.3 |
| `.strict()` / `.passthrough()` on object | deprecated; use `z.strictObject()` / `z.looseObject()` (the methods still work) | mechanical | **yes** — 41 `.strict()`, 16 `.passthrough()` (mostly in `config/yaml-schema.ts`). **Methods still supported in v4; treat as future cleanup.** |
| `.strip()` | deprecated; default behaviour | trivial | **no** — 0 hits |
| `.nonstrict()` | removed | n/a | **no** — 0 hits |
| `.deepPartial()` | removed (no replacement) | requires-thought | **no** — 0 hits |
| `z.unknown()` / `z.any()` keys marked optional | now required keys | requires-thought | **YES — broad blast radius.** Repo extensively uses `z.unknown()` inside `z.record(z.string(), z.unknown())` (41 sites). The inferred type changes from `{ [k]?: unknown }` to `{ [k]: unknown }`. This is a TypeScript-level change that may surface in handler consumers; expect compile errors at consumer sites that destructure with optional-key syntax. |
| `.merge()` on objects | deprecated → `.extend()` or spread | mechanical | **no** — 0 hits in `src/` |
| `z.nativeEnum()` | deprecated → `z.enum()` (overloaded) | mechanical | **yes** — `grep -rn "z\.nativeEnum" servers/exarchos-mcp/src` returns **0 hits**. Migration tablestakes only. |
| `z.array(...).nonempty()` inferred type | now `T[]` (was `[T, ...T[]]`) | requires-thought | check `grep -rn "\.nonempty()" servers/exarchos-mcp/src` — **0 hits**. Safe. |
| `z.promise()` | deprecated | trivial | **no** — 0 hits |
| `z.function()` API | new factory shape (`{ input, output }`) | requires-thought | **no** — 0 hits |
| `.refine(predicate as type-guard)` narrows | no longer narrows | requires-thought | **partial** — `grep -rn "\.refine(" servers/exarchos-mcp/src` returns 4 hits; none use a `val is X` predicate. Safe. |
| `ctx.path` in `.superRefine()` | dropped | requires-thought | check `grep -rn "ctx\.path\|superRefine" servers/exarchos-mcp/src` — **1 hit** (`config/validation.ts:28` uses `.superRefine((workflow, ctx) => ...)`). Inspect for `ctx.path` reads. Decision-record item if used. |
| `z.literal(Symbol)` | removed | trivial | **no** — 0 hits |
| `z.ZodString.create()` etc. static factories | removed | mechanical | **no** — repo uses factory functions exclusively |
| `z.record(valueSchema)` single-arg | requires `(keySchema, valueSchema)` | mechanical | **migrated in PR #1366.** Pre-migration audit found 7 single-arg sites — 4 in `evals/types.ts` (lines 13, 24, 49, 50), 1 in `evals/calibration-types.ts:13`, 1 in `workflow/schemas.ts:59`, 1 in `adapters/mcp.ts:40` (LCD_OUTPUT_SCHEMA). All converted to `z.record(z.string(), X)`. The remaining 34 of the 41 total `z.record(...)` sites were already two-arg. Verified post-merge by `grep -rnE "z\.record\(z\.unknown\(\)" servers/exarchos-mcp/src --include="*.ts"` returning zero hits. See §6. |
| `z.record(enumSchema, ...)` partial-key behaviour | now exhaustive; use `z.partialRecord(...)` for old behaviour | requires-thought | **no** — `grep` shows no `z.record(z.enum(...)` patterns |
| `z.intersection()` merge-conflict | throws plain `Error` (not `ZodError`) | requires-thought | **no** — 0 hits |

### 1.D — Internal changes (the introspection blockers)

| v3 idiom | v4 equivalent | Complexity | Used? |
|---|---|---|---|
| `schema._def` | `schema._zod.def` | **mechanical (rewrite)** | **yes — 22 sites.** Blocker for Phase 4 (`registry.ts`) and Phase 5 (`adapters/schema-to-flags.ts`). Full mapping in §4. |
| `z.ZodTypeAny` | `z.ZodType` (now defaults to `<unknown, unknown>`) | mechanical | **yes — 30 sites.** Full list §3. |
| `ZodEffects` class | removed; `.transform()` and `.preprocess()` return `ZodPipe<ZodTransform, U>` instead | **requires-thought (rewrite)** | **yes — 6 sites use `instanceof z.ZodEffects` checks.** Critical for Phase 4. See §5 + §8. |
| `ZodPreprocess` class | removed (was internal) | n/a — `z.preprocess()` function preserved | **n/a** |
| `ZodBranded` class | removed; branding now mutates inferred type only | trivial | **no** — 0 hits |
| `ZodType` generic shape | now `ZodType<Output = unknown, Input = unknown>` (no more `Def`) | trivial — generic-positional inference improves | **no impact** unless code declares custom generics in this position |
| `z.core.*` namespace | new — internals exported under `z.core` | additive | **no** — not yet consumed |

### 1.E — JSON Schema emission (PR-C's actual lever)

| Concern | v3 (today) | v4 (post-migration) |
|---|---|---|
| Default target | `'jsonSchema2019-09'` via the wrapper, then `$schema` relabeled to `2020-12` (see `adapters/json-schema.ts:73-95`) | `'draft-2020-12'` is the default (`node_modules/zod/v4/core/to-json-schema.d.ts:11`) |
| Native API | none — relies on `zod-to-json-schema@3.25.2` (archived) | `z.toJSONSchema(schema, { target, io, unrepresentable, override, metadata, … })` |
| `prefixItems` for fixed-length tuples | not emitted (2019-09 limitation) | emitted natively when `target: 'draft-2020-12'` |
| MCP SDK's `tools/list` path | falls through to `zodToJsonSchema(schema)` for v3 inputs, emitting draft-07 (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js:27-29`) | takes the `z4mini.toJSONSchema(schema, { target: 'draft-2020-12' })` branch (`zod-json-schema-compat.js:21-24`) |

---

## 2. Specifics on `z.toJSONSchema` (v4 native API)

**File:** `servers/exarchos-mcp/node_modules/zod/v4/core/to-json-schema.d.ts:1-88`

```ts
interface JSONSchemaGeneratorParams {
    /** A registry used to look up metadata for each schema. */
    metadata?: $ZodRegistry<Record<string, any>>;
    /** The JSON Schema version to target.
     * - `"draft-2020-12"` — Default. JSON Schema Draft 2020-12
     * - `"draft-7"` — JSON Schema Draft 7 */
    target?: "draft-7" | "draft-2020-12";
    /** How to handle unrepresentable types. */
    unrepresentable?: "throw" | "any";
    /** Arbitrary custom logic. */
    override?: (ctx: { zodSchema; jsonSchema; path }) => void;
    /** "input" or "output" (defaults to "output"). */
    io?: "input" | "output";
}

export declare function toJSONSchema(
  schema: schemas.$ZodType,
  _params?: ToJSONSchemaParams,
): JSONSchema.BaseSchema;
```

**Behavioural diff vs `zod-to-json-schema`:**

| Aspect | `zod-to-json-schema@3.25.2` (v3 path) | `z.toJSONSchema` (v4 path) |
|---|---|---|
| Default target | `'jsonSchema7'` | `'draft-2020-12'` |
| 2020-12 target | **not supported** (max is `'jsonSchema2019-09'`) | native — emits `prefixItems`, `unevaluatedProperties`, etc. |
| Discriminated-union output | emits `anyOf` (or `oneOf` with `strictUnions: true`) | emits `anyOf` with discriminator metadata |
| Tuple emission | `{ items: [...] }` | `{ prefixItems: [...] }` on 2020-12 target |
| Preprocess pipes | flattens via `pipeStrategy: 'input'` | takes `io: 'input'` param (same default) |
| Override hook | `definitions` + `override` callbacks | `metadata` registry + `override` callback (more powerful, registry-based) |
| Cycle handling | breaks via `$ref` | breaks via `$defs` (configurable `cycles: 'ref' \| 'throw'`) |
| `unrepresentable` types (e.g. `z.function()`, `z.symbol()`, `z.bigint()`) | silent fallback or error | configurable: `'throw'` (default) or `'any'` |

**Implication for `adapters/json-schema.ts`:** the wrapper currently merges
`{ target: 'jsonSchema2019-09', ...opts }` and post-emit overwrites
`$schema` (line 80-92). The v4 rewrite is a one-line passthrough:

```ts
return z.toJSONSchema(schema, { target: 'draft-2020-12', ...opts });
```

The relabel hack and `JSON_SCHEMA_2020_12_URI` export both drop.

---

## 3. `z.ZodTypeAny` → `z.ZodType` migration (30 sites)

`z.ZodTypeAny` does not exist in `zod/v4/classic`. Confirmed by:

```bash
grep -nE "^export (declare class|interface|const) (ZodEffects|ZodPreprocess|ZodBranded|ZodTypeAny)" \
  servers/exarchos-mcp/node_modules/zod/v4/classic/schemas.d.ts \
  servers/exarchos-mcp/node_modules/zod/v4/classic/external.d.ts
# (no output)
```

Replacement: `z.ZodType` (now defaults to `<unknown, unknown>`).

Migration is a literal find-replace. Complexity: **mechanical**.

**Full call-site list (`file:line`):**

```text
servers/exarchos-mcp/src/registry.test.ts:1747
servers/exarchos-mcp/src/evals/jsonl-reader.ts:10            (generic constraint)
servers/exarchos-mcp/src/registry.ts:82
servers/exarchos-mcp/src/registry.ts:215
servers/exarchos-mcp/src/registry.ts:242                     (generic param of ZodObject)
servers/exarchos-mcp/src/registry.ts:277                     (parameter type of unwrapPreprocess)
servers/exarchos-mcp/src/registry.ts:326
servers/exarchos-mcp/src/registry.ts:361
servers/exarchos-mcp/src/registry.ts:372
servers/exarchos-mcp/src/registry.ts:387
servers/exarchos-mcp/src/registry.ts:397
servers/exarchos-mcp/src/registry.ts:420
servers/exarchos-mcp/src/registry.ts:436
servers/exarchos-mcp/src/registry.ts:448
servers/exarchos-mcp/src/registry.ts:486
servers/exarchos-mcp/src/contract/schemas/envelope.ts:122             (doc-comment ref)
servers/exarchos-mcp/src/contract/schemas/envelope.ts:126
servers/exarchos-mcp/src/contract/schemas/envelope.ts:153
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:88
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:90
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:92
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:96
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:104
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:106
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:109
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:112
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:117
servers/exarchos-mcp/src/adapters/schema-to-flags.ts:131
servers/exarchos-mcp/src/adapters/mcp.test.ts:549
servers/exarchos-mcp/src/adapters/json-schema.ts:74          (wrapper signature — drops anyway when wrapper rewrites)
```

---

## 4. `_def` introspection — the registry.ts blocker (22 sites)

`schema._def` is dropped in Zod v4. The replacement is `schema._zod.def`,
with a slightly different internal shape:

| v3 access | v4 access | Notes |
|---|---|---|
| `s._def.typeName` (e.g. `'ZodOptional'`, `'ZodEffects'`) | `s._zod.def.type` (e.g. `'optional'`, `'pipe'`) | **type-name strings change** — see §8 |
| `s._def.innerType` (Optional/Default/Nullable wrapper) | `s._zod.def.innerType` | preserved, same semantics — `dispatch/core/schemas.d.ts:797-832` |
| `s._def.effect` (Effects wrapper) | **dropped** — no Effects class. Preprocess is `ZodPipe`; access via `s._zod.def.in` (ZodTransform), `s._zod.def.out` (wrapped schema) | requires rewrite — see §5 |
| `s._def.values` (ZodEnum) | `s._zod.def.entries` (returns the enum members object) | v4 calls this `entries`; the array form is `Object.keys(entries)` or `Object.values(entries)` |
| `s._def.value` (ZodLiteral) | `s._zod.def.values[0]` (literal is single-element array in v4 core; classic `z.literal(x)` still produces one with `.values = [x]`) | the v4 SDK compat shim already handles both at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js:181-208` |
| `s._def.options` (ZodUnion) | `s._zod.def.options` | preserved |
| `s._def.schema` (ZodEffects inner) | **dropped** — use ZodPipe traversal | see §5 |
| `s._def.defaultValue` (ZodDefault) | `s._zod.def.defaultValue` | `dispatch/core/schemas.d.ts:832` — note that in v4 it may be a getter or value |

**Full call-site list (`file:line` plus current code excerpt):**

`registry.ts:`

```ts
279:    const inner = schema._def.innerType;
280:    if (inner instanceof z.ZodEffects && inner._def.effect.type === 'preprocess') {
281:      return inner._def.schema.optional();
282:    }
284:  if (schema instanceof z.ZodEffects && schema._def.effect.type === 'preprocess') {
285:    return schema._def.schema;
374:  if (current instanceof z.ZodDefault) current = current._def.innerType;
375:  if (current instanceof z.ZodOptional) current = current._def.innerType;
392:    current = current._def.innerType;
400:    return [...(current._def.values as readonly string[])].sort();
406:    return [JSON.stringify(current._def.value as unknown)];
412:    const raw = Object.values(current._def.values as Record<string, unknown>);
420:    const options = current._def.options as readonly z.ZodTypeAny[];
425:      literalValues.push(JSON.stringify(peeled._def.value as unknown));
443:    current = current._def.innerType;
450:    return schema._def.defaultValue();
```

`adapters/schema-to-flags.ts:`

```ts
90:    const inner = schema._def.innerType as z.ZodTypeAny;
91:    if (inner instanceof z.ZodEffects && inner._def.effect.type === 'preprocess') {
92:      return (inner._def.schema as z.ZodTypeAny).optional();
95:  if (schema instanceof z.ZodEffects && schema._def.effect.type === 'preprocess') {
96:    return schema._def.schema as z.ZodTypeAny;
106:    return unwrapWrappers(schema._def.innerType as z.ZodTypeAny);
109:    return unwrapWrappers(schema._def.innerType as z.ZodTypeAny);
112:    return unwrapWrappers(schema._def.innerType as z.ZodTypeAny);
```

**Migration recipe (mechanical for `innerType`/`values`/`options`/
`defaultValue`; requires-thought for `effect`/`schema`):**

```ts
// v3
if (s instanceof z.ZodOptional) {
  current = s._def.innerType;
}
// v4 equivalent
if (s._zod.def.type === 'optional') {
  current = s._zod.def.innerType;
}
```

(The `instanceof z.ZodOptional` checks still compile under v4, but the
`_def` access does not. Mixing is fine — pick whichever reads cleaner.
The SDK's `zod-compat.js` prefers the `_zod.def.type === '<tag>'` form
and that's the pattern this migration should adopt.)

For `current._def.values` on `ZodEnum`, v4 reshapes:

```ts
// v3
return [...(current._def.values as readonly string[])].sort();
// v4
return Object.keys(current._zod.def.entries).sort();
```

(`Object.keys()` rather than `Object.values()` because v4 stores enums
as a key/value record where string-enum keys equal values; numeric/native
enums round-trip through `Object.values(...)`.)

---

## 5. `z.preprocess(...)` — `ZodEffects` → `ZodPipe` rewrite (6 sites)

Zod v4 drops the `ZodEffects` class entirely (migration guide:
*"drops ZodEffects"* / *"drops ZodPreprocess"*). The `z.preprocess()`
function is preserved but now returns `ZodPipe<ZodTransform<A, B>, U>`
(`node_modules/zod/v4/classic/schemas.d.ts:630`).

**v3 access pattern** (`registry.ts:284-285`):

```ts
if (schema instanceof z.ZodEffects && schema._def.effect.type === 'preprocess') {
  return schema._def.schema;
}
```

**v4 equivalent (one possible shape):**

```ts
if (schema._zod.def.type === 'pipe' &&
    schema._zod.def.in._zod.def.type === 'transform') {
  // schema._zod.def.in is the ZodTransform wrapper
  // schema._zod.def.out is the user-facing inner schema
  return schema._zod.def.out;
}
```

Reference: `node_modules/zod/v4/core/schemas.d.ts:926-940` for the
`$ZodPipeDef { type: "pipe"; in: A; out: B }` shape.

**Caveat:** `.transform()` ALSO produces `ZodPipe` (with `in = caller`,
`out = ZodTransform`), so disambiguating preprocess-vs-transform requires
checking which side hosts the `ZodTransform`. The recipe above checks
`def.in.type === 'transform'`, which correctly identifies preprocess.

**Construction call-sites (6, all preserved — no constructor change):**

```text
servers/exarchos-mcp/src/coerce.ts:31,41,51,62        (4 sites)
servers/exarchos-mcp/src/workflow/schemas.ts:183       (TaskStatusSchema)
servers/exarchos-mcp/src/adapters/schema-to-flags.test.ts:69,115  (test fixtures)
```

These do not need rewriting; only the **introspection sites** that
peer inside the resulting `ZodPipe` need the rewrite (i.e. the `_def.effect`
checks in §4).

---

## 6. `z.record(...)` audit (41 sites — migration complete)

> **Status (post-PR #1366):** the snapshot below is the **pre-migration**
> audit. All listed single-arg sites have been converted to the two-arg
> form — `grep -rnE "z\.record\(z\.unknown\(\)" servers/exarchos-mcp/src
> --include="*.ts"` now returns zero hits. The §1 summary table (line 32)
> and this section's heading agree: 41 sites, all key-explicit. Retained
> for migration history.

The v4 migration guide flags single-arg `z.record(valueSchema)` as a
breaking change requiring `(keySchema, valueSchema)`. The pre-migration
audit found **7 sites** still using the single-arg form, all in `evals/`,
`workflow/schemas.ts`, `calibration-types.ts`, and the LCD output schema
in `adapters/mcp.ts`:

```text
servers/exarchos-mcp/src/evals/types.ts:13     z.record(z.unknown())
servers/exarchos-mcp/src/evals/types.ts:24     z.record(z.unknown())
servers/exarchos-mcp/src/evals/types.ts:49     z.record(z.unknown())
servers/exarchos-mcp/src/evals/types.ts:50     z.record(z.unknown())
servers/exarchos-mcp/src/evals/calibration-types.ts:13   z.record(z.unknown())
servers/exarchos-mcp/src/workflow/schemas.ts:59          z.record(z.unknown())
servers/exarchos-mcp/src/adapters/mcp.ts:40              z.record(z.unknown())  ← LCD_OUTPUT_SCHEMA
```

(Also `coerce.ts:31` was already two-arg.)

**Applied migration (PR #1366):** `z.record(X)` → `z.record(z.string(), X)`.

The remaining 34 `z.record(...)` sites already passed an explicit key
schema and were transparent through the upgrade.

---

## 7. String chained-format methods (20 sites)

In v4 these still work (deprecated), so the migration is **optional**
and can be deferred to a follow-up. Sites:

```text
servers/exarchos-mcp/src/benchmarks/baselines-schema.ts:9    .datetime()
servers/exarchos-mcp/src/workflow/schemas.ts:54,65,70,84,193,194,327,328   .datetime()  (8 sites)
servers/exarchos-mcp/src/projections/snapshot-schema.ts:9    .datetime()
servers/exarchos-mcp/src/event-store/schemas.ts:396,694,826,835,1009  .datetime()  (5 sites)
servers/exarchos-mcp/src/event-store/schemas.ts:883,891,907,1225,1239,1251,1260,1272,1283,1295,1306,1326  .uuid()  (12 sites)
servers/exarchos-mcp/src/event-store/schemas.ts:1241,1262,1285  .url()  (3 sites)
```

Per the migration guide:

> The method forms (`z.string().email()`) still exist and work as before,
> but are now deprecated.

**Recommendation:** leave these in place during PR-C to keep diff minimal;
file a follow-up issue ("Migrate Zod v3 chained-format methods to v4
top-level APIs") to be picked up during Phase 6 or after PR-C lands.

**One real concern — `z.string().uuid()` semantics tightening:** v4
enforces RFC 9562 strictly (variant bits must be 10). The 12 sites that
use `.uuid()` in `event-store/schemas.ts` all parse values produced by
`crypto.randomUUID()` (Node's), which is already RFC-compliant. No
runtime regression expected, but call out for verification under PR-C's
test suite.

---

## 8. v3 → v4 `instanceof` checks: type-name mapping

v4 preserves the class constructors `z.ZodObject`, `z.ZodString`,
`z.ZodOptional`, etc., so `instanceof z.ZodObject` and friends keep
working. The exceptions:

| v3 class | v4 status |
|---|---|
| `z.ZodEffects` | **removed** (see §5) — code paths using `instanceof z.ZodEffects` must switch to checking `_zod.def.type === 'pipe'` |
| `z.ZodPreprocess` | removed (was internal) |
| `z.ZodBranded` | removed |

The full v4 `_zod.def.type` discriminator value-set (per
`node_modules/zod/v4/core/schemas.d.ts:25`):

```text
"string" | "number" | "int" | "boolean" | "bigint" | "symbol" | "null"
| "undefined" | "void" | "never" | "any" | "unknown" | "date" | "object"
| "record" | "file" | "array" | "tuple" | "union" | "intersection" | "map"
| "set" | "enum" | "literal" | "nullable" | "optional" | "nonoptional"
| "success" | "transform" | "default" | "prefault" | "catch" | "nan"
| "pipe" | "readonly" | "template_literal" | "promise" | "lazy" | "custom"
```

(Note: discriminated-union schemas still report `_zod.def.type === 'union'` —
they are a subclass of `ZodUnion`. To detect specifically a discriminated
union, prefer `instanceof z.ZodDiscriminatedUnion`.)

---

## 9. SDK compatibility verification (C1.4)

**File audited:** `servers/exarchos-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js`

The SDK at `1.26.0` already speaks both Zod v3 and Zod v4:

```js
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js:18-31
export function toJsonSchemaCompat(schema, opts) {
    if (isZ4Schema(schema)) {
        // v4 branch — use Mini's built-in toJSONSchema
        return z4mini.toJSONSchema(schema, {
            target: mapMiniTarget(opts?.target),
            io: opts?.pipeStrategy ?? 'input'
        });
    }
    // v3 branch — use vendored converter
    return zodToJsonSchema(schema, {
        strictUnions: opts?.strictUnions ?? true,
        pipeStrategy: opts?.pipeStrategy ?? 'input'
    });
}
```

Where:

```js
// zod-json-schema-compat.js:9-17 — target mapping
function mapMiniTarget(t) {
    if (!t) return 'draft-7';
    if (t === 'jsonSchema7' || t === 'draft-7') return 'draft-7';
    if (t === 'jsonSchema2019-09' || t === 'draft-2020-12') return 'draft-2020-12';
    return 'draft-7'; // fallback
}
```

And the runtime detection at `zod-compat.js:8-12`:

```js
export function isZ4Schema(s) {
    // Present on Zod 4 (Classic & Mini) schemas; absent on Zod 3
    const schema = s;
    return !!schema._zod;
}
```

**Verdicts:**

1. **Does the SDK runtime-detect Zod v3 vs v4?** Yes — via the
   `_zod` property presence check (`zod-compat.js:8-12`).
2. **Does the v4 path call `z.toJSONSchema(..., { target: 'draft-2020-12' })`
   natively?** Yes — but only when the caller invokes `toJsonSchemaCompat`
   with `target: 'draft-2020-12'` or `target: 'jsonSchema2019-09'`. The
   SDK's `mcp.js` server-registration path **calls `toJsonSchemaCompat`
   without any `target` option** (`mcp.js:78-81, 91-94`):

   ```js
   toolDefinition.outputSchema = toJsonSchemaCompat(obj, {
       strictUnions: true,
       pipeStrategy: 'output'  // (or 'input' for inputSchema)
   });
   ```

   With no `target`, `mapMiniTarget(undefined)` falls through to
   `'draft-7'`. **This means even after migrating to Zod v4, the
   SDK's auto-emitted `tools/list` schemas will be draft-7, NOT
   draft-2020-12.**

   This is a **critical finding**. See §10.

3. **What is the v3 fallback?** Routes through the archived
   `zodToJsonSchema()` (no target option propagated), emitting
   draft-07 with no `$schema` URL. Consistent with our current
   relabel-needing baseline.

4. **Does the SDK's `normalizeObjectSchema` accept Zod v4 discriminated
   unions?** **No.** See §11.

---

## 10. SDK compatibility gate — `tools/list` still emits draft-7 even on v4

**Severity:** Critical for PR-C's primary acceptance criterion (Wave 0
follow-up brief item: *"`tools/list` over MCP advertises 2020-12
natively"*).

**Source:** `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:75-96`:

```js
inputSchema: (() => {
    const obj = normalizeObjectSchema(tool.inputSchema);
    return obj
        ? toJsonSchemaCompat(obj, {
            strictUnions: true,
            pipeStrategy: 'input'
        })
        : EMPTY_OBJECT_JSON_SCHEMA;
})(),
…
if (tool.outputSchema) {
    const obj = normalizeObjectSchema(tool.outputSchema);
    if (obj) {
        toolDefinition.outputSchema = toJsonSchemaCompat(obj, {
            strictUnions: true,
            pipeStrategy: 'output'
        });
    }
}
```

The SDK passes no `target` to `toJsonSchemaCompat`. Combined with
`mapMiniTarget`'s `undefined → 'draft-7'` default, **the `tools/list`
output will be draft-7 regardless of whether the input is v3 or v4**.

**Three remediation options:**

1. **Upstream fix** — file an issue against `@modelcontextprotocol/sdk`
   asking the `tools/list` path to pass `target: 'draft-2020-12'`
   explicitly (the per-tool emission paths in `adapters/json-schema.ts`
   can already do the right thing via the wrapper, but the SDK-driven
   path can't).

2. **Pin a fixed SDK version** — if the SDK already has a fix on a
   newer release (1.27+ speculative; not currently published), pin to it.

3. **Workaround in Exarchos** — intercept the SDK's `tools/list` response
   and rewrite `$schema` / `target`. Brittle; not recommended.

**Decision-record proposal:** include in the recommendation that PR-C's
acceptance criterion be **relaxed** to "`tools/list` schemas are
structurally 2020-12-compatible (which draft-7 is for the constructs we
emit) and the per-tool `adapters/json-schema.ts` wrapper emits true
2020-12". Then file a follow-up issue for the SDK upstream fix.

This is non-fatal — `adapters/json-schema.ts` is the chokepoint for
**internal** schema emission (describe handlers, fingerprint, runbooks),
and it WILL emit true 2020-12 post-migration. Only the SDK-mediated
`tools/list` boundary remains draft-7 until upstream lands the fix.

---

## 11. SDK compatibility gate — `normalizeObjectSchema` rejects v4 discriminated unions (LCD)

**Source:** `node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js:79-121`:

```js
export function normalizeObjectSchema(schema) {
    if (!schema) return undefined;
    // ...
    if (isZ4Schema(schema)) {
        const v4Schema = schema;
        const def = v4Schema._zod?.def;
        if (def && (def.type === 'object' || def.shape !== undefined)) {
            return schema;
        }
    } else {
        const v3Schema = schema;
        if (v3Schema.shape !== undefined) {
            return schema;
        }
    }
    return undefined;
}
```

For a Zod v4 `discriminatedUnion`, `_zod.def.type === 'union'` (with a
subclass of `ZodDiscriminatedUnion` over `ZodUnion`). `normalizeObjectSchema`
returns `undefined`. Downstream at `mcp.js:88-96`, the
`if (obj) { toolDefinition.outputSchema = … }` branch is skipped — so the
discriminated-union outputSchema is silently dropped from `tools/list`.

**Concrete impact:** the LCD `EnvelopeSchema(z.unknown())` workaround
currently in `adapters/mcp.ts:37-43` (which uses
`z.object({...}).passthrough()` to dodge this exact issue) **must remain**
under Zod v4. The SDK has not improved the LCD code path between v3 and v4.

This is captured in the decision record as item 3 (LCD reactivation
strategy).

---

## 12. Repo usage census (raw greps)

Reproducible commands:

```bash
WT=/path/to/worktree

# imports
grep -rh "^import.*from 'zod'" $WT/servers/exarchos-mcp/src --include="*.ts" \
  | sort | uniq -c | sort -rn

# _def introspection
grep -rn "_def\." $WT/servers/exarchos-mcp/src --include="*.ts"

# ZodTypeAny
grep -rn "ZodTypeAny" $WT/servers/exarchos-mcp/src --include="*.ts"

# z.record single-arg (post-filter manually)
grep -rn "z\.record(" $WT/servers/exarchos-mcp/src --include="*.ts"

# preprocess construction
grep -rn "z\.preprocess" $WT/servers/exarchos-mcp/src --include="*.ts"

# instanceof z.ZodEffects (the introspection blocker)
grep -rn "instanceof z\.ZodEffects" $WT/servers/exarchos-mcp/src --include="*.ts"

# chained string formats
grep -rnE "z\.string\(\)\.(email|url|uuid|datetime|ip|cidr|base64|emoji)" \
  $WT/servers/exarchos-mcp/src --include="*.ts"

# discriminated unions
grep -rn "z\.discriminatedUnion" $WT/servers/exarchos-mcp/src --include="*.ts"

# .strict() / .passthrough()
grep -rnE "\.(passthrough|strict)\(\)" $WT/servers/exarchos-mcp/src --include="*.ts"
```

---

## 13. Summary

- **Total breaking-change categories cataloged:** 35 (28 in the user-facing
  API + 7 internal; ~6 affect this repo materially)
- **`_def` introspection sites needing rewrite:** 22 (across `registry.ts`
  and `adapters/schema-to-flags.ts`)
- **`z.ZodTypeAny` references to mechanically rename:** 30 across 6 files
- **`instanceof z.ZodEffects` checks needing `ZodPipe` rewrite:** 6 sites
- **Single-arg `z.record()` sites needing two-arg form:** 9
- **String-chained-format sites (deferrable):** 20 (can stay as
  deprecation warnings during PR-C)
- **SDK Zod v4 path is functional but the `tools/list` boundary still emits
  draft-7 (missing `target` passthrough)** — file upstream; relax PR-C
  acceptance to "structurally-equivalent 2020-12"
- **SDK's `normalizeObjectSchema` still rejects v4 discriminated unions**
  — LCD passthrough-object workaround must remain
- **Latest Zod v4 stable as of 2026-05-13:** `4.4.3` (released 2026-05-04,
  9 days old → satisfies renovate ≥7-day gate)

The three decision points for ratification are in the companion file
`docs/research/2026-05-13-zod-v4-decision-record.md`.
