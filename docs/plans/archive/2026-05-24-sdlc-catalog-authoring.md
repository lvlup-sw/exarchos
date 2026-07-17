# Implementation Plan: SDLC-* Consumer Catalog + Close the sdlc Seam (#1467)

> **Design:** [`docs/designs/2026-05-24-sdlc-catalog-authoring.md`](../designs/2026-05-24-sdlc-catalog-authoring.md)
> **Branch:** `feature/invariants-v3-content-and-sdlc` (combined PR with #1466)
> **Iron law:** no production code without a failing test first.

## Nature of this work

Mixed code + content + docs: a loader refactor, a new inline-catalog module, a one-line seam change, and a guide update. The 5 `SDLC-*` entries are typed data validated by the existing Zod schema. TDD applies to every code change; the guide (DR-4) is docs (no test, lint-checked).

All tasks land on the single combined branch (no worktree fan-out): the seam change (`resolve-effective-catalog.ts`) and the new module (`sdlc-catalog.ts`) are separate files but chain by dependency, so execution is serial.

---

### Task 1: Expose `parseInvariantEntries` from the loader (refactor enabler)
**Phase:** RED → GREEN → REFACTOR
**Maps:** Chosen-Approach (one parse path, INV-2 spirit)

1. [RED] Add to `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts`
   - Test: `parseInvariantEntries_rawEntries_projectsTypedShapeWithV3Fields`
   - Test: `parseInvariantEntries_duplicateIds_throws`
   - Expected failure: `parseInvariantEntries` is not exported.

2. [GREEN] Refactor `invariants-loader.ts`: extract the existing `data.invariants.map(parseEntry)` + duplicate-id guard into an exported pure `parseInvariantEntries(raw: unknown[]): InvariantEntry[]` (no file-IO, no schema-version guard, no devCatalog gate, no scope filter). `loadInvariants` calls it. Behavior unchanged for the file path.

3. [REFACTOR] Confirm the full loader suite (43 tests) stays green — the extraction is behavior-preserving.

**Dependencies:** None
**Parallelizable:** No (shared file with later edits)

---

### Task 2: `sdlc-catalog.ts` — author the 5-entry baseline
**Phase:** RED → GREEN → REFACTOR
**Maps:** DR-1

1. [RED] New `servers/exarchos-mcp/src/architecture/sdlc-catalog.test.ts`
   - Test: `loadSdlcCatalog_returnsFiveEntries_allAuditModeIntegritySdlc`
   - Test: `loadSdlcCatalog_everyEntry_axisSubstrateWorkflowAffinityExcludesDiscovery`
   - Test: `loadSdlcCatalog_malformedEntry_throwsAtLoad` (e.g. an embedded `script` key fails the `.strict()` enforcement schema)
   - Expected failure: module does not exist.

2. [GREEN] Author `sdlc-catalog.ts`: a raw-entry array (SDLC-1..5 per DR-1 table — `integrity-class: sdlc`, `axis: substrate`, `mode: audit` transport-neutral + workload-neutral prompts, `severity`, `workflow-affinity` excluding `discovery`; SDLC-2 prompt references `check_tdd_compliance`), and `loadSdlcCatalog()` = `parseInvariantEntries(RAW_SDLC_ENTRIES)` (Task 1), validated/fail-fast at module load.

3. [REFACTOR] Verify prompts contain no MCP-local language (INV-3) and no workflow-typed branching assumptions (INV-6).

**Dependencies:** Task 1
**Parallelizable:** No

---

### Task 3: Close the sdlc-layer seam (default-on)
**Phase:** RED → GREEN → REFACTOR
**Maps:** DR-2

1. [RED] Add to `servers/exarchos-mcp/src/architecture/resolve-effective-catalog.test.ts`
   - Test: `resolveEffectiveCatalog_devCatalogDisabled_stillReturnsSdlcEntries` (consumer scenario: dev layer empty, sdlc populated, default-on)
   - Test: `resolveEffectiveCatalog_workflowDiscovery_excludesAllSdlcEntries`
   - Expected failure: sdlc layer is the empty-array placeholder → zero SDLC entries.

2. [GREEN] In `resolve-effective-catalog.ts:131`, replace `const sdlc: InvariantEntry[] = []` with `const sdlc = loadSdlcCatalog()`. No gate.

3. [REFACTOR] Confirm `resolveEffectiveCatalog` stays pure (no fs added for the sdlc layer; INV-1).

**Dependencies:** Task 2
**Parallelizable:** No

---

### Task 4: Override-floor verification (the INV-11 acceptance)
**Phase:** RED → GREEN → REFACTOR
**Maps:** DR-3

1. [RED] Add to `resolve-effective-catalog.test.ts`
   - Test: `resolveEffectiveCatalog_sdlc3SeverityOverrideAdvisory_clampHonored`
   - Test: `resolveEffectiveCatalog_sdlc3EnabledFalse_refusedAndWarns` (floor=advisory → entry survives + warning, never silent drop)
   - Expected failure (pre-seam) / regression guard (post-seam): without the sdlc layer there is no SDLC-3 to override.

2. [GREEN] No new code expected — `applyOverrides` + the honored-disable filter already enforce the floor (delivered by #1465). This task proves it end-to-end against the real SDLC-3 entry. If a gap surfaces, fix minimally.

3. [REFACTOR] Assert the warning text names SDLC-3 and the floor.

**Dependencies:** Task 3
**Parallelizable:** No

---

### Task 5: Parity — gate + view surface identical SDLC payload
**Phase:** RED → GREEN → REFACTOR
**Maps:** DR-2 (INV-2)

1. [RED] Add a parity assertion (reuse `servers/exarchos-mcp/src/__tests__/parity-harness.ts` patterns) that the `invariants_effective` view / CLI `--json` and the gate's resolved catalog both contain the SDLC-* entries for a consumer context.
   - Test: `invariantsEffective_consumerContext_surfacesSdlcEntries_cliMcpIdentical`
   - Expected failure / regression guard.

2. [GREEN] Content already wired (Task 3); this verifies byte/shape identity across facades.

3. [REFACTOR] —

**Dependencies:** Task 3
**Parallelizable:** Yes (independent of Task 4)

---

### Task 6: Update the consumer authoring guide (DR-4) + full verification
**Phase:** (docs — no RED) → verify

1. [GREEN] Update `docs/guides/authoring-invariants.md`: replace the "sdlc layer is empty / forthcoming" status note with the shipped default-on `SDLC-*` baseline (all five named), the override-floor semantics (tune-to-advisory, not disable), and the dev/sdlc/user audience split (research §3) + a worked override example.

2. [VERIFY] `cd servers/exarchos-mcp && npm run test:run`; root `npm run test:run`; root `npm run typecheck`; `npm run skills:guard`; `npm run lint:invariants` (coverage-closure still green, no new findings — SDLC-* is outside the INV-/DIM- token regex, lint-neutral).

**Dependencies:** Tasks 1–5
**Parallelizable:** No

---

## Execution order

```
Task 1 (expose parseInvariantEntries)
   └─▶ Task 2 (sdlc-catalog.ts + 5 entries)
          └─▶ Task 3 (close seam, default-on)
                 ├─▶ Task 4 (override-floor verify)
                 └─▶ Task 5 (facade parity)
                        └─▶ Task 6 (guide + full suites)
```

## Definition of done (acceptance roll-up)

- [ ] `loadSdlcCatalog()` → 5 schema-valid entries, all `mode: audit`, `integrity-class: sdlc`, `axis: substrate`; malformed entry fails at load (DR-1).
- [ ] Seam closed: `devCatalog: disabled` consumer still gets SDLC-* (default-on); discovery excludes them (DR-2).
- [ ] Override-floor: SDLC-3 severity-clamp honored; full-disable refused + warning (DR-3, INV-11).
- [ ] Facade parity: gate + view identical SDLC payload (INV-2).
- [ ] Guide updated; `lint:invariants` coverage-closure green + no new findings; full MCP + root suites green; `tsc --noEmit` clean; `skills:guard` exit 0 (DR-4).
