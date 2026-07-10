# Quality A/B — pilot results (#1636 Phase 2)

Same task, same env, same model. The only variable is the verification regime: **E** = the production `renderImplementerPrompt` tier-selected verification note; **N** = none (bare "implement it"). `impl.ts` graded against a HIDDEN oracle the agent never saw, plus strict `tsc`.

## Per-run

| run | oracle | typecheck | wrote tests | key failures |
|---|---|---|---|---|
| parse-duration__E__r1 | 21/21 | ✓ | ✓ |  |
| parse-duration__E__r2 | 21/21 | ✓ | ✓ |  |
| parse-duration__N__r1 | 21/21 | ✓ | ✗ |  |
| parse-duration__N__r2 | 21/21 | ✓ | ✗ |  |
| token-bucket__E__r1 | 9/9 | ✓ | ✓ |  |
| token-bucket__E__r2 | 9/9 | ✓ | ✓ |  |
| token-bucket__N__r1 | 9/9 | ✓ | ✗ |  |
| token-bucket__N__r2 | 9/9 | ✓ | ✗ |  |

## Aggregate (task × arm)

| task | arm | runs | mean oracle pass rate | typecheck ok | wrote tests |
|---|---|---|---|---|---|
| parse-duration | E | 2 | 100% | 2/2 | 2/2 |
| parse-duration | N | 2 | 100% | 2/2 | 0/2 |
| token-bucket | E | 2 | 100% | 2/2 | 2/2 |
| token-bucket | N | 2 | 100% | 2/2 | 0/2 |
