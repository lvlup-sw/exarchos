# Rationalization Refutation — Implementation Planning

Common rationalizations that undermine planning rigor, with counter-arguments and correct actions.

| Rationalization | Counter-argument | What to do instead |
|-----------------|------------------|--------------------|
| "The design is clear enough to skip planning" | Designs describe *what* to build, not the sequence, dependencies, or test strategy. Skipping planning leads to ad-hoc implementation, missed edge cases, and rework. | Run `/exarchos:plan` to decompose the design into granular TDD tasks with explicit dependencies and parallel groups. |
| "Tests are implied by the implementation" | Implied tests are never written — and for a medium/high-tier task that is a missing safety net that lets regressions ship. | Write each medium/high-tier test explicitly in the plan: name, file path, method under test. |
| "Small change doesn't need tests" | The change's size does not determine its risk — its blast radius does. A high-blast "small" change still needs tests; a genuinely low-tier edit (docs/config/rename) legitimately does not. | Stamp the task's `riskTier` and let the ladder decide. Use the task template's tier-scaled Verification section. |
| "I'll add tests after the implementation" | Test-AFTER is fine (#1587) — the ordering ceremony is not the point. What is not fine is skipping the tests, or writing vacuous ones that pass against any implementation. | Plan the tests the tier requires; the `check_test_adequacy` kill-probe reverts your source and demands at least one test actually fails — so "after" must still be adequate. |
| "This is just a refactor, no tests needed" | Refactors change structure, and structural changes can alter behavior in subtle ways. Without tests, you cannot prove the refactor preserved semantics. | Ensure existing tests cover the code being refactored. If coverage gaps exist, plan tests to fill them before the refactor task. |
| "We can plan as we go" | Incremental planning without upfront decomposition hides dependency conflicts, prevents parallelization, and makes progress invisible. | Complete the full planning process: analyze design, decompose tasks, identify dependencies, then delegate. |
| "The task is too simple to decompose further" | Tasks that feel "simple" often contain hidden subtasks (error handling, validation, edge cases). Undecomposed tasks balloon during implementation. | Apply the 2-5 minute granularity rule. If a task takes longer than 5 minutes, it needs further decomposition. |
