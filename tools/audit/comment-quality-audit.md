# Code comment and docstring quality audit

**Audit date:** 2026-08-21  
**Scope:** 2,193 tracked TypeScript and JavaScript files  
**Method:** parse-based extraction through `tools/audit/lib/comment-prose.mjs`,
classification through the repository policy, and a second-pass smell census

## Executive finding

The dominant comment-quality problem is planning provenance: comments often
explain a real constraint well, then attach that explanation to identifiers a
future reader cannot resolve, such as `DR-16`, `task 042`, `T034`, `INV-12`,
`P07-05`, `epic #1546`, and paths under the relocated planning-document tree.

This is already the repository's stated diagnosis. The comment policy says a
comment must state its constraint in words and must not name a planning ordinal.
The reason is sound: planning identifiers are local to a workflow, can be
renumbered while the source stays unchanged, and frequently refer to documents
that no longer live in this repository.

The policy datum, classifier, fixtures, precision audit, and ESLint rule all
exist. The rule is not registered in `eslint.config.js`, however, and the CI
gate named by the policy's exemptions does not exist. Consequently, the two
most prevalent forbidden patterns continued to grow between the recorded
precision sample on August 11 and this audit on August 21:

- `DR-n`: 4,367 to 4,608 matches
- `task N`: 1,983 to 2,240 matches

Most affected comments should be rewritten rather than deleted. The
`atomic-write` example already captured in the policy fixtures demonstrates the
correct treatment: remove `DR-16:` while preserving every word explaining why
the parent directory must be synchronized after rename.

## Prior art

This audit uses several complementary definitions of comment quality.

### Empirical comment-smell taxonomy

