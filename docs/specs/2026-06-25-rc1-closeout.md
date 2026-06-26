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

- **#1622** — drop `--json` from the *create* invocation on both `gh pr create` and `glab mr create`; capture the PR URL from the command's output and derive the PR number from the URL's trailing path segment. Preserve the INV-13 two-event split (`pr.create.requested` → `pr.create.executed`) and the `PrResult {url, number}` contract (INV-5b). Azure DevOps already uses the valid global `--output json`, so it is verified, not changed.
- **#1609** — collapse the shim's three drifting command lists into one shim-local `COMMAND_DESCRIPTIONS` map (key = name, `skill` derived as `exarchos:<name>`), and add a **test-only** coupling guard that imports the root SoT across the package boundary and fails CI if the map's keys ≠ the canonical command set (union of `COMMAND_TO_SKILL` keys, `COMMAND_ONLY`, and `commands/*.md`). Pure prod-side derivation is impossible because the MCP-server `rootDir: ./src` boundary forbids importing the root SoT in production code (resolution below); the guard is the bounded structural fix — one map, made authoritative by a CI gate. Reconcile the existing drift (`-reload`, `+discover`, `+invariants`) as a consequence.
- **#1612 / #1613** — implement each provider's `getPrComments` to full GitHub parity against the platform-neutral `PrComment` contract: aggregate the platform's comment surfaces, thread-aware via one-level `parentId`, map native resolution to tri-state `resolved` (absent when unknown — never coerced to false), no platform field names leaking. Replace the `*_ThrowsUnsupported` conformance tests with harvesting suites mirroring the GitHub tests.
  - **DR-3/DR-4 end-to-end enablement (surfaced by plan-review).** `getPrComments` alone is insufficient: `handleAssessStack` (`assess-stack.ts:494`) calls `requiresGitHub(provider, 'assess_stack')`, which returns `{skipped:true}` for an explicitly-injected non-GitHub provider before the harvest runs. Since `assess_stack`'s required provider methods are now supported for GitLab/ADO (`checkCi` ✓, `getReviewStatus` ✓, `getPrComments` ← this batch) and its only other call, `listPrs` via `queryPrMergeState`, is already fail-soft (try/catch → `null`), the gate is **narrowed for `assess_stack` only** so GitLab/ADO proceed. INV-6 is read precisely: the *harvest loop* (`queryPrComments`) carries no provider branch; the handler-level `requiresGitHub` posture gate is the thing being narrowed. `check_pr_comments` and `validate_pr_stack` stay GitHub-gated — they need `getRepository`/`listPrs` (both still throw for GitLab/ADO); enabling those is **out of scope** (tracked as a follow-up under the DR-7 parent #1592).

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: `create_pr` succeeds without `--json` on the create command, across providers

The `create_pr` path must not pass `--json` to `gh pr create` or `glab mr create`. It captures the created PR's URL from stdout and returns the `PrResult {url, number}` carrier, with `number` derived from the URL's trailing numeric path segment. The fix lands in the provider layer (`vcs/github.ts`, `vcs/gitlab.ts`); if the orchestrate handler (`orchestrate/vcs/create-pr.ts`) duplicates the arg-building, it is deduped so behavior lives in one place (INV-2). Azure DevOps's existing `--output json` is confirmed valid and left unchanged.

**Acceptance criteria:**
- Given a GitHub repo, When `create_pr` runs, Then the spawned argv contains no `--json` token and a PR is created; the returned `{url, number}` matches the created PR.
- Given a GitLab repo, When `create_pr` runs, Then `glab mr create` is invoked without `--json` and `{url, number}` (number = MR iid) is parsed from the command output (the MR-URL pattern, scanned from combined stdout+stderr to be robust to which stream `glab` uses).
- The INV-13 two-event split is preserved: `*.requested` before the side effect, `*.executed` after; a retry idempotency-collapses the requested event (INV-8) and creates at most one PR. This is a *preservation* criterion — `handleCreatePr` is unchanged (the fix is provider-only), so it is covered by the existing untouched `orchestrate/vcs/create-pr.test.ts` two-event-split tests; no new test is required for it.
- A regression test asserts the absence of `--json` in the create argv for GitHub and GitLab (locks the class of bug).

