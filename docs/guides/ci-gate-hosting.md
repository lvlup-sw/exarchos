# CI gate hosting: the host-taxonomy decision table (DR-1)

This is the single canonical prose location for the CI gate-host taxonomy.
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) and every gate wired against this convention cite this document by name — they do not restate the table.
If you are adding a new CI gate (a grep or plain-node script, a coverage or mutation check, a lint pass), start here to pick its host before writing any workflow YAML.

## The four host classes

Every gate in `ci.yml` lives in exactly one of four host classes.
A gate's placement is correct only if its row applies — see [the two-surface subset rule](#the-two-surface-subset-rule) below for the row that most often gets this wrong.

| Host class | Existing host | Filter | Deps | For gates whose… |
|---|---|---|---|---|
| Zero-dep prefix, unfiltered | `grep-gates` (early steps) | none | none | check is a self-contained script (grep/node, no install) |
| Deps tail, unfiltered | `grep-gates` (tsx tail — installs BOTH dep trees at `ci.yml:620-625`) | none | root + MCP `npm ci` | check needs `tsx` over repo source AND scans surfaces broader than any filter |
| Deps, unfiltered, suite-shaped | `outcome-tests` | none | root + MCP `npm ci` + binary build | outcome-tier suites, not lint-shaped gates — job identity stays single-purpose |
| Deps, filtered | `test-root` / `test-mcp` | `root` / `mcp` | per-job | scan surface AND implementation surface are both subsets of the host's filter |

## The two-surface subset rule

A gate may live in a filtered job (`test-root` or `test-mcp`) only when BOTH of the following hold.

- Its **scan surface** — the files it reads or checks — is a subset of that job's path filter.
- Its **implementation surface** — the source of the check script itself, and of any tests exercising it — is also a subset of that job's path filter.

If either surface is not a subset of the filter, the gate does not belong in that filtered job.
It goes to one of the two unfiltered `grep-gates` regions instead, or to `outcome-tests` if it is itself an outcome-tier suite rather than a lint-shaped gate.
The failure mode this rule closes: a gate hosted in a filtered job whose own implementation lives outside that filter can be weakened by a PR the filter never arms, and `test-root`/`test-mcp` will skip-as-passed on exactly that PR — the gate stops governing without any CI signal saying so.

## `grep-gates` has two identities — never call it "zero-dependency"

`grep-gates` is not one uniform host.
It has an early **zero-dep prefix** (grep and plain-node scripts, no `npm ci`, no path filter) followed by a **deps tail** that installs both the root and `servers/exarchos-mcp` dependency trees (`ci.yml:620-625`) so its `tsx`-backed steps can shell out over the MCP TypeScript source.
The job's own inline NOTE (`ci.yml:605-608`) states this explicitly: the design's "grep-gates are root-only / zero-dependency" framing is inaccurate for the job as a whole.
No documentation anywhere — including this guide — should assert that `grep-gates` runs zero-dependency, or that it is path-filtered, as a whole job.
When citing a host-class row at a gate's wiring site, name the specific region (**zero-dep prefix** or **deps tail**), not just "grep-gates."

## The non-blocking allowlist contract

`ci-gate`'s `needs:` list is the source of truth for which jobs are blocking.
Any top-level job NOT in `ci-gate.needs` must appear in the non-blocking allowlist inside the conformance test `scripts/ci-topology.test.ts`, which parses `ci.yml` and asserts aggregator completeness.
The allowlist lives in the test file itself, not a separate config, so that a PR adding a new non-blocking job carries its allowlist entry in the same diff as the job — nothing can rot silently in a config nobody reviews alongside the workflow change.
Each allowlist entry MUST carry:

- a rationale string explaining why the job is intentionally non-blocking, and
- where applicable, a tracking-issue reference (for example, a flake class or a scoped follow-up), so the non-blocking disposition has an owner and an exit condition rather than a permanent, unexamined exemption.

## Out of scope: `pr-body-check.yml`

`pr-body-check.yml` is a separate workflow, not a job inside `ci.yml`.
It enforces PR description structure as a branch-protection concern, independent of the `ci-gate` aggregator this document governs.
Nothing in the host taxonomy above applies to it, and it does not participate in the `ci-gate.needs` completeness contract.

## Follow-up: the residual scripts-filter hole

The `root` path filter excludes `scripts/**`, so `test-root`'s execution of `scripts/**/*.test.ts` skips-as-passed on a scripts-only PR — an implementation-surface hole for any pre-existing scripts-hosted root-suite test that is NOT itself hosted unfiltered.
Widening the `root` filter to include `scripts/**` was considered and rejected: `changes.outputs.root` also arms `test-windows-root`, a chronically flaky Windows lane never proven green on `main` (#1699), and the existing `ci-gate` evaluate guard makes that lane required-not-skippable once `root == true` — every scripts-only PR would inherit a known-flaky blocking lane in exchange for closing a narrower coverage gap.
A follow-up issue tracking this residual hole, carrying the Windows-lane (#1699) constraint as the reason a filter-widening fix was not simply applied, is filed and cited from here.

**Follow-up issue pointer (filled in by the task that files it):** `<follow-up issue: TBD — filed against the scripts-filter hole above, carries the #1699 Windows-lane constraint>`
