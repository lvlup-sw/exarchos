```bash
● exarchos - exarchos_workflow_set (MCP)(featureId: "refactor-arch-rigor", updates:
{"worktrees":{"chain-a-guards-hsm":{"branch":"refactor/arch-rigor/chain-a-guar
ds-hsm","status":"in_progress","tasks":["1","2"]},"chain-b-tools-decomp":{"bra
nch":"refactor/arch-rigor/chain-b-tools-decomp","status":"in_progress","tasks"
:["3","4","5","6"]},"task-7-snapshot-tests":{"branch":"refactor/arch-rigor/tas
k-7-snapshot-tests","status":"in_progress","taskId":"7"}}})
⎿  Error: INVALID_INPUT: Write-time validation failed: [
{
"received": "in_progress",
"code": "invalid_enum_value",
"options": [
"active",
"merged",
"removed"
],
"path": [
… +37 lines (ctrl+o to see all)

● exarchos - exarchos_workflow_set (MCP)(featureId: "refactor-arch-rigor", updates:
{"worktrees":{"chain-a-guards-hsm":{"branch":"refactor/arch-rigor/chain-a-guar
ds-hsm","status":"active","tasks":["1","2"]},"chain-b-tools-decomp":{"branch":
"refactor/arch-rigor/chain-b-tools-decomp","status":"active","tasks":["3","4",
"5","6"]},"task-7-snapshot-tests":{"branch":"refactor/arch-rigor/task-7-snapsh
ot-tests","status":"active","taskId":"7"}}})
⎿  {
"success": true,
"data": {
… +7 lines (ctrl+o to expand)
```