#### DR-2: one source of truth for the canonical command set in the runtime shim

The shim collapses to a **single** shim-local map (`COMMAND_DESCRIPTIONS`, keyed by command name) — the redundant parallel `{name, skill, description}` array is gone; `name` is the map key and `skill` derives as `exarchos:<name>`. Because the MCP-server package boundary (`rootDir: ./src`) precludes importing the root SoT in *production* code (see the planning resolution below), the map's *names* cannot be derived from the SoT at build time; instead a **test-only coupling guard** imports the SoT across the boundary and asserts the map's keys equal the canonical command set, so any drift fails CI. This is the bounded structural improvement available under the package boundary: one map instead of three lists, with the SoT made authoritative by a CI gate — not the prod-side derivation the boundary forbids. The current drift is reconciled.

**Acceptance criteria:**
- The emitted shim advertises exactly the canonical command set: `reload` removed (no backing `commands/reload.md`), `discover` and `invariants` present.
- A guard test fails when an entry is added to `COMMAND_DESCRIPTIONS` that is not a canonical command, or when a canonical command lacks shim metadata (verified by a deliberately-drifted fixture failing and the reconciled tree passing).
- The shim keeps exactly one hand-maintained command surface (`COMMAND_DESCRIPTIONS`), reduced from the prior three-list drift; the canonical set (`COMMAND_TO_SKILL` ∪ `COMMAND_ONLY` ∪ `commands/*.md`) is the authority the guard enforces.
- INV-4: the shim emits the same reconciled set for every runtime that consumes it (Copilot/Cursor).

#### DR-3: GitLab `getPrComments` conforms to the platform-neutral `PrComment` contract

`GitLabProvider.getPrComments` harvests MR notes and discussion threads and maps them onto `PrComment`: notes → `source: 'issue-comment'`, per-line diff notes → `source: 'review-inline'` with `path`/`line`; threaded replies → one-level `parentId`. Resolution is tri-state and **only resolvable discussions carry it**: a resolvable discussion maps its `resolved` boolean to `true`/`false`; a non-resolvable plain note (GitLab marks these `resolvable: false`) leaves `resolved` **absent** (unknown — not `false`). No GitLab field names leak into the contract.

**Acceptance criteria:**
- `getPrComments` returns aggregated, thread-aware `PrComment[]`; the `GitLab_GetPrComments_ThrowsUnsupported` test is replaced with harvesting tests mirroring `github.test.ts`.
- A resolved resolvable discussion yields `resolved: true`; an unresolved resolvable discussion `resolved: false`; a non-resolvable note or indeterminate state omits `resolved`.
- GitLab MR comments surface as `comment-reply` action items through `assess_stack` (see DR-3/DR-4 enablement in Chosen Approach — the `requiresGitHub` handler gate is narrowed; the harvest loop `queryPrComments` stays provider-branch-free, INV-6).

#### DR-4: Azure DevOps `getPrComments` conforms to the platform-neutral `PrComment` contract

`AzureDevOpsProvider.getPrComments` harvests PR comment threads and maps them onto `PrComment`: threads → `source: 'issue-comment'` or `'review-inline'` (file/line-anchored threads carry `path`/`line`); replies → one-level `parentId`. Thread status maps over the **full** ADO `CommentThreadStatus` enum to tri-state `resolved`: the *decided* states — `fixed`, `closed`, `wontFix`, `byDesign` — → `true`; the *open* states — `active`, `pending` — → `false`; `unknown` (or any unrecognized future value) → **absent**. Mapping every decided state to `true` prevents maintainer-resolved (`wontFix`/`byDesign`) threads from re-surfacing as action items each cycle. No Azure field names leak.

