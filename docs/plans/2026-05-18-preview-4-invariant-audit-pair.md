# Implementation Plan — preview.4 invariant-audit pair (#1439 + #1370)

> **Design:** `docs/designs/2026-05-18-preview-4-invariant-audit-pair.md`
> **Date:** 2026-05-18
> **Integration branch (bundle):** `feature/preview-4-invariant-audit-pair`
> **PR-1 branch:** `feature/preview-4-invariant-audit-1439` (off integration)
> **PR-2 branch:** `feature/preview-4-invariant-audit-1370` (stacked off PR-1)
> **Closes:** #1439 (PR-1), #1370 (PR-2)
> **Iron Law:** No production code without a failing test first. Audit research deliverables (markdown) are exempt — they are reviewable artifacts, not executable surface.

---

## Wave map

| Wave | Tasks | PR | Parallelizable | Notes |
|---|---|---|---|---|
| **A** (audit research) | A1 | PR-1 | Single task | Markdown deliverable; no TDD |
| **B** (catalog edits) | B1, B2, B3 | PR-1 | B1 ∥ B2 (different files); B3 last | Per-entry edits to invariants.md and INV-* references |
| **C** (cost-of-load split) | C1, C2 | PR-1 | C1 → C2 | Loader scope arg + entry-level frontmatter marker |
| **D** (Phase 0 prompt update) | D1 | PR-1 | After C2 | `commands/ideate.md` Phase 0 directive |
| **E** (phase-transition audit) | E1 | PR-2 | After PR-1 lands | Markdown deliverable; no TDD |
| **F** (HIGH-finding fixes) | F1; F2..Fn | PR-2 | Fn count determined post-E1; planned via `/exarchos:plan --revise` | Each Fn is a strict-TDD task (regression test → fix) |

**Dependency edges:**
- Wave A produces audit verdicts that drive B + C + D.
- Wave E is read-only until F1 (issue triage); F2..Fn are inserted post-E1 via plan revision.
- PR-2 stacks on PR-1; merge bottom-up.

---

## PR-1 — Catalog content audit (#1439)

Branch: `feature/preview-4-invariant-audit-1439`

### Task A1: Conduct 5-part catalog content audit

**Closes:** #1439 (audit deliverable)
**Phase:** RESEARCH (markdown deliverable — Iron Law exempt; the audit IS the spec the subsequent tasks implement against)

