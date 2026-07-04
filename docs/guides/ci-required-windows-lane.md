# The Windows lane's required-check path (DR-5)

This repo does not list the Windows check-run as a standalone required status check in branch
protection.
Instead, the Windows lane is enforced *transitively* through the aggregate **CI Gate** check.
This note documents that path and why it is the right shape, so a future maintainer does not
"fix" it by adding a standalone required check that would block every docs-only PR.

## What enforces the Windows lane

The `test-windows` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) (check-run
name **"Windows Unit (MCP)"**) runs the MCP server's unit suite on `windows-latest`.
It does not appear in branch protection directly.
Instead, the `ci-gate` job (check-run name **"CI Gate"**) declares
`needs: [..., test-windows, ...]`, so `test-windows`'s result is visible to the aggregator's
"Evaluate results" step.
**CI Gate is the single required status check** configured in the repo's `default` ruleset.
A red Windows lane fails the `ci-gate` step, which fails CI Gate, which blocks merge — the same
path every other tier (`test-root`, `test-mcp`, `validate-no-legacy`, `grep-gates`,
`outcome-tests`) uses.

## Why not a standalone required check

`test-windows` only runs when MCP code changed:

```yaml
if: (github.event.pull_request.head.repo.full_name == github.repository || github.event_name != 'pull_request') && needs.changes.outputs.mcp == 'true'
```

If "Windows Unit (MCP)" were added directly to branch protection's required-checks list, GitHub
would wait forever for a check-run that never gets created on a docs-only PR — permanently
blocking merges that never touch MCP code.
Enforcing through the CI Gate aggregator sidesteps this: the aggregator's "skipped jobs are OK"
default already accounts for legitimate skips on non-MCP PRs, while still giving us a place to
add a targeted guard for the one case that *isn't* legitimate.

## The two guards that make "required" real

Two independent guards close the gap between "the lane exists" and "the lane actually ran and
passed whenever it should have":

1. **In-lane zero-count guard.** Inside `test-windows` itself, a zero-count guard fails the job
   if the worktree suite runs 0 tests. This catches a path-filter or matrix regression that lets
   the job execute but silently skip every test file.
2. **Aggregate skip guard (this change, DR-5).** Inside `ci-gate`'s "Evaluate results" step, a
   new check fails the aggregate if `needs.changes.outputs.mcp == 'true'` (MCP code changed) but
   `needs.test-windows.result == 'skipped'`. This catches a path-filter or matrix regression that
   drops the whole job — the one hole the aggregator's previous "skipped jobs are OK" logic left
   open.

Together: on any PR that touches MCP code, a green CI Gate is impossible unless the Windows
worktree suite actually ran and passed. On a docs-only PR, `test-windows` legitimately skips and
CI Gate stays green.

## Fallback for org-policy enforcement (documented, not applied)

If a maintainer later wants "Windows Unit (MCP)" named explicitly in branch protection (for
example, to satisfy an org policy that enumerates check names rather than trusting an
aggregator), that is possible but requires two things this change intentionally does not do:

- **Admin access** to edit the repo's `default` ruleset (ruleset id `11581356`), which carries
  `required_status_checks`, to add the check by name.
- A **companion skip-shim**: a lightweight job that always runs and reports "Windows Unit (MCP)"
  as a synthetic success when `changes.outputs.mcp != 'true'`, so non-MCP PRs are not blocked
  waiting on a check-run that never fires.

Neither is done here. The CI Gate aggregator path above delivers the same guarantee (a real
Windows failure or a real Windows skip-on-MCP-change both block merge) without the extra
maintenance surface of a synthetic shim job, so the standalone-required-check route is deferred,
not implemented.