**Acceptance criteria:**
- `getPrComments` returns aggregated, thread-aware `PrComment[]`; the `AzureDevOps_GetPrComments_ThrowsUnsupported` test is replaced with harvesting tests mirroring `github.test.ts`.
- Each `CommentThreadStatus` value maps per the full rule above; the test asserts the decided set (`fixed`/`closed`/`wontFix`/`byDesign`→true), the open set (`active`/`pending`→false), and `unknown`→absent.
- ADO PR comments surface as `comment-reply` action items through `assess_stack` (see DR-3/DR-4 enablement in Chosen Approach; harvest loop stays provider-branch-free, INV-6).

#### DR-5: provider side effects degrade fail-soft, never throwing into the workflow loop (error handling)

External-provider failures in this batch surface as recoverable, contract-preserving outcomes rather than exceptions that abort a phase.

**Acceptance criteria:**
- **Resolution enrichment (DR-3/DR-4):** if the platform's resolution surface (GitLab discussion state / ADO thread status) is unavailable or unparseable, affected comments leave `resolved` **absent** (unknown), never coerced to `false` — mirroring GitHub's fail-soft GraphQL enrichment. The base comment harvest still returns.
- **PR-number derivation (DR-1):** if the URL's trailing segment cannot be parsed to a number, the path falls back to `gh pr view <url> --json number` (GitHub) / `glab mr view <url> --json iid` (GitLab) rather than throwing; the `{url}` is always returned.
- A unit test exercises each degraded branch and asserts the contract (no throw; `resolved` absent on enrichment failure; URL returned on parse failure).

### Technical Design

The change set is confined to the VCS adapter layer and the runtime shim emitter — no event-store, projection, HSM, or gate-chain edits, so the roadmap's SDK-lowering discipline (coordination rule 3) does not bind this batch.

- **DR-1 (create_pr).** In `vcs/github.ts` and `vcs/gitlab.ts`, remove the `--json`/value pair from the create argv and replace `JSON.parse(output)` with a URL extractor: scan the combined command output for the provider's PR/MR-URL pattern (GitHub `…/pull/<n>`, GitLab `…/-/merge_requests/<n>`), then `number = Number(url.match(/\/(\d+)\/?$/)?.[1])`. Keep `draft`/`labels` handling. `handleCreatePr` is **not** touched — it already delegates to `provider.createPr` (`create-pr.ts:279`), so there is no argv duplication and INV-2 holds without a dedup. Implementers verify the actual URL stream against the installed `gh`/`glab` in their worktree (mocked tests cannot validate the live stdout/stderr contract — hence the combined-output scan).
- **DR-2 (shim SoT).** In `command-shim-emitter.ts`, replace the literal `CANONICAL_COMMANDS` array with a single `COMMAND_DESCRIPTIONS: Record<string, string>` and build `CANONICAL_COMMANDS` by mapping its keys to `{ name, skill: \`exarchos:${name}\`, description }`. Add `canonicalCommandSet()` to `canonical-skills.ts` (sorted union of `COMMAND_TO_SKILL` keys + `COMMAND_ONLY`) for the guard to consume. The coupling guard lives in the **MCP-server test suite** (not production): it imports `../../../../src/config/canonical-skills.js` — the established cross-boundary test pattern (`install-skills-bridge.test.ts`) — and asserts `Object.keys(COMMAND_DESCRIPTIONS).sort()` equals `canonicalCommandSet()`. Production code does not import across the boundary.
- **DR-3/DR-4 (getPrComments + gate).** Mirror `github.getPrComments` structure: a per-surface fetch (GitLab discussions/notes via `glab`/REST; ADO threads via `az repos pr` / ADO REST), a normalizer to `PrComment`, and a fail-soft resolution mapping. Reuse the existing async `exec` in `vcs/shell.ts` (the same path the providers already use for `createPr`/`getReviewStatus`). No change to `provider.ts` (the `PrComment` contract already exists). **`assess_stack` change (DR-3/DR-4 enablement):** remove the `requiresGitHub(provider, 'assess_stack')` call from `handleAssessStack` so GitLab/ADO reach the harvest — safe because the handler's provider methods are now supported (`checkCi`/`getReviewStatus`/`getPrComments`) or fail-soft (`listPrs`). `requiresGitHub` stays in `check_pr_comments`/`validate_pr_stack`. Any existing test asserting `assess_stack` skips a non-GitHub provider is updated to assert it now proceeds. The narrowing is scoped to the three real providers (all implement the methods `assess_stack` needs).

