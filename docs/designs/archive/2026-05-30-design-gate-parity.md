# Design: Authoring-Gate / Template Parity + YAML-Sidecar Abandonment

> Refactor brief for tracker [#1486](https://github.com/lvlup-sw/exarchos/issues/1486)
> sub-issues [#1493](https://github.com/lvlup-sw/exarchos/issues/1493) and
> [#1494](https://github.com/lvlup-sw/exarchos/issues/1494). Overhaul track.
>
> Authored verbatim in `skills-src/brainstorming/references/design-template.md`
> format on purpose: this document is also a regression fixture that the fixed
> `check_design_completeness` gate must accept with zero advisories.

## Problem Statement

The four Exarchos authoring gates — `check_design_completeness`,
`check_plan_coverage`, `check_provenance_chain`, `check_task_decomposition` —
validate authoring markdown with per-gate regex parsers. Those parsers have
drifted from the templates they are supposed to enforce, and nothing tests the
shipped templates against the gates (the existing `*.parity.test.ts` use inline
fixtures, not the real templates).

Two concrete drifts surfaced via dogfooding on `2.10.0-rc.4`:

- **#1493 (false positive):** `check_design_completeness` only recognizes a
  bullet-prefixed `- acceptance criteria` header, but the template *mandates* a
  standalone bold `**Acceptance criteria:**` header. GWT detection requires
  three separate `given`/`when`/`then` bullet lines, so the template's
  single-line and continuation-line GWT both fail. Result: a template-correct
  design emits `Advisory: DR entries missing acceptance criteria: DR-1…DR-N`.
- **task-decomposition (false negative):** a task authored verbatim from
  `task-template.md` has no prose and no `**Goal:**`/`**Description:**` between
  the `### Task` heading and `**Phase:**`, yielding a zero-word description that
  fails the `> 10` word check.

Separately, the YAML gate-sidecar layer ([#1298](https://github.com/lvlup-sw/exarchos/issues/1298))
shipped **consume-only** and never got an emitter. Its deprecation message
points users to a phantom `npm run sidecar:emit` that has never existed in git
history, and frames the regex/markdown path as a "deprecated fallback" even
though it is the only real path. Since SQLite is the authoritative structured
record (see `CLAUDE.md`), the YAML sidecar is being **abandoned** — markdown
parsing is the permanent authoring contract.

## Approaches Considered

### Option 1: Patch the one regex (rejected)

**Approach:** Broaden `ACCEPTANCE_CRITERIA_HEADER_PATTERN` only.

**Cons:** Leaves the task-decomposition drift, the phantom sidecar messaging,
and the structural blind spot (no template→gate test) untouched. Drift recurs.

### Option 2: Align parsers + add a round-trip contract shield + abandon sidecars (chosen)

**Approach:** Fix both confirmed parser drifts, add a contract test that runs
the *real* shipped templates through all four gates, and remove the abandoned
YAML-sidecar layer so markdown parsing is the explicit, supported path.

**Pros:** Fixes both reported bugs, prevents recurrence structurally, removes
vestigial/misleading code, and reconciles the roadmap (#1407).

**Cons:** Larger blast radius (gate handlers, schemas, fixtures, docs).

### Option 3: Build a real sidecar emitter (rejected)

**Approach:** Implement `sidecar:emit` and wire `/ideate` + `/plan` to emit YAML
sidecars.

**Cons:** Directly contradicts the SQLite-as-structured-backbone direction;
duplicates structured state already in the event store; large feature cost for
a layer we are abandoning.

## Chosen Approach

Option 2. Markdown templates + parsers are the durable authoring contract;
SQLite holds structured workflow state. We align the parsers to the templates,
lock the alignment with a round-trip contract test across all four gates,
delete the consume-only YAML-sidecar layer and its phantom deprecation
messaging, and reconcile #1407 (its "remove the regex fallback" premise is
inverted by the abandonment).

## Requirements

### DR-1: design-completeness recognizes all template-mandated acceptance-criteria header shapes

The pure parser must treat a requirement as having acceptance criteria when the
template's documented shapes are present, matching the shapes the shell checker
(`scripts/check-design-completeness.sh`) already accepts.

**Acceptance criteria:**
- A standalone bold header `**Acceptance criteria:**` followed by bullets is recognized.
- A markdown heading form (`#### Acceptance criteria`) is recognized.
- The existing bullet-prefixed `- Acceptance criteria:` form continues to be recognized (no regression).
- A design with no acceptance-criteria block on a DR still produces the advisory (no false negative introduced).

### DR-2: design-completeness recognizes single-line and continuation-line Given/When/Then

**Acceptance criteria:**
- Given a DR whose acceptance criteria is a single bullet `- Given X, when Y, then Z`
  When `check_design_completeness` runs
  Then that DR is NOT reported as missing acceptance criteria.
- Given a DR using the template's continuation-line GWT (`- Given …` / `  When …` / `  Then …`)
  When the gate runs
  Then that DR is recognized as having acceptance criteria.

### DR-3: task-decomposition accepts a template-shaped task description

**Acceptance criteria:**
- A task authored verbatim from `task-template.md` passes the description check rather than being flagged missing-description.
- The fix does not re-open the F20/#1213 regression where an inline `**Files:**` list was miscounted as description prose.
- The chosen remedy (parser leniency vs. template `**Goal:**` field, or both) is documented in the plan.

### DR-4: template→gate round-trip contract test (#1299)

**Acceptance criteria:**
- A new test under `servers/exarchos-mcp/src/orchestrate/` loads the shipped `design-template.md`, `plan-document-template.md`, and `task-template.md` (or minimal valid renderings derived from them).
- It runs every authoring gate against those fixtures and asserts each blocking check passes and advisory checks are advisory-clean.
- The failure message identifies which gate and which template are out of sync.
- The test fails if a parser tightens beyond the template, or a template drifts from a parser.

### DR-5: abandon the YAML gate-sidecar layer

**Acceptance criteria:**
- No source or message references `npm run sidecar:emit`; `grep -r "sidecar:emit"` over `src` returns nothing.
- The consume-only sidecar path (`sidecar-lookup.ts`, `sidecar-schemas.ts`, sidecar branches in the four gates, `sidecar-backfill.test.ts`, the two `*.sidecar.yml` fixtures) is removed, OR any retained piece carries an explicit justification.
- Each gate evaluates the markdown path directly with no dead "sidecar-present" branch.
- The full MCP test suite is green after removal.

### DR-6: roadmap and documentation reconciliation

**Acceptance criteria:**
- #1407 (remove regex fallback) is reframed or closed with rationale referencing the sidecar abandonment.
- Any doc/comment framing markdown parsing as a deprecated fallback is corrected to "supported permanent path."
- `CLAUDE.md`'s architecture section reflects markdown+SQLite as the canonical authoring contract (no live YAML-sidecar co-existence claim).

### DR-7: error/edge-case coverage and no regressions

**Acceptance criteria:**
- Mixed-format designs (some DRs bold-header, some GWT, some bullet) are each judged correctly.
- Empty/malformed design and plan inputs still fail gracefully (no crash, structured error), preserving current behavior.
- Root `npm run test:run` and `cd servers/exarchos-mcp && npm run test:run` are green; `npm run typecheck` clean; `npm run skills:guard` clean if any template changed.

## Technical Design

Primary edits live in `servers/exarchos-mcp/src/orchestrate/`:

- `pure/design-completeness.ts` — broaden `ACCEPTANCE_CRITERIA_HEADER_PATTERN`
  to the shell checker's union (bold / heading / bullet-bold / bullet) and
  loosen GWT detection to accept single-line and continuation-line forms.
- `task-decomposition.ts` — make `extractDescriptionSpan` recognize the
  template's task shape without reintroducing the `**Files:**` miscount.
- New `template-roundtrip.test.ts` — fixture loader + all-gates assertions.
- Remove `sidecar-lookup.ts`, `sidecar-schemas.ts`, `sidecar-backfill.test.ts`,
  the `evaluate*Sidecar` branches in the four gate handlers, and the two
  `docs/**/*.sidecar.yml` fixtures.

Possible small template touch-ups in `skills-src/` (e.g. clarify the task
description field) flow through `npm run build:skills` + `skills:guard`.

## Integration Points

- The four gate handlers wire through `verbs/composite.ts`
  (`check_design_completeness`, etc.) and emit `gate.executed` events — behavior
  preserved; only the input-parsing branch changes.
- `scripts/check-design-completeness.sh` is the parity reference for DR-1.
- Skills pipeline (`build:skills`, `skills:guard`) gates any template edit.

## Testing Strategy

Characterization-first: encode the current false-positive (#1493) and
false-negative (task-decomposition) as RED tests reproducing the bug, then fix
to GREEN. Add the DR-4 round-trip contract test as the durable shield. Run the
full MCP and root suites; the sidecar removal is validated by suite-green plus
the `sidecar:emit` grep assertion.

## Open Questions

- DR-3 remedy: parser leniency, a template `**Goal:**` field, or both? (Decide in plan; lean parser-leniency to avoid forcing authors.)
- DR-5 scope: full deletion of the consume layer vs. staged removal — full deletion preferred given the abandonment, pending plan-phase blast-radius confirmation.
- Should DR-6 close #1407 outright or repurpose it to "delete sidecar consume layer"? (Repurpose-then-close likely cleanest.)
