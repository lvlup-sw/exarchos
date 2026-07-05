# Unified Spec Template (depth-scaled)

Save to: `docs/specs/YYYY-MM-DD-<feature>.md`

One document replaces the former two-artifact (`docs/designs/` + `docs/plans/`) split.
It carries a `## Design & Rationale` section (the **DR-N source** — design requirements live here) followed by a `## Decomposition` section (tasks → DR-N), so traceability resolves **within the same document** rather than across two files.

## Depth scaling

The design section is authored at one of three depths, frozen per feature as `designDepth` on the PLAN phase (the per-feature analog of per-task `riskTier` — the same ladder applied to planning instead of verification).
A higher rung is a **strict superset** of the lower: it adds sections, it never removes them.

| `designDepth` | Design & Rationale shape | When |
|---|---|---|
| `thin` | Minimal preamble: Problem Statement + the DR-N list. No alternatives, no exploration. | Trivial, low-blast features where the decomposition is the substance. |
| `standard` | Full rationale: Problem, Chosen Approach, DR-N (with acceptance criteria), Technical Design, Alternatives. **(default)** | Most features. |
| `deep` | The `standard` shape **plus** an Exploration section citing a `/exarchos:discover` research pass (stitched by `correlationId`) and the divergent-loop alternatives. | High-uncertainty / high-blast-radius features where the open-design path is warranted. |

Whatever the depth, DR-N identifiers are parsed from the **same** `## Design & Rationale` heading, so the `## Decomposition` matrix and the traceability gates resolve against one source.

## Template

````markdown
# Spec: [Feature Name]

**Date:** YYYY-MM-DD · **Feature:** `<feature-id>` · **Depth:** [thin | standard | deep]
**Inputs:** [prior specs, research reports, roadmap/epic links]

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

[What is broken / missing, and why it matters. Required at every depth.]

### Chosen Approach            <!-- standard + deep -->

[The approach in 1–3 paragraphs. For `deep`, cite the exploration section below.]

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: [requirement headline]

[One paragraph of intent.]

**Acceptance criteria:**            <!-- standard + deep; thin may list a single bullet -->
- [Observable, testable criterion]
- [Given/When/Then where behavior is conditional]

#### DR-2: [requirement headline]

[…repeat per requirement…]

### Technical Design            <!-- standard + deep -->

[How the change lands: the seams it touches, the shape of the new code, the invariants it preserves. Keep it design-level, not task-level — task detail belongs in Decomposition.]

### Integration Points            <!-- standard + deep -->

- `path/to/seam.ts` — [what changes]

### Exploration            <!-- deep only -->

[The divergent loop: 2–3 approaches considered, the back-and-forth, why the chosen one won.
Cite the `/exarchos:discover` research report by path and `correlationId` so provenance spans both documents.]

### Alternatives considered            <!-- standard + deep -->

- **Option B —** [what it was, why rejected].
- **Option C —** [what it was, why rejected].

### Open Questions

- [Question + how/when it resolves, or explicit deferral with rationale.]

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.
A task with no DR-N is a coverage gap; a DR-N with no task is unimplemented — both are flagged by `check_plan_coverage`.

### Scope

**Target:** [Full design | Partial: <components>]
**Excluded:** [None | sections deferred, with rationale]

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | [headline] | 001, 002 |
| DR-2 | [headline] | 003 |

### Tasks

Each task carries a `riskTier` stamp that selects its verification depth (see the ladder in `@skills/_shared/references/verification.md`).
Tests are judged **test-after by adequacy** — the failing-test-first ordering ceremony is not required.
Full task fields are in [`task-template.md`](./task-template.md).

#### Task 001: [brief description]

**Risk Tier:** [low | medium | high]
**Boundary Touching:** [true | false — optional]
**Implements:** DR-1
**Files:**
- `path/to/implementation.ts`
- `path/to/implementation.test.ts` (medium/high tiers)
**Verification:** [per the ladder — low: static; medium: scoped tests + `check_test_adequacy`; high: + integration suite across the seam]
**Dependencies:** [Task IDs, or None]
**Parallelizable:** [Yes/No]

#### Task 002: [brief description]

[…repeat per task…]

### Parallelization

[Critical path + which tasks run in parallel worktrees.]

### Completion checklist

- [ ] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document (no forward-dangling references)
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`
````

## Notes

- **One approval point.** The unified artifact is reviewed once, at `plan-review` (a dispatched, fresh-context adversarial pass over this document) — there is no separate design approval.
- **Traceability stays internal.** `check_provenance_chain` and `generate_traceability` parse DR-N from this file's `## Design & Rationale` and validate task→DR-N against this file's `## Decomposition`; they do not cross to a second document.
- **Depth never relaxes the floor.** `thin` shortens the design preamble; it does not drop the DR-N list or the traceability matrix — the decomposition contract is depth-invariant.
- **Historical record.** Existing `docs/designs/` + `docs/plans/` files stay as-is; only newly-`init`'d features author the unified `docs/specs/` artifact.