### Integration Points

- `servers/exarchos-mcp/src/vcs/github.ts` — `createPr` (drop `--json`, stdout URL + number-from-URL).
- `servers/exarchos-mcp/src/vcs/gitlab.ts` — `createPr` (same fix); `getPrComments` (new impl, DR-3).
- `servers/exarchos-mcp/src/vcs/azure-devops.ts` — `createPr` (verify `--output json` valid, no change expected); `getPrComments` (new impl, DR-4).
- `servers/exarchos-mcp/src/orchestrate/vcs/create-pr.ts` — **no change** (delegates to `provider.createPr`; confirmed at `:279`).
- `servers/exarchos-mcp/src/orchestrate/assess-stack.ts` — remove the `requiresGitHub` gate so GitLab/ADO harvest runs (DR-3/DR-4 enablement).
- `servers/exarchos-mcp/src/vcs/require-github.ts` — unchanged utility; still used by `check_pr_comments`/`validate_pr_stack`.
- `servers/exarchos-mcp/src/runtime/command-shim-emitter.ts` — collapse to `COMMAND_DESCRIPTIONS` map (DR-2).
- `src/config/canonical-skills.ts` — SoT; add `canonicalCommandSet()` accessor.
- Tests: `vcs/{github,gitlab,azure-devops}.test.ts`, `runtime/command-shim-emitter.test.ts` (incl. the cross-boundary guard), `src/config/canonical-skills.test.ts`, `orchestrate/assess-stack.test.ts`. (`orchestrate/vcs/create-pr.test.ts` is untouched — it backstops the INV-13 preservation criterion.)

### Alternatives considered

- **DR-1 — keep `--json`, call `gh pr view` after a flagless create.** Rejected: an extra round-trip per create; deriving `number` from the returned URL is simpler and provider-uniform (`gh pr view` is retained only as the DR-5 fallback).
- **DR-2 — add only a coupling guard, keep the hand-kept list.** Rejected: leaves the third source of truth in place and merely alarms on drift — a local patch, not the structural fix. Deriving the set removes the class.
- **DR-2 — derive `description` too (from command frontmatter).** Rejected for now: descriptions are not uniformly present in `commands/*.md` frontmatter; over-reach. The guard on a shim-local description map is sufficient.
- **DR-3/DR-4 — minimal harvest (top-level comments only, no threading/resolution).** Rejected: breaks parity with the GitHub reference; `assess_stack` would surface already-resolved comments as action items and lose reply threading.

### Open Questions

- **INV-2 duplication (DR-1):** does `orchestrate/vcs/create-pr.ts` re-build the create argv, or delegate to `provider.createPr`? Resolve at `/plan` via symbol inspection; if duplicated, the fix is one task that touches both and a parity assertion.
- **Windows `az` shim (DR-4):** new Azure DevOps `getPrComments` invokes `az`, which is `az.cmd` on win32 — the #1623 class of `.cmd`-shim spawn bug. Existing `az repos pr` calls already go through the async `exec` in `vcs/shell.ts` with the same exposure, so this batch stays consistent with the current path; flag for a separate Windows-portability follow-up rather than widening scope here.
- **Live-CI coverage (DR-3/DR-4):** there is no live GitLab/ADO CI; tests are mocked-CLI suites mirroring the GitHub provider tests (the existing provider test harnesses already mock `exec`). Acceptable — same coverage posture as the shipped GitHub harvester.

