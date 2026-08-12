# Spec: Comment hygiene enforcement

**Date:** 2026-08-11 · **Feature:** `comment-hygiene-enforcement` · **Depth:** deep
**Inputs:** [`docs/research/2026-08-11-comment-hygiene.md`](../research/2026-08-11-comment-hygiene.md) (discovery workflow `comment-hygiene-research`) · correlationId `b1a16fd6-ef31-4ef0-a145-b42fddd56e8a`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

The census in the research report measured 140,638 comment lines against 396,872 lines of
code (26.2%; 36.9% in production source). 7,456 comments cite a planning artifact by
identifier, 743 narrate change history, and the comment share of newly added lines rose from
10.7% to 34.4% between February and May 2026 while spec-citation lines grew 29-fold.

Guidance exists but never reached the authors. `skills-src/refactor/references/doc-update-checklist.md`
and `.../phases/update-docs.md` say the right thing ("Comments explain 'why' not 'what'",
"Avoid over-commenting", "No stale comments referring to old code"). Both are reachable only
from the refactor skill's polish and doc-update phases, so an agent doing ordinary
implementation work never loads them. An earlier framing of this document claimed the tree
had already run the experiment and that prose guidance failed. It had not: unreachable prose
was never tested. What is established is narrower, and still actionable. Four prose
representations of comment policy exist, none is authoritative, and nothing mechanically
binds any of them.

The harness also supplies the stimulus. `skills-src/plan/references/task-template.md` and
`skills-src/delegate/references/implementer-prompt.md` hand every dispatched agent an
`Implements: DR-N` stamp and a task ordinal, which is the direct upstream source of the
citation shape the census found. A gate that rejects those ordinals while the prompt keeps
issuing them fights its own harness on every task.

This design therefore removes the stimulus first and measures the result, then enforces what
remains. Enforcement is still required: a convention nothing checks is not an authority, and
re-stating it a fifth time in `AGENTS.md` would decay identically while violating INV-4,
which rejects per-harness fan-out of authored content.

A second, opposite defect runs alongside it: only 69.6% of 4,748 exported declarations carry
TSDoc. Comment effort is concentrated in inline narration rather than on the surface readers
consume. A policy that penalises comment volume alone would worsen this, which is precisely
Ousterhout's objection to comment minimisation. The remedy has to be asymmetric.

### Chosen Approach

One machine-readable policy datum becomes the single authority. Every consumer derives from
it rather than restating it: a custom ESLint rule for editor-time feedback, a
`scripts/check-comment-hygiene.mjs` CI gate for tree-wide and diff-scoped enforcement, and
the agent-facing policy prose rendered through the existing `skills-src/` pipeline. No
consumer carries its own copy of the rules.

The policy's rule is deliberately flat: a code comment states its constraint in words and
names no planning ordinal. `DR-N`, `task N`, `T-N`, `wave N`, `slice N`, `epic #N`, and
`INV-N` are forbidden alike. An earlier framing carved out `INV-*` because it resolves
against a registered catalog. That carve-out did not survive review. A resolution check
proves an entry exists, not that the citation is still true, and the catalog is mutable
prose whose entries have been rewritten and renumbered, so a stale citation would stay green
indefinitely. The carve-out was also circular: it forbade the `docs/specs/….md#DR-N` deep
link, which is the one spec-citation form a scanner could genuinely resolve. One rule for
all ordinals costs less to state, cannot rot, and matches the objection that motivated the
work.

What remains permitted is the durable external reference: a URL, `owner/repo#123`, a CVE, an
RFC section. Those name something outside this repository's planning cycle and a reader can
follow them. The invariants catalog stays citable from documentation; this rule governs code
comments only.

Enforcement composes into the substrate that already exists. Each gate lands its primary, its
`scripts/enforcer-wiring-manifest.json` entry, and its invoking CI step in one change, with
`disposition: gating` and `diffDependent: true`, which forces the host workflow's
`pull_request` trigger to include `synchronize`. Registering a primary without a workflow
reference merely trades one wiring violation for another. Existing debt is held by a per-file
count budget rather than a dated tolerance: each file carries the number of offenders it has
today, a file over its number fails, and the numbers may only go down.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: One policy authority, mechanically derived

Comment policy exists exactly once, as data. Every consumer derives from that datum. No
consumer restates a pattern, an allowed-reference class, or a threshold. Because the
consumers are a plain-Node CI gate and a plain-JS ESLint rule, the shared classifier is
authored as `.mjs` that both can import directly; TypeScript in the MCP server package is
not importable by either without a build step neither has.

**Acceptance criteria:**
- A single policy file declares the forbidden ordinal classes, the allowed reference
  classes, the changelog patterns, the structural exemptions, and the coverage thresholds.
- The classifier is authored once, in a module format both consumers import at runtime. No
  classification logic is implemented twice.
- A standing check fails if either consumer source contains a literal pattern that the
  policy datum also declares. Prose assertion is not sufficient; this is a mechanical check.
- A cross-consumer conformance test runs one fixture corpus through both the gate and the
  ESLint rule and fails if their verdicts disagree on any fixture.
- Given the policy datum is edited, the agent-facing prose is regenerated from it rather than
  hand-edited. The generated region is delimited in the rendered file, and a bidirectional
  drift check fails when the prose states a pattern the datum does not declare, and when the
  prose omits a class the datum declares. Hand-authored rationale may surround the generated
  region; the pattern list itself is never hand-maintained (INV-4: authored once).

#### DR-2: Planning-artifact ordinals are rejected in code comments

Comments must not name a planning ordinal: `DR-<n>`, `task <n>`, `T<n>`, `wave <n>`,
`slice <n>`, `epic #<n>`, `INV-<n>`, or a `docs/{specs,designs,plans}/…` path. State the
constraint instead.

**Acceptance criteria:**
- Each of those forms is rejected in a comment, `INV-<n>` included.
- `phase <n>` is NOT rejected: it is product vocabulary (`/ideate` Phase 0, `appendLocked`
  Phase 1) and produced 45 false positives in the census.
- A URL, `owner/repo#123`, `CVE-…`, or `RFC …` is permitted anywhere and takes precedence
  over every forbidden pattern.
- The message names the required remedy. A test asserts the message text, not only the
  verdict, because the remedy wording is what makes remediation judged rather than
  mechanical.
- A precision floor is met before a class blocks. For each pattern that ships, 50 matches are
  sampled from the current tree, adjudicated, and committed as a fixture so the number is
  auditable. A pattern ships enabled at 95% precision or better and disabled below it. If a
  pattern has fewer than 50 matches, all of them are adjudicated. `T<n>` is measured
  separately: it collides with generic type parameters, `@template T1`, `{@link T2}`, and
  `T0` timing notation.
- Test files are held to the same rule as production. They carry 3,660 of the citations.

#### DR-3: The stimulus is removed before the gate blocks

The harness that issues the ordinals is amended first, so enforcement applies to a residue
rather than to a stream the repository keeps generating.

