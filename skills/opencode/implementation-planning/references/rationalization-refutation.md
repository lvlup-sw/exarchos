# Rationalization Refutation — Implementation Planning

Common rationalizations that undermine planning rigor, with counter-arguments and correct actions.

| Rationalization | Counter-argument | What to do instead |
|-----------------|------------------|--------------------|
| "The design is clear enough to skip planning" | Designs describe *what* to build, not the sequence, dependencies, or test strategy. Skipping planning leads to ad-hoc implementation, missed edge cases, and rework. | Run `/exarchos:plan` to decompose the design into granular TDD tasks with explicit dependencies and parallel groups. |
| "Tests are implied by the implementation" | Implied tests are never written. The Iron Law exists because every "implied" test is a missing safety net that lets regressions ship. | Write each test explicitly in the plan: name, file path, method under test, expected failure reason. |
| "Small change doesn't need tests" | Small changes break things too — especially boundary conditions and integration points. The change's size does not determine its risk. | Plan a test for every behavioral change, regardless of size. Use the task template's TDD section. |
| "I'll add tests after the implementation" | Post-hoc tests validate what you built, not what you should have built. They miss edge cases the implementation accidentally handles and confirm bugs as features. | Plan tests first (RED step). Each task starts with a failing test that defines the expected behavior before any production code. |
| "This is just a refactor, no tests needed" | Refactors change structure, and structural changes can alter behavior in subtle ways. Without tests, you cannot prove the refactor preserved semantics. | Ensure existing tests cover the code being refactored. If coverage gaps exist, plan tests to fill them before the refactor task. |
| "We can plan as we go" | Incremental planning without upfront decomposition hides dependency conflicts, prevents parallelization, and makes progress invisible. | Complete the full planning process: analyze design, decompose tasks, identify dependencies, then delegate. |
| "The task is too simple to decompose further" | Tasks that feel "simple" often contain hidden subtasks (error handling, validation, edge cases). Undecomposed tasks balloon during implementation. | Apply the 2-5 minute granularity rule. If a task takes longer than 5 minutes, it needs further decomposition. |