#### Resolutions folded in during planning

- **DR-1 / INV-2:** resolved — `handleCreatePr` (`orchestrate/vcs/create-pr.ts:279`) delegates to `provider.createPr`; it does **not** re-build the argv. The `--json` bug is provider-only; no handler dedup is required.
- **DR-2 / build boundary:** resolved — the MCP server tsconfig is `rootDir: ./src`, so production code in `servers/exarchos-mcp/src/` cannot import root `src/config/canonical-skills.ts`. The coupling is therefore a **test-only guard** that imports the SoT across the package boundary (the established pattern: `install-skills-bridge.test.ts` already imports `../../../../src/...`). The emitter reduces its hand-kept array to a `COMMAND_DESCRIPTIONS` map keyed by command name (names + `skill: exarchos:<name>` derive locally); the guard asserts those keys equal the canonical set. `canonical-skills.test.ts` already validates the SoT against `commands/*.md`.
- **DR-3/DR-4 / `assess_stack` enablement (plan-review round 1, HIGH gap):** the adversarial pass found that `handleAssessStack` gates on `requiresGitHub` before harvesting, so `getPrComments` alone would not surface GitLab/ADO comments end-to-end — and the original Task 009 test (inject a non-GitHub provider) would hit the gate. Resolved by adding **Task 010** (narrow the gate for `assess_stack` only; safe because its provider methods are supported or fail-soft) and rewriting Task 009 to test the now-open path. `check_pr_comments`/`validate_pr_stack` stay gated (need `getRepository`/`listPrs`) and are scoped out. The INV-6 claim is sharpened: the *harvest loop* is branch-free; the *handler posture gate* is what's narrowed. Other plan-review findings folded in: full ADO `CommentThreadStatus` enum mapping (Task 008), GitLab resolvable-vs-note resolution (Task 007), `glab` combined-output URL scan (Task 002), corrected `boundaryTouching` stamps (005/006), and the DR-5 traceability row (002).

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.
A task with no DR-N is a coverage gap; a DR-N with no task is unimplemented — both are flagged by `check_plan_coverage`.

### Scope

**Target:** Full design (DR-1..DR-5).
**Excluded:**
- #1616 (re-homed under #1258/#1253 — edits the Z3 consolidation surface `playbooks.ts`).
- Windows `az`/`.cmd`-shim hardening for the new ADO path (consistent with existing `az repos pr` calls; tracked separately — see Open Questions).
- GitLab/ADO enablement of `check_pr_comments` and `validate_pr_stack` (they call `getRepository`/`listPrs`, which still throw for those providers). Only `assess_stack` is enabled here; the other two stay GitHub-gated. Tracked as a follow-up under DR-7 parent #1592.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | `create_pr` succeeds without `--json` across providers | 001, 002, 003 |
| DR-2 | one SoT for the canonical command set in the shim | 004, 005, 006 |
| DR-3 | GitLab `getPrComments` conforms + surfaces via `assess_stack` | 007, 010, 009 |
| DR-4 | Azure DevOps `getPrComments` conforms + surfaces via `assess_stack` | 008, 010, 009 |
| DR-5 | provider side effects degrade fail-soft | 001, 002, 007, 008 |

### Tasks

Each task carries a `riskTier` stamp selecting its verification depth (the ladder in `@skills/_shared/references/verification.md`); tests are judged test-after by adequacy.

#### Task 001: Fix `github.createPr` — drop `--json`, capture URL from stdout

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1, DR-5

