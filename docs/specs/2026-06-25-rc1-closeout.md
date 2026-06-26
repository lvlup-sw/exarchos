# Spec: v2.11.0 rc.1 closeout batch

**Date:** 2026-06-25 · **Feature:** `rc1-closeout` · **Depth:** standard
**Inputs:** issues #1622, #1609, #1612, #1613 · roadmap tracker #1599 (Z1/v2.11 residue) · north-star `docs/system-design.html` · DR-7 parent epic #1592

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` (added at `/plan`) maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

Four open issues are the final v2.11.0 residue to fold in before the rc.1 tag. They are heterogeneous but share one property: **none touches the Z3 consolidation surface** (`playbooks.ts`, `hsm-definitions.ts`, the gate chains that #1258/#1253 delete), so none is the churn-then-delete the roadmap's coordination rule 3 warns against. (The fifth candidate, #1616, *does* edit `playbooks.ts` and was re-homed under #1258/#1253 — out of this batch.)

1. **#1622 — `create_pr` is broken on GitHub.** The action passes `--json url,number` to `gh pr create`, which has no `--json` output mode (it is valid only on `gh pr view`/`gh pr list`). `gh` exits non-zero on flag parse *before creating the PR*, so no PR is created (field-reported from a hierophant GitHub synthesis run). The same `--json` mistake exists in the GitLab provider (`glab mr create --json url,iid`, `vcs/gitlab.ts:96`) — a *class* of bug ("append `--json` to a write command"). **Scope note (surfaced by plan-review):** the GitLab/ADO `create_pr` path is *additionally* blocked upstream — `handleCreatePr` runs a **fail-closed** `provider.listPrs` idempotency precheck (`create-pr.ts:224`) before `createPr`, and `listPrs` throws `UnsupportedOperationError` for both, so `create_pr` returns `PRECHECK_FAILED` and the create is never reached. Therefore the **end-to-end** `create_pr` fix is **GitHub-only**; the GitLab/ADO `--json` correction is a *provider-unit defensive class-lock* (so the create works once those providers are completed), not an end-to-end enablement. Completing GitLab/ADO `create_pr` (implementing `listPrs` et al.) is out of scope (the same provider-completion follow-up as the `assess_stack`/`check_pr_comments` gaps).
2. **#1609 — the canonical command set has three sources of truth.** `CANONICAL_COMMANDS` (`runtime/command-shim-emitter.ts`) is a third, hand-kept list that drifts from the documented SoT (`COMMAND_TO_SKILL` + `COMMAND_ONLY` in `src/config/canonical-skills.ts`, and `commands/*.md`). Current drift: `reload` is advertised but has no backing command; `discover` and `invariants` are real commands missing from the shim, so Copilot/Cursor users never see them. Nothing keeps the third list in sync.
3. **#1612 / #1613 — provider parity gap (DR-7 residue of #1592).** GitHub PR-feedback harvesting shipped contract-generic; GitLab and Azure DevOps `getPrComments` still throw `UnsupportedOperationError`. On those platforms `assess_stack` surfaces zero MR/PR comments as action items, silently degrading the ship-gate feedback loop.

Why it matters: #1622 breaks the synthesize auto-chain on every provider (field-reported from a hierophant run); #1609 mis-advertises the command surface on two first-class runtimes (an INV-4 parity defect); #1612/#1613 leave the DR-7 ship-gate feedback loop GitHub-only.

### Chosen Approach

Treat the batch as four independent, parallelizable fixes landing on one branch, one PR, behind the v2.11.0 milestone. Each is a behavior-preserving change to a non-consolidation surface:

- **#1622** — drop `--json` from the *create* invocation. **GitHub (end-to-end fix — the actual issue):** parse the PR URL from `gh pr create` stdout (the proven `createIssue` pattern at `github.ts:504`), derive `number` from the URL's trailing segment; DR-5 fallback `gh pr view <url> --json number,url`. **GitLab (provider-unit defensive class-lock only):** remove the invalid `--json` from `glab mr create`, and at the unit level obtain `{url, number}` via `glab mr view <headBranch> --json iid,webUrl` (do **not** parse create's output stream — undocumented; `exec` is stdout-only). This is not end-to-end (the fail-closed `listPrs` precheck blocks GitLab `create_pr`); it locks the class and is correct for when `listPrs` lands. **Azure DevOps** already uses the valid global `--output json` — verified, not changed. Preserve the INV-13 two-event split and the `PrResult {url, number}` contract (INV-5b).
- **#1609** — collapse the shim's three drifting command lists into one shim-local `COMMAND_DESCRIPTIONS` map (key = name, `skill` derived as `exarchos:<name>`), and add a **test-only** coupling guard that imports the root SoT across the package boundary and fails CI if the map's keys ≠ the canonical command set (union of `COMMAND_TO_SKILL` keys, `COMMAND_ONLY`, and `commands/*.md`). Pure prod-side derivation is impossible because the MCP-server `rootDir: ./src` boundary forbids importing the root SoT in production code (resolution below); the guard is the bounded structural fix — one map, made authoritative by a CI gate. Reconcile the existing drift (`-reload`, `+discover`, `+invariants`) as a consequence.
- **#1612 / #1613** — implement each provider's `getPrComments` to full GitHub parity against the platform-neutral `PrComment` contract: aggregate the platform's comment surfaces, thread-aware via one-level `parentId`, map native resolution to tri-state `resolved` (absent when unknown — never coerced to false), no platform field names leaking. Replace the `*_ThrowsUnsupported` conformance tests with harvesting suites mirroring the GitHub tests.
  - **DR-3/DR-4 end-to-end enablement (surfaced by plan-review).** `getPrComments` alone is insufficient: `handleAssessStack` (`assess-stack.ts:494`) calls `requiresGitHub(provider, 'assess_stack')`, which returns `{skipped:true}` for an explicitly-injected non-GitHub provider before the harvest runs. Since `assess_stack`'s required provider methods are now supported for GitLab/ADO (`checkCi` ✓, `getReviewStatus` ✓, `getPrComments` ← this batch) and its only other call, `listPrs` via `queryPrMergeState`, is already fail-soft (try/catch → `null`), the gate is **narrowed for `assess_stack` only** so GitLab/ADO proceed. INV-6 is read precisely: the *harvest loop* (`queryPrComments`) carries no provider branch; the handler-level `requiresGitHub` posture gate is the thing being narrowed. `check_pr_comments` and `validate_pr_stack` stay GitHub-gated — they need `getRepository`/`listPrs` (both still throw for GitLab/ADO); enabling those is **out of scope** (tracked as a follow-up under the DR-7 parent #1592).

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: `create_pr` succeeds without `--json` on the create command, across providers

No provider passes `--json` to its *create* command. **End-to-end** this fixes GitHub `create_pr` (the actual #1622); for GitLab/ADO it is a **provider-unit** correction (the `handleCreatePr` fail-closed `listPrs` precheck independently blocks their action-level path — out of scope to fix here). The GitHub `createPr` returns `PrResult {url, number}` with `url` from `gh pr create` stdout and `number` from the URL; GitLab `createPr` returns `{url, number}` from `glab mr view --json` after a flagless create. The fix lives in the provider layer (`vcs/github.ts`, `vcs/gitlab.ts`); `handleCreatePr` is unchanged (it already delegates — INV-2 holds). ADO's existing `--output json` is confirmed valid and unchanged.

**Acceptance criteria:**
- Given a GitHub repo, When `create_pr` runs, Then the spawned `gh pr create` argv contains no `--json` token and a PR is created; `{url, number}` (number parsed from the stdout URL) matches the created PR (the end-to-end #1622 fix).
- Given `GitLabProvider.createPr` is invoked directly (unit), Then `glab mr create` is spawned without `--json`, and `{url, number}` (number = MR iid) is obtained from a follow-up `glab mr view <headBranch> --json iid,webUrl` — not from create's output stream. (The `create_pr` *action* remains blocked for GitLab by the upstream `listPrs` precheck; this is the unit-level class-lock, not an action-level guarantee.)
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

`AzureDevOpsProvider.getPrComments` harvests PR comment threads and maps them onto `PrComment`: threads → `source: 'issue-comment'` or `'review-inline'` (file/line-anchored threads carry `path`/`line`); replies → one-level `parentId`. Thread status maps over the **full** ADO `CommentThreadStatus` enum to tri-state `resolved`: the *decided* states — `fixed`, `closed`, `wontFix`, `byDesign` — → `true`; the *open* states — `active`, `pending` — → `false`; `unknown` (or any unrecognized future value) → **absent**. Mapping every decided state to `true` prevents maintainer-resolved (`wontFix`/`byDesign`) threads from re-surfacing as action items each cycle. **System-generated threads** (`commentType: 'system'` — vote changes, ref/commit pushes, reviewer/status updates) are filtered out, paralleling GitHub's empty-review-body filter, so they never surface as action items. No Azure field names leak.

**Acceptance criteria:**
- `getPrComments` returns aggregated, thread-aware `PrComment[]`; the `AzureDevOps_GetPrComments_ThrowsUnsupported` test is replaced with harvesting tests.
- Each `CommentThreadStatus` value maps per the full rule above; the test asserts the decided set (`fixed`/`closed`/`wontFix`/`byDesign`→true), the open set (`active`/`pending`→false), and `unknown`→absent.
- System-generated (`commentType: 'system'`) threads are excluded from the returned `PrComment[]`.
- ADO PR comments surface as `comment-reply` action items through `assess_stack` (see DR-3/DR-4 enablement in Chosen Approach; harvest loop stays provider-branch-free, INV-6).

#### DR-5: provider side effects degrade fail-soft, never throwing into the workflow loop (error handling)

External-provider failures in this batch surface as recoverable, contract-preserving outcomes rather than exceptions that abort a phase.

**Acceptance criteria:**
- **Resolution parsing (DR-3/DR-4):** GitLab/ADO carry resolution **inline** in the same discussions/threads response as the comment bodies (unlike GitHub's separable GraphQL `reviewThreads` call). So fail-soft here is *per-field defensive parsing*: if an individual discussion/thread is missing or has an unrecognized resolution/status field, that comment's `resolved` is left **absent** (unknown, never coerced to `false`) while the rest of the harvest maps normally. (GitHub's separable-call fail-soft is github-specific and unchanged.)
- **PR-number derivation (DR-1):** GitHub — if the stdout URL's trailing segment cannot be parsed, fall back to `gh pr view <url> --json number,url` (recovers a real `number`) rather than throwing. GitLab — `{url, number}` come from `glab mr view --json`; there is **no** independent fallback (a second `mr view` shares the same failure mode, and `PrResult.number` is non-optional — a partial `{url}` would break the contract and poison the `pr.create.executed` event at `create-pr.ts:298`). If the post-create read fails, the provider **throws** (`createPr` returns `Promise<PrResult>` with non-optional `number`, so neither a partial `{url}` nor a `ToolResult` is type-valid); `handleCreatePr`'s existing catch (`create-pr.ts:310`) maps the rejection to `VCS_ERROR` end-to-end. Never a contract-invalid partial.
- A unit test exercises each degraded branch and asserts the contract (GitHub: `resolved` absent on a missing/unrecognized resolution field; URL+number recovered via `pr view` fallback; GitLab: `VCS_ERROR` — not a partial `PrResult` — when the post-create `mr view` read fails).

### Technical Design

The change set is confined to the VCS adapter layer and the runtime shim emitter — no event-store, projection, HSM, or gate-chain edits, so the roadmap's SDK-lowering discipline (coordination rule 3) does not bind this batch.

- **DR-1 (create_pr).** Remove the `--json`/value pair from each create argv. **GitHub** (`vcs/github.ts`): the stdout of `gh pr create` is the PR URL (proven by `createIssue` at `github.ts:504`) — take the last non-empty stdout line, `number = Number(url.match(/\/(\d+)\/?$/)?.[1])`; DR-5 fallback `gh pr view <url> --json number,url`. **GitLab** (`vcs/gitlab.ts`): run flagless `glab mr create`, then `glab mr view <headBranch> --json iid,webUrl` for the structured `{iid, webUrl}` → `{number, url}` — no reliance on create's output stream (the shared `exec` in `shell.ts` returns stdout only and `glab`'s create stream is undocumented; this avoids both). Keep `draft`/`labels`. `handleCreatePr` is **not** touched — it already delegates to `provider.createPr` (`create-pr.ts:279`), so INV-2 holds without a dedup.
- **DR-2 (shim SoT).** In `command-shim-emitter.ts`, replace the literal `CANONICAL_COMMANDS` array with a single `COMMAND_DESCRIPTIONS: Record<string, string>` and build `CANONICAL_COMMANDS` by mapping its keys to `{ name, skill: \`exarchos:${name}\`, description }`. Add `canonicalCommandSet()` to `canonical-skills.ts` (sorted union of `COMMAND_TO_SKILL` keys + `COMMAND_ONLY`) for the guard to consume. The coupling guard lives in the **MCP-server test suite** (not production): it imports `../../../../src/config/canonical-skills.js` — the established cross-boundary test pattern (`install-skills-bridge.test.ts`) — and asserts `Object.keys(COMMAND_DESCRIPTIONS).sort()` equals `canonicalCommandSet()`. Production code does not import across the boundary.
- **DR-3/DR-4 (getPrComments + gate).** Follow `github.getPrComments`'s *shape* (fetch → normalize to `PrComment` → tri-state resolution), adapted per platform — not a literal mirror (GitHub's `review-summary` source and separable GraphQL `reviewThreads` call have no GitLab/ADO analog; both platforms carry resolution inline). **GitLab:** fetch MR discussions/notes (`glab`/REST). **ADO:** there is no `az repos pr` thread-list subcommand — use `az devops invoke --area git --resource pullRequestThreads`, which needs `project` + `repositoryId` + `pullRequestId`; resolve `repositoryId`/`project` first (e.g. `az repos pr show`), since the provider's `_config` does not carry them. Filter ADO **system-generated** threads (`commentType: 'system'` — votes, ref pushes, status changes) so they don't surface as action items, paralleling GitHub's empty-review-body filter. Reuse the existing async `exec` in `vcs/shell.ts`. No change to `provider.ts` (the `PrComment` contract already exists). **`assess_stack` change (DR-3/DR-4 enablement):** remove the `requiresGitHub(provider, 'assess_stack')` call from `handleAssessStack` so GitLab/ADO reach the harvest — safe because the handler's provider methods are now supported (`checkCi`/`getReviewStatus`/`getPrComments`) or fail-soft (`listPrs`). `requiresGitHub` stays in `check_pr_comments`/`validate_pr_stack`. Any existing test asserting `assess_stack` skips a non-GitHub provider is updated to assert it now proceeds. The narrowing is scoped to the three real providers (all implement the methods `assess_stack` needs).

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

- **DR-1 — `view`-after-create for GitHub too (uniform with GitLab).** Rejected for GitHub: `gh pr create`'s stdout URL is reliable (the `createIssue` precedent), so the extra `gh pr view` round-trip is unnecessary (retained only as the DR-5 fallback). GitLab *does* use `mr view --json` as its primary read — not for uniformity but because `glab mr create`'s output stream is undocumented and the shared `exec` is stdout-only, so a structured read is the only assumption-free source.
- **DR-2 — pure prod-side derivation of the command set from the SoT.** Rejected because **impossible** under the constraints, not on preference: the MCP-server `rootDir: ./src` boundary forbids production code importing the root SoT. The chosen design is therefore the bounded structural step the boundary permits — collapse the three drifting lists into one `COMMAND_DESCRIPTIONS` map and make the SoT authoritative via a test-only CI guard. (A guard *without* the 3→1 collapse — leaving the parallel `{name, skill, description}` array — was also rejected: the collapse is what removes the redundant lists; the guard alone would only alarm.)
- **DR-2 — derive `description` too (from command frontmatter).** Rejected for now: descriptions are not uniformly present in `commands/*.md` frontmatter; over-reach. The guard on a shim-local description map is sufficient.
- **DR-3/DR-4 — minimal harvest (top-level comments only, no threading/resolution).** Rejected: breaks parity with the GitHub reference; `assess_stack` would surface already-resolved comments as action items and lose reply threading.

### Open Questions

- **INV-2 duplication (DR-1):** does `orchestrate/vcs/create-pr.ts` re-build the create argv, or delegate to `provider.createPr`? Resolve at `/plan` via symbol inspection; if duplicated, the fix is one task that touches both and a parity assertion.
- **Windows `az` shim (DR-4):** new Azure DevOps `getPrComments` invokes `az`, which is `az.cmd` on win32 — the #1623 class of `.cmd`-shim spawn bug. Existing `az repos pr` calls already go through the async `exec` in `vcs/shell.ts` with the same exposure, so this batch stays consistent with the current path; flag for a separate Windows-portability follow-up rather than widening scope here.
- **Live-CI coverage (DR-3/DR-4):** there is no live GitLab/ADO CI; tests are mocked-CLI suites mirroring the GitHub provider tests (the existing provider test harnesses already mock `exec`). Acceptable — same coverage posture as the shipped GitHub harvester.

#### Resolutions folded in during planning

- **DR-1 / INV-2:** resolved — `handleCreatePr` (`orchestrate/vcs/create-pr.ts:279`) delegates to `provider.createPr`; it does **not** re-build the argv. The `--json` bug is provider-only; no handler dedup is required.
- **DR-2 / build boundary:** resolved — the MCP server tsconfig is `rootDir: ./src`, so production code in `servers/exarchos-mcp/src/` cannot import root `src/config/canonical-skills.ts`. The coupling is therefore a **test-only guard** that imports the SoT across the package boundary (the established pattern: `install-skills-bridge.test.ts` already imports `../../../../src/...`). The emitter reduces its hand-kept array to a `COMMAND_DESCRIPTIONS` map keyed by command name (names + `skill: exarchos:<name>` derive locally); the guard asserts those keys equal the canonical set. `canonical-skills.test.ts` already validates the SoT against `commands/*.md`.
- **DR-3/DR-4 / `assess_stack` enablement (plan-review round 1, HIGH gap):** the adversarial pass found that `handleAssessStack` gates on `requiresGitHub` before harvesting, so `getPrComments` alone would not surface GitLab/ADO comments end-to-end — and the original Task 009 test (inject a non-GitHub provider) would hit the gate. Resolved by adding **Task 010** (narrow the gate for `assess_stack` only; safe because its provider methods are supported or fail-soft) and rewriting Task 009 to test the now-open path. `check_pr_comments`/`validate_pr_stack` stay gated (need `getRepository`/`listPrs`) and are scoped out. The INV-6 claim is sharpened: the *harvest loop* is branch-free; the *handler posture gate* is what's narrowed. Other round-1 findings folded in: full ADO `CommentThreadStatus` enum mapping (Task 008), GitLab resolvable-vs-note resolution (Task 007), corrected `boundaryTouching` stamps (005/006), and the DR-5 traceability row (002).
- **Round-2 resolutions (second adversarial pass).** A second HIGH was found: `vcs/shell.ts`'s `exec` returns **stdout only**, so the round-1 "scan combined stdout+stderr" for `glab mr create` was unimplementable. Resolved by dropping output-stream parsing for GitLab entirely — Task 002 reads `{iid, webUrl}` from `glab mr view --json` after a flagless create (`--json` support proven elsewhere in `gitlab.ts`); GitHub keeps its stdout parse (the `createIssue` precedent). Folded-in MEDIUM/LOW: ADO `getPrComments` uses `az devops invoke … pullRequestThreads` (no `az repos pr` thread-list subcommand) and filters `commentType:'system'` (Task 008); DR-5 fail-soft reframed as *per-field defensive parsing* for GitLab/ADO's inline (single-call) resolution, not GitHub's separable-call model; class-lock assertions moved into each provider's own suite (Task 003 → ADO only); "full parity" reworded to "two-source parity"; 007/008 high-tier verification re-attributed (the assess_stack cross-seam integration is Task 009); and the `listPrs`-fail-soft merge-detection degradation for GitLab/ADO is documented (Task 010).
- **Round-3 resolutions (third adversarial pass).** Two new HIGHs, both code-verified: (a) `handleCreatePr` runs a **fail-closed** `provider.listPrs` precheck (`create-pr.ts:224`) before `createPr`, and `listPrs` throws for GitLab/ADO — so GitLab/ADO `create_pr` is blocked end-to-end *regardless of the `--json` fix*. Resolved by scoping honestly: GitHub gets the end-to-end #1622 fix; the GitLab/ADO `--json` correction is a **provider-unit defensive class-lock** only, with the end-to-end gap (and `listPrs`/`getRepository` implementation) explicitly Excluded under the same #1592 provider-completion follow-up. (b) The GitLab DR-5 fallback `return {url}` violated the non-optional `PrResult.number` contract — resolved by returning a structured `VCS_ERROR` on a failed post-create read instead of a partial. Folded-in MEDIUM/LOW: GitLab discussions pagination (Task 007); ADO **PR-unique id composition** (per-thread ids collide — Task 008); explicit `source` classification + path/line + no-field-leak tests pinned for both providers; `Task 009` `boundaryTouching` corrected to false (test-only). The DR-5 *inline-resolution* model and ADO `threadContext`/`parentCommentId` derivability were probed and confirmed sound.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.
A task with no DR-N is a coverage gap; a DR-N with no task is unimplemented — both are flagged by `check_plan_coverage`.

### Scope

**Target:** Full design (DR-1..DR-5).
**Excluded:**
- #1616 (re-homed under #1258/#1253 — edits the Z3 consolidation surface `playbooks.ts`).
- Windows `az`/`.cmd`-shim hardening for the new ADO path (consistent with existing `az repos pr` calls; tracked separately — see Open Questions).
- GitLab/ADO enablement of `check_pr_comments` and `validate_pr_stack` (they call `getRepository`/`listPrs`, which still throw for those providers). Only `assess_stack` is enabled here; the other two stay GitHub-gated. Tracked as a follow-up under DR-7 parent #1592.
- **GitLab/ADO `create_pr` end-to-end** — blocked by the fail-closed `listPrs` precheck in `handleCreatePr` (`create-pr.ts:224`); `listPrs` is unimplemented for both. This batch lands only the GitHub end-to-end fix plus the GitLab/ADO provider-unit `--json` class-lock. Completing GitLab/ADO `create_pr` (implementing `listPrs`/`getRepository`) is the same provider-completion follow-up as the `assess_stack` `listPrs` and `check_pr_comments` gaps — one tracked item under #1592.

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

**Provider-unit defensive class-lock** (not action-level — the `listPrs` precheck blocks GitLab `create_pr` end-to-end; see DR-1 scope note). In `vcs/gitlab.ts`, remove `--json`/`url,iid` from `glab mr create`. Do **not** parse create's output stream (undocumented; `exec` is stdout-only). After a successful create, read `{iid, webUrl}` via `glab mr view <headBranch> --json iid,webUrl` → `{number: iid, url: webUrl}`. DR-5: if the `mr view` read fails, **throw** (provider returns `Promise<PrResult>`; `number` is required, so neither a partial nor a `ToolResult` is valid) — `handleCreatePr` maps the rejection to `VCS_ERROR`. Verify the actual `mr view --json` field keys (`iid`/`webUrl` vs `url`) against the installed `glab` during implementation; resolve the just-created MR unambiguously (the open MR for `headBranch`). Preserve `draft`/`labels`. Add the GitLab class-lock assertion (no `--json` in the create argv) here.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/vcs/gitlab.ts`, `servers/exarchos-mcp/src/vcs/gitlab.test.ts`
**Expected tests:** `GitLab_CreatePr_OmitsJsonFlagOnCreate`, `GitLab_CreatePr_ReadsIidAndUrlFromMrView`, `GitLab_CreatePr_ThrowsWhenViewReadFails`
**Dependencies:** None
**Parallelizable:** Yes

#### Task 003: Verify ADO `createPr` `--output json` validity + lock the class

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-1

Confirm `az repos pr create --output json` is valid (global `--output`, unlike a write-command `--json`) and leave the invocation unchanged. Assert ADO's own create argv carries no bare `--json` write flag. (The GitHub/GitLab class-lock assertions live in their own suites — Tasks 001/002 — since each provider builds its argv in its own file.)

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

#### Task 007: Implement `GitLabProvider.getPrComments` (two-source `PrComment` parity)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-3, DR-5

Follow `github.getPrComments`'s shape (GitLab has the two contract sources `issue-comment`/`review-inline`; no `review-summary` analog). Harvest MR notes + discussion threads (via the provider's existing `exec`/`glab`/REST path), normalize to `PrComment`. **Classify** per note: a note carrying diff position → `source: 'review-inline'` with `path`/`line`; otherwise `source: 'issue-comment'`. Thread replies → one-level `parentId`. **Paginate** the discussions endpoint (GitLab pages ~20/discussion-page; `glab --paginate` or a REST page-walk like GitHub's `--paginate`) so large MRs are not truncated. Resolution is inline and tri-state, **only on resolvable discussions**: map a resolvable discussion's `resolved` boolean to `true`/`false`; leave `resolved` **absent** for non-resolvable plain notes (`resolvable: false`). DR-5: per-field defensive parsing — a discussion with a missing/unrecognized resolution field yields `resolved` absent while the rest of the harvest maps. Emit only the contract keys — no GitLab field-name leak. Replace `GitLab_GetPrComments_ThrowsUnsupported` with a harvesting suite.

**Verification (high):** the provider unit suite (the tests below) + `check_test_adequacy` + the full MCP suite (`npm run test:run`) for cumulative regression. The cross-seam `assess_stack` integration is realized downstream in Task 009 (which depends on 007/008/010), not re-run here.
**Files:** `servers/exarchos-mcp/src/vcs/gitlab.ts`, `servers/exarchos-mcp/src/vcs/gitlab.test.ts`
**Expected tests:** `GitLab_GetPrComments_AggregatesNotesAndThreads`, `GitLab_GetPrComments_ClassifiesDiffNoteAsReviewInlineWithPathLine`, `GitLab_GetPrComments_MapsResolvableDiscussionTriState`, `GitLab_GetPrComments_LeavesResolvedAbsentOnNonResolvableNote`, `GitLab_GetPrComments_ThreadsRepliesByParentId`, `GitLab_GetPrComments_PaginatesBeyondFirstPage`, `GitLab_GetPrComments_EmitsOnlyContractKeys`, `GitLab_GetPrComments_LeavesResolvedAbsentOnMissingResolutionField`
**Dependencies:** 002 (same file `gitlab.ts`)
**Parallelizable:** Yes (vs. 008)

#### Task 008: Implement `AzureDevOpsProvider.getPrComments` (two-source `PrComment` parity)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-4, DR-5

Harvest ADO PR comment threads via `az devops invoke --area git --resource pullRequestThreads` (there is **no** `az repos pr` thread-list subcommand). The invoke needs `project` + `repositoryId` + `pullRequestId`; resolve `repositoryId`/`project` first (e.g. `az repos pr show`), since the provider's `_config` does not carry them. **Classify** per thread: a thread with `threadContext` (file/line) → `source: 'review-inline'` with `path`/`line`; otherwise `source: 'issue-comment'`. **Compose a PR-unique numeric `id`**: ADO comment ids are sequential *within a thread* (and `parentCommentId` is per-thread), so map `id`/`parentId` from a stable thread-scoped composition (e.g. `threadId * BASE + commentId`) — a raw `comment.id` collides across threads and would corrupt `assess_stack`'s `${prNumber}:${c.id}` idempotency keys (`assess-stack.ts:173/185`) and `parentId` threading. Filter **system threads** (`commentType: 'system'`). Map the **full** `CommentThreadStatus` enum to tri-state `resolved`: decided (`fixed`, `closed`, `wontFix`, `byDesign`) → `true`; open (`active`, `pending`) → `false`; `unknown`/unrecognized/missing → absent (DR-5 per-field fail-soft). Emit only contract keys — no Azure field-name leak. Replace `AzureDevOps_GetPrComments_ThrowsUnsupported` with a harvesting suite.

**Verification (high):** the provider unit suite (below) + `check_test_adequacy` + the full MCP suite for cumulative regression. The cross-seam `assess_stack` integration is realized in Task 009.
**Files:** `servers/exarchos-mcp/src/vcs/azure-devops.ts`, `servers/exarchos-mcp/src/vcs/azure-devops.test.ts`
**Expected tests:** `AzureDevOps_GetPrComments_AggregatesThreads`, `AzureDevOps_GetPrComments_ClassifiesThreadContextAsReviewInlineWithPathLine`, `AzureDevOps_GetPrComments_ComposesPrUniqueIdsAcrossThreads`, `AzureDevOps_GetPrComments_ExcludesSystemThreads`, `AzureDevOps_GetPrComments_MapsDecidedStatusesToResolvedTrue`, `AzureDevOps_GetPrComments_MapsOpenStatusesToResolvedFalse`, `AzureDevOps_GetPrComments_ThreadsRepliesByParentId`, `AzureDevOps_GetPrComments_EmitsOnlyContractKeys`, `AzureDevOps_GetPrComments_LeavesResolvedAbsentOnUnknownStatus`
**Dependencies:** 003 (same file `azure-devops.ts`)
**Parallelizable:** Yes (vs. 007)

#### Task 010: Narrow the `requiresGitHub` gate in `assess_stack` to enable GitLab/ADO

**Risk Tier:** medium
**Boundary Touching:** true (changes `assess_stack` behavior for non-GitHub providers — the INV-6 provider-posture seam)
**Implements:** DR-3, DR-4

Remove the `requiresGitHub(provider, 'assess_stack')` call from `handleAssessStack` (`assess-stack.ts:494`) so an injected GitLab/ADO provider reaches the harvest. Safe because every provider call in the handler is either supported for those providers (`checkCi`, `getReviewStatus`, `getPrComments`) or already fail-soft (`listPrs` via `queryPrMergeState` → try/catch → `null`; `checkCi`/`getReviewStatus` query helpers also catch → `[]`). **Known partial-enablement (acceptable):** because `listPrs` throws for GitLab/ADO, `queryPrMergeState` returns `null`, so merge-detection (`shepherd.completed`) cannot fire for those providers — an enabled loop runs to its iteration bound rather than auto-completing on merge. This violates no DR acceptance (comment-surfacing, the goal, works); `listPrs` enablement is the scoped-out follow-up (#1592 child). Leave `requiresGitHub` in `check_pr_comments`/`validate_pr_stack`. Update any existing test that asserts `assess_stack` skips a non-GitHub provider to assert it now proceeds.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/orchestrate/assess-stack.ts`, `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
**Expected tests:** `AssessStack_NonGitHubProvider_ProceedsNotSkipped` (replaces any prior `_Skipped` assertion)
**Dependencies:** 007, 008
**Parallelizable:** No

#### Task 009: Integration — GitLab/ADO comments surface via `assess_stack` (harvest loop branch-free, INV-6)

**Risk Tier:** medium
**Boundary Touching:** false (test-only; the boundary change is Task 010)
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
- [x] Ready for `plan-review` — **survived** a 4-round dispatched adversarial pass (rounds 1–3 refuted → revised; round 4 both voters `survives`)
