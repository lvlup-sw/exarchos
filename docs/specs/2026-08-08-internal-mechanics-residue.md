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

## Decomposition

Ordering below is by **risk and exposure**, not dependency — all six are independently dispatchable.

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

## Exit condition

All six merged, with:
- root suite green and MCP at the known-red merge-orchestrate + `store.race` baseline, member-for-member;
- `npm run validate` 9/9 and `validate-no-legacy` at 0 unallowlisted;
- every kill fixture above demonstrated by mutation, not by a green suite;
- 075's migration note landed in `docs/`;
- the DR-14 cast floor re-baselined in the open if any task moves it.