In `vcs/github.ts`, remove the `--json`/`url,number` argv pair from `gh pr create`; capture the PR URL as the last non-empty stdout line; derive `number` from the URL's trailing `/(\d+)/?$` segment. DR-5 fallback: if the segment does not parse, run `gh pr view <url> --json number,url` rather than throwing. Preserve `draft`/`labels` and the `PrResult {url, number}` shape.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/vcs/github.ts`, `servers/exarchos-mcp/src/vcs/github.test.ts`
**Expected tests:** `GitHub_CreatePr_OmitsJsonFlag`, `GitHub_CreatePr_ParsesNumberFromUrl`, `GitHub_CreatePr_FallsBackToPrViewOnUnparseableUrl`
**Dependencies:** None
**Parallelizable:** Yes

#### Task 002: Fix `gitlab.createPr` — drop the latent `--json` sibling

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1, DR-5

In `vcs/gitlab.ts`, apply the same class fix to `glab mr create`: remove `--json`/`url,iid`; extract the MR URL by scanning the **combined** command output for the `…/-/merge_requests/<n>` pattern (robust to whether `glab` writes the URL to stdout or stderr — verify live against the installed `glab` during implementation, since mocked exec cannot validate the stream); derive `number` (iid) from the URL's trailing segment; DR-5 fallback to `glab mr view <url> --json iid`. Preserve `draft`/`labels`.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/vcs/gitlab.ts`, `servers/exarchos-mcp/src/vcs/gitlab.test.ts`
**Expected tests:** `GitLab_CreatePr_OmitsJsonFlag`, `GitLab_CreatePr_ParsesIidFromUrl`, `GitLab_CreatePr_FallsBackToMrViewOnUnparseableUrl`
**Dependencies:** None
**Parallelizable:** Yes

#### Task 003: Verify ADO `createPr` `--output json` validity + lock the class

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-1

Confirm `az repos pr create --output json` is valid (global `--output`, unlike a write-command `--json`) and leave the invocation unchanged. Add the class-locking regression assertion: ADO's create argv carries no bare `--json` write flag, and (cross-provider) `gh pr create`/`glab mr create` argv contain no `--json` token.

**Verification (low):** static analysis (typecheck + lint) + the regression assertion.
**Files:** `servers/exarchos-mcp/src/vcs/azure-devops.ts` (expected no change), `servers/exarchos-mcp/src/vcs/azure-devops.test.ts`
**Expected tests:** `AzureDevOps_CreatePr_UsesOutputJsonNotWriteJsonFlag`
**Dependencies:** None
**Parallelizable:** Yes (sequence before 008 — same file `azure-devops.ts`)

#### Task 004: Add `canonicalCommandSet()` accessor to the SoT

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-2

In `src/config/canonical-skills.ts`, export `canonicalCommandSet(): readonly string[]` = sorted union of `Object.keys(COMMAND_TO_SKILL)` and `[...COMMAND_ONLY]`. Extend `canonical-skills.test.ts` to assert the accessor equals the set derived from `commands/*.md` at test time.

**Verification (low):** static analysis + the accessor drift assertion.
**Files:** `src/config/canonical-skills.ts`, `src/config/canonical-skills.test.ts`
**Expected tests:** `CanonicalCommandSet_MatchesCommandsDir`
**Dependencies:** None
**Parallelizable:** Yes

#### Task 005: Collapse `CANONICAL_COMMANDS` to a description map + reconcile drift

**Risk Tier:** medium
**Boundary Touching:** true (mutates the emitted Copilot/Cursor shim — the INV-4 cross-runtime surface)
**Implements:** DR-2

