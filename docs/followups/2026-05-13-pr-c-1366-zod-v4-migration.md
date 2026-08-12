# PR-C — Migrate `exarchos-mcp` from Zod v3 to Zod v4 (#1366)

**Stack position:** PR-C of the Wave 0 follow-up stack — the largest and last
**Base branch:** PR-B's branch (`refactor/wave-0-followups/1368-cli-toCliResult-wiring`)
**Head branch:** `refactor/wave-0-followups/1366-zod-v4-migration`
**Closes:** #1366
**Unblocks:** Native JSON Schema 2020-12 emission; removes the relabel hack in `adapters/json-schema.ts`
**Source of this brief:** `docs/followups/2026-05-13-pr-c-1366-zod-v4-migration.md`

## Why

Wave 0 (#1369) advertises JSON Schema 2020-12 on emitted schemas — but **structurally**, the schemas are draft-2019-09 with the `$schema` URL relabeled. The cause: `zod-to-json-schema@3.25.2` is the archived final release of that package (changelog: *"v4 now supports JSON schema natively"*). It supports `jsonSchema7 | jsonSchema2019-09 | openApi3 | openAi` targets — never 2020-12. `@modelcontextprotocol/sdk@1.29.0` (the version pinned by this PR; the original draft cited 1.26.x) internally converts Zod schemas, but its routing splits on Zod major: v4 inputs take the `z4mini.toJSONSchema(target: 'draft-2020-12')` path and emit **true** 2020-12; v3 inputs fall through to the same archived `zodToJsonSchema` and emit draft-07.

Migrating `servers/exarchos-mcp` from `zod@^3.23` to `zod@^4` is the lever:
1. `adapters/json-schema.ts` becomes a thin wrapper over `z.toJSONSchema(schema, { target: 'draft-2020-12' })` — no relabel hack
2. `@modelcontextprotocol/sdk@1.26`'s internal converter emits true 2020-12 on `tools/list` automatically
3. Emitted schemas use 2020-12-specific structural keywords where appropriate (`prefixItems`, `unevaluatedProperties`)

This PR is the **highest-leverage, highest-risk** of the three follow-ups. Every Zod usage in the MCP server (56 files, ~51 use schema constructs) goes through a major-version migration with breaking API changes.

## Zod v4 breaking changes survey

Per [Zod v4 migration guide](https://zod.dev/v4), the surface areas that affect this codebase:

| v3 idiom | v4 equivalent | Files likely affected |
|---|---|---|
| `z.record(z.unknown())` | `z.record(z.string(), z.unknown())` (key schema now required) | registry.ts, schemas/envelope.ts, format.ts |
| `z.string().min(1).max(N)` | unchanged | most schemas |
| `z.preprocess((arg, ctx) => ...)` | unchanged but ZodEffects API tightened | coerce.ts, registry.ts |
| `z.ZodTypeAny` | `z.ZodType` (or specific) | every interface declaration |
| `schema._def.typeName` | `schema._zod.def.type` | introspection in `buildRegistrationSchema`, `validateAgainstActionSchema`, `aggregateToolAnnotations` |
| `z.discriminatedUnion('k', [a, b])` | unchanged structurally but error message format changed | schemas/envelope.ts |
| `z.infer<typeof X>` | unchanged | every type alias |
| `z.input<typeof X>` / `z.output<typeof X>` | unchanged | none in repo so far |
| `.parse()` / `.safeParse()` | unchanged | most call sites |
| `.passthrough()` / `.strict()` | unchanged | registry.ts |
| `ZodError.issues[].path` | `path` may include keys instead of indices in some cases | `_meta.outputSchemaViolation` formatting in adapters/mcp.ts |
| `z.string().email()` etc. | moved to top-level `z.email()` | unknown — need scan |

Plus `z.toJSONSchema` (the new v4 native converter) replaces `zod-to-json-schema` entirely for production emission.

**This survey must be re-run against the actual codebase during the audit phase** — Zod v4 is mature now (v4.x post-2025-06) but the migration cliff for individual idioms varies.

## Scope

### `package.json` changes

| File | Change |
|---|---|
| `servers/exarchos-mcp/package.json` | Bump `zod` from `^3.23.0` to `^4.0.0` (or whatever latest stable ≥7-days-old per the renovate gate) |
| `servers/exarchos-mcp/package.json` | Drop `zod-to-json-schema` dependency entirely (no longer needed) |

### Adapter rewrite

| File | Change |
|---|---|
| `servers/exarchos-mcp/src/adapters/json-schema.ts` | Replace upstream call: `return z.toJSONSchema(schema, { target: 'draft-2020-12', ...opts })`. Drop `JSON_SCHEMA_2020_12_URI` export (no longer needed for relabel). Drop the relabel section of the source comment. Add a forward note: "Native 2020-12 emission via Zod v4; replaces relabel from #1366 era." |

### Schema declarations (`servers/exarchos-mcp/src/contract/schemas/envelope.ts`)

The `EnvelopeSchema` factory and supporting schemas migrate to v4:
- `z.discriminatedUnion('success', [...])` — verify shape preserved
- `z.array(NextActionSchema)` — likely unchanged
- `z.record(...)` — needs key schema added
- `z.literal(true)` / `z.literal(false)` — unchanged
- Possibly tighten Envelope success-branch `success: z.literal(true)` for cleaner discriminated-union narrowing (this resolves a v3 TypeScript narrowing issue surfaced in D.2/D.3 agent's report)

### Registry surface (`servers/exarchos-mcp/src/registry.ts`)

The big file. Areas:
- `ToolAction.schema: z.ZodObject<z.ZodRawShape>` — verify v4 generic compatibility
- `ToolAction.outputSchema: z.ZodTypeAny` → `z.ZodType` (v4 idiom)
- `ActionAnnotationsSchema = z.object({...}).strict()` — verify .strict() behavior unchanged
- `buildCompositeSchema` discriminated-union construction — verify v4 .extend() / discriminator generics
- `buildRegistrationSchema` — uses `field._def` introspection; migrate to v4 `_zod.def`
- All 95 `outputSchema: EnvelopeSchema(...)` declarations — should be transparent if EnvelopeSchema's signature is preserved

### Handler/coercion files

- `servers/exarchos-mcp/src/coerce.ts` — `z.preprocess` migration if needed
- `servers/exarchos-mcp/src/workflow/schemas.ts` — verify Zod v4 compatibility
- `servers/exarchos-mcp/src/next-action.ts` — `NextAction` schema preservation
- `servers/exarchos-mcp/src/format.ts` — `wrapError` v4 compatibility
- All ~56 files importing `zod` — sweep and adapt

### Test fixtures

- Snapshot tests asserting `$schema === 'https://json-schema.org/draft/2020-12/schema'` — should still pass since the URL is the same
- Snapshot tests asserting structural keywords — may need updates if Zod v4 emits `prefixItems` where Zod v3 emitted `items: []`
- Any test using `schema._def.typeName` for introspection — update to v4 `_zod.def.type`
- `adapters/json-schema.test.ts` — drop the override-target test since the wrapper no longer relabels (or repurpose as a "passes through to z.toJSONSchema" test)
- `adapters/json-schema-migration.test.ts` (from B.2-B.5 era) — update assertions to expect true 2020-12 structural shape

### MCP adapter (`adapters/mcp.ts`)

- `validateAgainstActionSchema` — Zod v4's `safeParse` may have a slightly different error issue shape; update `_meta.outputSchemaViolation` mapping
- `aggregateToolAnnotations` — unchanged (consumes ToolAction.annotations)
- `LCD_OUTPUT_SCHEMA` — the SDK's ZodObject constraint may relax in newer SDK versions; verify whether passthrough ZodObject is still needed or whether the canonical `EnvelopeSchema(z.unknown())` discriminated union is now acceptable

## Implementation plan

**Iron Law: no production code change without a failing test first.** For a migration this size, the TDD discipline is per-module: bump the dep, watch ~50 file's tests fail, then bring them back to green one cohesive surface at a time.

### Phase 1 — Audit (1 agent, ≤4 hours)

| Task | Action |
|---|---|
| C1.1 | Read Zod v4 migration guide; produce a `docs/research/2026-05-XX-zod-v4-breaking-changes.md` cataloging EVERY breaking change relevant to the repo |
| C1.2 | `grep -rn "z\." servers/exarchos-mcp/src --include="*.ts" \| head -200` — sample representative usage patterns |
| C1.3 | Specifically catalog: `_def.typeName` access (`buildRegistrationSchema` will need rewriting), `z.preprocess` call sites (coerce.ts), `z.record` without explicit key schema, `ZodTypeAny` import sites |
| C1.4 | Verify the SDK's Zod v4 path: read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js` to confirm v4 detection and target='draft-2020-12' usage |
| C1.5 | Pick the target Zod version (latest stable ≥7 days old per renovate gate). Commit findings as `docs(pr-c): Zod v4 migration audit` |

### Phase 2 — Foundation: bump dep + adapter rewrite (1 agent, 1–2 hours)

| Task | Action |
|---|---|
| C2.1 | Bump `zod` to `^4.x` in `servers/exarchos-mcp/package.json`; drop `zod-to-json-schema` |
| C2.2 | Run `npm install` from `servers/exarchos-mcp` |
| C2.3 | Run `npx tsc --noEmit` — capture the breaking-change error list; commit findings to a tracking file |
| C2.4 | Rewrite `adapters/json-schema.ts` to use `z.toJSONSchema(schema, { target: 'draft-2020-12', ...opts })`. Drop `JSON_SCHEMA_2020_12_URI` export and relabel logic. Update source comment. |
| C2.5 | Update `adapters/json-schema.test.ts` to assert native 2020-12 emission (no relabel test). The override-target test repurposes as "respects caller overrides" |
| C2.6 | Run `npx vitest run src/adapters/json-schema.test.ts` — expect GREEN |
| C2.7 | Commit as `feat(pr-c): bump zod to v4 + rewrite json-schema adapter for native 2020-12 (#1366)` |

### Phase 3 — Schema foundation: `contract/schemas/envelope.ts` (1 agent, 1–2 hours)

| Task | Action |
|---|---|
| C3.1 | Update `EnvelopeSchema`, `SuccessEnvelopeSchema`, `ErrorEnvelopeSchema`, `NextActionSchema`, `PerfMetricsSchema`, etc. for Zod v4 syntax |
| C3.2 | Tighten `Envelope<T>.success` to `z.literal(true)` (success branch); this resolves the v3 narrowing issue and is more precise |
| C3.3 | Run `npx vitest run src/contract/schemas/envelope.test.ts`. Expect GREEN. |
| C3.4 | Commit as `refactor(pr-c): migrate envelope schemas to Zod v4 (#1366)` |

### Phase 4 — Registry surface: `registry.ts` (1 agent, 2–4 hours)

This is the heaviest single file. The agent:
1. Migrates `ToolAction` interface to v4 type idioms (`z.ZodType` instead of `z.ZodTypeAny`)
2. Migrates `ActionAnnotationsSchema` and `validateAnnotations`
3. Rewrites `buildRegistrationSchema` introspection (`_def.typeName` → `_zod.def.type`)
4. Verifies all 95 per-action declarations compile (the agent doesn't touch them individually — just ensures the factory + types support them)
5. Runs `npx vitest run src/registry.test.ts`. Expects GREEN with the discriminated-union assertion test gaining `prefixItems` if applicable.

Commit as `refactor(pr-c): migrate registry to Zod v4 (#1366)`.

### Phase 5 — Adapters: `mcp.ts` + `cli.ts` + `cli-format.ts` (1 agent, 1–2 hours)

| Task | Action |
|---|---|
| C5.1 | `adapters/mcp.ts`: update `validateAgainstActionSchema` to consume v4 `.safeParse` issue shape (path may differ). Update `LCD_OUTPUT_SCHEMA` to use canonical `EnvelopeSchema(z.unknown())` if the SDK now accepts unions (or keep the passthrough workaround if not — verify against the pinned SDK version) |
| C5.2 | `adapters/cli-format.ts`: verify Envelope/ErrorEnvelope type narrowing (the discriminated-union narrowing issue noted in D.2/D.3 agent report should be resolved post-Phase 3) |
| C5.3 | `adapters/cli.ts`: verify integration still passes its tests |
| C5.4 | Run `npx vitest run src/adapters/`. Expect GREEN. |

Commit as `refactor(pr-c): migrate adapters surface to Zod v4 (#1366)`.

### Phase 6 — Sweep remaining surfaces (parallel agents, ~6–12 hours total)

Sweep ~40 remaining `zod`-using files in parallel batches. Group by surface:

| Wave | Files | Effort |
|---|---|---|
| C6.1 | `workflow/` — schemas, handlers, state machine | 1 agent |
| C6.2 | `orchestrate/` — handlers + composite | 1–2 agents |
| C6.3 | `views/` — handlers + composite | 1 agent |
| C6.4 | `event-store/` — concurrency, storage, etc. | 1 agent |
| C6.5 | `projections/` — rehydration, next-action, fingerprint | 1 agent |
| C6.6 | `describe/`, `runbooks/`, `coerce.ts`, `next-action.ts`, `format.ts` | 1 agent |
| C6.7 | All `*.test.ts` files relying on v3 idioms | parallel per directory |

Each agent runs `npx tsc --noEmit && npx vitest run <scope>` until GREEN before commit. Commit per surface.

### Phase 7 — Snapshot updates

| Task | Action |
|---|---|
| C7.1 | Run full snapshot suite with `-u`: `npx vitest run --update` |
| C7.2 | Inspect every changed snapshot. Most should be additive (new structural keywords like `prefixItems`). Reject regressions (e.g., dropping required fields). |
| C7.3 | Commit as `test(pr-c): update snapshots for Zod v4 / 2020-12 structural shape (#1366)` |

### Phase 8 — Final verification

| Task | Action |
|---|---|
| C8.1 | `npm run test:run` from MCP server. Confirm ALL tests green. |
| C8.2 | `npm run test:run` from root. Confirm root parity tests green. |
| C8.3 | `npx tsc --noEmit` (MCP server + root). Confirm clean. |
| C8.4 | Verify `tools/list` over MCP advertises 2020-12 via the SDK's converter (not the wrapper) — drive an integration test against a live in-process server, assert `$schema === 'https://json-schema.org/draft/2020-12/schema'` AND that emitted schemas use 2020-12 structural keywords |
| C8.5 | Drop or simplify the wrapper module if `z.toJSONSchema` is sufficient and lint can enforce non-direct imports of `z.toJSONSchema` |

## Acceptance

- [ ] `servers/exarchos-mcp/package.json` has `zod: ^4.x` (≥7 days old per renovate gate); no `zod-to-json-schema` dependency
- [ ] `adapters/json-schema.ts` wrapper uses `z.toJSONSchema(..., { target: 'draft-2020-12' })` natively; no `JSON_SCHEMA_2020_12_URI` post-emit override
- [ ] All 56 `zod`-using files migrated to v4 API; `npx tsc --noEmit` clean
- [ ] Full test suite green (MCP server + root)
- [ ] Snapshot tests assert structural 2020-12 keywords (`prefixItems` where applicable) where Zod's output legitimately uses them
- [ ] `tools/list` over MCP advertises `$schema: https://json-schema.org/draft/2020-12/schema` natively (verified by live integration test)
- [ ] Source comment in `adapters/json-schema.ts` updated to reflect Zod-v4 path; relabel rationale removed
- [ ] PR description enumerates Zod v4 breaking changes encountered + the migration choices made per surface

## Risks

- **Major-version dep bump blast radius** — Zod is foundational. Every schema declaration potentially needs adjustment. Mitigation: Phase 1 audit catalogs every breaking-change site BEFORE any code change; Phase 2-6 traverse those sites in dependency order.
- **Snapshot churn** — every emitted JSON Schema may change shape (e.g., `items: []` → `prefixItems: []`). Mitigation: Phase 7 inspects each snapshot diff manually; regressions are rejected.
- **SDK Zod v4 detection** — historically `@modelcontextprotocol/sdk@1.26.x` did not handle v4 inputs correctly. The bump to `@modelcontextprotocol/sdk@1.29.0` (pinned by this PR) carries the v4 routing fix; the Phase 1 audit ran against 1.29.0 and confirmed the v4 path.
- **TypeScript strict mode** — Zod v4's type inference may surface stricter compile errors. Mitigation: do not weaken strict mode; fix the call sites.
- **Downstream Exarchos consumers (basileus, plugins)** — if they import schemas from `@lvlup-sw/exarchos`, they break. Mitigation: check if any schemas are re-exported via `package.json` exports field; if yes, coordinate with downstream consumers OR keep the schemas internal.
- **Renovate gate** — must pick a Zod v4 version ≥7 days old. As of 2026-05-13, that's satisfied by Zod v4.x stable releases (the major shipped in 2025).
- **Time investment** — this is the largest of the three follow-ups. ~16–24 hours of focused subagent work. Schedule and budget accordingly.

## Out of scope

- Migrating other `lvlup-sw` workspaces (root installer, exarchos CLI) — they don't use the MCP server's Zod surface. Separate effort if Exarchos-wide migration is desired.
- Re-introducing strict 2020-12 validation at the `tools/list` boundary — out of scope; covered by the live integration test in Phase 8.
- Changing the registered LCD outputSchema back to a discriminated union if SDK accepts it — judgment call during Phase 5.

## Estimated effort

~16–24 hours via subagent dispatch across 7 phases:
- Phase 1 audit: 1 agent, ~4 hours
- Phase 2 foundation: 1 agent, ~2 hours
- Phase 3 envelope: 1 agent, ~2 hours
- Phase 4 registry: 1 agent, ~4 hours
- Phase 5 adapters: 1 agent, ~2 hours
- Phase 6 sweep: 5-7 parallel agents, ~6 hours wall-clock
- Phase 7 snapshots: 1 agent, ~2 hours
- Phase 8 verification: orchestrator inline, ~1 hour

PR-C targets PR-B's branch. If PR-B merges first, retarget to wave-0 (then main).

## Decision points the user may want to weigh in on

- **Zod target version** — latest stable (e.g., 4.5.x) vs. one LTS-pinned (e.g., 4.0.x)? Newer = more API stability but less battle-tested in this codebase.
- **Wrap or strip `adapters/json-schema.ts`** — keep the wrapper as a single conformance chokepoint, or expose `z.toJSONSchema` directly and use a lint rule to gate? The wrapper has lint-discoverability value; recommend keep.
- **Discriminated-union LCD reactivation** — try the canonical `EnvelopeSchema(z.unknown())` against the SDK once on v4. If the SDK's `normalizeObjectSchema` v4 path accepts unions, drop the passthrough ZodObject workaround. If not, file an SDK issue.

These decisions can be deferred until Phase 1's audit informs them.