**Acceptance criteria:**
- `skills-src/plan/references/task-template.md` and
  `skills-src/delegate/references/implementer-prompt.md` stop directing agents to carry task
  or DR ordinals into code, and state the comment rule at the point of authoring.
- The rendered runtime variants reflect the change and `npm run skills:guard` is green.
- The same measurement is repeated after 30 days of post-change commits, and both figures are
  recorded in the repository. The comparison is reported; it does not gate anything, because
  a single before/after on one repository cannot establish causation on its own.

#### DR-4: Changelog narration is rejected

Comments describe present behavior. History belongs to version control.

**Acceptance criteria:**
- `previously this…`, `used to be`, `formerly`, and passive change verbs (`was renamed`,
  `was replaced`, `was removed`, `was migrated`) are rejected.
- A bare `previously` with no change-narration context does not trip the rule.
- `no longer` is measured before it blocks. 321 comments match it on the current tree and a
  sampled audit found a substantial legitimate share describing present or conditional
  behavior. It ships only if it meets DR-2's precision floor, and is dropped otherwise.
- A false-positive fixture corpus drawn from the current tree accompanies each phrase.

#### DR-5: Commented-out code is rejected

**Acceptance criteria:**
- `sonarjs/no-commented-code` (S125) is enabled.
- Its offender count over the full linted scope is measured before it blocks, by a step that
  installs the plugin and reports the count without enabling it as an error. At 25 offenders
  or fewer it ships blocking and they are fixed in the same change; above 25 it ships with
  its own per-file count budget on the DR-10 pattern.
- The check is parse-based, not regex-based. A regex classifier was attempted during
  discovery: it flagged 521 comments, and sampling showed most were section banners or
  ordinary prose.

#### DR-6: Exported-surface documentation ratchets upward

Interface documentation is a separate obligation from inline-comment restriction, enforced
in its own right. It is not offered as the answer to the missing-comment cost asymmetry;
DR-10's rationale-retention metric carries that.

**Acceptance criteria:**
- TSDoc coverage on exported declarations is measured and recorded as a baseline. The
  counting rule is the definition of record and is stated explicitly, including how
  `export const` arrow functions, re-exports, `export default`, and overload signatures are
  treated. The research figure of 3,303 / 4,748 is an estimate produced by a different
  method and is not a pass criterion.
- Coverage may not decrease, following the `scripts/check-coverage-ratchet.mjs` idiom.
- A new exported declaration without TSDoc fails the diff-scoped gate.
- The coverage gate is wired exactly as DR-7 requires. A `scripts/check-*.mjs` primary that
  exists on disk without a manifest entry fails `check-enforcer-wiring.mjs` outright.
- `jsdoc/informative-docs` rejects TSDoc that only restates the symbol name, subject to the
  same measure-before-blocking rule as DR-5.

#### DR-7: Every gate composes into the existing enforcement substrate

**Acceptance criteria:**
- Each gate primary lands together with its manifest entry AND its CI step in one change.
  Registering a primary without a workflow reference trades `[unlisted-primary]` for
  `[orphan]` or `[advisory-orphan]`, which fails the wiring gate just as hard. A
  `*.test.sh` reference does not create reachability.
- Entries carry `disposition`, `diffDependent`, `unfilteredCiPath`, and a rationale.
- `check-enforcer-wiring.mjs` passes, proving each gate is reachable and failable from its
  named workflow and that the workflow's `pull_request` trigger includes `synchronize`.
- Each gate is wired as a direct CI step on a host whose path filter actually covers the
  gate's scan surface. Registration in `validate-manifest.json` alone is insufficient: no
  workflow invokes `npm run validate`, so a validate-only gate is `unreachable-npm` by the
  wiring gate's own taxonomy.
- The guard self-test is re-asserted on the unfiltered lane, following the
  `check-enforcer-wiring.test.sh` and `validate-plugin.test.sh` precedent, so a
  scripts-only PR cannot weaken a gate without running its test.
- Widening ESLint's reach changes the `lint` script's CLI glob, not only the flat config's
  `files` key, and names a host job whose filter covers the widened surface.

#### DR-8: Gates fail closed and distinguish indeterminate from pass

This is the error-handling and edge-case requirement.

**Acceptance criteria:**
- A file that does not parse is reported as indeterminate and fails the gate. It is never
  silently skipped.
- A run that examines zero files fails loudly; "nothing to check" and "everything passed"
  must not print the same result.
- A missing or malformed policy file exits non-zero (fail closed), not with defaults.
- Two exemption classes exist and are distinct. Structural exemptions (`exemptPaths`) are
  permanent and carry no expiry: they cover the gate's own sources, its fixtures, the policy
  datum's examples, and `docs/evals/**/runs/**`, which holds verbatim captured agent output
  that is evidence rather than authored code and must be neither blocked nor rewritten.
  Waivers carry an owner and an `expires`, and an expired waiver fails the gate.
- Given the comment extractor throws, when the gate runs, then it exits non-zero rather than
  reporting a clean tree.
- Self-test: the guard is proven to fail when its subject is violated, so guard-execution
  failure cannot pass as success.

#### DR-9: Kill fixtures are drawn from the real backlog

**Acceptance criteria:**
- Fixtures include verbatim offenders measured during discovery. Ordinals are masked in this
  document so the spec does not self-match its own detector; the fixture files carry the
  literal text. Examples: `workflow/tools.ts:52` (`T0NN (DR-N) — checkpoint materializes…`)
  and `next-actions-computer.test.ts` (`DR-N (#1581 task 018)…`).
- Fixtures include the permitted counter-cases: a URL citation, and the ordinal-stripped
  rewrite of `utils/atomic-write.ts:313`. That comment's as-committed text begins with a
  literal ordinal, so it belongs in the offenders fixture, not the permitted one.