In `runtime/command-shim-emitter.ts`, replace the hand-kept `CANONICAL_COMMANDS` array with a `COMMAND_DESCRIPTIONS: Record<string, string>` map; build `CANONICAL_COMMANDS` by mapping its keys to `{ name, skill: \`exarchos:${name}\`, description }`. Reconcile the drift: remove `reload`; add `discover` and `invariants` with descriptions. The emitter's baselines are **inline assertions** in `command-shim-emitter.test.ts` (not golden files): update `commandCount` `toBe(17)`→`18` (two sites), `toHaveLength(17)`→`18`, and the hardcoded `expectedCommands` array (drop `reload`, add `discover`/`invariants`) — the count changes 17→18.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/runtime/command-shim-emitter.ts`, `servers/exarchos-mcp/src/runtime/command-shim-emitter.test.ts`
**Expected tests:** `EmitCommandShim_AdvertisesDiscoverAndInvariants`, `EmitCommandShim_DropsRetiredReload`
**Dependencies:** None
**Parallelizable:** Yes (independent file from 004; both feed 006)

#### Task 006: Coupling guard — shim command set == canonical SoT

**Risk Tier:** medium
**Boundary Touching:** false (test-only assertion; adds no cross-component behavior)
**Implements:** DR-2

Add a guard test in the MCP server that imports the root SoT (`../../../../src/config/canonical-skills.js`, the established cross-boundary test pattern) and asserts `Object.keys(COMMAND_DESCRIPTIONS)` (sorted) equals `canonicalCommandSet()`; assert `reload` is absent and `discover`/`invariants` present. Prove it fails on a deliberately-drifted fixture and passes on the reconciled tree.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe (the guard must fail on injected drift).
**Files:** `servers/exarchos-mcp/src/runtime/command-shim-emitter.test.ts`
**Expected tests:** `CommandShim_NameSet_EqualsCanonicalSoT`, `CommandShim_Guard_FailsOnInjectedDrift`
**Dependencies:** 004, 005
**Parallelizable:** No

#### Task 007: Implement `GitLabProvider.getPrComments` to full `PrComment` parity

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-3, DR-5

