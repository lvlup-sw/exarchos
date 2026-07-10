# Does the verification pipeline improve generated-code quality? (empirical, #1636)

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

Two self-contained tasks, each with a spec + stub shown to the agent and a
**hidden oracle** (a comprehensive edge-case suite the agent never sees), used
only at grade time:

| task | tier | why it's a good probe |
|---|---|---|
| `TokenBucket` | high · boundary | injected-clock seam; lazy proportional refill, cap, all-or-nothing consume, no-partial-on-failure, fractional accrual across reads |
| `parseDuration` | medium | the `ms`-vs-`m` trap, multi-segment sums, strict rejection of malformed input |

2 replicates per (task, arm) = **8 live agent runs**. Graded on: hidden-oracle
pass rate (correctness / spec-conformance), strict `tsc` (type errors), and
whether the agent produced durable tests (behavioral). See `RESULTS.md` /
`results.json`; produced code is under `runs/`.

## Results

| task | arm | mean oracle pass rate | typecheck ok | durable tests |
|---|---|---|---|---|
| parse-duration | E | **100%** | 2/2 | **2/2** |
| parse-duration | N | **100%** | 2/2 | 0/2 |
| token-bucket | E | **100%** | 2/2 | **2/2** |
| token-bucket | N | **100%** | 2/2 | 0/2 |

Two clear signals:

1. **Correctness: no delta.** Every run — both arms, both tasks — passed 100% of
   the hidden oracle and typechecked clean. On well-specified tasks, a strong
   model (opus) produced fully correct code *with or without* the verification
   steer. The edge cases these tasks turn on (the `ms`/`m` distinction,
   no-partial-consume, fractional refill) were handled unprompted.

2. **Process: a large, consistent delta.** Every Arm-E run produced a **durable
   test file** and ran an explicit **kill-probe / mutation check** (from the agent
   reports: *"all 27 tests fail against a constant-42 stub"*, *"an always-true
   mutant fails 23 of them"*). No Arm-N run left a durable test behind; where N
   agents tested at all it was ephemeral scratch they deleted. 4/4 vs 0/4.

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

## Limitations (this is a pilot, read it as directional)

- **n is small:** 2 tasks × 2 arms × 2 replicates. Not statistically powered.
- **Correctness ceiling:** both tasks were well-specified enough that N scored
  100%, so they cannot *discriminate* on correctness — a 100/100 tie is consistent
  with "no effect" AND with "tasks too easy." The informative next step is
  **under-specified / adversarial tasks** (ambiguous specs, non-obvious edge cases,
  hostile inputs) where a hasty impl plausibly misses cases the "cover the edge
  cases" steer would catch — that is the condition under which a correctness delta,
  if it exists, would appear.
- **Single model (opus).** A weaker/cheaper model may depend on the steer more —
  worth a model-crossed run, which also directly tests the Phase-0 model-routing
  question (does haiku-on-scaffolding hold quality?).
- The kill-probe was *self-reported* by the E agents, not independently run by the
  grader. A stronger harness would run the diff-scoped mutation gate on each impl.

## Reproduce

```bash
# 1. set up run dirs (SPEC.md + stub) outside the repo, dispatch agents per arm
# 2. grade the produced impls against the hidden oracles:
tsx docs/evals/quality-ab/grade.ts <runsBaseDir>
```
