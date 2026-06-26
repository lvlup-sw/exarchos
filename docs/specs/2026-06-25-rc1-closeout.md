# Spec: v2.11.0 rc.1 closeout batch

**Date:** 2026-06-25 · **Feature:** `rc1-closeout` · **Depth:** standard
**Inputs:** issues #1622, #1609, #1612, #1613 · roadmap tracker #1599 (Z1/v2.11 residue) · north-star `docs/system-design.html` · DR-7 parent epic #1592

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` (added at `/plan`) maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

Four open issues are the final v2.11.0 residue to fold in before the rc.1 tag. They are heterogeneous but share one property: **none touches the Z3 consolidation surface** (`playbooks.ts`, `hsm-definitions.ts`, the gate chains that #1258/#1253 delete), so none is the churn-then-delete the roadmap's coordination rule 3 warns against. (The fifth candidate, #1616, *does* edit `playbooks.ts` and was re-homed under #1258/#1253 — out of this batch.)

1. **#1622 — `create_pr` is broken.** The action passes `--json url,number` to `gh pr create`, which has no `--json` output mode (it is valid only on `gh pr view`/`gh pr list`). `gh` exits non-zero on flag parse *before creating the PR*, so no PR is created. The same latent bug exists in the GitLab provider: `glab mr create --json url,iid` (`vcs/gitlab.ts:96`). This is a *class* of bug — "append `--json` to a write command" — not a GitHub-only symptom.
2. **#1609 — the canonical command set has three sources of truth.** `CANONICAL_COMMANDS` (`runtime/command-shim-emitter.ts`) is a third, hand-kept list that drifts from the documented SoT (`COMMAND_TO_SKILL` + `COMMAND_ONLY` in `src/config/canonical-skills.ts`, and `commands/*.md`). Current drift: `reload` is advertised but has no backing command; `discover` and `invariants` are real commands missing from the shim, so Copilot/Cursor users never see them. Nothing keeps the third list in sync.
3. **#1612 / #1613 — provider parity gap (DR-7 residue of #1592).** GitHub PR-feedback harvesting shipped contract-generic; GitLab and Azure DevOps `getPrComments` still throw `UnsupportedOperationError`. On those platforms `assess_stack` surfaces zero MR/PR comments as action items, silently degrading the ship-gate feedback loop.

Why it matters: #1622 breaks the synthesize auto-chain on every provider (field-reported from a hierophant run); #1609 mis-advertises the command surface on two first-class runtimes (an INV-4 parity defect); #1612/#1613 leave the DR-7 ship-gate feedback loop GitHub-only.

### Chosen Approach

Treat the batch as four independent, parallelizable fixes landing on one branch, one PR, behind the v2.11.0 milestone. Each is a behavior-preserving change to a non-consolidation surface:

- **#1622** — drop `--json` from the *create* invocation on both `gh pr create` and `glab mr create`; capture the PR URL from stdout (both CLIs print it on success) and derive the PR number from the URL's trailing path segment. Preserve the INV-13 two-event split (`pr.create.requested` → `pr.create.executed`) and the `PrResult {url, number}` contract (INV-5b). Azure DevOps already uses the valid global `--output json`, so it is verified, not changed.
- **#1609** — derive the canonical command *set* from the SoT instead of hand-keeping it. Keep only the shim-local `description` metadata the SoT does not carry; assert via a coupling guard that the description-map keys equal the canonical command set (union of `COMMAND_TO_SKILL` keys, `COMMAND_ONLY`, and `commands/*.md`). This removes the third list (its names now come from the SoT) and locks any future add/retire with a CI failure until all sources agree. Reconcile the existing drift (`-reload`, `+discover`, `+invariants`) as a consequence.
- **#1612 / #1613** — implement each provider's `getPrComments` to full GitHub parity against the platform-neutral `PrComment` contract: aggregate the platform's comment surfaces, thread-aware via one-level `parentId`, map native resolution to tri-state `resolved` (absent when unknown — never coerced to false), no platform field names leaking. Replace the `*_ThrowsUnsupported` conformance tests with harvesting suites mirroring the GitHub tests. The consumer `assess_stack` harvest loop stays branch-free (INV-6).

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: `create_pr` succeeds without `--json` on the create command, across providers

The `create_pr` path must not pass `--json` to `gh pr create` or `glab mr create`. It captures the created PR's URL from stdout and returns the `PrResult {url, number}` carrier, with `number` derived from the URL's trailing numeric path segment. The fix lands in the provider layer (`vcs/github.ts`, `vcs/gitlab.ts`); if the orchestrate handler (`orchestrate/vcs/create-pr.ts`) duplicates the arg-building, it is deduped so behavior lives in one place (INV-2). Azure DevOps's existing `--output json` is confirmed valid and left unchanged.

**Acceptance criteria:**
- Given a GitHub repo, When `create_pr` runs, Then the spawned argv contains no `--json` token and a PR is created; the returned `{url, number}` matches the created PR.
- Given a GitLab repo, When `create_pr` runs, Then `glab mr create` is invoked without `--json` and `{url, number}` (number = MR iid) is returned from stdout.
- The INV-13 two-event split is preserved: `*.requested` is emitted before the side effect and `*.executed` after; a retry idempotency-collapses the requested event (INV-8) and creates at most one PR.
- A regression test asserts the absence of `--json` in the create argv for GitHub and GitLab (locks the class of bug).

#### DR-2: one source of truth for the canonical command set in the runtime shim

`CANONICAL_COMMANDS` no longer independently enumerates command names; the authoritative set is derived from the canonical SoT. Shim-local metadata (`description`) is retained, but a coupling guard asserts its key set equals the canonical command set. The current drift is reconciled.

**Acceptance criteria:**
- The emitted shim advertises exactly the canonical command set: `reload` removed (no backing `commands/reload.md`), `discover` and `invariants` present.
- A guard test fails when an entry is added to the description map that is not a canonical command, or when a canonical command lacks shim metadata (verified by a deliberately-drifted fixture failing and the reconciled tree passing).
- No third hand-maintained name list remains; names flow from `COMMAND_TO_SKILL` ∪ `COMMAND_ONLY` ∪ `commands/*.md`.
- INV-4: the shim emits the same reconciled set for every runtime that consumes it (Copilot/Cursor).

#### DR-3: GitLab `getPrComments` conforms to the platform-neutral `PrComment` contract

`GitLabProvider.getPrComments` harvests MR notes and discussion threads and maps them onto `PrComment`: notes → `source: 'issue-comment'`, per-line diff notes → `source: 'review-inline'` with `path`/`line`; threaded replies → one-level `parentId`; GitLab discussion `resolved` → tri-state `resolved` (absent when unknown). No GitLab field names leak into the contract.

**Acceptance criteria:**
- `getPrComments` returns aggregated, thread-aware `PrComment[]`; the `GitLab_GetPrComments_ThrowsUnsupported` test is replaced with harvesting tests mirroring `github.test.ts`.
- A resolved GitLab discussion yields `resolved: true`; an open one `resolved: false`; an indeterminate one omits `resolved`.
- `assess_stack` surfaces GitLab MR comments as `comment-reply` action items with no change to its harvest loop (INV-6).

#### DR-4: Azure DevOps `getPrComments` conforms to the platform-neutral `PrComment` contract

`AzureDevOpsProvider.getPrComments` harvests PR comment threads and maps them onto `PrComment`: threads → `source: 'issue-comment'` or `'review-inline'` (file/line-anchored threads carry `path`/`line`); replies → one-level `parentId`; thread status (`active`/`fixed`/`closed`) → tri-state `resolved` (fixed/closed → `true`, active → `false`, unknown → absent). No Azure field names leak.

**Acceptance criteria:**
- `getPrComments` returns aggregated, thread-aware `PrComment[]`; the `AzureDevOps_GetPrComments_ThrowsUnsupported` test is replaced with harvesting tests mirroring `github.test.ts`.
- Thread status maps to the correct tri-state `resolved` per the rule above.
- `assess_stack` surfaces ADO PR comments as `comment-reply` action items with no change to its harvest loop (INV-6).

#### DR-5: provider side effects degrade fail-soft, never throwing into the workflow loop (error handling)

External-provider failures in this batch surface as recoverable, contract-preserving outcomes rather than exceptions that abort a phase.

**Acceptance criteria:**
- **Resolution enrichment (DR-3/DR-4):** if the platform's resolution surface (GitLab discussion state / ADO thread status) is unavailable or unparseable, affected comments leave `resolved` **absent** (unknown), never coerced to `false` — mirroring GitHub's fail-soft GraphQL enrichment. The base comment harvest still returns.
- **PR-number derivation (DR-1):** if the URL's trailing segment cannot be parsed to a number, the path falls back to `gh pr view <url> --json number` (GitHub) / `glab mr view <url> --json iid` (GitLab) rather than throwing; the `{url}` is always returned.
- A unit test exercises each degraded branch and asserts the contract (no throw; `resolved` absent on enrichment failure; URL returned on parse failure).

### Technical Design

The change set is confined to the VCS adapter layer and the runtime shim emitter — no event-store, projection, HSM, or gate-chain edits, so the roadmap's SDK-lowering discipline (coordination rule 3) does not bind this batch.

- **DR-1 (create_pr).** In `vcs/github.ts` and `vcs/gitlab.ts`, remove the `--json`/value pair from the create argv and replace `JSON.parse(output)` with: `url = output.trim().split(/\r?\n/).pop()`; `number = Number(url.match(/\/(\d+)\/?$/)?.[1])`. Keep `draft`/`labels` handling. Confirm whether `orchestrate/vcs/create-pr.ts` re-builds the argv or delegates to `provider.createPr` — if it re-builds, collapse to the provider (INV-2). The two-event split and idempotency key are unchanged.
- **DR-2 (shim SoT).** In `command-shim-emitter.ts`, replace the literal `CANONICAL_COMMANDS` name list with a derivation from the canonical set exported by `canonical-skills.ts` (extend that module with a `canonicalCommandSet()` accessor if one is not already exposed), joined to a shim-local `COMMAND_DESCRIPTIONS: Record<command, string>`. Add a coupling guard in the emitter's test (and/or `canonical-skills.test.ts`) asserting `keys(COMMAND_DESCRIPTIONS) === canonicalCommandSet()`. The per-runtime `skill` field continues to render as `exarchos:<name>`.
- **DR-3/DR-4 (getPrComments).** Mirror `github.getPrComments` structure: a per-surface fetch (GitLab discussions/notes via `glab`/REST; ADO threads via `az repos pr` / ADO REST), a normalizer to `PrComment`, and a fail-soft resolution mapping. Reuse the existing async `exec` in `vcs/shell.ts` (the same path the providers already use for `createPr`/`getReviewStatus`). No change to `provider.ts` (the `PrComment` contract already exists) and none to `assess_stack`.

### Integration Points

- `servers/exarchos-mcp/src/vcs/github.ts` — `createPr` (drop `--json`, stdout URL + number-from-URL).
- `servers/exarchos-mcp/src/vcs/gitlab.ts` — `createPr` (same fix); `getPrComments` (new impl, DR-3).
- `servers/exarchos-mcp/src/vcs/azure-devops.ts` — `createPr` (verify `--output json` valid, no change expected); `getPrComments` (new impl, DR-4).
- `servers/exarchos-mcp/src/orchestrate/vcs/create-pr.ts` — dedupe if it duplicates provider argv (INV-2).
- `servers/exarchos-mcp/src/runtime/command-shim-emitter.ts` — derive `CANONICAL_COMMANDS` from SoT + guard (DR-2).
- `src/config/canonical-skills.ts` — SoT; add a `canonicalCommandSet()` accessor if needed (read source otherwise).
- Tests: `vcs/{github,gitlab,azure-devops}.test.ts`, `orchestrate/vcs/create-pr.test.ts`, `runtime/command-shim-emitter` test, `src/config/canonical-skills.test.ts`.

### Alternatives considered

- **DR-1 — keep `--json`, call `gh pr view` after a flagless create.** Rejected: an extra round-trip per create; deriving `number` from the returned URL is simpler and provider-uniform (`gh pr view` is retained only as the DR-5 fallback).
- **DR-2 — add only a coupling guard, keep the hand-kept list.** Rejected: leaves the third source of truth in place and merely alarms on drift — a local patch, not the structural fix. Deriving the set removes the class.
- **DR-2 — derive `description` too (from command frontmatter).** Rejected for now: descriptions are not uniformly present in `commands/*.md` frontmatter; over-reach. The guard on a shim-local description map is sufficient.
- **DR-3/DR-4 — minimal harvest (top-level comments only, no threading/resolution).** Rejected: breaks parity with the GitHub reference; `assess_stack` would surface already-resolved comments as action items and lose reply threading.

### Open Questions

- **INV-2 duplication (DR-1):** does `orchestrate/vcs/create-pr.ts` re-build the create argv, or delegate to `provider.createPr`? Resolve at `/plan` via symbol inspection; if duplicated, the fix is one task that touches both and a parity assertion.
- **Windows `az` shim (DR-4):** new Azure DevOps `getPrComments` invokes `az`, which is `az.cmd` on win32 — the #1623 class of `.cmd`-shim spawn bug. Existing `az repos pr` calls already go through the async `exec` in `vcs/shell.ts` with the same exposure, so this batch stays consistent with the current path; flag for a separate Windows-portability follow-up rather than widening scope here.
- **Live-CI coverage (DR-3/DR-4):** there is no live GitLab/ADO CI; tests are mocked-CLI suites mirroring the GitHub provider tests (the existing provider test harnesses already mock `exec`). Acceptable — same coverage posture as the shipped GitHub harvester.