Mirror `github.getPrComments`: harvest MR notes + discussion threads (via the provider's existing `exec`/`glab`/REST path), normalize to `PrComment` (`source`, `path`/`line` for diff notes, one-level `parentId`). Resolution is tri-state and **only resolvable discussions carry it**: map a resolvable discussion's `resolved` boolean to `true`/`false`; leave `resolved` **absent** for non-resolvable plain notes (GitLab `resolvable: false`). DR-5: fail-soft — if the resolution surface is unavailable, leave `resolved` absent (never `false`); the base harvest still returns. Replace `GitLab_GetPrComments_ThrowsUnsupported` with a harvesting suite mirroring `github.test.ts`. No leak of GitLab field names.

**Verification (high):** medium set + the integration suite across the `assess_stack` seam.
**Files:** `servers/exarchos-mcp/src/vcs/gitlab.ts`, `servers/exarchos-mcp/src/vcs/gitlab.test.ts`
**Expected tests:** `GitLab_GetPrComments_AggregatesNotesAndThreads`, `GitLab_GetPrComments_MapsResolvableDiscussionTriState`, `GitLab_GetPrComments_LeavesResolvedAbsentOnNonResolvableNote`, `GitLab_GetPrComments_ThreadsRepliesByParentId`, `GitLab_GetPrComments_LeavesResolvedAbsentOnEnrichmentFailure`
**Dependencies:** 002 (same file `gitlab.ts`)
**Parallelizable:** Yes (vs. 008)

#### Task 008: Implement `AzureDevOpsProvider.getPrComments` to full `PrComment` parity

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-4, DR-5

Mirror `github.getPrComments`: harvest PR comment threads (via the provider's existing `exec`/`az repos pr`/ADO REST path), normalize to `PrComment` (`source`, `path`/`line` for file/line-anchored threads, one-level `parentId`). Map the **full** `CommentThreadStatus` enum to tri-state `resolved`: decided (`fixed`, `closed`, `wontFix`, `byDesign`) → `true`; open (`active`, `pending`) → `false`; `unknown`/unrecognized → absent. DR-5 fail-soft on missing/unparseable status (→ absent). Replace `AzureDevOps_GetPrComments_ThrowsUnsupported` with a harvesting suite. No Azure field-name leak.

**Verification (high):** medium set + the integration suite across the `assess_stack` seam.
**Files:** `servers/exarchos-mcp/src/vcs/azure-devops.ts`, `servers/exarchos-mcp/src/vcs/azure-devops.test.ts`
**Expected tests:** `AzureDevOps_GetPrComments_AggregatesThreads`, `AzureDevOps_GetPrComments_MapsDecidedStatusesToResolvedTrue`, `AzureDevOps_GetPrComments_MapsOpenStatusesToResolvedFalse`, `AzureDevOps_GetPrComments_ThreadsRepliesByParentId`, `AzureDevOps_GetPrComments_LeavesResolvedAbsentOnUnknownStatus`
**Dependencies:** 003 (same file `azure-devops.ts`)
**Parallelizable:** Yes (vs. 007)

#### Task 010: Narrow the `requiresGitHub` gate in `assess_stack` to enable GitLab/ADO

**Risk Tier:** medium
**Boundary Touching:** true (changes `assess_stack` behavior for non-GitHub providers — the INV-6 provider-posture seam)
**Implements:** DR-3, DR-4

Remove the `requiresGitHub(provider, 'assess_stack')` call from `handleAssessStack` (`assess-stack.ts:494`) so an injected GitLab/ADO provider reaches the harvest. Safe because `assess_stack`'s provider methods are now supported for those providers (`checkCi`, `getReviewStatus`, `getPrComments`) and its only other call (`listPrs` via `queryPrMergeState`) is already fail-soft. Leave `requiresGitHub` in `check_pr_comments`/`validate_pr_stack` (out of scope). Update any existing test that asserts `assess_stack` skips a non-GitHub provider to assert it now proceeds.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/orchestrate/assess-stack.ts`, `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
**Expected tests:** `AssessStack_NonGitHubProvider_ProceedsNotSkipped` (replaces any prior `_Skipped` assertion)
**Dependencies:** 007, 008
**Parallelizable:** No

#### Task 009: Integration — GitLab/ADO comments surface via `assess_stack` (harvest loop branch-free, INV-6)

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3, DR-4

With the gate narrowed (010), extend `assess-stack` tests: inject a GitLab and an ADO mock provider (the 4th positional arg of `handleAssessStack`) returning `PrComment[]`, and assert each surfaces as `comment-reply` action items, honoring tri-state `resolved` (absent/false → actionable; true → filtered). Assert the *harvest loop* (`queryPrComments`) carries no provider/workflow-type branch (INV-6) — the only provider conditioning removed was the handler-level posture gate (010).

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
**Expected tests:** `AssessStack_SurfacesGitLabComments_AsCommentReply`, `AssessStack_SurfacesAdoComments_AsCommentReply`, `AssessStack_HarvestLoop_NoProviderBranch`
**Dependencies:** 007, 008, 010
**Parallelizable:** No

### Parallelization

- **Wave 1 (parallel):** 001 (github.ts), 002 (gitlab.ts), 003 (azure-devops.ts), 004 (canonical-skills.ts), 005 (command-shim-emitter.ts) — five disjoint files.
- **Wave 2 (parallel):** 006 (after 004+005), 007 (after 002), 008 (after 003).
- **Wave 3:** 010 (after 007+008 — narrows the gate), then 009 (after 010 — integration test).
- **Critical path:** 002→007→010→009 ‖ 003→008→010 (the high-tier provider work + enablement). DR-2 chain (004‖005→006) runs alongside and is shorter.
- **Same-file sequencing:** 002→007 and 003→008 share a provider file each; 010→009 share `assess-stack.test.ts` — each pair merges in order rather than running concurrently in separate worktrees.

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [x] Open questions resolved (INV-2 duplication; DR-2 build boundary) or explicitly deferred (Windows `az` shim) with rationale
- [ ] Ready for `plan-review`
