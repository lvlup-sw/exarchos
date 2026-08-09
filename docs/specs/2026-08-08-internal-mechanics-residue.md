# Spec: Internal-mechanics residue — the defects Wave 1 found but did not fix

**Date:** 2026-08-08 · **Feature:** `internal-mechanics-residue` · **Depth:** standard · **Workflow:** `refactor` · **Track:** overhaul
**Parent:** [`2026-08-06-internal-mechanics-overhaul.md`](2026-08-06-internal-mechanics-overhaul.md) (rev 4.19) — tasks 071–077 were filed there and never dispatched.
**Status:** authored, **not instantiated**. No workflow exists for this spec yet.

## Why this is its own spec

Six tasks, all filed during the internal-mechanics-overhaul by the task that tripped over them. None were dispatched, because each was discovered by an agent already shipping something else — the correct call at the time, and the reason they are still open.

They belong together because they are one defect wearing six faces, and it is the parent program's own thesis: **a rule that is declared, is enforced, and cannot fail.** Two write paths where only one validates. Four copies of a lexer. Three copies of a date-arithmetic ledger. Two authorities deciding what an event may be called. A guard whose predicate tests its own filename. An amendment verb that rewrites the document it was asked to edit one field of.

None of these is a bug report from a user. Every one was produced by a guard doing its job, which is the parent program working — and then filed rather than fixed, which is the part this spec closes.

Task **076 is already done** (`953d2d929`); it is excluded. The six here are 071, 072, 073, 074, 075, 077.

## Constraints

- **Existing code only.** This is a refactor: no new capability, no new user-visible feature. 075 is the one behaviour change, and it is a *removal* of an inconsistency, not an addition.
- **Every dependency has landed.** 013, 014, 015, 017, 023, 065 and 068 are all merged, so all six tasks are dispatchable immediately and in parallel. There is no internal ordering constraint — the sequence in Decomposition is a risk ordering, not a dependency graph.
- **Non-empty denominator on every scan.** A census that resolves zero items fails rather than passing clean. This is the parent program's standing rule and it applies unchanged.
- **Derive counts; never write them.** Bare integers in assertions were the dominant integration defect of the parent program (five occurrences in task 076 alone). Denominators are computed.
- **No cast-budget spend.** The DR-14 floor is at 1777 with the wave delta restored to 5 of 5. A task that must spend from it says so in its report.
- **Baseline is `feat/internal-mechanics-overhaul` @ `f7daf86aa`**, not `main`. Re-derive every count in this document against the branch tip before acting — the parent spec was refuted 3/3 on unre-derived premises, twice.

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

## Decomposition

Ordering below is by **risk and exposure**, not dependency.
Tasks 071-077 came from the overhaul's own residue; **078-087 were added by the 2026-08-08 review**
of `internal-mechanics-overhaul` — its nine HIGH findings were fixed inline on that branch, and these
are the MEDIUM/LOW remainder, grouped by defect class rather than transcribed one per finding.

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
**Files:** `servers/exarchos-mcp/src/event-store/`, the `exarchos_event` handlers
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

### Task 087: INV-11's STATE-authority claim is not enforced at the chokepoint it names
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-7
**Files:** `.exarchos/invariants.md` (INV-11), `servers/exarchos-mcp/src/index.ts`, `servers/exarchos-mcp/src/core/context.ts`, `servers/exarchos-mcp/src/capabilities/`
**Detail:** INV-11 states STATE authority is enforced "in the dispatch/MCP handler — a read-only agent cannot invoke a mutating action". Production builds the resolver as `createInMemoryResolver([])` / `createInMemoryResolver([ANTHROPIC_NATIVE_CACHING])` — a response-cache flag, not a posture — so no agent posture ever reaches the dispatch resolver. The posture→capability mapping (`posture-mapping.ts`) is well-formed and its output goes nowhere near dispatch; enforcement in practice rests on render-time tool-surface selection and the harness's own tool allowlist. The `shared-mutating` gate deletion (d6685d47c) was correct and well-argued — this is the OTHER half, which that commit's own reasoning notes ("agent postures do matter, but at RENDER time").
**Acceptance criteria:** either postures reach the dispatch resolver and a read-only caller is denied a mutating action by construction, or INV-11's text is amended to name render-time selection as the actual chokepoint. Asserting the stronger claim while the weaker one holds is the overclaim INV-11 elsewhere refuses to make. Kill fixture: a read-only posture invoking a mutating action.
**Verification:** medium — scoped tests + kill-probe at the resolved chokepoint.
**Dependencies:** none · **Parallelizable:** yes

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

## Exit condition

All eighteen merged (071-077 from the overhaul's residue, 078-088 from the review), with:
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
