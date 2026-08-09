# Spec: Internal-mechanics residue — the defects Wave 1 found but did not fix

**Date:** 2026-08-08 · **Feature:** `internal-mechanics-residue` · **Depth:** standard · **Workflow:** `refactor` · **Track:** overhaul
**Parent:** [`2026-08-06-internal-mechanics-overhaul.md`](2026-08-06-internal-mechanics-overhaul.md) (rev 4.19) — tasks 071–077 were filed there and never dispatched.
**Status:** rev 2 — **instantiated 2026-08-09** as workflow `internal-mechanics-residue`. Epic [#1764](https://github.com/lvlup-sw/exarchos/issues/1764).
**Rev 2 changes:** the parent shipped (PR #1755, squash `f0bac4a89`), so the baseline moved to `main`; a post-merge audit added tasks 091–093 and DR-10; task **087 was relocated** to the anchor epic. See *Rev 2 — what changed and why* below.

## Why this is its own spec

Six tasks, all filed during the internal-mechanics-overhaul by the task that tripped over them. None were dispatched, because each was discovered by an agent already shipping something else — the correct call at the time, and the reason they are still open.

They belong together because they are one defect wearing six faces, and it is the parent program's own thesis: **a rule that is declared, is enforced, and cannot fail.** Two write paths where only one validates. Four copies of a lexer. Three copies of a date-arithmetic ledger. Two authorities deciding what an event may be called. A guard whose predicate tests its own filename. An amendment verb that rewrites the document it was asked to edit one field of.

None of these is a bug report from a user. Every one was produced by a guard doing its job, which is the parent program working — and then filed rather than fixed, which is the part this spec closes.

Task **076 is already done** (`953d2d929`); it is excluded. The original six are 071, 072, 073, 074, 075, 077.

**Rev 2 scope:** the 2026-08-08 review of the parent added 078-086 and 088-090, and the 2026-08-09 post-merge audit added 091-093. With 087 relocated (D6), this spec now carries **21 tasks** and is the closeout plan for epic #1764. The "one defect wearing six faces" framing above still holds — the later tasks are the same defect wearing fifteen more.

## Constraints

- **Existing code only.** This is a refactor: no new capability, no new user-visible feature. 075 is the one behaviour change, and it is a *removal* of an inconsistency, not an addition.
- **Every dependency has landed.** 013, 014, 015, 017, 023, 065 and 068 are all merged — and as of rev 2 the whole parent wave is on `main`. All 21 tasks are dispatchable immediately and in parallel. There is no internal ordering constraint — the waves in Decomposition are a risk ordering, not a dependency graph.
- **Non-empty denominator on every scan.** A census that resolves zero items fails rather than passing clean. This is the parent program's standing rule and it applies unchanged.
- **Derive counts; never write them.** Bare integers in assertions were the dominant integration defect of the parent program (five occurrences in task 076 alone). Denominators are computed.
- **No cast-budget spend.** The DR-14 floor is at 1777 with the wave delta restored to 5 of 5. A task that must spend from it says so in its report.
- **Baseline is `main` @ `f0bac4a89`** (rev 2). The parent branch `feat/internal-mechanics-overhaul` was squash-merged and **deleted**; the rev-1 baseline `f7daf86aa` no longer resolves. Re-derive every count in this document against `main` before acting — the parent spec was refuted 3/3 on unre-derived premises, twice, and rev 1's own baseline went stale within a day of being written.

## Design & Rationale

### Problem statement

The parent program built mechanisms that detect multiply-owned representations and unreachable enforcement. Those mechanisms worked. What they surfaced, in the course of shipping 28 other tasks, is this list. The residue is not a quality problem in the parent program; it is the parent program's output that nobody consumed.

Two of the six have live exposure that has *grown* since filing:

- **074 went from latent to load-bearing.** Task 076 hoisted `merge-orchestrate` out of the hand-written CLI and wired `cli-derivation-guard` direct and blocking. That guard self-executes via `process.argv[1].endsWith('<its own filename>')`. Rename the file and update `ci.yml` — the ordinary meaning of "rename a file" — and CI runs a step that resolves, exits 0 and enforces nothing. When 074 was filed the guard was `unreachable` with a `GUARD_EXEMPTIONS` entry, so the hole was theoretical. It is not theoretical now.
- **071 is accumulating permanent damage.** Six malformed `task.completed` events (sequences 152–157) carry a string `evidence` where the registered schema declares an object. Events are immutable and nothing downstream re-validates, so every additional `batch_append` misuse is another permanent row that projections must defend against.

### Chosen approach

Fix each at its authority, not at its symptom. Concretely that means: one validator shared by both write paths (071); one lexer port the three remaining sites delegate to (072); a splice instead of a document round-trip (073); the resolved-path idiom the repo already uses in `validate-plugin.mjs` (074); one name grammar (075); one dependency-free ledger module (077).

Three of the six (072, 074, 077) are the *same shape of fix already performed once* elsewhere in the tree. Those are cheap and the value is in closing the class, not in the individual edits.

### Decisions taken

- **D1 — 075 lands last and alone.** It changes a public runtime seam: custom event names with digits (`deploy.v2`) or multi-word namespaces (`my-app.started`) stop registering, and snake_case starts. `ExarchosConfig.events` lets users declare types this repo has never seen, so real configs can break at load. It needs a migration note covering already-persisted streams (INV-1 makes renaming a registered event a log-compatibility break) and it should not share a batch with mechanical work.
- **D2 — 074's structural fix outranks its three edits.** The repair is four lines per site. The question worth more is whether `guard-inventory` can detect the class: a guard whose `hasDirectRunExit` is satisfied but whose predicate tests a filename is exactly the "declared, enforced, cannot fail" shape. If it can, that is the deliverable and the three edits are a footnote.
- **D3 — do not migrate the six malformed events in 071.** They are immutable history and the record of the defect. Determine instead whether any projection reads `evidence` and would break on the string form, and report what is found.
- **D4 — 077's extraction goes toward a dependency-free module, not toward the existing census.** Task 023 declined to extract for a good reason: `output-schema-census.ts` imports `TOOL_REGISTRY`, and pulling it into the CLI guard would destroy that guard's load-bearing property of never reaching `bun:sqlite`. The shared module must import nothing.
- **D5 — 072 may legitimately conclude "leave it alone" at a site.** If a site genuinely has no input on which the heuristic and the parse disagree, saying so with evidence is a real outcome, not a failure. What is not acceptable is a kill fixture on which the two instruments never differ, quietly leaving the port unmotivated.

### Rev 2 — what changed and why (2026-08-09)

The parent shipped as PR #1755 and a post-merge adversarial audit ran against the merged tree, scoped to exclude both the anchors and the residue already filed here. It returned **CONDITIONAL, no HIGH** — the wave's headline mechanisms are genuinely wired — and produced three items, now tasks **091–093**. Two facts from that audit are load-bearing for this spec and are recorded here rather than left in the issue tracker:

1. **The parent's guards are real.** `grep-gates` hosts all 59 guard and self-test steps and is genuinely unfiltered; `declareOutputSchema` is module-private so the DR-4 brand really is two-constructor; all 38 `measured:` markers re-derive. This matters because several tasks below assume those mechanisms work and only their *scope* is wrong. That assumption is now measured, not inherited.
2. **The dominant defect class survived inside its own repair.** Task 092 is the H1 vacuity fix guarding the named case and missing the class: `withCappedShape(EnvelopeSchema(z.unknown()))` is refused, `withCappedShape(z.unknown())` is accepted and branded while still total. Same shape as DR-8, one layer in.

- **D6 — task 087 is relocated to the anchor epic, not deferred.** 087's acceptance criteria offer two routes, and its second — *amend INV-11's text to name render-time selection as the chokepoint* — is verbatim anchor 044's scope (#1781, "Invariant amendments (INV-2, 5b, 11, 17)"). Two epics owning one invariant amendment is the multiply-owned-representation defect this programme exists to detect, committed by the programme's own issue tracker. 087 moves to #1763 where 044 already owns INV-11; **#1764 closes on the remaining 21 tasks.** The cost is explicit: INV-11's STATE-authority overclaim stays live until 044 lands behind 043, and that is a known-open invariant, not a closed one.
- **D7 — closeout is risk-ordered, not dependency-ordered.** Every dependency has landed, so all 21 are dispatchable; ordering is therefore a pure risk choice. **078 and 085 go first** because they are the silent-wrong-answer defects — a skipped gate reading as evidence, a failure envelope exiting 0, a short write promoted over good data. **092 joins that first wave**: it is the same class (a totality predicate that does not run on every path) and it is cheap. Everything after is a guard that under-reports, which is a slower harm.

## Requirements

### DR-1: One validator across both event write paths

`batch_append` validates each event against its registered schema using the **same** validator `append` uses — shared, not a second implementation. Two validators is the multiply-owned-representation defect this program exists to detect, and it is how the paths diverged.

Atomicity is a decision, not an accident: state whether one invalid event rejects the whole batch or only itself, and make the tests say which. Silently appending the valid subset trades one silent failure for another.

### DR-2: One lexer port, three remaining consumers

`src/test-helpers/module-lexer.ts` already exists, already returns both `imports` and `maskedSource` from one parse, and already lives in the only directory both excluded from the effect ledger and inside `tsconfig.json`'s `include`. The three surviving hand-rolled instances either adopt it or are proven correct against task 065's `ADVERSARIAL_SET`. No fourth adversarial table.

### DR-3: Field-scoped amendment writes field-scoped diffs

An `invariants_amend` writes back only the amended entry's serialized lines, spliced into the original text, rather than round-tripping the whole document. Sibling entries stay byte-identical. The catalog is a frozen contract authority whose digest covers raw file text, so a collateral re-wrap moves that digest exactly as much as the real edit does — which is what forced task 019 to perform a contract re-approval for a two-string-literal change.

### DR-4: Entrypoint predicates test identity, not filename

A guard that self-executes via `argv[1].endsWith('<filename>')` couples *whether it runs* to *what it is called*. All three remaining sites use the resolved-path idiom already present in `scripts/validate-plugin.mjs` and `scripts/run-validate.mjs`: resolved `argv[1]` compared against `fileURLToPath(import.meta.url)`, plus `realpathSync` so a filename-shaped no-op is not traded for a symlink-shaped one.

`cli-vocab-guard.ts` runs under **bun**, whose `import.meta.url` / `argv` semantics task 018 could not verify. Check them empirically; do not reason by analogy with Node.

### DR-5: One authority decides event-name well-formedness

`registerEventType` consumes `isWellFormedEventName` and `EVENT_NAME_PATTERN` is deleted. Today the two disagree on 25 of 171 live names **in both directions**: the shipped pattern rejects 25 of its own built-ins (it has never failed because built-ins are a literal array never fed through it), while the DR-3 grammar is narrower on digits and multi-word namespaces. The runtime half is the permissive one, so `registerEventType('my-app.started2', …)` succeeds today and lands a grammar-violating name in the live registry.

The no-digits clause is **re-examined against evidence before adoption**. Task 014 chose it deliberately — 0 of 171 built-ins use a digit, so the strict reading was the falsifiable one — but built-ins are not the population at risk. User-registered names are, and `deploy.v2` is an ordinary thing to want. Decide on measured user-config evidence and say what was measured.

### DR-6: One waiver-ledger module

`isIsoDay` / `isoDayUtc` / `daysBetween` / the key-set digest exist independently three times. The vocabulary is identical by deliberate discipline, which is why nothing has diverged yet — and three copies of one rule is still the defect the DR-6 census exists to detect. One dependency-free module, an injected subject descriptor so each census supplies its own population and finding vocabulary, all three delegating. DR-2's copy gains the horizon pin it currently lacks in the process.

### DR-7: A gate's verdict is the gate's own verdict **[new — from the 2026-08-08 review]**

A step that reports GAPS, SKIP or "did not run" must not be aggregated, folded or defaulted into a
PASS. SDLC-3 already says this; the review found four independent places where the aggregation says
otherwise, which makes it a shape rather than an incident. The repair is per-site, but the property
is one: **the verdict a reader sees must be the verdict the step computed.**

### DR-8: A guard's scan root and its floor are both part of its claim **[new — from the 2026-08-08 review]**

Third recurrence. A guard that claims a repository-wide property while walking one subtree, or whose
non-empty-denominator tooth is a bare integer far below the real population, is green for reasons
unrelated to the tree being clean. Roots exclude by PROPERTY (`node_modules`, `dist`, dot-dirs), never
by naming subtrees; denominators are DERIVED against an independent count, never floored.
(The DR-26 seam audit and `check-measured-premises` were repaired inline; the rest are below.)

### DR-9: The guard inventory's denominator must include the guards **[new — from the 2026-08-08 review]**

DR-24's whole-inventory reachability proof only ranges over what `buildGuardInventory` discovers, and
discovery has three channels that between them miss the `src/architecture/**` census/seam modules this
programme shipped. A guard invisible to the inventory is not proven reachable — it is unexamined, and
the proof that says otherwise is measuring a smaller set than it claims.

### DR-10: A lane's execution is not optional **[new — from the 2026-08-09 post-merge audit]**

Every requirement above concerns a guard that runs but measures the wrong thing. DR-10 is the layer
underneath: **whether the guard runs at all must itself be asserted, not assumed.**

`ci-gate` aggregates eight lanes. Four carry an explicit `result == 'skipped'` fail-closed arm — added
by the wave-S DR-3 work and commented in-file as closing the *"skipped-as-passed hole"*. The other
four, including `grep-gates`, are tested only against `failure|cancelled`, and the job's last line is
`echo "All checks passed (skipped jobs are OK)"`. `grep-gates` is now the single host for this
programme's entire enforcement substrate: G1–G5 and their self-tests, the DR-4 vacuity ratchet and its
enforced expiry, the DR-5 derivation guard and ratchet, DR-27 measured-premise drift, the cast and
type-debt ratchets, and the 18-case `no-handler-throw` self-test. They were moved there *precisely
because* the lane is unfiltered.

The hole is **latent, not live** — `grep-gates` has no path filter today, so it cannot skip on an
in-repo PR. That is exactly the objection DR-4 already answered once: a constructor restriction was
chosen over a counting ratchet because *"nothing currently constructs one"* is not enforcement. The
same reasoning applies to a lane whose mandatory execution rests on the continued absence of a path
filter — a convention, sitting twenty lines from the same guarantee asserted structurally for the
test lanes.

**The general property:** for any lane the aggregator gates, either the lane has a declared legitimate
skip condition and the aggregator asserts that skips only occur under it, or the lane has none and a
skip is a hard failure. A lane that can silently not-run is a guard that cannot fail.

## Decomposition

Ordering below is by **risk and exposure**, not dependency.
Tasks 071-077 came from the overhaul's own residue; **078-087 were added by the 2026-08-08 review**
of `internal-mechanics-overhaul` — its nine HIGH findings were fixed inline on that branch, and these
are the MEDIUM/LOW remainder, grouped by defect class rather than transcribed one per finding.
**091-093 were added by the 2026-08-09 post-merge audit** of the shipped result (verdict CONDITIONAL,
no HIGH). **076 shipped in Wave 1** and **087 was relocated** to the anchor epic (D6), so this spec
carries **21 tasks**: 071-075, 077-086, 088-093.

### Closeout waves (D7 — risk-ordered; every dependency has landed, so this is a risk choice, not a DAG)

| Wave | Tasks | Why this wave |
|---|---|---|
| **1 — silent wrong answers** | 078, 085, 092 | Something incorrect currently reads as correct: a skipped gate recorded as evidence, a failure envelope exiting 0, a short write promoted over good data, a totality predicate that does not run on every path. Two are HIGH tier. Nothing else should start until these land. |
| **2 — the guard set's own claims** | 079, 080, 081, 091 | Loose floors, narrow roots, spelling-not-meaning detectors, and the lane whose execution is unasserted. These decide whether the *remaining* measurements can be trusted, so they precede the work that relies on them. |
| **3 — one authority per rule** | 071, 072, 074, 077, 082, 084 | The multiply-owned-representation cluster: two validators, four lexers, three filename-coupled predicates, three waiver ledgers, a hand-maintained census, transcribed counts. Mechanical, highly parallel, and the shape already performed once elsewhere in the tree. |
| **4 — contract debt** | 073, 083, 086, 093 | Field-scoped amendment, the two vacuous `outputSchema`s, INV-4's false-positive, the waiver horizon. Lower blast radius; several are judgement calls needing an owner's sign-off rather than code. |
| **5 — the behaviour change, alone** | 075 | Per D1: a public runtime seam changes and real user configs can break at load. Lands last, in its own PR, with the migration note. |

Waves 1-4 are internally parallel. **088, 089, 090** are already filed as their own issues (#1756, #1757, #1758) and slot into Wave 2 (088 — a blocking gate measuring the wrong tree), Wave 3 (089 — the mutation runner's package resolution) and Wave 2 (090 — a mutating verb ignoring `dryRun`).

**074 sits in Wave 3.** Rev 2 declared 21 tasks but the table above placed only 20 — 074 had a full entry and no wave, so it would have been dropped at dispatch. Wave 3 is where it belongs on both counts: it is the third member of the same-shape cluster this document already names (072, 074, 077), and its D2 question — whether `guard-inventory` can detect the class structurally, which outranks the three edits — cannot be answered until 080 gives the inventory sight of the guards this wave shipped. 080 is Wave 2.

### Task 074: Filename-coupled entrypoint predicates — a silent no-op on rename
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-4
**Files:** `servers/exarchos-mcp/scripts/cli-derivation-guard.ts`, `servers/exarchos-mcp/scripts/cli-vocab-guard.ts`, `servers/exarchos-mcp/scripts/generate-docs.ts`, possibly `scripts/guard-inventory.ts`
**Detail:** Found and measured by task 018 while fixing the fourth instance. It measured the consequence on `output-schema-ratchet-guard.ts`: a byte-identical copy under any other name printed 0 bytes on stdout, 0 on stderr, and exited 0. Invisible to everything that would otherwise catch it — `guard-inventory` still reports the host as direct and unfiltered, and the guard's own unit suite never spawns a process, so it reads the return value of a function CI never reaches.

**Live exposure, updated 2026-08-08:** `cli-derivation-guard` is no longer exempt. Task 076 deleted its `GUARD_EXEMPTIONS` entry and wired it direct and blocking. The hole is live.

**Acceptance criteria:**
- All three sites use the resolved-path idiom. The repair is the same four lines each; the value is closing the class.
- **Kill fixture per site:** a byte-identical copy under a different name must still enforce. Follow the shape of 018's `LegacyFilenamePredicate_GoesSilentlyGreen`, including its refusal to pass when the mutation cannot be applied — a mutation that silently produces an unmutated copy must FAIL, not pass.
- Verify the `bun` case empirically (see DR-4).
- **Non-empty denominator:** a self-test that spawns zero processes, or resolves zero guard files, fails.
- Assess whether `guard-inventory` can detect the class structurally (D2). If it can, that is worth more than the three edits.

**Verification:** medium — scoped tests + per-site kill-probe.
**Dependencies:** none · **Parallelizable:** yes

### Task 071: `batch_append` does not validate event data; `append` does
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/event-store/append.ts`, `servers/exarchos-mcp/src/event-store/batch-append.ts`, `servers/exarchos-mcp/src/event-store/event-validation.ts` (the shared validator this task introduces), `servers/exarchos-mcp/src/events/tools.ts`, `servers/exarchos-mcp/src/event-store/batch-append.test.ts`
**Tests:** `BatchAppend_EventWithSchemaViolatingData_IsRejected`, `BatchAppend_OneInvalidEventInBatch_RejectsPerDeclaredAtomicity`, `AppendAndBatchAppend_IdenticalPayload_AgreeOnValidity`
**Detail:** Measured 2026-08-07 against the live store. `task.completed` registers `evidence` as an object (`{type, output, passed}`, `additionalProperties: false`). Emitting it through `append` with a string `evidence` is correctly rejected with `VALIDATION_ERROR`. The identical payload through `batch_append` **succeeds**. Six such events sit on the `internal-mechanics-overhaul` stream at sequences 152–157; querying them back confirms the malformed value is what was stored, not a rendering artifact.

This is task 068's defect one layer down — a schema that exists, is enforced on one write path, and is bypassed by choosing the other door. It is worse than 068's: that one is caught later by the reader, so the damage surfaces. Here the event store is authoritative, events are immutable, and nothing downstream re-validates, so malformed data is permanent and silent.

**Acceptance criteria:**
- Shared validator across both paths (DR-1).
- Atomicity stated and tested (DR-1).
- **Kill fixture:** `task.completed` with a string `evidence` must fail through `batch_append`. It currently succeeds.
- **Non-empty denominator:** a batch resolving zero events, or a validator resolving zero registered schemas, fails rather than passing clean.
- **Do not migrate the six existing events** (D3). Report instead whether any projection reads `evidence` and would break on the string form.

**Verification:** high — scoped tests + kill-probe + integration over the real store.
**Dependencies:** none · **Parallelizable:** yes

### Task 077: The waiver-ledger idiom is triplicated
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-6
**Files:** a new dependency-free `waiver-ledger` module; `servers/exarchos-mcp/src/architecture/output-schema-census.ts`, `report-coupling-census.ts`, `servers/exarchos-mcp/scripts/cli-derivation-ratchet-guard.ts`
**Detail:** Reported by task 023 against its own work, having just written the third copy. DR-4's `output-schema-census.ts` (task 017), DR-2's `report-coupling-census.ts` (task 013) and DR-5's `cli-derivation-ratchet-guard.ts` (task 023) each carry their own copy. One is already weaker: DR-2's rolls its own `isExpired` and has **no horizon pin**, so per-entry renewal is possible there in a way 017 and 023 both deliberately made impossible.

**Acceptance criteria:**
- One module importing nothing, taking an injected subject descriptor. All three delegate; no copy retains its own date arithmetic or digest.
- **DR-2 gains a horizon pin** in the process — the extraction is the moment to close that gap, not preserve it.
- **Kill fixture per consumer:** each census's existing expiry and shrink-only tests must still bite after delegation. Prove by mutation, not by the suite staying green.
- The CLI guard's no-`bun:sqlite` property is preserved and asserted (D4).
- **Non-empty denominator:** a ledger resolving zero entries fails.

**Verification:** medium — scoped tests + per-consumer kill-probe.
**Dependencies:** none (013, 017, 023 all landed) · **Parallelizable:** yes

### Task 072: Three more near-duplicate lexers, now that a real one exists
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/architecture/vcs-ownership.ts` (`stripComments`), `servers/exarchos-mcp/src/workflow/admission/remediation-purity.ts` (`extractImportSpecifiers`), the `delivery-safety` module (`maskLiteralsAndComments`), `servers/exarchos-mcp/src/test-helpers/module-lexer.ts`
**Detail:** Reported by task 065 against its own work. Having replaced `effect-ledger.ts`'s hand-rolled lexer with a real parse behind a caller-supplied port, 065 named three survivors. This is not speculative: 065 measured its own subject and found the heuristic wrong in **both** directions — a regex containing a backtick hid a real `node:fs` import entirely (heuristic 0, parse 1), and a nested template substitution made it **invent** an effect that was not there (heuristic 1, parse 0), falsifying that module's written promise that it "never invents one". 065 also found `import('p').T` type queries miscounted as value imports and flagged that class as likely present in all three.

**Acceptance criteria:**
- Each site adopts the port or is proven correct against 065's `ADVERSARIAL_SET`. No fourth adversarial table.
- **Per-site kill fixture with both numbers asserted.** A table on which the two instruments never differ fails rather than silently leaving the port unmotivated — unless the site genuinely has no disagreeing input, which must be said and justified (D5).
- Check each for the `import('p').T` miscount specifically.
- **Non-empty denominator** on every scan, and **no cast-budget spend**.
- The shipped bundle stays byte-identical; 065 verified both `--target=bun` and `--target=node` at 991 modules with matching md5s.

**Verification:** medium — scoped tests + kill-probe per site.
**Dependencies:** none (065 landed) · **Parallelizable:** yes

### Task 073: `invariants_amend` re-flows entries it was not asked to touch
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/orchestrate/invariants/catalog-file.ts`, `servers/exarchos-mcp/src/orchestrate/invariants/amend.ts`
**Detail:** Found by task 019 against task 068's verb, on the first real use of it. `invariants_amend` advertises itself as id-targeted and field-scoped, and semantically it is — but committing re-serializes the whole frontmatter document, so `yaml`'s line-width folding re-wraps folded scalars in unrelated entries. 019's one-field amendment to INV-17 produced a 69-insert / 34-delete diff, ~35 lines of which were cosmetic re-wrap of INV-2 and INV-11.

019 proved it is whitespace-only: parsing before and after and diffing the parsed entries yields exactly one semantic change, 21/21 entries intact, markdown body byte-identical. So it is diff noise, not content drift — and still not harmless. Every future one-field amendment drags a contract re-approval along with it, and a reviewer cannot separate amendment from reflow without running a parse-level comparison. That punishes the sanctioned path, which is the one DR-23 exists to make usable.

**Acceptance criteria:**
- An amendment writes back only the amended entry's serialized lines, spliced into the original text. Sibling entries byte-identical.
- **Kill fixture:** amend one field of one entry in a catalog whose siblings carry folded scalars; assert the diff touches only that entry — proved on **raw text**, not the parsed form, because raw text is what the digest covers.
- **Non-empty denominator:** a splice matching zero lines, or a write resolving zero entries, fails.
- State whether the authority digest still moves for a genuine wording change. It should — the catalog's wording is a load-bearing generation input — but it must move for the amendment and nothing else.

**Verification:** medium — scoped tests + kill-probe on the raw-text diff.
**Dependencies:** none (068 landed) · **Parallelizable:** yes

### Task 075: Collapse `EVENT_NAME_PATTERN` into the DR-3 grammar
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-5
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`, `servers/exarchos-mcp/src/event-store/event-name.ts`, migration notes
**Detail:** Two authorities decide what an event name may be and they disagree on 25 of 171 live names. Found by task 014, measured on the runtime path by task 015, and recorded by 015 as an owned, dated, two-way-checked concession rather than fixed — because fixing it changes a public runtime seam.

`EVENT_NAME_PATTERN` (`schemas.ts`) is `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/` — no `_` in either character class — so it rejects 25 of its own built-ins. It has never failed because `registerEventType` applies it only to custom registrations; the built-ins are a literal array never fed through it. A validator its own authoritative corpus fails, invisible because it is never pointed at that corpus. The DR-3 grammar (`event-name.ts`) was derived from all 171 registered names and accepts every one, but is narrower in the other direction: no digits, single-word namespaces.

**Sequencing:** last, and alone (D1).

**Acceptance criteria:**
- One authority decides well-formedness. The census's `divergesFromShippedPattern` concession is **retired, not re-dated** — task 015 wired the stale direction so leaving it standing after the repair trips `STALE_SEED_ENTRY`. Let that fire; do not silence it.
- Re-examine the no-digits clause against measured user-config evidence before adopting it (DR-5).
- A migration note: what breaks, what starts working, what a user with an affected name does. INV-1 makes renaming a registered event a log-compatibility break, so the note must cover already-persisted streams.
- **Kill fixture both ways:** a name the old pattern admitted and the grammar rejects must now fail *with a message naming the migration*; a name the old pattern rejected (snake_case) must now succeed.
- **Non-empty denominator:** a validator resolving zero names fails.

**Verification:** high — scoped tests + `check_test_adequacy` + integration over the registration seam and a replay of persisted streams.
**Dependencies:** none (014, 015 landed) · **Parallelizable:** yes, but see D1

### Task 078: Verdict fidelity — four places a non-pass reads as a pass
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-7
**Files:** `servers/exarchos-mcp/src/orchestrate/gate-utils.ts` (`normalizeGateVerdict`), `scripts/check-measured-premises.mjs` + the `npm run validate` aggregator, `scripts/installer-verify.test.ts`, `servers/exarchos-mcp/src/ctk/cross-runtime.test.ts`
**Tests:** `NormalizeGateVerdict_SkippedCarrierWithPassedTrue_IsIndeterminate`, `AppendGateExecutedSignal_SkippedGate_PreservesSkippedAndDiscriminant`, `ValidateAggregator_StepReportingGaps_IsNotRecordedAsPass`, `InstallerVerify_ShellAbsent_FailsClosedRatherThanSkipping`
**Detail:** Four independent sites, one shape.
1. `normalizeGateVerdict` returns `'pass'` for the advisory-skip carrier `{ passed: true, skipped: true }` — the `skipped && passed !== true` guard never fires because `passed` IS true. Three gates now emit that carrier through `runDurableGateProducer`, so the durable `admission.evidence-recorded` row records `verdict: 'pass'` and `gate.executed` is minted `passed: true` for a gate that never ran. It is also an observability regression: the retired `emitPolicySkipIfNeeded` carried `details.skipped` + `discriminant`; the runner-minted row carries neither.
2. `check-measured-premises.mjs` prints `VERDICT: GAPS` and the words *"reportable, NOT a pass"* with 11 of 13 proof rungs unprobed — and `npm run validate` records it as `PASS measured-premises`, 9/9, exit 0.
3. `scripts/installer-verify.test.ts` drops 11 tests per shell via `describe.skipIf(BASH/PWSH === undefined)` with no fail-closed assertion, no issue, no expiry. `pwsh` is absent on at least one dev host, so the entire PowerShell half of the DR-20 acceptance suite reports success without running.
4. `ctk/cross-runtime.test.ts:97` skips the only cross-runtime leg on `BUN_EXECUTABLE === null`, falling back to a Node-only test that proves `corpusDigest(x) === corpusDigest(x)`. `bun` is a documented build prerequisite, so its absence is an environment defect, not a reason to skip.

**Acceptance criteria:**
- An explicitly-skipped carrier maps to `indeterminate` (or a first-class `skipped`) regardless of `passed`, and `skipped`/`discriminant` survive into `appendGateExecutedSignal`'s `details`.
- A step whose own verdict is GAPS cannot be aggregated as PASS: either it fails the chain, or the aggregate renders its real verdict and the exit code reflects the configured severity.
- Both installer shells asserted present under CI; `pwsh` installed on the lane that owns DR-20 acceptance.
- Every remaining tolerated skip carries an issue reference and an expiry. `skipIf(win32)` (#1641) is exempt.
- **Kill fixture per site:** a gate that did not run must be demonstrably distinguishable from one that passed.

**Verification:** high — scoped tests + `check_test_adequacy` + a probe that a skipped gate never reads as evidence.
**Dependencies:** none · **Parallelizable:** yes

### Task 079: Loose floors and narrow roots across the guard set
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-8
**Files:** `servers/exarchos-mcp/src/sdk/seam.test.ts`, `servers/exarchos-mcp/src/architecture/effect-ledger.test.ts`, `servers/exarchos-mcp/src/contract/governing-catalog.test.ts`, `servers/exarchos-mcp/src/architecture/vcs-ownership.ts`, `servers/exarchos-mcp/src/architecture/effect-ledger.ts`, `servers/exarchos-mcp/src/architecture/delivery-safety.ts`, `servers/exarchos-mcp/src/architecture/import-cycles.ts`, `scripts/check-module-intent.mjs`, `src/skills-catalog-gating.test.ts`
**Detail:** Measured floors against measured populations: `seam.test.ts:364` asserts `moduleCount > 50` where the scanned root holds **1545** modules — 30× loose, and the floor is what DR-26's sole-importer conclusion rested on. Same class at `effect-ledger.test.ts` (`> 100` twice, `files.length > 100`), `governing-catalog.test.ts:282` (`>= 300`). Narrow roots: `vcs-ownership` and `effect-ledger` take `sourceRoot` but every live caller passes `servers/exarchos-mcp/src` while their headers claim "the shipped source"; `check-module-intent.mjs`'s default root is the MCP package, so root `src/` (which now holds `advisory-registry`, `shim-registry`, `projection-containment`, `friction-signal`) is outside the gate entirely. Transcribed populations: `delivery-safety.ts:188` hard-codes a two-element `REQUIRED_DELIVERY_MODULES` (of four modules under `channel/`) with no non-empty-denominator tooth, and its test asserts the constant contains what the constant declares — a comparison with itself. `import-cycles.ts:97` returns `[]` for a prefix that matches nothing, indistinguishable from acyclic, and its blocking CI consumer prints OK and exits 0. `src/skills-catalog-gating.test.ts:33` scans a hand-transcribed nine-file list against a 106-file `skills-src/` tree.

**Acceptance criteria:**
- Every floor is derived from an independently computed population (the pattern landed in `layer-boundaries-seam.test.ts`: `git ls-files` as the second authority), or expressed as a band around it. No bare integer denominators survive.
- Every filesystem-walking guard's root either covers what its header claims, or the header is narrowed to name the root it actually walks. Prefer widening; excluding by property.
- `detectRuntimeCycles` reports its resolved first-party node count and fails closed on zero.
- `auditDeliverySafety` raises `EMPTY_POPULATION` on an empty module list and derives its population from a module property.
- **Kill fixture:** for each repaired guard, a narrowed root or emptied population must FAIL, not pass.

**Verification:** medium — scoped tests + per-guard kill-probe.
**Dependencies:** none · **Parallelizable:** yes

### Task 080: The guard inventory cannot see the guards this wave shipped
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-9
**Files:** `scripts/guard-inventory.ts`, `scripts/enforcer-wiring-manifest.json`, `scripts/check-enforcer-wiring.mjs`, `scripts/check-module-intent.mjs`, `src/friction-signal.ts`, `servers/exarchos-mcp/src/orchestrate/pure/gate-preflight.ts`
**Detail:** `buildGuardInventory` discovers through three channels (root `scripts/` manifest primaries, Wave-1 spec task `**Files:**` entries, and `servers/exarchos-mcp/scripts` gates with a SIBLING self-test). Absent from the inventory entirely: `adapter-ownership-seam.ts`, `effect-port-seam.ts`, `audit-delivery-closure.ts`, `delivery-safety.ts`, `import-cycles.ts` — so `Wave1Exit_NoGuardIsUnreachable`, asserted "over the FULL inventory" precisely so a wave cannot wire its headline guards while leaving others dark, does not range over them. `servers/exarchos-mcp/scripts/authority-live-proof.ts` (42 KB) is dropped because its self-test lives at `src/architecture/authority-live-proof.test.ts` rather than beside it. `unresolvedSpecArtifacts` computes the promised-but-absent list and `auditGuardInventory` never raises a violation for it, so a task whose declared artifact never landed passes the DR-24 proof unremarked. Adjacent: `unfilteredCiPath` is declared by zero of 24 manifest primaries (the adjudication is fixture-only), `emitPolicySkipIfNeeded` is dead production code kept alive by its own test, and `src/friction-signal.ts` is a 245-line module with no production importer whose header states it was placed in root `src/` *because* the MCP-side module-intent gate would have flagged it — relocating out of a gate's reach is not satisfying it.

**Acceptance criteria:**
- A fourth discovery channel enumerates `servers/exarchos-mcp/src/architecture/*.ts` census/seam modules; `Wave1Exit_NoGuardIsUnreachable` demonstrably ranges over them.
- `selfTestCandidates` also resolves `src/**/<name>.test.ts`, so `authority-live-proof.ts` is visible.
- `unresolvedSpecArtifacts` becomes a violation with an explicit, expiring waiver channel.
- `check-module-intent.mjs` covers root `src/`, and each dead-in-prod module there carries a declared class with an owner and a rationale (the blanket `/-seam\.ts$/` filename rule is replaced by per-module entries).
- `unfilteredCiPath` claims recorded on the grep-gates primaries, so the adjudication has a live subject.
- **Non-empty denominator:** an inventory resolving zero guards fails closed (already true — keep it).

**Verification:** medium — scoped tests + kill-probe that an unwired guard fails the reachability proof.
**Dependencies:** none · **Parallelizable:** yes

### Task 081: Detectors that match spelling instead of meaning
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-8
**Files:** `servers/exarchos-mcp/src/orchestrate/gate-ownership-census.ts`, `scripts/check-windows-portability.mjs`, `scripts/lint-envelopes.mjs`, `servers/exarchos-mcp/src/contract/governing-catalog.test.ts`, `servers/exarchos-mcp/src/contract/cli/cli-contract-seam.ts`
**Detail:** Same class as the DR-4 vacuity hole repaired inline (`acceptsEveryValue` tested the outermost node, not what the schema admits). Remaining instances: `gate-ownership-census.ts:162` detects an alternate evidence emitter only via a RAW STRING LITERAL inside `.append(...)`, while the codebase's own idiom is the exported `ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED` constant or a hoisted event object — so a rogue emitter written the way every existing emitter is written is invisible. `check-windows-portability.mjs`'s `SPAWN_RE` matches only `execFile(Sync)('npm'|'npx'|…)` and its `DYNAMIC_SPAWN_RE` requires an identifier first argument, so `lint-envelopes.mjs:94`'s literal `spawnSync('npx', …)` falls through both — and the gate's default `--src-root` is the MCP package, so root `scripts/**` is never scanned at all (that spawn fails on every Windows host post-CVE-2024-27980). `governing-catalog.test.ts:241` greps `/INV-2\s+parity/i` over whole-file source, so an innocuous comment reddens the build — brittle enough that the test splits the literal in its own fixture to avoid self-matching. `cli-contract-seam.ts:323` excludes by directory NAME, and three of the six names (`evals`, `benchmarks`, `test-helpers`) are compiled and emitted to `dist/`.

**Acceptance criteria:**
- Discriminant detectors resolve symbolically (accept the constant and an identifier traced to its object literal) or use a checker-based scan; regex-over-source is not sufficient for a code claim.
- Portability scan covers root `scripts/**` and root `src/**`, and matches `spawn(Sync)` with a literal shim name.
- Prose sweeps restrict to comment text or a stricter shape.
- Directory exclusions derive from a property (build output, test suffix), not a name list.
- **Kill fixture per detector:** the evaded form must trip it.

**Verification:** medium — scoped tests + per-detector kill-probe.
**Dependencies:** none · **Parallelizable:** yes

### Task 082: `no-handler-throw`'s census is a hand-maintained closed set
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-9
**Files:** `eslint-rules/no-handler-throw.js`, `servers/exarchos-mcp/src/orchestrate/composite.ts`, `servers/exarchos-mcp/src/orchestrate/invariants/amend.ts`
**Detail:** `SPECIAL_BRANCH_ACTIONS` lists six handler names; this same wave added a seventh special-cased branch (`invariants_amend` → `handleAmend`, composite.ts:846-853). It is not in the map, so the rule never scans it — and unlike an `ACTION_HANDLERS` entry, where an unresolvable value is FAIL-LOUD `unresolvedHandler` precisely because "an unscannable entry is a gate hole", the special-branch path returns silently (`if (!actionName) return;`, `if (!fnNode) return;`). `handleAmend` is not throw-free either: its commit path calls `replaceEntryInCatalog` (which throws) outside any try/catch, so an escaping throw is flattened to a generic `INTERNAL_ERROR`, discarding the coded envelope the handler builds everywhere else. Two reviewers found this independently.
**Note:** the rule's 18-case self-test now runs on the unfiltered grep-gates lane (fixed inline), so a repair here is actually observed by CI.

**Acceptance criteria:**
- The special-branch census DERIVES from the dispatch branches rather than a hand-written map, so the next special-branch verb cannot fall off it. A hand-maintained list is acceptable only with a two-way conformance assertion against live `composite.ts`.
- The special-branch resolver reports `unresolvedHandler` instead of returning silently.
- `handleAmend`'s catalog-write path returns a coded envelope.
- **Kill fixture:** a throw added to a special-branch handler must be reported.

**Verification:** medium — scoped tests + kill-probe.
**Dependencies:** none · **Parallelizable:** yes

### Task 083: Two new verbs shipped vacuous `outputSchema`s
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/registry.ts`, `servers/exarchos-mcp/src/output-schema-vacuity-allowlist.ts`, `servers/exarchos-mcp/src/orchestrate/cutover-readiness.ts`
**Detail:** `cutover_readiness` and `cutover_decide` are new on this branch and both declare `vacuityWaiver(...)`, seeded into the allowlist in the same change — while DR-4's stated tooth #1 is that a NEW action cannot declare a vacuous `outputSchema` at all. `invariants/amend.ts` held itself to the opposite rule in the same PR ("the verb is new, so it has no seeded vacuityWaiver entry to inherit — and the waiver allowlist is shrink-only") and declared a substantive `AmendInvariantData`. Both handlers return fully typed shapes (`CutoverGateReport` already exists), so the schemas are writable today.
**Note:** the construction path is now closed (`withCappedShape` refuses a vacuous base) and `acceptsEveryValue` sees through wrappers, so this is the remaining DEBT, not a live hole.

**Acceptance criteria:**
- Both verbs declare substantive `data` schemas; both rows drop off the waiver seed (off, not sideways).
- The seed digest moves in the open, with the shrink recorded.
- Or: an explicit, owned, expiring statement of why two new verbs are exempt from the rule the third new verb met.

**Verification:** medium — scoped tests; the DR-4 census already ratchets.
**Dependencies:** none · **Parallelizable:** yes

### Task 084: Count-as-literal sweep — the release path and the authority census
**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-8
**Files:** `.github/workflows/release.yml`, `scripts/release-workflow.test.ts`, `servers/exarchos-mcp/src/architecture/authority-live-proof.test.ts`, `servers/exarchos-mcp/src/architecture/authority-census.test.ts`, `servers/exarchos-mcp/src/adapters/cli.test.ts`, `scripts/audit/knip-diff.ts`
**Detail:** The dominant defect class of this programme, still present in six places. Worst is the release path: `release.yml:303` `expected=10` and `:333` `expected=11` denominate the cross-compile TARGETS population (5 targets × {binary, .sha512} + 1 manifest) and are not derived from `TARGETS`; the contract test that should catch drift hard-codes the same 11-element list, so **both sides are literals and the test is green by construction**. `ci-binary-matrix.test.ts` next door DERIVES its expectation from `TARGETS` — so adding a target updates `ci.yml` under a derived gate, leaves `release.yml` and its test green, and breaks the release at tag-push time. Also: `authority-live-proof.test.ts:233/342` and `authority-census.test.ts:827-830` transcribe 8/8/24/15 beside assertions that already pin the same facts in derived form; `cli.test.ts:1391` says "four hard-wired top-level promotions" where there are three since task 076; `knip-diff.ts:32` states "There are 84 of them" where the live measurement prints 94.

**Acceptance criteria:**
- Both release counts and `release-workflow.test.ts`'s asset set derive from `TARGETS`; adding a target reddens the PR, not the tag push.
- The authority denominators are derived from the topology data or dropped in favour of the existing derived assertions.
- Prose counts are removed or restated as dated measurements.
- **Kill fixture:** adding a sixth target must fail on the PR.

**Verification:** medium — scoped tests + kill-probe on the target list.
**Dependencies:** none · **Parallelizable:** yes

### Task 085: Correctness and robustness residue
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-7
**Files:** `servers/exarchos-mcp/src/adapters/cli.ts`, `src/operations/atomic-json.ts`, `servers/exarchos-mcp/src/architecture/report-coupling-census.ts`, `servers/exarchos-mcp/src/runbooks/drift.test.ts`, `servers/exarchos-mcp/src/__tests__/sdk-patch-policy.test.ts`, `servers/exarchos-mcp/src/contract/cli/generated-client.test.ts`, `scripts/validate-plugin.mjs`, `servers/exarchos-mcp/src/contract/cli/differential-fixtures.test.ts`
**Tests:** `ResolveExitCode_FailureResultWithoutError_DoesNotExitZero`, `AtomicJson_ShortWrite_FailsRatherThanPromotingPartialContents`, `AuditReportCouplingSeed_TodayParameter_IsRequiredNotAmbient`, `ValidatePluginPolicy_UnknownTopLevelKey_IsReportedAsFinding`, `RunbookAutoEmits_EventDeclaredButNoStepEmits_FailsBijection`
**Detail:** Seven independent defects with real failure modes.
1. **`resolveExitCode` regressed the failure floor.** A `ToolResult` with `success: false` and no `error` now exits **0** (`exitCodeForError(undefined)` → SUCCESS). `ToolResult` is not a discriminated union, so the shape is type-legal for any of the 123 handlers, and the MCP wire renders the same value as `isError: true` — the two surfaces disagree. `DIFFERENTIAL_CASES` has no error-less case, so the differential proof is blind to it. The deleted body fell through to `HANDLER_ERROR`.
2. **`atomic-json` does not guarantee what its header claims.** The "validate the serialized bytes by parsing them back" step parses an in-memory string that `JSON.stringify` just produced — it cannot fail. Meanwhile the real risk is unchecked: the `nodeFs` adapter discards `fs.writeSync`'s return value, so a short write is `fsync`ed and `rename`d over the target, destroying the previous contents. No directory `fsync` after `rename` either. Both `writeConfig` and `~/.claude.json` route through it.
3. **G3's expiry tooth reads the wall clock inside the library** (`auditReportCouplingSeed(..., now = new Date())`), against the discipline the sibling ratchets follow (`today` a required ISO-day parameter). Its guard IS its co-located vitest, so the whole unit suite goes red on every developer's machine on 2027-03-01.
4. **The runbook `autoEmits` bijection was deleted** with `compute.ts`; only one-directional containment survives, so a runbook declaring an event no step emits is caught nowhere.
5. **`sdk-patch-policy.test.ts` mandates dead tooling on a false premise** — it requires `patch-package` to stay a RUNTIME dependency and `postinstall` to keep invoking it, asserting "patches/ exists" when the directory does not exist and v1 is gone.
6. **The packaged-binary ENOENT guard lost its subject** — it exercises `compileForCliAddressing()`, which has zero production callers, while the real dispatch path (`invokeContractAction` → `contractActionIds`) never runs under the fs mock. Three module headers still describe the retired lazy-compile mechanism.
7. **`validate-plugin.mjs` reads its policy with no key validation** — a mistyped top-level key silently produces zero checks for that whole family, and the non-empty tooth only fires when ALL families vanish. Measured: three declared families dropped and the gate still exits 0.
Plus: `differential-fixtures.test.ts:54/107` compares two functions with byte-identical bodies delegating to the same helper — one authority wearing two names, and the fixture module's own docblock concedes it.

**Acceptance criteria:**
- `resolveExitCode` has an explicit failure floor; `DIFFERENTIAL_CASES` gains the error-less case.
- `atomic-json` loops on the byte count (or throws on a short write), re-reads before `rename` if the promotion claim is kept, and the header describes what is enforced.
- `today` is a required parameter on the G3 ratchet; the clock read moves to a `scripts/` entrypoint.
- The `autoEmits` bijection is re-homed rather than dropped.
- `sdk-patch-policy` conditions on `readPatchFilenames().length > 0`; `patch-package` leaves `dependencies`.
- The ENOENT guard exercises the live dispatch path; the three stale headers are corrected.
- `validate-plugin` validates its policy against a strict schema and pushes `[policy-unknown-key]`.
- **Kill fixture** for 1, 2 and 7 specifically — each is a silent-wrong-answer, not a loud failure.

**Verification:** high — scoped tests + `check_test_adequacy` + integration across the CLI/MCP surfaces.
**Dependencies:** none · **Parallelizable:** yes

### Task 086: INV-4 fires on every conforming `build:skills` commit
**Risk Tier:** low · **Boundary Touching:** false · **Implements:** DR-7
**Files:** `.exarchos/invariants.md` (INV-4 enforcement block)
**Detail:** INV-4's `mode: check` predicate scopes to `skills/**` and greps `@@`, so ANY touched generated skill file is a blocking finding — but CLAUDE.md requires committing the regenerated `skills/` tree alongside its source, and `skills:guard` already proves the tree matches `skills-src/`. The predicate cannot distinguish regenerated output from a hand edit, so it fires on exactly the commits the convention mandates (73 files on this branch alone). A blocking invariant that a conforming change cannot satisfy trains reviewers to ignore it.
**Acceptance criteria:** the check consults `skills:guard`'s verdict (or a render-equivalence probe) so a regenerated tree passes and a HAND-EDITED one still fails. Kill fixture: a hand edit to `skills/**` that `skills-src/` does not produce must fail.
**Verification:** low — static + the existing guard.
**Dependencies:** none · **Parallelizable:** yes

> **Task 087 (INV-11 STATE-authority) was RELOCATED to the anchor epic on 2026-08-09 — see D6.**
> Its text now lives on [#1798](https://github.com/lvlup-sw/exarchos/issues/1798) under epic
> [#1763](https://github.com/lvlup-sw/exarchos/issues/1763), alongside anchor 044 which already owns
> the INV-11 amendment. It is deliberately absent from this spec's task set so plan-coverage and
> provenance measure the 21 tasks this epic actually closes. The id **087 is retired, not reused.**

### Task 088: `prepare_synthesis` measures the directory it was launched in
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-8
**Files:** `servers/exarchos-mcp/src/orchestrate/prepare-synthesis.ts`, `servers/exarchos-mcp/src/orchestrate/prepare-synthesis.test.ts`
**Detail:** DR-8's scan-root defect on a BLOCKING gate rather than a guard. `runTestSuite`, `runTypecheck`, `verifyStack` and `changedFilesAgainstBase` each shell out with no `cwd` option, so all four legs measure `process.cwd()` — whatever directory the MCP server happened to be launched in — while the readiness verdict is reported as the workflow's. The handler's second positional argument is `stateDir`, not a repo root, so there is currently nothing to thread: the gate has no way to name the tree it is judging. Two consequences. In production, a server launched anywhere but the workflow's repo returns a readiness verdict for an unrelated tree, and `testsPass`/`typecheckPass` are then folded into `ready`. In test, the legs run for real: the one `phase-gate-evidence.test.ts` case that clears the task-completion short-circuit re-entered the whole `vitest run` from inside a test and waited out both subprocess timeouts (120s + 60s = the 180s observed under load). That test was repaired inline by stubbing `node:child_process`, matching `prepare-synthesis.test.ts`; the production hole is untouched.
**Acceptance criteria:**
- The gate takes an explicit repo root and every subprocess leg passes it as `cwd`; no leg reads ambient `process.cwd()`.
- A verdict computed against a directory that is not the workflow's repo is a structural impossibility, not a convention.
- **Kill fixture:** run the gate with a repo root that differs from `process.cwd()` and assert the legs ran against the root — this must fail before the change.

**Verification:** medium — scoped tests + kill-probe on the cwd argument.
**Dependencies:** none · **Parallelizable:** yes

### Task 089: The mutation runner still never runs where its config lives
**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-8
**Files:** `servers/exarchos-mcp/src/orchestrate/mutation-adequacy.ts`, `servers/exarchos-mcp/src/orchestrate/mutation-adequacy.test.ts`
**Detail:** The second half of the review's H4. That finding had two required fixes — stop treating `total: 0` as adequacy, and resolve the runner at the package that owns `stryker.conf.mjs`. Only the first landed: the gate now degrades with a reason instead of trivial-passing, so the vacuous verdict is gone. But the command still executes with `cwd: args.repoRoot` (the single `cwd` in the module), and `stryker.conf.mjs` plus the Stryker 9.6.1 devDependency live under `servers/exarchos-mcp`, which is not a workspace of the root (`workspaces: packages/*`) and puts no `stryker` on the root `.bin`. So the gate is now honestly reporting that it cannot run, rather than dishonestly reporting that it passed — an improvement, and still not a mutation score. **No mutation score has ever been measured for this branch's diff.** The dimension is advisory by default, so this blocks nothing; it does mean the R5 backstop is unexercised and the NoCoverage axis has nothing to enforce against.
**Acceptance criteria:**
- The resolved mutation command runs in the package that owns the mutation config, discovered from the config's location rather than named in a list.
- A real carrier comes back for a diff touching MCP source: non-zero `total`, with `killed`/`survived`/`noCoverage` populated.
- The degrade path added by H4 stays reachable and keeps its reason — this task must not restore a trivial pass.
- **Kill fixture:** move the mutation config and the gate must degrade, not silently pass.

**Verification:** medium — scoped tests + one real diff-scoped run whose carrier is non-empty.
**Dependencies:** none · **Parallelizable:** yes

### Task 090: `transition` silently ignores `dryRun` and performs the real transition
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-7
**Files:** `servers/exarchos-mcp/src/registry.ts` (the `transition` action schema), `servers/exarchos-mcp/src/workflow/tools.ts`, `servers/exarchos-mcp/src/workflow/tools.test.ts`
**Detail:** H7's defect class on a MUTATING verb. `exarchos_workflow`'s composite input schema carries `dryRun`, and five actions declare it (`cancel`, `cleanup`, `prune_stale_workflows`, `invariants_add`, `invariants_amend`, plus `merge_orchestrate` on the sibling tool) — but `transition` does not. Zod strips what the action never declared, so `{action:'transition', target:'synthesize', dryRun:true}` is accepted, reports success, and **performs the transition**. The caller asked to test a guard and moved the workflow. Found live: a dry-run probe of `review → synthesize` on `internal-mechanics-overhaul` advanced the phase for real. The failure is silent in the worst direction — a parameter whose entire purpose is "do not mutate" reads as honoured. A caller cannot distinguish "dry run succeeded" from "the thing happened".
**Acceptance criteria:**
- Either `transition` implements `dryRun` (evaluate guards, return the would-be phase, append nothing), or it REJECTS `dryRun` as an unknown parameter — silently accepting and ignoring it is the one option ruled out.
- A composite-level audit: every action reachable through a shared input schema either declares each parameter it is passed or rejects it. This is H7's mechanism, so the sweep should look for other instances rather than fix this one site.
- **Kill fixture:** a `dryRun:true` transition must leave the projected phase unchanged, asserted against the event stream — not merely against the return value.

**Verification:** medium — scoped tests + a kill-probe asserting no event was appended.
**Dependencies:** none · **Parallelizable:** yes

## Exit condition

All twenty merged (071-077 from the overhaul's residue, 078-090 from the review), with:
- root suite green and MCP at the known-red merge-orchestrate + `store.race` baseline, member-for-member;
- `npm run validate` 9/9 and `validate-no-legacy` at 0 unallowlisted;
- every kill fixture above demonstrated by mutation, not by a green suite;
- 075's migration note landed in `docs/`;
- the DR-14 cast floor re-baselined in the open if any task moves it.

**Two exit criteria the review added, because both were previously satisfiable while false:**
- `npm run validate` exiting 0 is NOT sufficient on its own — no step may report a non-pass verdict
  that the aggregate records as PASS (DR-7). Read the step verdicts, not just the exit code.
- No guard may be green because of what it does not look at (DR-8). For every guard this spec
  touches, the scan root and the denominator are stated in its own test, and a narrowed root fails.

**Sequencing note.** 078 and 085 carry the silent-wrong-answer defects (a skipped gate reading as
evidence; a failure envelope exiting 0; a short write promoted over good data). Take those first —
the rest are guards that under-report, which is a slower harm than a gate that misreports.

### Task 091: A gated CI lane can silently not-run
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-10
**Files:** `.github/workflows/ci.yml` (`ci-gate`), `servers/exarchos-mcp/src/architecture/ci-topology.test.ts`
**Detail:** `ci-gate` aggregates eight lanes. `test-root`, `test-mcp`, `test-windows` and `test-windows-root` each carry an explicit `result == 'skipped'` fail-closed arm, added by the wave-S DR-3 work and commented in-file as closing the *"skipped-as-passed hole"*. `grep-gates`, `manifest-gate`, `outcome-tests` and `validate-no-legacy` are tested only against `failure|cancelled`; the job's final line is `echo "All checks passed (skipped jobs are OK)"`. `grep-gates` is the single host for this programme's entire enforcement substrate — 59 steps covering G1-G5 and their self-tests, the DR-4 vacuity ratchet and enforced expiry, the DR-5 derivation guard and ratchet, DR-27 measured-premise drift, the cast/type-debt ratchets, and the 18-case `no-handler-throw` self-test — and they were moved there precisely because the lane is unfiltered.

**Latent, not live.** `grep-gates` has no `needs: changes` and no path filter, so it cannot skip on an in-repo PR today; the fork arm skips `ci-gate` too. The defect is that mandatory execution rests on the continued *absence* of a path filter. DR-4 already rejected that reasoning once — it chose a constructor restriction over a counting ratchet because "nothing currently constructs one" is not enforcement. Adding a path filter to a 59-step lane that installs both dependency trees is an obvious future optimisation, and it would convert every guard above to skipped-as-passed while CI Gate prints success.

**Acceptance criteria:**
- `grep-gates`, `manifest-gate` and `outcome-tests` gain an unconditional `result == 'skipped'` fail-closed arm — these lanes have no declared legitimate skip, so no `changes.outputs.*` predicate is owed.
- `validate-no-legacy` gains the same, predicated on its path filter if it declares one.
- The rule is expressed once and derived, not transcribed per lane: the aggregator's lane list and its skip policy come from one place, so a lane added to `needs:` cannot be omitted from the policy.
- **Kill fixture:** add a path filter to `grep-gates` that excludes the PR's changed files; `CI Gate` must redden. Reverting the fail-closed arm must make that fixture pass again.

**Verification:** medium — CI-topology conformance test + the kill fixture.
**Dependencies:** none · **Parallelizable:** yes

### Task 092: `withCappedShape` refuses vacuity only on the envelope-shaped path
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-8
**Files:** `servers/exarchos-mcp/src/output-schema-declaration.ts`, `servers/exarchos-mcp/src/output-schema-declaration.test.ts`
**Detail:** The 2026-08-08 review's H1 repair added an `acceptsEveryValue(baseData)` throw, but the line above it returns the brand before that check is reached whenever the input is not envelope-shaped: `const baseData = extractEnvelopeDataSchema(outputSchema); if (baseData === undefined) return declareOutputSchema(outputSchema);`. Measured on the merged tree by direct import: `withCappedShape(EnvelopeSchema(z.unknown()))` and `withCappedShape(EnvelopeSchema(z.any()))` are correctly REFUSED, while `withCappedShape(z.unknown())` and `withCappedShape(z.any())` are both ACCEPTED and return a branded `DeclaredOutputSchema` for which `acceptsEveryValue(...)` is `true`. The module's own comment — *"this constructor mints substance, so it must refuse to mint it out of nothing"* — is false for that path.

**One tooth of two, backstop intact.** `classifyOutputSchema` fails closed: both the branded and the bare form classify `{ vacuous, unreadable-envelope }` (measured), so the DR-4 census and its shrink-only ratchet still catch a new action declared this way. This is debt in the repair, not a live hole — and it is DR-8's shape (the guard's subject is narrower than its claim) occurring inside the fix for the previous instance.

**Acceptance criteria:**
- The totality check runs on every construction path: either hoist it above the early return so a non-envelope schema is tested directly, or make the non-envelope branch fail loudly rather than brand.
- The choice is stated: a non-envelope `outputSchema` is either legal-and-checked or rejected outright. Branding it unchecked is the one option ruled out.
- **Kill fixture:** `withCappedShape(z.unknown())` must throw; the two envelope-wrapped cases must keep throwing; a genuinely typed envelope must still succeed.

**Verification:** medium — scoped tests + kill-probe on each of the three input shapes.
**Dependencies:** none · **Parallelizable:** yes

### Task 093: The DR-4 waiver horizon is one cliff for all 111 entries
**Risk Tier:** low · **Boundary Touching:** false · **Implements:** DR-7
**Files:** `servers/exarchos-mcp/src/output-schema-vacuity-allowlist.ts`, `servers/exarchos-mcp/src/output-schema-seed-pin.ts`, `servers/exarchos-mcp/scripts/output-schema-ratchet-guard.ts`
**Detail:** All 111 live waivers carry `expires: '2027-02-28'`, the single pinned `VACUITY_EXPIRY_HORIZON`, across four owners (`orchestration` 75, `views` 21, `workflow-platform` 12, `event-store` 4). The mechanism is sound and deliberate: an entry cannot re-date itself, a re-date is one constant in a dedicated file, and the clock is read at the CI entrypoint rather than inside the unit suite — correctly avoiding the wall-clock-in-library shape task 085 flags for G3. The gap is incentive, not mechanism. Nothing applies pressure before the horizon, so the modelled outcome is 111 simultaneous failures on 2027-03-01 resolved by a single horizon bump — which is the "permanent exemption wearing a date" the file's own header says task 017 set out to end, deferred by eighteen months rather than removed.

**Acceptance criteria:**
- Either the horizon is staggered per owner (four dates derived from the owner set, not transcribed) so paydown pressure arrives incrementally and one bump cannot renew all 111, or an explicit, owned, dated statement records that a single cliff is intended and who reviews it before it lands.
- The ratchet reports waiver count by owner, so the trend is visible per PR rather than only at the cliff.
- **Kill fixture:** if staggering is chosen, an entry re-dated past its owner's horizon must fail.

**Verification:** low — static; the existing ratchet already enforces the record shape.
**Dependencies:** none · **Parallelizable:** yes