1. **[RESEARCH]** Walk all 18 entries in `docs/architecture/invariants.md` and produce `docs/research/2026-05-18-invariant-content-audit.md`. For each entry, record:
   - **Coverage** — list ≥3 file:line references that exemplify the invariant. Use `grep`/`rg` against the entry's `applies-to` scopes as the search frontier.
   - **Currency** — verify each `applies-to` scope still maps to a present codebase surface. Flag stale scopes (e.g., JSONL runtime ripped via #1332, deprecated DR-4/6/7 shims).
   - **Contradiction** — check whether the implementation actually honors the entry's claim. Reference exemplar: `docs/research/2026-05-16-event-sourced-task-store-audit.md` FINDING-2 (INV-1 wording vs. `EventSourcedTaskStore.tasks` cache).
   - **Selection-rule** — for INV-5: decide whether to add an `INV-5` umbrella entry to the catalog OR migrate the ~10 umbrella file references to specific INV-5a/b/c/d. Document the decision.
   - **Cost-of-load** — classify as `always-load` (Phase 0 surfaces it on most ideations) | `reference-only` (load on-demand) | `archivable` (move to `docs/architecture/invariants-archive.md`).
   - **recommended_action** — one of `keep` | `sharpen <new-summary>` | `delete <reason>` | `move-archive` | `downgrade-to-principle`.
   - **INV-4 cross-runtime check** (per design §6) — for each entry's `summary:` and `applies-to:` wording, verify no Claude-Code-specific assumption leaks (e.g., literal `Skill({...})`, `.claude/`-rooted paths in entry text). Flag with `inv-4-finding: yes/no`.

2. **[RESEARCH]** Walk `.claude/skills/design-invariants/SKILL.md` description per design §6 INV-5a. Record a one-paragraph appendix: does the skill description give "do NOT use for" guidance (yes per current §"When NOT to use" — verify intact post-edits)? Are triggers (`'check invariants'`, etc.) workflow-neutral? Any `inv-5a-finding` is filed in the same audit doc's findings table.

3. **[VERIFY]** Audit doc passes its own integrity check: every entry has all 5 sections + a `recommended_action` + an `inv-4-finding` field; the INV-5a appendix is present. Verified by reviewer; no script.

**Dependencies:** None
**Parallelizable:** No (single-author audit)

---

### Task B1: Apply catalog edits to `docs/architecture/invariants.md`

**Closes:** #1439 (edits)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `Invariants_AfterAudit_AllRequiredIdsStillPresentOrExplicitlyMigrated`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: `REQUIRED_INVARIANT_IDS` + `REQUIRED_DIMENSION_IDS` arrays match the post-audit catalog. If A1 recommends deleting/downgrading an ID currently in the required set, this test fails until the required list is updated *with explicit rationale in a comment*. The test forces the audit's deletion verdicts to be reconciled with the load contract.
   - Companion test: `Invariants_AfterAudit_EveryKeptEntryHasMinimumThreeReferencesInFrontmatter`
     - Asserts each entry's `references:` array length ≥ 3 (or `recommended_action: delete` documented in audit doc — but the test only sees frontmatter, so this is a YAML-level check).
   - Expected failure: today the loader test requires INV-5a/b/c/d but doesn't require ≥3 references per entry; A1 may produce verdicts that change the required set.

2. **[GREEN]** Apply audit verdicts to `docs/architecture/invariants.md`:
   - For each entry with `recommended_action: keep` — leave as-is.
   - For `sharpen` — replace `summary:` text per A1's audit doc.
   - For `delete` — remove entry; update `REQUIRED_INVARIANT_IDS`/`REQUIRED_DIMENSION_IDS` in the loader test (with comment linking back to audit doc § for the entry).
   - For `move-archive` — see Task B2.
   - For `downgrade-to-principle` — see Task B3.
   - Resolve INV-5 selection-rule per A1's verdict.
   - For each kept entry, ensure `references:` array has ≥3 entries (file paths from A1's coverage walk).

3. **[REFACTOR]** Run `npm run skills:guard` + `cd servers/exarchos-mcp && npm test -- invariants-loader` to verify no consumer breakage. Then run `/axiom:humanize` (per design §7 acceptance) on the edited `summary:` fields of `docs/architecture/invariants.md` — fix any AI-writing tells (em-dash overuse, inflated phrasing, rule-of-three patterns) before opening PR-1.

**Dependencies:** A1
**Parallelizable:** With B2 (different files)

---

### Task B2: Create archive file (if A1 recommends `move-archive` for any entry)

**Closes:** #1439 (archive split)
**Phase:** RED → GREEN

1. **[RED]** Write test: `InvariantsArchive_WhenAuditRecommendsMoveArchive_FileExistsAndParses`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend) or new `invariants-archive-loader.test.ts`
   - Asserts: if A1's audit doc lists ≥1 entry with `recommended_action: move-archive`, then `docs/architecture/invariants-archive.md` exists and parses as a valid invariants document (same schema as catalog). Entries listed in the audit doc as `move-archive` appear in the archive file, not the active catalog.
   - Conditional skip: if A1 recommends 0 entries for archive, test skips with `it.skip` — no archive file is created in that case.
   - Expected failure: archive file does not yet exist.

2. **[GREEN]** If A1 has ≥1 `move-archive` entry: create `docs/architecture/invariants-archive.md` with `schema-version: 1` frontmatter, move flagged entries verbatim, ensure they retain their `references:` arrays. Add a top-of-file note: "Archived invariants. Not loaded by `/ideate` Phase 0. Reference for historical context only."

3. **[REFACTOR]** None expected.

**Dependencies:** A1
**Parallelizable:** With B1 (different file)

---

### Task B3: Sharpen INV-* reference files in `.claude/skills/design-invariants/references/`

**Closes:** #1439 (reference-file edits)
**Phase:** EDIT (no behavioral test — prose changes)

1. **[EDIT]** For each entry where A1 verdict is `sharpen` AND the corresponding reference file at `.claude/skills/design-invariants/references/INV-*.md` has wording that diverges from the new summary, update the reference file to match. Cross-link audit doc § for traceability.
2. **[VERIFY]** Run `npm run build:skills` and confirm no diff in `skills/<runtime>/design-invariants/**` (reference files are copied verbatim — any drift indicates a structural override needs updating).

**Dependencies:** B1
**Parallelizable:** No (sequential after B1 to avoid wording drift)

---

### Task C1: Add `cost-of-load` field to invariant entry schema

**Closes:** #1439 (cost-of-load split — schema layer)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `LoadInvariants_WithScopeCore_ReturnsOnlyAlwaysLoadEntries`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts:
     - `loadInvariants(INVARIANTS_DOC, { scope: 'core' })` returns only entries with `cost-of-load: always-load`.
     - `loadInvariants(INVARIANTS_DOC, { scope: 'all' })` (or default) returns every entry.
     - `loadInvariants(INVARIANTS_DOC)` defaults to `{ scope: 'all' }` for backwards compat.
   - Companion test: `Invariants_EveryEntry_HasCostOfLoadField`
     - Asserts each entry's frontmatter has a `cost-of-load` field matching one of `always-load` | `reference-only` | `archivable`.
   - Companion test: `LoadInvariants_WithUnknownScope_ThrowsLoudly` (per design §5 DIM-2)
     - Asserts: `loadInvariants(INVARIANTS_DOC, { scope: 'invalid-scope' as any })` throws an `Error` whose message names the offending scope and lists the valid options. No silent degradation, no fallback to `'all'`.
   - Expected failure: `cost-of-load` field doesn't exist on entries; `loadInvariants` has no `scope` arg; unknown scopes don't throw.

2. **[GREEN]**
   - Extend `InvariantEntry` type in `servers/exarchos-mcp/src/architecture/invariants-loader.ts` with `costOfLoad: 'always-load' | 'reference-only' | 'archivable'`.
   - Modify `loadInvariants` to accept an optional `{ scope: 'core' | 'all' }` argument and filter accordingly.
   - Add `cost-of-load: <classification>` to every entry in `docs/architecture/invariants.md` per A1's verdicts.

3. **[REFACTOR]** Co-locate the scope-filter logic; document the public API with one-line JSDoc on the public type.

**Dependencies:** A1, B1
**Parallelizable:** With B2/B3 (different concern)

---

### Task C2: Surface core scope through the loader-export wrapper used by `/ideate` Phase 0

**Closes:** #1439 (cost-of-load split — surface layer)
**Phase:** RED → GREEN

1. **[RED]** Write test: `InvariantsLoaderExport_CoreScope_IsConsumedByPhase0Renderer`
   - File: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts` (extend)
   - Asserts: there exists a documented export (e.g., `loadCoreInvariants()` or `loadInvariantsForPhase0()`) that returns only `always-load` entries; downstream consumers (vocabulary-lint, /ideate Phase 0 wrappers if any in code, design-invariants skill loader hook) use it OR explicitly call `loadInvariants(..., { scope: 'all' })`.
   - Expected failure: only the original `loadInvariants` exists.

2. **[GREEN]** Add the named wrapper export. Audit existing consumers (`grep -rn 'loadInvariants(' servers/`) and update each call site to pass an explicit scope or use the wrapper.

**Dependencies:** C1
**Parallelizable:** No (depends on C1)

---

### Task D1: Update `/ideate` Phase 0 directive in `commands/ideate.md` to honor cost-of-load split

**Closes:** #1439 (Phase 0 prompt update)
**Phase:** EDIT + VERIFY (prompt directive change — no automated TDD target; manual smoketest)

1. **[EDIT]** Update `commands/ideate.md` Phase 0 (lines 34-36) directive:
   - Change "load the machine-readable invariants catalog at `docs/architecture/invariants.md`" → "load the core invariants catalog at `docs/architecture/invariants.md` (entries marked `cost-of-load: always-load`); load reference-only entries on-demand if the proposal's topic warrants it."
   - Note: if reference-only entries become needed mid-design, the model loads them lazily by re-reading the same file with the model's own filter. No new file required.
   - If A1 recommended archived entries, add a sentence: "Archived invariants (`docs/architecture/invariants-archive.md`) are not loaded; reference only for historical research."

2. **[VERIFY]**
   - Re-render skills: `npm run build:skills` and verify `commands/ideate.md` Phase 0 directive change is preserved.
   - Manual smoketest: invoke `/exarchos:ideate` with a CLI-shaped sample prompt and confirm Phase 0 surfaces the always-load entries before the clarifying questions; confirm prompt does not surface entries marked `reference-only`.
   - Document smoketest result in PR-1 description.

**Dependencies:** C2
**Parallelizable:** No

---

## PR-2 — Phase-transition application audit (#1370)

Branch: `feature/preview-4-invariant-audit-1370` (stacked off PR-1)

### Task E1: Conduct phase-transition audit across all 18 commands

**Closes:** #1370 (audit deliverable)
**Phase:** RESEARCH (markdown deliverable — Iron Law exempt)

1. **[RESEARCH]** For each command in `commands/*.md` (autocompact, checkpoint, cleanup, debug, delegate, discover, dogfood, ideate, oneshot, plan, prune, refactor, rehydrate, review, shepherd, synthesize, tag, tdd), walk every phase transition the command performs and audit against the **audited** catalog from PR-1. Produce `docs/research/2026-05-18-phase-transition-invariant-audit.md`.

2. For each command + each transition, record findings against:
   - **INV-1** — Are events emitted before downstream gates read state? (e.g., `task.assigned` per [memory: feedback_orchestrator_task_assigned_emission])
   - **INV-2** — Does CLI facade produce identical `ToolResult` to MCP facade? Cross-reference `servers/exarchos-mcp/src/workflow/parity.test.ts` coverage.
   - **INV-4** — Runtime-agnostic? Check for hardcoded Claude Code assumptions in the skill body (e.g., literal `Skill({...})` calls).
   - **INV-5b** — `next_actions` present on `ToolResult`? Registry-canonical verb names per [memory: project_review_contract_sot]?
   - **INV-5c** — Verb choice Aspire-inspired? (e.g., `delegate` over `dispatch`)
   - **INV-5d** — Composite-tool dispatch uses action discriminator?
   - **INV-6** — Skill body grepped for workflow-typed literals; `metadata.workflow-type:` declared if intentionally scoped.

3. Findings table uses design-invariants skill's JSON format: `{ command, transition, invariant, severity, file, line, description, required_fix, axiom_overlap? }`. Each finding cites file:line.

4. Produce a triage summary at end of doc:
   - HIGH count by invariant
   - MEDIUM/LOW count by invariant
   - Recommended absorption split: surgical-in-PR-2 vs. file-as-follow-up

**Dependencies:** PR-1 merged to integration branch (catalog edits must be in place before PR-2's audit references them)
**Parallelizable:** No (single-author audit)

---

### Task F1: File HIGH/MEDIUM/LOW findings as standalone issues; classify surgical-in-PR-2 set

**Closes:** #1370 (triage deliverable)
**Phase:** TRIAGE (no code — issue filing only)

1. **[ACT]** For each HIGH finding from E1: file a standalone GitHub issue with the finding's JSON record as the body, labeled `type:bug`, `priority:high`, parented to #1441 if surgical OR to the relevant downstream epic if structural.
2. **[ACT]** For each MEDIUM/LOW finding: file with appropriate severity label.
3. **[ACT]** Update E1's audit doc with a final § "Filed sub-issues" listing each finding-id → GitHub issue-number mapping.
4. **[DECIDE]** Classify each HIGH finding as `surgical-in-PR-2` (one-file, well-contained fix) or `defer-to-follow-up` (broader scope). The `surgical-in-PR-2` set defines the F2..Fn task count.

**Dependencies:** E1
**Parallelizable:** No

---

### Task F2..Fn: Per-HIGH-finding fix (count determined by F1 triage)

**Closes:** the HIGH finding's filed issue
**Phase:** RED → GREEN → REFACTOR (strict TDD)

**Template** (instantiated once per `surgical-in-PR-2` finding):

1. **[RED]** Write test: `<Method>_<Scenario>_<Outcome>` per the finding's `required_fix` field
   - File: co-located alongside the implementation file from the finding's `file` field
   - Asserts: the behavior the invariant requires
   - Expected failure: today's implementation violates the invariant per the finding

2. **[GREEN]** Apply the `required_fix` from the finding

3. **[REFACTOR]** As warranted by the finding's complexity

**Plan revision note:** Task count and concrete task bodies for F2..Fn are determined by E1's audit output. After E1 lands its research doc and F1 classifies the surgical set, re-invoke `/exarchos:plan --revise docs/designs/2026-05-18-preview-4-invariant-audit-pair.md` to insert concrete F2..Fn tasks. The plan-review delta analysis will detect the gap (F2..Fn currently template-only) and the auto-loop will fill it.

**Dependencies:** E1, F1
**Parallelizable:** Per-finding parallel (each Fn is a separate file/test pair); subject to plan-revise output

---

## Parallelization summary

```
PR-1 parallel-safe groups (after A1 completes):
  Group 1: [B1, C1] (both extend invariants-loader.test.ts and invariants.md; serialize within group)
  Group 2: [B2]      (creates new file)
  Group 3: [B3]      (sequential after B1)
  Group 4: [C2, D1]  (C2 first, then D1)

PR-2:
  E1 → F1 → {F2..Fn parallel}
```

A1 and E1 are single-author research tasks (no dispatch).
B/C/D tasks are eligible for parallel dispatch via `/exarchos:delegate` after A1 completes.
F2..Fn are eligible for parallel dispatch after F1 triages.

## Branch + merge sequence

1. Create `feature/preview-4-invariant-audit-pair` off `main` as integration parent.
2. Create `feature/preview-4-invariant-audit-1439` off integration parent. PR-1 opens against `feature/preview-4-invariant-audit-pair`.
3. Dispatch B/C/D tasks onto `task/preview-4-invariant-audit-<id>` branches; merge into `feature/preview-4-invariant-audit-1439`.
4. PR-1 review → CodeRabbit pass → merge to `feature/preview-4-invariant-audit-pair`.
5. Create `feature/preview-4-invariant-audit-1370` off `feature/preview-4-invariant-audit-1439` (now merged into integration). PR-2 opens against `feature/preview-4-invariant-audit-pair`.
6. Dispatch E1; F1 fires after E1; plan-revise; dispatch F2..Fn.
7. PR-2 review → merge to `feature/preview-4-invariant-audit-pair`.
8. Final integration branch → one PR to `main` (or merge in place if the team's stacked-PR pattern targets `main` directly per [memory: PR Operations: GitHub-Native]).

**Merge ordering caveat** [memory: feedback_stacked_pr_auto_merge_collapses_granularity]: do NOT enable `--auto --squash` on PR-2 before PR-1 lands; merge bottom-up explicitly with `gh pr merge --squash` per PR.

## Total task count

- **Concrete tasks now**: 9 (A1, B1, B2, B3, C1, C2, D1, E1, F1)
- **Template tasks (count TBD post-E1)**: F2..Fn (estimate 0–5 based on typical audit yield against a recently-shipped substrate)
- **Estimated total**: 9–14 tasks across 2 PRs
