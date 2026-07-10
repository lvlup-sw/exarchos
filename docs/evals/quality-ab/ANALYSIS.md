# Does the verification pipeline improve generated-code quality? (empirical, #1636)

> ⚠️ **Partly superseded by [#1670](../2026-07-09-1670-delegation-pipeline-empirical.md) — the process-delta claim does NOT survive.**
> What holds: the **correctness null**, now extended to *under-specified* tasks (E = N on
> the hidden oracle even when edge cases must be discovered). What FAILS: the **process
> delta** below (durable tests, "7/7 vs 0/7"). That gap was an artifact of prompt
> asymmetry — only the E arm was asked to write a test. #1670 re-ran with **symmetric
> prompts** (both arms asked to implement AND test, only the steer's content varying) and
> mechanical mutation grading: both arms wrote tests **12/12** and both were mutation-
> adequate **12/12**. So the verification steer's *content* shows no measured benefit on
> this corpus once "was asked to test" is held constant. Read the "process delta" section
> below as **refuted**, not confirmed. Model selection (Exp 2) is deferred — see #1670.

Companion to the deterministic corpus benchmark (`../2026-07-09-1636-plan-format-corpus.md`).
This is the **live A/B** that the deterministic arm cannot speak to: it actually
generates code under two regimes and measures the result.

## Design

Same task, same environment, same model. The **only** variable is the
verification regime the agent is dispatched under:

- **Arm E (exarchos):** the verbatim production `renderImplementerPrompt`
  tier-selected verification note — "cover the behavior with focused tests that
  can actually fail; kill-probe mindset; (high tier) exercise the seam; (boundary)
  hermetic fixtures."
- **Arm N (native):** no verification steer — "implement it."

Three self-contained tasks, each with a spec + stub shown to the agent and a
**hidden oracle** (a comprehensive edge-case suite the agent never sees, each
validated against a correct reference), used only at grade time:

| task | tier | model | why it's a good probe |
|---|---|---|---|
| `TokenBucket` | high · boundary | opus | injected-clock seam; lazy proportional refill, cap, all-or-nothing consume, no-partial-on-failure, fractional accrual across reads |
| `parseDuration` | medium | opus | the `ms`-vs-`m` trap, multi-segment sums, strict rejection of malformed input |
| `csvParseLine` | high · boundary | **sonnet** | RFC-4180 quoting/escaping traps (commas-in-quotes, `""` escaping, junk-after-quote errors); a *discriminating* round — a harder task on a **weaker model**, the condition under which a verification-correctness delta should appear if one exists |

**14 live agent runs** total (2–3 replicates per task×arm). Graded on: hidden-oracle
pass rate (correctness / spec-conformance), strict `tsc` (type errors, `es2022`
lib), and whether the agent produced durable tests (behavioral). See `RESULTS.md`
/ `results.json`; produced code is under `runs/`.

## Results

| task | model | arm | mean oracle pass rate | typecheck ok | durable tests |
|---|---|---|---|---|---|
| token-bucket | opus | E | **100%** | 2/2 | **2/2** |
| token-bucket | opus | N | **100%** | 2/2 | 0/2 |
| parse-duration | opus | E | **100%** | 2/2 | **2/2** |
| parse-duration | opus | N | **100%** | 2/2 | 0/2 |
| csv-line | sonnet | E | **100%** | 3/3 | **3/3** |
| csv-line | sonnet | N | **100%** | 3/3 | 0/3 |

Two clear signals, robust across **2 models × 3 tasks × 14 runs**:

1. **Correctness: no delta.** Every run — both arms, all three tasks — passed 100%
   of the hidden oracle and typechecked clean. This holds even in the
   *discriminating* round: the weaker model (sonnet) on the trickiest task
   (CSV quoting/escaping) still produced fully correct code in **both** arms. The
   traps these tasks turn on (the `ms`/`m` distinction, no-partial-consume,
   fractional refill, commas-inside-quotes, `""` escaping, junk-after-quote) were
   handled unprompted — every Arm-N agent wrote a proper single-pass parser, not
   the naive `split(',')` failure mode.

2. **Process: a large, consistent delta.** Every Arm-E run (7/7) produced a
   **durable test file** and ran an explicit **kill-probe / mutation check** (from
   the agent reports: *"all 27 tests fail against a constant-42 stub"*, *"an
   always-true mutant fails 23 of them"*, *"three explicit kill-probes asserting
   the output is not the naive/stub result"*). No Arm-N run (0/7) left a durable
   test behind; where N agents tested at all it was ephemeral scratch they
   deleted. **7/7 vs 0/7.**

## Interpretation — where the pipeline's value actually is (and isn't)

The verification pipeline is **not** what makes a capable model *correct on a
well-specified task* — that null is robust here. Its measurable effect is on
**process durability**: it reliably converts a throwaray one-shot into durable
regression tests plus an adversarial self-check. That value accrues over time (a
covered contract that catches the *next* change), not in the one-shot correctness
of the initial implementation.

This lines up with the deterministic arm's findings on the *other* dimensions:

- **Model selection** (Phase 0): exarchos routes 99/100 corpus tasks to the same
  `implementer/opus` a native flat run would use — ≈0 differentiation, and the one
  downgrade was miscalibrated (a high-tier task sent to cheap haiku). No evidence
  it helps.
- **Verification depth** (Phase 0): the value is real but *latent* — pre-#1636 the
  plan's tier never reached dispatch, so 45/100 tasks shipped under-provisioned.
  The fix makes the depth actually track the plan; this A/B shows what that depth
  buys (durable tests + kill-probe), which is regression protection, not one-shot
  correctness.

**Bottom line:** on this evidence the pipeline earns its keep as a *durable-test /
regression-protection* mechanism, not as a one-shot correctness or model-cost
optimizer. The theoretical basis (tier-scaled verification) holds in the sense
that E agents did more/deeper verification; the practical payoff shows up as test
durability, and did not (here) change whether the code was right the first time.

## Limitations & what the null does / doesn't establish

- **n is small:** 14 runs, 2–3 replicates per cell. Directional, not statistically
  powered — but the correctness result is a *unanimous* 14/14, not a narrow margin.
- **Two candidate explanations for the correctness null were tested and rejected:**
  "tasks too easy" (the CSV round is a genuinely trap-laden parser) and "model too
  strong" (sonnet is materially weaker than opus). Both still tied at 100/100. So
  the null is not simply an artifact of easy tasks or a strong model.
- **Spec COMPLETENESS — the untested discriminator — is now probed ([#1670](../2026-07-09-1670-delegation-pipeline-empirical.md) · Exp 3).**
  All three specs here *fully enumerate* their edge cases, so both arms only had to
  *implement to spec* — a competent model does that without a steer. #1670 re-ran the
  A/B on **under-specified** variants (edge cases stripped, oracle unchanged) on opus +
  sonnet, the condition under which a correctness delta *should* appear if one exists.
  It did not: E and N tie on the oracle even when the corners must be discovered — a
  **clean null** — and, under symmetric prompts, they also tie on test adequacy (see the
  next bullet), so no steer benefit survives on either axis for this corpus.
- **The self-reported kill-probe is now run mechanically — and it REFUTES the process delta ([#1670](../2026-07-09-1670-delegation-pipeline-empirical.md) · Exp 3).**
  #1670's grader runs the diff-scoped mutation gate on each produced impl. Under the
  corrected **symmetric** design (both arms asked to test), both arms score **12/12**
  mutation-adequate — the "7/7 vs 0/7 durable-test" gap here was the prompt asymmetry
  (only E was asked to test), not the steer's content. The steer shows no measured
  test-adequacy benefit on this corpus.
- **Durable-tests is a proxy** for "the pipeline's verification actually happened":
  N agents did test (ephemerally) but discarded it, so the metric captures
  *durable coverage left behind*, which is the thing with regression value — but it
  under-counts N's transient testing.

## Reproduce

```bash
# 1. set up run dirs (SPEC.md + stub) outside the repo, dispatch agents per arm
# 2. grade the produced impls against the hidden oracles:
tsx docs/evals/quality-ab/grade.ts <runsBaseDir>
```