Jabrayilzade et al., [*Taxonomy of inline code comment
smells*](https://link.springer.com/article/10.1007/s10664-023-10425-5)
(*Empirical Software Engineering*, 2024), identifies eleven smell classes.
The classes visible here are:

- **Non-local information:** planning ordinals, epic numbers, and paths into
  external or relocated planning documents.
- **Misleading comments:** comments whose declaration attachment or external
  citation can cease to match the code.
- **Beautification:** decorative section banners that add no semantic content.
- **Too much information:** process history and delivery provenance embedded
  in implementation documentation.
- **Task comments:** deferred work represented by TODO-style prose.
- **Commented-out code:** inactive source retained as prose.

Practitioners surveyed in that study rated misleading comments as the class
most harmful to comprehension. Non-local information is the dominant class in
this repository.

### Comments should say what code cannot

Kevlin Henney's [*Comment Only What The Code Cannot
Say*](https://accu.org/journals/overload/28/157/henney_2796/) argues that
comments which parrot code are noise and comments which preserve history
duplicate version control. Kernighan and Plauger state that a wrong comment has
zero or negative value. Robert Martin's *Clean Code* likewise warns that
comments are not compiled and therefore decay, while his later
[*Necessary Comments*](https://blog.cleancoder.com/uncle-bob/2017/02/23/NecessaryComments.html)
recognizes rationale that cannot be expressed in code as a legitimate and
valuable use.

Exarchos is generally strong at rationale. Its failure mode is attaching
short-lived process metadata to otherwise necessary comments.

### Code-comment inconsistency research

Research on comment/code co-evolution, including Fluri et al. (2007), Wen et
al. at ICPC 2019, and later obsolete-comment detectors, shows that comments are
frequently not updated with the code. An external planning citation compounds
that risk because either side can change independently.

### TypeScript and JavaScript style guidance

The Google TypeScript and JavaScript style guides and
[ts.dev](https://ts.dev/style/) distinguish API documentation from
implementation comments, advise against restating TypeScript types and
identifiers, and advise against boxed decorative comments. The repository is
good at avoiding redundant parameter documentation, but heavily uses boxed
section banners.

### Direct sibling rule

Mailglass's
[`NoPlanningArtifactComments`](https://mailglass.hexdocs.pm/Mailglass.Credo.NoPlanningArtifactComments.html)
expresses the same rule: planning-artifact tokens do not belong in comments or
docstrings; behavior-focused rationale does. Exarchos independently developed
a more rigorous mechanism, including allowed durable references and a measured
precision floor, but has not connected that mechanism to authoring or CI.

## Method and limits

The census covered every tracked `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`,
`.cjs`, and `.jsx` file. It reused the repository's parser-backed extractor
rather than scanning lines with regular expressions. That matters because the
extractor distinguishes comments from comment-like text inside literals and
refuses recovered parses instead of silently reporting an incomplete tree.

Directive comments such as `@ts-expect-error` and `eslint-disable` were counted
but not classified as prose. Existing structural exemptions were honored,
including classifier fixtures and captured evaluation output.

The second pass counted candidate smells that the current policy does not
declare. Those counts are raw population measurements, not permission to add a
blocking expression. New expressions should go through the policy's existing
0.95 precision floor.

Structured Markdown under `content/` and generated `rendered/` output were
outside scope. Shell, YAML, and ordinary Markdown prose were also outside the
code-comment census.

## Census

### Overall volume

| Metric | Value |
| --- | ---: |
| Files scanned | 2,193 |
| Indeterminate files | 0 |
| Comments | 95,436 |
| Comment characters as a share of source characters | 32.6% |
| Comment share under `src/` | 45.0% |
| Files containing at least one comment | 2,150 |
| Files containing a policy-pattern hit | 1,317 |
| Comments containing a policy-pattern hit | 7,367 |
| Comments stacking two or more pattern identifiers | 1,318 |
| JSDoc comments | 11,959 |
| Empty comment spacers | 4,268 |
| Comments longer than 400 characters | 2,276 |

The product tree is not under-documented. Nearly half of `src/` by character
count is comment text. Attention, rather than comment volume, is the scarce
resource.

### Distribution

| Tree | Files | Comments | Comment share | Policy hits |
| --- | ---: | ---: | ---: | ---: |
| `src/` | 726 | 33,738 | 45.0% | 4,632 |
| `tests/` | 1,210 | 51,278 | 24.5% | 4,445 |
| `tools/` | 250 | 10,086 | 37.0% | 1,038 |
| `vitest.config.ts` | 1 | 220 | 65.3% | 20 |

Tests have the largest raw comment population because many suites narrate
which task or design record produced an assertion. `src/` is the highest-value
remediation surface because it is both denser and shipped.

### Declared policy patterns

| Pattern | Enabled | August 11 | August 21 | Change |
| --- | --- | ---: | ---: | ---: |
| Design requirement (`DR-n`) | yes | 4,367 | 4,608 | +241 |
| Task ordinal (`task N`) | yes | 1,983 | 2,240 | +257 |
| Task shorthand (`T-n`) | yes | 629 | 625 | -4 |
| Padded task shorthand (`T034`) | yes | 326 | 324 | -2 |
| Wave ordinal | yes | 224 | 219 | -5 |
| Slice ordinal | yes | 60 | 60 | 0 |
| Epic ordinal | yes | 31 | 31 | 0 |
| Invariant ordinal (`INV-n`) | yes | 1,283 | 1,310 | +27 |
| Planning-artifact path | yes | 114 | 113 | -1 |
| `previously` narration | yes | 18 | 19 | +1 |
| `used to be` | yes | 38 | 63 | +25 |
| `formerly` | yes | 4 | 4 | 0 |
| Passive change verb | no | 131 | 145 | +14 |
| `no longer` | no | 316 | 397 | +81 |

The precision sample and this audit scanned different tree sizes, so the
change is not a same-denominator trend statistic. It does establish that new
source still contains the forbidden style and that no monotonic ratchet is
active.

### Highest-hit files

| File | Comments | Policy hits |
| --- | ---: | ---: |
| `src/events/schemas.ts` | 899 | 242 |
| `tests/unit/events/schemas.test.ts` | 759 | 154 |
| `tests/unit/registry.test.ts` | 697 | 127 |
| `tests/unit/architecture/invariants-loader.test.ts` | 360 | 88 |
| `src/dispatch/core/onboarding/reconcile.ts` | 143 | 87 |
| `src/verbs/team/prepare-delegation.ts` | 299 | 73 |
| `src/adapters/cli/cli.ts` | 464 | 70 |
| `src/workflow/rehydrate.ts` | 212 | 69 |

### Candidate smells outside the datum

| Candidate | Matches | Interpretation |
| --- | ---: | --- |
| Decorative section banners | 6,069 | Beautification; often carry a ticket title |
| Bare issue numbers such as `#1643` | 2,893 | Less durable than `owner/repo#1643` |
| Locative “this function/module/file” | 975 | Too imprecise to block; many are legitimate |
| Stacked planning provenance | 944 | Multiple identifiers before the constraint |
| Program package identifiers (`P07-05`) | 631 | Undeclared planning ordinal |
| Effect identifiers (`EFF-004`) | 59 | Undeclared planning ordinal |
| `NOTE:` / `IMPORTANT:` labels | 43 | Usually removable without information loss |
| Feature identifiers (`F-022`) | 31 | Undeclared planning ordinal |
| Temporary / workaround language | 30 | Mixed present behavior and debt |
| TODO / FIXME / HACK / XXX | 9 | Rare; several are fixtures or rule prose |
| Delivery state such as `T38 GREEN` | 8 | Missed by the current task expressions |
| AI-writing vocabulary | 11 | Confined to the linters and their tests |
| Redundant `@param` / `@return` | 0 | Not a repository-wide problem |
| Apology comments | 0 | Not a repository-wide problem |

## Enforcement gap

| Component | State |
| --- | --- |
| `.exarchos/comment-policy.json` | Present; declares the policy and precision floor |
| `tools/audit/lib/comment-prose.mjs` | Present; parse-based extraction |
| `tools/audit/lib/comment-classifier.mjs` | Present; shared classification |
| `tools/eslint-rules/comment-content.js` | Present and unit-tested |
| Comment-hygiene kill and permit fixtures | Present |
| Recorded precision audit | Present |
| ESLint registration | Missing |
| CI gate | Missing |
| Package script | Missing |
| Waivers | Empty |

The policy exempts `scripts/check-comment-*.mjs` and corresponding tests because
such a gate must contain the vocabulary it detects. No matching files exist.
`eslint.config.js` registers only the Windows-portability
`no-restricted-syntax` selectors; it does not load the comment-content rule.

The architecture documentation-accuracy test treats the JSON policy as the
enforcer for the agent instruction. A policy datum cannot reject a change, so
that assertion can remain green while thousands of violations remain.

## Antipatterns

### Planning ordinals as comment subjects

The dominant pattern is a comment that starts with the provenance key rather
than the constraint:

```ts
// DR-16: the bytes were fsync'd before the rename; the NAME is durable
// only once the parent directory is fsync'd too.
```

Removing `DR-16:` makes this stronger. The explanation remains local,
actionable, and testable; the unresolvable key disappears.

Other recurring subjects include `DR-25 / governing INV-2`, `task 021`,
`T034 (DR-6)`, and `epic #1546`. They require readers to decode a process
taxonomy before reaching the behavior.

### Task and delivery residue

Task numbers collide across plans and lose meaning when a delivery batch
lands. A comment about a cold-start path should name the import-graph
constraint and p95 budget, not the task that introduced it. A test should name
the behavior under test, not report `T45 GREEN`.

Delivery terms such as wave and slice have the same defect. “Verification
ladder slice 1” describes rollout order; “tdd-compliance is advisory” describes
the current product.

### Invariant identifiers

Invariant ordinals are the most defensible contested case. Unlike a design
record, an invariant currently resolves inside this repository. The policy
still forbids it because catalog entries are rewritten and renumbered in place;
the changelog records an `INV-1` split into three distinct invariants.

The repository should choose explicitly between:

1. the current ban, requiring the invariant's substance in every comment;
2. a trailing-reference rule, where the comment states the constraint first
   and may then cite `INV-n`;
3. unrestricted identifiers because the catalog is local.

The second option preserves discoverability without allowing phrases such as
“governing INV-2” to substitute for a behavioral explanation. Any change needs
a new precision audit.

### Paths into relocated planning documents

Comments still point at `docs/designs/archive/`, `docs/plans/archive/`, and
similar paths. Those documents have moved to another repository. At least one
comment cites `docs/migrations/2026-08-10-event-name-grammar.md`, which is
absent in this checkout. The surrounding grammar explanation remains useful;
the path has already demonstrated the staleness the policy predicts.

### Undeclared ordinal families

The live tree contains planning families the policy does not yet know:
`P07-05`, `EFF-004`, `F-022`, and codes such as `BASE-003` and `WFQ-016`.

For example, the retirement-safety module narrates a program sequence from
shadowing through migration to deletion. The durable constraint is simpler:
never remove legacy authority until the event-sourced cutover gate is
satisfied.

These families should be measured through the existing precision workflow
before being added to `forbiddenOrdinals`.

### Bare issue numbers

The policy already permits fully qualified `owner/repo#123` references because
they identify durable records. Bare `#123` references assume the reader knows
which tracker owns the number. They are better than local design ordinals but
less durable than the qualified form.

A broad bare-number regular expression is risky because anchors, colors, and
ordinary prose can collide. The 2,893 raw matches require adjudication before
enforcement.

### Changelog narration

Comments such as “Previously this used a hardcoded fallback” and “the string
literal used to be duplicated” preserve commit history beside current code.
The durable rewrites are present tense: the path comes from configuration; the
filename has one authority. Git retains the transition.

The two disabled English patterns should remain disabled until narrowed. Their
documented false-positive classes are coherent and common.

### Provenance stacking

A representative title is:

```text
Task 008 (#1581 DR-4): post-collapse affordance integrity (INV-12)
```

This contains five provenance markers and no local statement of the
post-collapse constraint. Stacking amplifies the non-local-information smell
and teaches future authors to begin comments with tickets.

### Decorative banners

The repository contains 6,069 long runs of decorative characters. Concept-only
banners are relatively harmless, but banners are the preferred location for
ticket titles. They add visual weight, are read by every comment scanner, and
encourage comments to describe work packages rather than behavior.

This is lower priority than removing planning identifiers. It should begin as
an advisory rule, if it is automated at all.

### Essay comments

Long comments are not automatically poor. The event-name module records live
catalog and persisted-store measurements that justify its grammar; the code
cannot express that rationale. The problem is the design-record framing and
now-missing migration path woven through an otherwise durable argument.

The correct edit is to preserve the evidence and remove unstable provenance.

### Redundant and detached documentation

Redundant parameter documentation is almost absent. A small number of method
comments do narrate the next statements, such as a snapshot `save` method whose
JSDoc explains that it writes a temporary file and renames it while the body
does exactly that.

The more serious structural case is adjacent JSDoc in the event schemas: one
block describes `PhaseBlockedData`, another describes
`PhaseBlockedKindSchema`, and the first sits before the kind declaration rather
than its own declaration. Such attachment errors are easy to turn into
misleading editor hover text and cannot be reliably detected by prose regexes.

### Label noise

`NOTE:` and `IMPORTANT:` usually add no content. The useful CLI comments say
that large dependency graphs must not be imported at module top level. That
constraint remains equally visible without the label.

By contrast, “this function” and “this module” are too context-dependent for a
blocking pattern. Many uses legitimately locate a rule. The existing precision
floor should prevent such a broad expression from shipping.

### Smells that are not material here

The review catalog targets commented-out code and TODO-family markers. Neither
is a repository-wide problem. Likewise, AI-writing vocabulary appears in the
prose linters and tests that name it, not in ordinary production comments.

Expanding these checks would not materially improve the signal-to-noise ratio.

## Strengths worth preserving

- Comments frequently state constraints, alternatives, and failure modes that
  the code cannot express.
- Exported declaration documentation is substantial and generally avoids
  restating TypeScript.
- Allowed durable references are distinguished from local workflow ids.
- The parser fails closed on syntax errors rather than reporting an unread file
  as clean.
- The precision-floor mechanism correctly keeps ambiguous English patterns
  disabled.
- Exemptions distinguish authored prose from machine directives, fixtures, and
  captured agent output.

The cleanup target is therefore not fewer comments as an end in itself. It is
more durable information per comment.

## Recommendations

### Stop new violations first

Connect the existing classifier to an authoring-time or CI consumer. Enabling
the rule against the whole tree at once would create thousands of failures, so
start with a diff-scoped ratchet. This immediately stops the dominant classes
from growing without requiring a giant waiver.

The ESLint rule and a CI gate can eventually coexist because they serve
different feedback times, but one live consumer is sufficient to start.

### Rewrite rather than delete

Remove the ordinal and retain the constraint. Use the existing
`atomic-write` kill/permit fixture pair as the acceptance example. Delete a
comment only when its remaining prose merely restates code or delivery status.

### Extend the policy through measurement

Measure these candidates in order:

1. `Pnn-nn`, because it has 631 structurally clear matches;
2. `EFF-n`;
3. delivery-state phrases such as `T38 GREEN`;
4. feature and program identifier families.

Do not enable bare issue-number, “this function,” or broad change-narration
expressions without adjudicating their actual matches.

### Resolve invariant-reference policy

Make the discrepancy between the current datum and current practice explicit.
A trailing-reference rule is the most balanced option, but it must be measured
and documented rather than inferred.

### Remediate by leverage

1. Add diff-scoped enforcement.
2. Rewrite several short, high-quality examples so live production code models
   the desired form.
3. Address `src/events/schemas.ts` and `src/adapters/cli/cli.ts`.
4. Continue through `src/workflow/` and `src/dispatch/`.
5. Clean tests last; they have high volume but lower reader impact.

### Keep low-value checks low priority

Do not center the cleanup on TODOs, commented-out code, AI vocabulary, or
decorative banners. The measurable problem is planning provenance.

## Conclusion

Exarchos already contains the right conceptual policy and unusually strong
supporting machinery. Its comments are often valuable explanations of why the
system is shaped as it is. The information is diluted by workflow identifiers,
delivery history, decorative structure, and citations whose targets have left
the repository.

The first engineering task is not to invent another policy. It is to connect
the existing one to a diff-scoped consumer, then rewrite violations by
preserving their constraints and removing their provenance.
