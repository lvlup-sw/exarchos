# Design — preview.4 invariant-audit pair (#1439 + #1370)

> **Workflow**: `preview-4-invariant-audit-pair`
> **Epic**: #1441 (v2.10.0-preview.4 polish + post-bundle follow-ups)
> **Sub-issues closed by this bundle**: #1439 (content audit), #1370 (phase-transition audit)
> **Downstream unblock**: #1442 (Tier B behavioral eval for `/ideate` invariant surfacing, under epic #1403)
> **Date**: 2026-05-18
> **Status**: Design

## 1. Context

The v2.10.0-preview.4 substrate bundle (PRs #1421–#1452) shipped two artifacts that consume an unverified invariant catalog:

- `docs/architecture/invariants.md` — 18-entry, 319-LOC, ~3.2K-token catalog landed via PR #1425 (#1260). Extracted in one pass from CLAUDE.md prose, project memory, and audit findings; **the content has never been audited against the implementation it claims to govern.**
- `commands/ideate.md` Phase 0 — loads the catalog on every `/ideate` invocation. Token cost scales with every invocation; if entries are stale, the cost is paid against degraded ground truth.

The catalog is now load-bearing for three consumers:
1. `/ideate` Phase 0 — first-turn invariant surfacing for design exploration.
2. `.claude/skills/design-invariants/SKILL.md` — operational projection used during `/exarchos:review` and pre-commit audits.
3. The pending Tier B behavioral eval (#1442 under epic #1403) — measures `/ideate`'s surfacing fidelity. The audit's deliverable IS the eval's ground truth, so the catalog must be audited *before* the eval is built.

Three sub-issues remain open against #1441 — this design covers the two with the strongest mutual coupling. **#1395** (event auto-emission investigation + rehydrate-report spike) is a different domain and ships in a separate, sequential closure bundle.

## 2. Goal

Produce an audited invariant catalog and verified phase-transition conformance, in two stacked PRs, such that:

- Every catalog entry has ≥3 code/doc references OR has been deleted, sharpened, or downgraded.
- Every phase transition in the 18 commands under `commands/` is walked against the audited catalog with HIGH findings fixed and MEDIUM/LOW findings filed.
- `/ideate` Phase 0 cost-of-load is classified (always-load / reference-only / archivable) and the loader honors the split.
- `/design-invariants` is exercised meta-recursively — once on its own catalog (PR-1), once on the artifacts that consume it (PR-2).

Closure of both sub-issues moves #1441 to 13/13 sub-issues closed (the remaining axis after this bundle is #1395 alone), unblocking #1442 in epic #1403.

## 3. Non-goals

- **Not** redesigning the invariant catalog schema. The YAML frontmatter (`schema-version: 1`, `applies-to`, `references`) stays; only entry contents and counts change.
- **Not** building #1442 (the Tier B eval itself). This bundle delivers the eval's stable target; the eval lives under epic #1403.
- **Not** rewriting the `design-invariants` skill body. The skill's INV-1..INV-6 reference files at `.claude/skills/design-invariants/references/` are the operational definitions; they don't need re-derivation. If audit findings change an INV-N entry's wording, the corresponding reference file is updated as a follow-on edit, not as a redesign.
- **Not** addressing #1395 in this bundle (separate domain — sequential closure bundle).
- **Not** rolling up the 3 LOW polish nits from the #1452 review or the bundle-audit §Recommendations reconciliation — both land in the eventual epic-closure pass.

## 4. Approach — Sequential stack

Two PRs, stacked, ordered to eliminate cross-audit false positives.

### PR-1 — Catalog content audit (#1439)

**Deliverable A**: `docs/research/2026-05-NN-invariant-content-audit.md`. For each of the 18 entries:

1. **Coverage** — search the codebase for ≥3 references that exemplify the invariant. Record file:line per reference.
2. **Currency** — verify each `applies-to` scope still matches the post-preview-4 codebase shape. Surfaces renamed/removed (JSONL runtime ripped in #1332, deprecated DR-4/6/7 shims) get trimmed.
3. **Contradiction check** — does the implementation actually honor the invariant's claim? Exemplar: INV-1 wording vs. `EventSourcedTaskStore`'s cache (FINDING-2 in `docs/research/2026-05-16-event-sourced-task-store-audit.md`).
4. **Selection-rule audit** — resolve the INV-5 umbrella decision flagged in PR #1425's "Known follow-up." Either add INV-5 umbrella to the catalog or migrate the 10 file references to INV-5a/b/c/d.
5. **Cost-of-load** — classify each entry as **always-load** (Phase 0), **reference-only** (load on-demand via skill), or **archivable** (move to `docs/architecture/invariants-archive.md`).

Each entry gets a `recommended_action`: `keep` | `sharpen <new-summary>` | `delete <reason>` | `move-archive` | `downgrade-to-principle`.

**Deliverable B**: Apply the recommended actions:
- Edit `docs/architecture/invariants.md` per per-entry verdicts.
- If split, create `docs/architecture/invariants-archive.md` for archived entries.
- Update `commands/ideate.md` Phase 0 loader to honor always-load vs. reference-only split.
- Update `.claude/skills/design-invariants/references/INV-*.md` files where audit findings tighten wording.
- Re-run vocabulary lint (`npm run skills:guard` and any `lint-inv*` scripts) to catch downstream drift.

### PR-2 — Phase-transition application audit (#1370)

Stacked on PR-1's branch — audits the 18 commands under `commands/` (see `ls commands/`) against the **audited** catalog from PR-1.

**Deliverable A**: `docs/research/2026-05-NN-phase-transition-invariant-audit.md`. For each command + each phase transition it performs:

- Which events emit before downstream gates read state? (INV-1)
- Does the CLI facade produce the same `ToolResult` as the MCP facade? (INV-2)
- Does the transition assume Claude Code or is it runtime-agnostic? (INV-4)
- Does the `ToolResult` include `next_actions` and registry-canonical verb names? (INV-5b)
- Are control verbs Aspire-inspired? (INV-5c)
- Is the dispatch shape an action discriminator? (INV-5d)
- Does the command's skill body leak workflow-typed literals without `metadata.workflow-type:`? (INV-6)

Findings use the design-invariants skill's standard JSON format (`verdict`, `findings[]`, each with `invariant`, `severity`, `file`, `line`, `description`, `required_fix`, optional `axiom_overlap`).

**Deliverable B**: Apply HIGH-severity findings as code/skill edits. MEDIUM/LOW findings file as standalone issues parented to the relevant area (e.g., #1438 for task-store-class regressions, new sub-issues for new domains). Apply MEDIUM/LOW only when surgical; defer the rest with explicit rationale.

## 5. Cross-cutting — /axiom:design walk

Each DIM is a design constraint on the bundle itself, not a finding to record. Resolved choices:

- **DIM-1 (Correctness)** — Audit verdicts require ≥3 references for `keep`. False keeps and false deletes are both correctness failures; the reference-count threshold makes "looks load-bearing" verifiable.
- **DIM-2 (Resilience)** — Catalog edits must not silently degrade Phase 0. If the cost-of-load split introduces a lazy-load path, that path needs a loud failure mode (throw, not console.warn), since /ideate's first-turn surfacing is the eval's measurement surface.
- **DIM-3 (Contracts)** — The catalog's YAML frontmatter is a schema. Edits must keep `schema-version: 1` valid; consumers (vocabulary-lint, /ideate loader, design-invariants skill) must keep loading. The audit enumerates consumers explicitly.
- **DIM-4 (Test fidelity)** — Each phase-transition finding cites file:line. Where a HIGH finding maps to a behavioral regression, PR-2 adds a regression test (TDD: red → green → refactor).
- **DIM-5 (Distillation)** — Cost-of-load classification IS a distillation exercise — what's dead weight in the always-load catalog?
- **DIM-6 (Architecture)** — Audit checks whether INV-5 as currently split (5a/5b/5c/5d) is the right factoring, or whether further splits/joins are warranted.
- **DIM-7 (Operational)** — Catalog edits are rollback-safe (markdown + skill files; no migration, no runtime state). The cost-of-load split, if introduced, ships behind a feature-flag-class config check the first PR cycle, then promoted.
- **DIM-8 (Communication)** — Catalog summaries are audited for AI-writing tells via `/axiom:humanize` as a pre-commit pass on PR-1. Vocabulary lint already enforces canonical dimension names; this layer adds prose hygiene.

## 6. Cross-cutting — /design-invariants walk (meta-check)

The audit's own conformance to INV-1..INV-6:

- **INV-1** — N/A. Deliverables are markdown research docs + skill edits; no event-store mutations.
- **INV-2** — N/A. No new verbs introduced.
- **INV-3** — N/A. No runtime YAML changes.
- **INV-4** — Catalog wording must not assume Claude Code as the only runtime. PR-1 explicitly checks each entry against the per-runtime variant rendering at `skills/<runtime>/`.
- **INV-5a (input ergonomics)** — `/design-invariants` skill description audited for "do NOT use for" guidance and trigger clarity.
- **INV-5b (output contract)** — PR-2's transition fixes must restore `next_actions` on any `ToolResult` found missing them.
- **INV-5c (Aspire verbs)** — Transition-level verb choice audited; e.g., does `delegate` align with Aspire's control-plane verb pattern?
- **INV-5d (action discriminator)** — Each transition's dispatch shape checked for the action-discriminator pattern.
- **INV-6** — Catalog and skill bodies grepped for workflow-typed literals (`feature/`, `delegate`, `synthesize`); declared `workflow-type:` exemptions verified.

## 7. Acceptance criteria

PR-1 (#1439):
- [ ] `docs/research/<dated>-invariant-content-audit.md` committed with 18-entry walk, references, currency, contradictions, recommended actions.
- [ ] `docs/architecture/invariants.md` edited per audit verdicts; YAML still parses; consumers still load.
- [ ] Selection-rule audit resolved (INV-5 umbrella decision documented).
- [ ] Cost-of-load classification applied with `/ideate` Phase 0 loader honoring the split.
- [ ] `npm run skills:guard` and `npm run build` clean.
- [ ] Vocabulary lint clean.
- [ ] CodeRabbit + internal review + `/axiom:humanize` pass on edited catalog prose.

PR-2 (#1370):
- [ ] `docs/research/<dated>-phase-transition-invariant-audit.md` committed with per-command transition walk + findings.
- [ ] All HIGH findings fixed in PR-2 with regression tests where behavioral.
- [ ] MEDIUM/LOW findings filed as standalone issues or surgically fixed.
- [ ] `npm run test:run` and `cd servers/exarchos-mcp && npm run test:run` clean.
- [ ] Each fixed finding's `required_fix` is verifiable from PR diff.

Bundle-level:
- [ ] #1439 and #1370 closed; epic #1441 sub-issue count → 12/13 closed (only #1395 remaining).
- [ ] #1442 in epic #1403 references the audited catalog as its measurement target.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Audit balloons — too many entries flagged for deletion/rewrite | Time-box per-entry review to ≤30 min; default to `keep` + LOW finding when uncertain, defer rewrite to follow-on. |
| Cost-of-load split breaks `/ideate` Phase 0 silently | DIM-2 design constraint: lazy-load path throws, doesn't degrade silently. Add an `/ideate` smoketest that asserts always-load entries are present in Phase 0 output. |
| PR-2 surfaces catalog wording defects that need PR-1 rework | Sequential stack absorbs this naturally — amend PR-1 if PR-2 catches it pre-merge; file follow-up if post-merge. |
| Phase-transition audit blast radius too wide (18 commands × 6 invariants) | PR-2 audits but doesn't fix every finding — HIGH only; MEDIUM/LOW filed for v2.11.0 absorption. |
| #1442 timeline pressure — eval team blocked on this | The audit doc IS the eval ground truth; deliver PR-1 first (the catalog content audit) since #1442 only needs content, not transition fixes. |
| Stacked-PR auto-merge collapses granularity ([memory: feedback_stacked_pr_auto_merge_collapses_granularity]) | Never `--auto --squash` on PR-2 before PR-1 lands on main; merge bottom-up explicitly. |

## 9. Rollout

1. PR-1 opens against `main` with feature branch `feature/preview-4-invariant-audit-1439`.
2. PR-2 opens against PR-1's branch (`feature/preview-4-invariant-audit-1370`).
3. PR-1 lands on `main`; PR-2 auto-retargets to `main`.
4. PR-2 lands on `main`.
5. Status comment on #1441 closes the audit-pair axis; checklist updates; #1442 unblocked.

No runtime migration, no schema bump, no version bump. Pure documentation + skill edits + targeted handler fixes.

## 10. Out of scope

- #1395 (auto-emission investigation + rehydrate-report spike) — ships in the next closure bundle.
- The 3 LOW polish nits from #1452 review — fold into eventual epic-closure PR.
- Bundle-audit §Recommendations reconciliation — same epic-closure PR.
- #1442 implementation itself — lives under epic #1403.
- Catalog schema redesign (`schema-version: 2`) — not needed; current schema absorbs all expected edits.
- Per-runtime divergence in catalog content — INV-4 enforces single-source; runtime variants come from rendering only.

## 11. References

- Epic: [#1441](https://github.com/lvlup-sw/exarchos/issues/1441)
- Sub-issues: [#1439](https://github.com/lvlup-sw/exarchos/issues/1439), [#1370](https://github.com/lvlup-sw/exarchos/issues/1370)
- Downstream unblock: [#1442](https://github.com/lvlup-sw/exarchos/issues/1442) under epic [#1403](https://github.com/lvlup-sw/exarchos/issues/1403)
- Catalog: `docs/architecture/invariants.md` (319 LOC, 18 entries)
- Phase 0 loader: `commands/ideate.md`
- Operational skill: `.claude/skills/design-invariants/SKILL.md`
- Catalog origin: PR #1425, Issue #1260
- Contradiction exemplar: `docs/research/2026-05-16-event-sourced-task-store-audit.md` FINDING-2
- Token-cost source: `docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md`
- Stacked-PR memory: [memory: feedback_stacked_pr_discipline], [memory: feedback_stacked_pr_auto_merge_collapses_granularity]
