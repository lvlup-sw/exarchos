# Debloat wave-1 — dated-artifact archival T8 baseline (DR-18)

Measurement record for the **T8 archival track** of the debloat wave-1 feature. This is the
before/after ledger for *moving* superseded dated delivery artifacts out of the active docsite
surface — **distinct** from the post-*deletion* differential baseline
(`2026-07-15-debloat-wave1-structural-enforcement-baseline.md`, DR-1/DR-8), which records module
*removals* in `servers/exarchos-mcp/src`. Deletions shrink the shipped binary; archival shrinks the
*documentation* surface without losing history (files are `git mv`'d, not deleted).

Tasks 031 and 032 append their own sections to **this** doc as they archive further dated trees.

## T8.030 — `docs/plans/**` + `docs/designs/**` (this task)

**Method.** Every top-level dated `.md` record under `docs/plans/` and `docs/designs/` was moved
into a sibling `archive/` subtree via `git mv` (rename-preserving; history intact). The pre-existing
`docs/designs/archive/` (one file, from the 2026-04-21 install-rewrite) and `docs/designs/future/`
(forward-looking, not superseded) were left in place. Layout follows the established
`docs/designs/archive/` convention, which also keeps the `docs/designs/` / `docs/plans/` *prefix*
trees intact — the load-bearing property for the two classification constants below.

### Active-surface delta (top-level dated records removed from the live docsite)

| Tree | Files | Lines | Bytes |
| --- | ---: | ---: | ---: |
| `docs/plans/*.md` (before) | 171 | 70,950 | 3,375,384 |
| `docs/designs/*.md` (before) | 134 | 43,246 | 2,461,211 |
| **Active surface removed** | **305** | **114,196** | **5,836,595 (5.56 MB)** |
| `docs/plans/*.md` (after) | 0 | 0 | 0 |
| `docs/designs/*.md` (after) | 0 | 0 | 0 |

Archive destinations after the move: `docs/plans/archive/` = 171 files; `docs/designs/archive/` =
135 files (134 moved + 1 pre-existing `2026-03-14-create-exarchos.md`).

**Repo bytes: unchanged.** The 5.56 MB / 114,196 lines are relocated, not deleted — `git mv`
preserves blame/history. DR-18 targets the *active docsite* surface (what a docsite build publishes
and what agents/humans browse as "current"), which drops by 305 files / 5.56 MB to zero top-level
dated records. Archived records remain reachable under `**/archive/`, excluded from the live surface
by the archive convention.

Guidance re-measured against the audit's week-old target (114.5K ln / 5.58 MB): **actual = 114,196
ln / 5.56 MB** — within rounding, no drift.

### Inbound reference repointing

Inbound path references to the moved records were repointed (`docs/{designs,plans}/2026-…` →
`docs/{designs,plans}/archive/2026-…`) across the task's declared trees — `servers/exarchos-mcp/src/**`
and `skills-src/**` (`commands/**` had none). Distinct moved-file targets referenced: **19**; all 19
resolve to their new archived location post-move. See the src classification table in the task report
for the inert / must-change / must-not-touch breakdown.

Out of the declared update scope (and therefore **not** repointed by this task): docs↔docs
cross-references from other dated-record trees (`docs/research`, `docs/specs`, `docs/adrs`,
`docs/architecture`, `docs/guides`) into the moved files. These join the repo's pre-existing
historical-link corpus that the whole-tree link checker already flags; they are **not** counted as
this task's link-check evidence.

### Classification boundary — two constants proven left alone

The archival move is inert to workflow behavior. Two constants *look* archival-sensitive but MUST NOT
be repointed; each is pinned by a guard test that goes red if the constant is edited:

- `workflow/rehydrate.ts` `LEGACY_DESIGN_DIR = 'docs/designs/'` — the artifact-layout classifier is
  **filesystem-blind**; it discriminates on the event-folded *recorded* artifact path, never on disk.
  Archiving the physical doc does not rewrite the recorded path, so a resuming legacy two-artifact
  workflow still classifies `'two-artifact'`. Repointing the constant to `docs/designs/archive/`
  would force the mid-flight migration the module forbids. Test:
  `Rehydrate_LegacyDesignPath_ClassificationUnchangedByArchival`.
- `architecture/vocabulary-lint.ts` `DATED_RECORD_TREES` — **inert**: `scanRepoDefaults` walks a
  positive four-root allowlist (`docs/architecture`, `docs/guides`, `skills-src`, `commands`) and
  never reads `DATED_RECORD_TREES`. Archiving `docs/plans` + `docs/designs` cannot change the scan;
  editing the constant is a vacuous no-op. Test: `VocabularyLint_ScanRoots_UnchangedByArchival`.

## T8.031 / T8.032 — (reserved)

Subsequent archival tasks append their measured before/after deltas here.