- Both consumers use the same fixture corpus (DR-1's conformance test).
- The fixture paths are listed as structural exemptions under DR-8, or the guard flags its
  own kill fixtures.

#### DR-10: Existing debt is budgeted down, and rewrites preserve rationale

**Acceptance criteria:**
- Every file has a comment-debt budget: the count of offenders it currently carries, across
  all forbidden classes including changelog narration. A file exceeding its budget fails.
- Budgets may only decrease. A run that would raise any budget fails.
- The gate generates and rewrites the budget file itself under `--update`. It is never
  hand-edited, and it lands in the same change as the gate, so the gate is never wired
  without it.
- Remediation rewrites each offender to state its constraint and drop the ordinal. A comment
  may be deleted only when the ordinal was its entire content.
- Deletions are listed in the pull request description so a reviewer can see them without
  reading the whole diff. Reviewers reject a batch that deleted rationale instead of
  restating it. This is a review obligation, not a CI check: judging whether a rewrite
  preserved meaning is not mechanically decidable, and this spec does not pretend otherwise.
- Batches are capped at 20 files, serialized, and each shrinks the budget.
  `scripts/run-validate.mjs` and `scripts/check-measured-premises.mjs` are handled
  individually; their headers are dense load-bearing design essays.
- The gate reports remaining totals per area on every run so burn-down is observable.
- A `.git-blame-ignore-revs` entry is added for each bulk remediation commit.

#### DR-11: Comment extraction exposes positions, and diff scoping is origin-aware

The gate reports `file:line`, the diff-scoped mode maps findings onto added lines, and any
finding type needs a line number. No extractor exists in the tree to supply one.

**Acceptance criteria:**
- The extractor returns, per comment, its text and its source position. It is **authored**, not
  relocated: no `comment-prose` module is tracked and neither `extractCommentProse` nor
  `collectComments` appears in `HEAD` (see Technical Design). The unlanded copy under
  `.claude/worktrees/` is read as a recovery candidate and adjudicated, never adopted unread.
- Because there is no incumbent consumer, no joined-prose compatibility surface is owed. The
  extractor is designed for the two consumers this spec introduces, and a joined-prose helper
  ships only if a consumer actually needs one.
- The extractor refuses a recovered parse rather than reporting partial results.
- A rename, move, or whole-file reformat does not turn existing offenders into failures. Line
  positions are used for reporting, never for identity: the per-file count budget in DR-10 is
  what tolerates existing debt, and a count is unaffected by lines moving.

### Technical Design

**Policy datum.** A `comment-policy` file (JSON, versioned) declaring `forbiddenOrdinals`,
`allowedReferences`, `changelogPatterns`, `exemptPaths`, `waivers`, and `coverage`
thresholds. It is the guard's policy expressed as data the guard reads, not prose inside a
test body.

**Module format is a constraint, not a detail.** Both consumers are non-TypeScript:
`scripts/check-comment-hygiene.mjs` runs on plain Node with no build step, and
`eslint-rules/comment-content.js` is loaded by ESLint with no `tsx` (the `no-handler-throw.js`
precedent imports only `typescript` and `node:path`, never MCP source). A classifier authored
as TypeScript inside the MCP server package would therefore have to be reimplemented in the
rule, putting the false-positive rules in two languages. The classifier and the extractor are
authored as `.mjs` that both consumers import directly, and a cross-consumer conformance test
runs one corpus through both.

**Extraction.** All consumers extract comments by parsing. The discovery pass demonstrated why
parsing rather than scanning is required: a `ts.createScanner` token loop under-counted comment
lines by 33% because it desynchronises after a `${…}` template substitution.

**Correction (2026-08-11): the extractor this design planned to relocate does not exist.**
An earlier framing described `test-helpers/comment-prose.ts` as already implementing the hard
part, and scoped the work as a move plus an API extension. Verified against the tree:
`git ls-files` matches no `comment-prose` path, and `git grep` over `HEAD` finds neither
`extractCommentProse` nor `collectComments` anywhere in tracked source. The module exists only
inside stale agent worktrees under `.claude/worktrees/`, from a workflow that never landed.
`servers/exarchos-mcp/src/contract/governing-catalog.test.ts` is tracked and real, but imports
nothing from it, so the "two-import change" is zero imports.

The consequence is scope, not direction: the extractor is **authored**, not relocated. Its
unlanded worktree copy is a recovery candidate to be read and adjudicated before writing fresh
— it may already encode the recovered-parse refusal — but it carries no landed test history
and is treated as untrusted input, not as a baseline.

**Debt budget.** Existing offenders are held by a per-file count budget in
`scripts/comment-debt-budget.json`, one integer per file, following
`scripts/check-type-debt.mjs`. That module's header records why an entry ledger was rejected
for this exact job: a `{file,line,col}` register "churns on unrelated edits", and a single
refactor wave would invalidate it wholesale. A count needs no identity scheme, survives
reformatting and line shifts, does not conflict on merge, and makes monotonicity a numeric
comparison. Budgets may only decrease. The gate writes the file itself under `--update`, so
it is regenerated rather than hand-edited, and it is generated in the same change that lands
the gate, so there is no window where the gate is wired without its budget.

**Invariants preserved.** INV-4: policy prose is authored once in `skills-src/` and rendered
per runtime by the existing pipeline, guarded by `npm run skills:guard`. INV-6: the policy is
a behavior, so it belongs in a skill rather than a workflow-type-specific surface.

### Integration Points

- `scripts/lib/comment-policy.mjs` — policy loader, shared by both consumers.
- `scripts/lib/comment-classifier.mjs` — the classifier, authored once.
- `scripts/lib/comment-prose.mjs` — parse-based extractor with per-comment positions.
- `scripts/check-comment-hygiene.mjs` — new gate, diff-scoped and tree-wide modes.
- `scripts/check-comment-hygiene.test.sh` — unfiltered-lane self-test re-assert.
- `scripts/check-tsdoc-coverage.mjs` — new gate, ratchet plus diff-scoped export check.
- `scripts/enforcer-wiring-manifest.json` — one entry per new primary, added in the task that
  creates the primary.
- `scripts/validate-manifest.json` — local-repro steps only; not the deadline mechanism.
- `.github/workflows/` — direct CI steps on hosts whose path filters cover the scan surface,
  landed with the primary and its manifest entry.
- `scripts/comment-debt-budget.json` — per-file offender counts, regenerated via `--update`.
- `scripts/s125-baseline.json`, `scripts/informative-docs-baseline.json`,
  `scripts/eslint-widened-scope-baseline.json` — measured before each rule blocks.
- `.exarchos/comment-policy.json` — the policy datum.
- `eslint-rules/comment-content.js` + `.test.js` + `__fixtures__/` — new rule, house idiom.
- `eslint.config.js` and the `lint` script in `package.json` — register the virtual plugin;
  widen both the flat-config `files` key and the CLI glob.
- `skills-src/plan/references/task-template.md`,
  `skills-src/delegate/references/implementer-prompt.md` — stop issuing ordinals into code.
- `skills-src/` — the authored policy prose; rendered, not hand-copied.
- `.git-blame-ignore-revs` — one entry per bulk remediation commit.
- `package.json` — `eslint-plugin-sonarjs` and `eslint-plugin-jsdoc` dev dependencies.

### Exploration

Research pass: [`docs/research/2026-08-11-comment-hygiene.md`](../research/2026-08-11-comment-hygiene.md),
discovery workflow `comment-hygiene-research`, correlationId
`b1a16fd6-ef31-4ef0-a145-b42fddd56e8a`. It supplied the census, the trend, the doctrine
survey, and the verified tooling table.

**Approach A — ESLint rule only.** Cheapest to write and the only option giving editor-time
feedback, which is where an authoring agent can still act on it. Rejected as the sole
mechanism: `npm run lint` covers one directory of four, ESLint has no diff-scoping, and
`eslint.config.js` states outright that this repo does not use ESLint for general linting.
Adopting it as the single authority would mean a large, separate scope expansion before the
policy could bind anything.

**Approach B — `check-*.mjs` gate only.** Matches the dominant house idiom (16 gates), covers
every path, supports diff-scoping, has no runtime dependencies, and slots directly into the
wiring manifest. Rejected as the sole mechanism because it only speaks at CI time. An agent
that has already written 200 comments learns this after the fact, which is the slowest
possible feedback loop for the actor generating most of the volume.

**Approach C — both, composed over one policy datum (chosen).** The two mechanisms have
complementary reach: the rule is early and local, the gate is total and diff-scoped. The
objection to running both is duplicated policy, and that objection is exactly what the single
datum answers. It is also the defect the research identified as the root cause, so solving
it here is not incidental. This is what makes the design compositional rather than two
overlapping half-measures.

The divergent loop also moved the policy's central line, twice. The first framing forbade
doc-citation as such, which would have deleted `// DR-N: the bytes were fsync'd before the
rename`, a comment that states its constraint and merely happens to carry an ordinal. The
second framing distinguished durable from perishable references and permitted `INV-*` on the
grounds that it resolves against a registered catalog.

A three-voter adversarial panel refuted that second framing, and the third framing is the
flat rule now in Chosen Approach. Two findings closed it. A resolution check proves an entry
exists, not that a citation is still true, and the catalog is mutable prose whose entries
have been rewritten and renumbered, so stale-but-resolving citations would have stayed green
indefinitely against this design's own stated bar. Separately, the rule forbade the
`docs/specs/….md#DR-N` deep link while giving unresolvability as its reason for forbidding
spec citations, which is circular: the deep link is the one spec-citation form a scanner
could resolve. One rule for all ordinals is cheaper to state, cannot rot, and matches the
objection that motivated the work.

The same panel refuted the original causal claim. This document previously asserted that
correct guidance sat in the tree while the metric tripled, and concluded that prose cannot
work. The guidance is reachable only from the refactor skill's polish and doc-update phases,
so implementation-time agents never loaded it, and the harness itself hands agents the
ordinals. The design now removes the stimulus and measures before enforcing the residue.

### Alternatives considered

- **Instructions as the *only* control —** rejected, but instructions are now a first-class
  part of the design rather than a footnote. Anthropic's documentation states memory files
  are "context, not enforced configuration" and directs users to hooks for enforcement;
  Cursor's rules documentation lists copying style guides as an anti-pattern. The earlier
  claim that this repo had already disproved instruction-level control was wrong: the
  guidance never reached implementation-time agents. DR-3 tests it properly by fixing the
  harness and measuring, and enforcement then applies to what remains.
- **Permitting `INV-*` because it resolves against the catalog —** rejected on review. See
  Exploration; a resolution check cannot detect a stale-but-resolving citation, and the rule
  was circular about deep links.
- **Extending `vocabulary-lint` to source-comment prose —** dropped with the `INV-*`
  carve-out. It would also have turned the live blocking `lint:invariants` step red on
  landing: source comments carry 143 unresolved occurrences across 9 tokens (`DIM-1`..`DIM-8`
  and a bare `INV-5`), none of which appear in the four markdown roots scanned today.
- **`sonarjs/comment-regex` (S124) instead of a custom rule —** rejected as the destination,
  viable as a pilot. One pattern and one message per rule instance does not survive DR-2's
  forbidden classes with distinct remedies.
- **`vercel-labs/konsistent` —** evaluated at the user's suggestion and not adopted. It
  checks project-level structural conventions (paths, directory shape, exported value and
  type names) and does not read comment content, so it cannot carry DR-2, DR-4, DR-5, or the
  DR-1 hard-coding guard. The one place it would fit is asserting that every
  `eslint-rules/*.js` has a co-located `.test.js` and `__fixtures__/` directory: real, but
  guard-structure hygiene rather than comment hygiene. Recorded as a separate candidate.
- **Bulk-strip all citations mechanically —** rejected. Roughly a third state their
  constraint and lose only the ordinal; the rest lose their entire content. DR-10 requires a
  judged rewrite with deletions listed for review, because a count reaching zero is otherwise
  minimised fastest by deletion.
- **Comment-density cap —** rejected. It penalises volume without regard to placement and
  would push directly against DR-6. Ousterhout's asymmetry ("the cost of missing comments is
  easily 10-100x the cost of incorrect comments") argues against ratio targets as a control.

### Open Questions

- The `expires` retirement for DR-10. **Resolved:** removed. A per-file count budget replaced
  the dated tolerance, so there is no date to set and no cost-estimate circularity.
- Which skill hosts the policy prose (DR-1). It determines which runtimes render it and
  therefore which agents see it, so it is a real decision rather than a naming detail.
  **Open; resolve before task 026 dispatches.**
- Whether `no longer` ships at all. 321 matches on the current tree with a substantial
  legitimate share. DR-4 makes it conditional on the precision floor. **Resolved by
  measurement, not by judgement.**
- Whether the `─── Section ───` banner convention (4,413 occurrences across 1,178 of 1,981
  files) is wanted. Untouched by this spec. Note that its lines are counted inside the
  headline 26.2% comment share, so that figure overstates what this enforcement can move.
  **Deferred deliberately.**
- Whether the citation backlog is really 7,456. That figure came from regex classification,
  and this document applies a precision caveat to other regex results without applying it
  here. DR-3 re-measures with the parse-based extractor before any deadline is set.
- ~~Whether tests are held to the same bar as production.~~ **Resolved:** yes. Tests carry
  more spec citations than production (3,660 against 3,488) despite a lower comment share.
- ~~Whether relocating `comment-prose.ts` breaks consumers.~~ **Resolved, and the premise was
  false:** there is nothing to relocate. No `comment-prose` path is tracked and `HEAD` contains
  neither `extractCommentProse` nor `collectComments`; the module lives only in stale agent
  worktrees. `governing-catalog.test.ts` is real but imports none of it. Task 003 authors the
  extractor, with the unlanded worktree copy as an adjudicated recovery candidate.
- ~~Whether `INV-*` should be permitted.~~ **Resolved:** no. See Exploration.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design (DR-1 through DR-11).
**Excluded:** The box-drawing banner convention and the `vercel-labs/konsistent`
guard-structure convention (both recorded above). Extending `vocabulary-lint` to source
comments is dropped with the `INV-*` carve-out.

### Delivery stages

This design is delivered by **two workflows**, split around
[`docs/specs/2026-08-11-exarchos-repo-structure-cleanup.md`](2026-08-11-exarchos-repo-structure-cleanup.md),
which moves or deletes every path this spec writes to. The split line is **logic before,
registries after**: the classifier, the policy datum, the extractor and the fixtures are
path-independent and survive the move untouched; every baseline, budget, manifest entry and CI
step is keyed to paths the structure refactor destroys.

**Stage 1 — `comment-hygiene-foundation`** (tasks 001, 002, 003, 004, 005, 006, 007, 008, 013,
015). Runs **to completion before the structure refactor captures its oracle**, because that
refactor's baseline tasks record a test inventory and a guard-liveness census that any
concurrent test or guard addition corrupts.

Task 001 leads and lands alone. The structure refactor dispatches roughly 65 tasks through the
very templates that stamp `Implements: DR-N` and a task ordinal into implementer prompts; if
the stimulus is still live, that refactor manufactures thousands of fresh citations across the
entire moved tree and grows the backlog this spec exists to burn down.

**Stage 1 ships no enforcement.** No CI step, no manifest entry, no baseline file, no enabled
ESLint rule. That constraint is what keeps the structure refactor's guard-liveness baseline
clean and keeps this work out of its rename-detected Phase 1 diff. Task 013 authors the rule;
registering it is Stage 2's task 017.

Task 015's dependency is relaxed from 010 to 008. The fixture corpus is an **input** to the
gate, not an output of it, and task 008 already curates an adjudicated corpus from the same
tree; waiting for a gate that cannot land until Stage 2 would strand it for no benefit.

**Stage 2 — `comment-hygiene-enforcement`** (tasks 009, 010, 011, 012, 014, 016, 017–031).
Runs after the structure refactor's Phase 1 lands. Every path-keyed artifact is then generated
exactly once against a settled tree: the debt budget, the S125 and informative-docs baselines,
the widened-scope baseline, and the TSDoc coverage baseline.

Three tasks get materially cheaper by waiting, and one gets materially safer:

- **017/018 (scope widening)** currently measure a baseline over seven roots — `src/`,
  `scripts/`, `hooks-src/`, `test/`, `tests/`, `docs/evals/`, `servers/exarchos-mcp/scripts/`.
  The refactor deletes six of them. Afterwards the widened glob is four directories, and the
  work folds into that refactor's own guard-retargeting task rather than duplicating it.
- **021–025 (TSDoc)** must land after the refactor's decomposition wave. That wave splits six
  files totalling roughly 19k LOC into new modules with new exported declarations, which
  invalidates any coverage baseline captured before it. Worse, task 024 fails any new
  undocumented export in the diff — landed early, it would **block the decomposition wave
  outright**.
- **027–031 (debt budget)** is the load-bearing reason for the whole ordering. The per-file
  count was chosen over an entry ledger because a count survives reformatting and line shifts.
  It does **not** survive a path change, and this document never claimed it did. A budget keyed
  to `servers/exarchos-mcp/src/registry.ts` is void once that file becomes several modules
  under `src/dispatch/`. Generating it before the move would guarantee a wholesale
  regeneration afterward.
- **002's `exemptPaths`** are retargeted in Stage 2: `docs/evals/**/runs/**` becomes
  `tests/evals/**/runs/**`, and the gate's own sources move with `scripts/` into `tools/`.

**Fold — remediation of the hotspot files is absorbed, not repeated.** Tasks 029 and 030 name
`registry.ts`, `views/tools.ts`, `workflow/tools.ts`, `sqlite-backend.ts`, `guard-inventory.ts`
and `build-skills.ts`. The structure refactor's decomposition wave rewrites those same six
files. Those tasks therefore gain an acceptance criterion in that spec — no extracted module
carries a planning ordinal in a comment, verified by this spec's classifier — and tasks 029 and
030 here shrink to the residue the decomposition did not touch. Paying for two judged rewrite
passes over the same 19k LOC buys nothing.

**Measurement.** DR-3 asks for the same census repeated after 30 days of post-change commits.
The structure refactor's execution is a better natural experiment than a calendar window: run
the Stage 1 classifier in **observe mode** over every one of its PRs. The pre-change census
comes free from task 008's corpus; the post-change census is taken at that refactor's terminal
gate. The comparison is still reported rather than gating, for the reason DR-3 already gives.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | One policy authority, mechanically derived | 003, 004, 013, 014, 016, 026 |
| DR-2 | Planning-artifact ordinals rejected in code comments | 005, 006, 008, 013 |
| DR-3 | Stimulus removed before the gate blocks | 001 |
| DR-4 | Changelog narration rejected | 007, 008 |
| DR-5 | Commented-out code rejected | 019, 020 |
| DR-6 | Exported-surface documentation ratchets upward | 021, 022, 023, 024, 025 |
| DR-7 | Every gate composes into the enforcement substrate | 009, 014, 017, 018, 021, 027 |
| DR-8 | Gates fail closed; indeterminate ≠ pass | 002, 004, 011, 012 |
| DR-9 | Kill fixtures drawn from the real backlog | 012, 015, 016 |
| DR-10 | Existing debt is budgeted down; rewrites preserve rationale | 027, 029, 030, 031 |
| DR-11 | Extraction exposes positions; diff scoping reports only | 003, 010, 028 |

### Tasks

#### Stimulus first (DR-3)

### Task 001: Stop the harness issuing ordinals into code

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-3
**Files:**
- `skills-src/plan/references/task-template.md`
- `skills-src/delegate/references/implementer-prompt.md`
- `skills-src/plan/SKILL.md`

**Verification:** the templates stop directing agents to carry task or DR ordinals into code
and state the comment rule at the point of authoring. Rendered variants regenerated;
`npm run build:skills` and `npm run skills:guard` green.
**Dependencies:** None
**Parallelizable:** Yes

### Task 002: Structural exemptions in the policy datum

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-8
**Files:**
- `.exarchos/comment-policy.json`
- `scripts/lib/comment-policy.test.ts`

**Verification:** `exemptPaths` covers the gate's own sources, its fixtures, the policy
datum's examples, and `docs/evals/**/runs/**`, which holds verbatim captured agent output.
Tests: `Policy_ExemptPath_NeverExpires`, `Policy_EvalRunArtifact_NotScanned`.
**Dependencies:** 004
**Parallelizable:** No

#### Shared foundation (DR-1, DR-11)

### Task 003: Author the comment-prose extractor as .mjs with per-comment positions

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1, DR-11
**Files:**
- `scripts/lib/comment-prose.mjs`
- `scripts/lib/comment-prose.test.ts`

**Verification:** returns per-comment text plus source position; refuses a recovered parse.
Authored as `.mjs` because both consumers are non-TypeScript. **This task authors the module.**
An earlier framing scoped it as relocating `test-helpers/comment-prose.ts` and updating one
import; that module is not tracked and neither `extractCommentProse` nor `collectComments`
appears in `HEAD`. First action is to read the unlanded copy under `.claude/worktrees/` and
adjudicate it — adopt what survives review, write the rest. `governing-catalog.test.ts` is
**not** in this task's file list: it imports nothing from the extractor, so there is no
consumer to retarget and no joined-prose compatibility surface to preserve. Tests:
`ExtractComments_MultiLineBlock_ReportsStartLine`,
`ExtractComments_CommentInsideTemplateLiteral_NotEmitted`,
`ExtractComments_RecoveredParse_Throws`.
**Dependencies:** None
**Parallelizable:** Yes

### Task 004: Policy datum, schema, and fail-closed loader

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1, DR-8
**Files:**
- `.exarchos/comment-policy.json`
- `scripts/lib/comment-policy.mjs`
- `scripts/lib/comment-policy.test.ts`

**Verification:** declares `forbiddenOrdinals`, `allowedReferences`, `changelogPatterns`,
`exemptPaths`, `waivers`, `coverage`. `exemptPaths` is structural and non-expiring;
`waivers` carry owner and `expires`. Tests:
`LoadPolicy_ValidDatum_ExposesEveryDeclaredClass`, `LoadPolicy_MissingFile_ExitsNonZero`,
`LoadPolicy_MalformedJson_ExitsNonZero`, `LoadPolicy_ExpiredWaiver_Fails`,
`LoadPolicy_ExemptPathWithoutExpiry_Accepted`.
**Dependencies:** None
**Parallelizable:** Yes

#### Detection (DR-2, DR-4)

### Task 005: Forbidden-ordinal classifier

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-2
**Files:**
- `scripts/lib/comment-classifier.mjs`
- `scripts/lib/comment-classifier.test.ts`

**Verification:** rejects `DR-<n>`, `task <n>`, `T<n>`, `wave <n>`, `slice <n>`, `epic #<n>`,
`INV-<n>`, and `docs/{specs,designs,plans}/…`. Tests:
`Classify_SpecOrdinal_Rejected`, `Classify_InvOrdinal_Rejected`,
`Classify_PhaseOrdinal_NotRejected`. Property test over generated ordinals.
**Dependencies:** 004
**Parallelizable:** No

### Task 006: Allowed-reference precedence and remedy message

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-2
**Files:**
- `scripts/lib/comment-classifier.mjs`
- `scripts/lib/comment-classifier.test.ts`

**Verification:** URL, `owner/repo#123`, `CVE-…`, `RFC …` permitted and taking precedence.
Tests: `Classify_ForbiddenOrdinalInsideUrl_Permitted`,
`Classify_Rejection_MessageNamesRemedy` asserts message text, not only verdict.
**Dependencies:** 005
**Parallelizable:** No

### Task 007: Changelog-narration classifier

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-4
**Files:**
- `scripts/lib/comment-classifier.mjs`
- `scripts/lib/comment-classifier.test.ts`

**Verification:** rejects `previously this…`, `used to be`, `formerly`, and passive change
verbs. Tests: `Classify_BarePreviously_NotRejected`, `Classify_PassiveChangeVerb_Rejected`.
`no longer` is implemented behind a policy flag, default off, pending task 008.
**Dependencies:** 006
**Parallelizable:** No

### Task 008: Precision audit before any class blocks

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2, DR-4
**Files:**
- `scripts/lib/comment-classifier.precision.test.ts`
- `scripts/__fixtures__/comment-hygiene/precision-sample.json`

**Verification:** 50 matches per shipping pattern are sampled from the current tree,
adjudicated, and committed so the number is auditable; all matches are adjudicated when there
are fewer than 50. A pattern ships enabled at 95% precision or better and disabled below it.
Tests: `Precision_SampledPattern_ScoreRecorded`,
`Precision_TypeParameterT_NotClassifiedAsOrdinal`,
`Precision_PatternBelowFloor_ShipsDisabled`.
**Dependencies:** 005, 006, 007
**Parallelizable:** No

#### The comment gate (DR-7, DR-8, DR-9, DR-10, DR-11)

### Task 009: Gate primary, manifest entry, and CI step in one change

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7
**Files:**
- `scripts/check-comment-hygiene.mjs`
- `scripts/enforcer-wiring-manifest.json`
- `.github/workflows/ci.yml`

**Verification:** the primary, its manifest entry, AND its invoking CI step land together. A
manifest entry without a workflow reference yields `[orphan]`, which fails the wiring gate as
hard as `[unlisted-primary]`; a `*.test.sh` reference does not create reachability. Tests:
`WiringGate_PrimaryManifestAndStepTogether_ExitsZero`,
`WiringGate_ManifestEntryWithoutCiStep_ReportsOrphan`.
**Dependencies:** 003, 004
**Parallelizable:** No

### Task 010: Tree-wide mode with file:line reporting

**Risk Tier:** high
**Test Layer:** acceptance
**Implements:** DR-11
**Files:**
- `scripts/check-comment-hygiene.mjs`
- `scripts/check-comment-hygiene.test.ts`

**Verification:** classifies every source file and reports offenders with `file:line` using
task 003's positions. Tests: `RunTreeWide_TreeWithOffender_ReportsFileAndLine`,
`RunTreeWide_CleanTree_ExitsZero`, `RunTreeWide_OffenderInsideStringLiteral_NotReported`.
**Dependencies:** 008, 009
**Parallelizable:** No

### Task 011: Fail-closed and indeterminate semantics

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-8
**Files:**
- `scripts/check-comment-hygiene.mjs`
- `scripts/check-comment-hygiene.test.ts`

**Verification:** Tests: `RunGate_UnparseableFile_ReportsIndeterminate`,
`RunGate_ZeroFilesExamined_FailsLoudly`, `RunGate_ExtractorThrows_ExitsNonZero`,
`RunGate_ExpiredWaiver_Fails`, `RunGate_StructuralExemption_NeverExpires`. "Nothing to check"
and "everything passed" must render differently.
**Dependencies:** 010
**Parallelizable:** No

### Task 012: Self-test, re-asserted on the unfiltered lane

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-8, DR-9
**Files:**
- `scripts/check-comment-hygiene.test.sh`
- `.github/workflows/ci.yml`

**Verification:** proves the guard exits non-zero when its subject is violated, and runs on
the unfiltered lane following the `check-enforcer-wiring.test.sh` and
`validate-plugin.test.sh` precedent, so a scripts-only PR cannot weaken the gate without
running its test. Tests: `SelfTest_GuardSubjectViolated_GateFails`,
`SelfTest_ScriptsOnlyPr_StillRuns`.
**Dependencies:** 011
**Parallelizable:** No

#### ESLint rule and conformance (DR-1, DR-9)

### Task 013: comment-content rule over the shared classifier

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-1, DR-2
**Files:**
- `eslint-rules/comment-content.js`

**Verification:** `Program:exit` plus `context.sourceCode.getAllComments()`, reporting on
`loc` since comments have no node. Imports the shared `.mjs` classifier; contains no literal
pattern. Skips directive comments.
**Dependencies:** 008
**Parallelizable:** No

### Task 014: Consumer hard-coding guard

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1
**Files:**
- `scripts/check-comment-policy-authority.mjs`
- `scripts/enforcer-wiring-manifest.json`
- `.github/workflows/ci.yml`

**Verification:** fails if either consumer's source contains a literal pattern the policy
datum also declares. This is the mechanical check DR-1 requires; prose assertion is not
sufficient. Primary, manifest entry, and CI step land together, or the guard can never run.
Tests: `AuthorityGuard_ConsumerHardcodesDeclaredPattern_Fails`,
`AuthorityGuard_ConsumerReadsDatum_Passes`, `AuthorityGuard_WiredAsFailableStep_ExitsNonZero`.
**Dependencies:** 013
**Parallelizable:** No

### Task 015: Kill fixtures from the measured backlog

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-9
**Files:**
- `scripts/__fixtures__/comment-hygiene/offenders.ts`
- `scripts/__fixtures__/comment-hygiene/permitted.ts`

**Verification:** offenders carry the literal discovery-measured text from
`workflow/tools.ts:52` and `next-actions-computer.test.ts`. The `utils/atomic-write.ts:313`
comment goes in the OFFENDERS fixture in its as-committed form, which begins with a literal
ordinal, and its ordinal-stripped rewrite goes in the permitted fixture; listing the current
text as permitted would make task 016's conformance test contradict task 005. Permitted also
carries a URL citation. The fixture directory is listed in `exemptPaths` so the guard does
not flag its own fixtures.
**Dependencies:** 008 (relaxed from 010 — the corpus is an input to the gate, not an output of
it, and 008 already curates an adjudicated corpus from the same tree; see Delivery stages)
**Parallelizable:** Yes

### Task 016: Cross-consumer conformance test

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1, DR-9
**Files:**
- `scripts/lib/comment-classifier.conformance.test.ts`

**Verification:** runs the single fixture corpus through both the gate and the ESLint rule and
fails when their verdicts disagree. Tests:
`Conformance_SameCorpus_GateAndRuleAgree`,
`Conformance_RuleDivergesFromGate_Fails`.
**Dependencies:** 013, 015
**Parallelizable:** No

#### Wiring and scope (DR-7)

### Task 017: Measure the widened-scope baseline, then widen the run

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7
**Files:**
- `eslint.config.js`
- `package.json`
- `scripts/eslint-widened-scope-baseline.json`

**Verification:** the existing ruleset is run against the new directories and its findings
recorded BEFORE the scope widens, because `src/`, `scripts/`, `hooks-src/`, `test/`,
`tests/`, `docs/evals/`, and `servers/exarchos-mcp/scripts/` have never been linted and a
zero-new-findings outcome cannot be assumed. Widens BOTH the flat-config `files` key and the
`lint` script's CLI glob, which currently bounds the run to
`servers/exarchos-mcp/src/**/*.ts` regardless of config. `docs/evals/**/runs/**` is excluded
as captured evidence. Tests: `LintScope_CliGlobWidened_ScriptsDirectoryLinted`,
`LintScope_FlatConfigAloneWidened_RunStillBounded`,
`LintScope_WidenedTreeFindings_MatchRecordedBaseline`.
**Dependencies:** 013
**Parallelizable:** No

### Task 018: Re-host the widened lint on a matching CI lane

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7
**Files:**
- `.github/workflows/ci.yml`

**Verification:** the widened scan surface disqualifies the path-filtered `test-root` host
under the two-surface subset rule in `docs/guides/ci-gate-hosting.md`, so the step moves to a
host whose filter covers it. No manifest entry is added: ESLint runs via the `lint` npm
script, not a `scripts/(check|lint)-*.{mjs,sh}` primary, and a manifest entry with no
on-disk primary yields `[missing-file]`. Tests:
`LintHost_WidenedSurface_CoveredByHostFilter`.
**Dependencies:** 017
**Parallelizable:** No

#### Commented-out code (DR-5)

### Task 019: Install the plugin and measure the S125 baseline

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-5
**Files:**
- `package.json`
- `scripts/measure-s125-baseline.mjs`
- `scripts/s125-baseline.json`

**Verification:** static. Adds `eslint-plugin-sonarjs` as a dev dependency and reports the
`sonarjs/no-commented-code` offender count over the widened scope WITHOUT enabling it as an
error. The plugin must be installed here, not in task 020, or the measurement cannot run its
own subject.
**Dependencies:** 018
**Parallelizable:** Yes

### Task 020: Enable sonarjs/no-commented-code

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5
**Files:**
- `eslint.config.js`
- `scripts/s125-baseline.json`

**Verification:** at 25 offenders or fewer it ships as `error` and they are fixed in this
change; above 25 it ships with its own per-file count budget on the DR-10 pattern.
**Dependencies:** 019
**Parallelizable:** No

#### Exported surface (DR-6)

### Task 021: TSDoc coverage gate, registered on creation

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-6, DR-7
**Files:**
- `scripts/check-tsdoc-coverage.mjs`
- `scripts/enforcer-wiring-manifest.json`
- `.github/workflows/ci.yml`

**Verification:** the primary, its manifest entry, and its CI step land together.
`check-enforcer-wiring.mjs` exits 0. Tests:
`TsdocGate_RegisteredOnCreation_WiringPasses`,
`TsdocGate_WiredAsFailableStep_ExitCodePropagates`.
**Dependencies:** 003
**Parallelizable:** Yes

### Task 022: Counting rule as the definition of record

**Risk Tier:** medium
**Test Layer:** unit
**Acceptance Test Ref:** 021
**Implements:** DR-6
**Files:**
- `scripts/check-tsdoc-coverage.mjs`
- `scripts/tsdoc-coverage-baseline.json`

**Verification:** states explicitly how `export const` arrow functions, re-exports,
`export default`, and overload signatures are counted. The baseline is whatever this rule
measures; the research figure of 3,303 / 4,748 is not a pass criterion. Tests:
`CountExports_ArrowConstExport_Counted`, `CountExports_OverloadSignatures_CountedOnce`.
**Dependencies:** 021
**Parallelizable:** No

### Task 023: Monotonic coverage ratchet

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6
**Files:**
- `scripts/check-tsdoc-coverage.mjs`
- `scripts/check-tsdoc-coverage.test.ts`

**Verification:** follows the `check-coverage-ratchet.mjs` idiom. Tests:
`Ratchet_CoverageDecreases_Fails`, `Ratchet_CoverageIncreases_UpdatesBaseline`,
`Ratchet_UndocumentedExportDeleted_DoesNotCountAsProgress`.
**Dependencies:** 022
**Parallelizable:** No

### Task 024: New undocumented export fails the diff-scoped gate

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6
**Files:**
- `scripts/check-tsdoc-coverage.mjs`
- `scripts/check-tsdoc-coverage.test.ts`

**Verification:** an export added in the diff without TSDoc fails even when total coverage
rises.
**Dependencies:** 023
**Parallelizable:** No

### Task 025: Install eslint-plugin-jsdoc, measure, then enable informative-docs

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6
**Files:**
- `package.json`
- `eslint.config.js`
- `scripts/informative-docs-baseline.json`

**Verification:** the plugin is installed and its offender count recorded before the rule is
enabled as an error, in this same task, so the measurement can run its own subject. Same 25
threshold as task 020.
**Dependencies:** 020
**Parallelizable:** No

#### Agent-facing policy (DR-1)

### Task 026: Generate policy prose from the datum, with a bidirectional drift check

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-1
**Files:**
- `skills-src/<host-skill>/references/comment-policy.md`
- `scripts/check-comment-policy-authority.mjs`

**Verification:** the pattern list is generated into a delimited region from the policy datum
rather than hand-maintained; hand-authored rationale may surround it. Rendered per runtime
(INV-4); `npm run skills:guard` green. The drift check fails when the prose states a pattern
the datum does not declare AND when it omits a class the datum declares. The host skill is
named before dispatch (see Open Questions).
**Dependencies:** 004, 014
**Parallelizable:** No

#### Remediation (DR-10)

### Task 027: Per-file debt budget with --update regeneration

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7, DR-10
**Files:**
- `scripts/check-comment-hygiene.mjs`
- `scripts/comment-debt-budget.json`
- `scripts/check-comment-hygiene.test.ts`

**Verification:** follows `scripts/check-type-debt.mjs`, whose header records why an entry
ledger was rejected for this job. One integer per file; a file over budget fails; budgets may
only decrease; the gate writes the file under `--update` so it is regenerated, not
hand-edited. Generated in this change, so the gate is never wired without it. Tests:
`Budget_FileOverBudget_Fails`, `Budget_BudgetRaised_Fails`,
`Budget_OffenderRemoved_BudgetShrinks`, `Budget_Reformat_DoesNotChangeCount`.
**Dependencies:** 012
**Parallelizable:** No

### Task 028: Diff-scoped mode

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-11
**Files:**
- `scripts/check-comment-hygiene.mjs`
- `scripts/check-comment-hygiene.test.ts`

**Verification:** reports offenders on added lines. Line positions are used for reporting
only; existing debt is tolerated by task 027's counts, so a move or reformat cannot turn old
offenders into failures. Tests: `DiffScope_NewlyAddedOffender_Fails`,
`DiffScope_PureFileMove_ReportsNothing`,
`DiffScope_WholeFileReformat_CountUnchanged_Passes`.
**Dependencies:** 027
**Parallelizable:** No

### Task 029: Remediate the highest-count files

**Risk Tier:** high
**Test Layer:** integration
**Implements:** DR-10
**Files:**
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/event-store/schemas.ts`
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/adapters/cli.ts`
- `servers/exarchos-mcp/src/workflow/tools.ts`
- `scripts/comment-debt-budget.json`
- `.git-blame-ignore-revs`

**Verification:** each comment states its constraint with the ordinal removed, or is deleted
where the ordinal was its entire content, with deletions listed in the PR description. The
budget shrinks by the number remediated. Tests:
`Remediation_FirstBatch_BudgetShrinks`, `Remediation_ExistingSuite_StaysGreen`,
`Remediation_BudgetNotRaised_ByAnyFile`. High tier: this batch sets the rewrite pattern the
later batches follow.
**Dependencies:** 027
**Parallelizable:** No

### Task 030: Remediate remaining production and scripts in capped batches

**Risk Tier:** high
**Test Layer:** integration
**Implements:** DR-10
**Files:**
- `servers/exarchos-mcp/src/event-store/event-registration.ts`
- `servers/exarchos-mcp/src/verbs/worktree/manager.ts`
- `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts`
- `servers/exarchos-mcp/src/dispatch/core/onboarding/reconcile.ts`
- `servers/exarchos-mcp/src/architecture/invariants-loader.ts`
- `scripts/guard-inventory.ts`
- `scripts/comment-debt-budget.json`
- `.git-blame-ignore-revs`

**Verification:** batches capped at 20 files, serialized because every batch edits the shared
budget file. Deletions listed per PR. `scripts/run-validate.mjs` and
`scripts/check-measured-premises.mjs` are handled individually; their headers are dense
load-bearing design essays. Tests: `Remediation_BatchExceedsFileCap_Rejected`,
`Remediation_EachBatch_ShrinksBudget`,
`Remediation_DenseHeaderFile_HandledIndividually`.
**Dependencies:** 029
**Parallelizable:** No

### Task 031: Remediate tests and retire the budget file

**Risk Tier:** high
**Test Layer:** acceptance
**Implements:** DR-10
**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.test.ts`
- `servers/exarchos-mcp/src/registry.test.ts`
- `servers/exarchos-mcp/src/workflow/rehydrate.test.ts`
- `scripts/comment-debt-budget.json`
- `.git-blame-ignore-revs`

**Verification:** test-tree batches under the same cap, then every budget reaches zero and
the file is removed, leaving the gate blocking on any offender.
`check-enforcer-wiring.mjs` still passes. Tests:
`Remediation_TestTree_BudgetsReachZero`,
`Remediation_BudgetFileRemoved_GateStillPasses`,
`Remediation_AfterRetirement_AnyOffenderFails`.
**Dependencies:** 030
**Parallelizable:** No

### Parallelization

**Critical path:** 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 027 → 029 →
030 → 031, interrupted at the stage boundary after 008/013/015 (see Delivery stages).

**Stage 1 — three lanes, and they are genuinely concurrent.** Maximum useful width is three
worktrees:
- **Lane A:** 001 alone, dispatched first and merged before the others (it changes only
  authored skill prose, so it conflicts with nothing, but everything downstream benefits from
  it landing early).
- **Lane B:** 003 — the extractor, no dependencies.
- **Lane C:** 004 → 005 → 006 → 007 → 008 → 013 → 015, plus 002 after 004. Serial by
  construction: 005, 006 and 007 all edit `comment-classifier.mjs` and its test.

Lane C is the stage's critical path. Lanes A and B are short, so expect the stage to be
roughly the length of Lane C.

**Stage 2 — after the structure refactor's Phase 1 lands:**
- **Wave 4 (gate chain):** 009 → 010 → 011 → 012, then 016 once 010 exists.
- **Wave 5 (authority):** 014 after 013, with 026 after 004 and 014.
- **Wave 6 (config chain):** 017 → 018 → 019 → 020 → 025. Folds into the structure refactor's
  guard-retargeting task rather than duplicating it.
- **Wave 7 (TSDoc):** 021 → 022 → 023 → 024, after the decomposition wave, never before it.
- **Wave 8 (remediation, fully serial):** 027 → 028, then 029 → 030 → 031, each shrunk to the
  residue the decomposition wave did not already rewrite.

Shared-file constraints that forbid concurrent worktrees:
- 005, 006, and 007 all edit `comment-classifier.mjs` and its test.
- 010, 011, 027, and 028 share `scripts/check-comment-hygiene.mjs`.
- 017, 019, 020, and 025 share `eslint.config.js` and `package.json`.
- 021, 022, 023, and 024 share `scripts/check-tsdoc-coverage.mjs`.
- 009, 014, and 021 each touch `scripts/enforcer-wiring-manifest.json`.
- 009, 012, 014, 018, and 021 each touch `.github/workflows/ci.yml`.
- 027, 029, 030, and 031 share `scripts/comment-debt-budget.json`, and the remediation tasks
  each append to `.git-blame-ignore-revs`. That chain is serial.

### Completion checklist

- [ ] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests; low-tier tasks lean on static analysis
- [ ] Open questions resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`
