# Semantic Merge Queue PRD — Discovery Audit & Revised Design

**Date:** 2026-05-14
**Status:** Discovery — feeds future implementation planning
**Workflow:** `semantic-merge-queue-audit` (discovery)
**Input artifact:** `docs/references/Semantic_Merge_Queue_PRD.pdf` (v Draft / Review)
**Lens:** `axiom:design` (DIM-1..DIM-8, generic) + Exarchos invariants (INV-1, INV-3, INV-4, INV-5a..d) applied analogically
**Note on invariants:** The Exarchos invariants codify decisions for *Exarchos*. For an external CI system PRD they are not strictly normative; they are used here as a project-tested design lens because the cross-cutting concerns (event-sourced decision audit, capability-aware tool use, platform-agnosticity, agent-first interface contracts) transfer cleanly to the merge-gate domain.

---

## 1. Executive verdict

**Conditional pass with required revisions.** The PRD's *thesis* — bisect every PR into a fast classifier and a heavy E2E phase, run only what is needed — is sound and well-grounded in current merge-queue practice. The *implementation* as drafted has six load-bearing gaps that will either silently regress mainline or fail to deliver the promised cost reduction:

1. **No failure-mode policy** for the gatekeeper. A Phase 1 timeout, 5xx, malformed JSON, or rate-limit response has no documented behavior. Whatever the script defaults to is the *de facto* policy — defaulting to `false` ships untested code; defaulting to `true` makes the LLM optional. (DIM-2, DIM-7)
2. **Output contract is one bit** (`requires_e2e: bool`) where it needs ~50 (decision, confidence, rationale, fallback reason, prompt + model IDs, suggested test scope). Without a structured envelope, calibration, audit, and self-correction are impossible. (DIM-3, INV-5b)
3. **No calibration plan.** The PRD names a "dry-run analysis on historical closed PRs" as a Next Step but does not define the gold set, the threshold, the false-negative budget, or the re-baselining cadence when the model snapshot changes — which it will. (DIM-4)
4. **Single-vendor LLM judge with no pinning.** "Claude 3 Haiku" is not a versioned identifier in 2026; you must pin a snapshot ID and run judge-vs-judge calibration on a schedule. The published research on LLM-judge drift says this is the difference between a measurement and a story. (DIM-3, DIM-4, INV-3)
5. **Resilience against the load bearing surfaces is unaddressed.** Anthropic API rate limits (Tier-4 caps), ACA Jobs cold-start (P95 ≈ 22s even for hello-world), 7-GB-image pull dominating any NuGet-cache savings, no timeout on the gatekeeper call, no graceful degradation. (DIM-7)
6. **Phase 2 is monolithic.** "All E2E = Claude Code via Aspire" puts agentic test execution on the critical path of every gated PR. Some E2E should remain deterministic Playwright; the LLM-driven flow should be additive for novel journeys, not the replacement for the catalog. (DIM-4, DIM-6)

The revised design (§5) keeps the two-phase thesis, adds a deterministic Tier 0 ahead of the LLM (folding in Buildkite's native `if_changed`), upgrades the output contract to a structured envelope, persists gate decisions as events for audit/replay/calibration, pins judges, makes failure modes explicit in policy, and decouples the "decide" step from the "emit pipeline" step. Net effect on the PRD's success metrics: the 60 % cost-reduction claim becomes defensible (and can be measured); merge velocity is no longer at the mercy of the Anthropic API's tail latency; mainline stability gets an audit trail that survives staff turnover.

---

## 2. What the PRD gets right (anchor before critique)

The audit below is corrective, not dismissive. The PRD makes several genuinely good calls:

- **Two-phase gate is the correct shape.** Splitting "do we need E2E?" from "run E2E" maps cleanly to current merge-queue practice ([merge-queue.academy on speculative checks](https://merge-queue.academy/features/speculative-merging/) explicitly recommends "a lightweight PR CI check before PRs even enter the queue — catching obvious failures early reduces costly cascade restarts").
- **Speculative-merge testing is right.** Testing against `head_sha` (PR + base + ahead-of-queue PRs) is the only way to catch integration regressions; per [GitHub merge-queue docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), the `merge_group` webhook surfaces this commit explicitly.
- **`merge_group` webhook trigger** (not `push`) is the right integration point. Required-status-check semantics depend on it.
- **Buildkite dynamic pipeline upload** is the correct mechanism for conditional Phase 2 ([Buildkite SDK docs](https://buildkite.com/docs/pipelines/configure/dynamic-pipelines/sdk)).
- **Custom "fat" agent image** is correct in spirit — runtime installs are a known cold-start tax — but the size is unaddressed (§4 below).
- **NuGet via Premium Azure Files SMB share** has documented latency wins ([Microsoft SMB performance docs](https://learn.microsoft.com/en-us/azure/storage/files/smb-performance) — metadata caching cuts >30% on metadata-heavy workloads).
- **Edge-case section exists.** Most CI PRDs ship without one.

These choices are kept in the revised design.

---

## 3. Findings by axiom dimension

Severities follow axiom's HIGH/MEDIUM/LOW vocabulary. Each finding cites the PRD section and proposes the discrete change required to clear it.

### DIM-1 Topology

| Sev | Finding | PRD ref | Required change |
|---|---|---|---|
| **HIGH** | The gatekeeper is a single point of failure for *every* merge with no documented fallback policy. If `evaluate-diff.sh` errors, Buildkite either (a) defaults to `false` (silently ships untested), (b) defaults to `true` (gates work but cost-savings collapse), or (c) errors out (merge queue blocks for everyone). The PRD does not say which. | §3 Phase 1 | Make the policy explicit and machine-readable: on timeout/5xx/malformed-output → emit `decision: "run_e2e"` + `fallback_reason: "<cause>"` event, never `false`. |
| **HIGH** | No single source of truth for the gate *decision*. The verdict lives ephemerally in script stdout that becomes pipeline YAML. After-the-fact ("which PRs in the last 30 days skipped E2E and what changed?") requires log archaeology, not a query. | §3 Phase 1 | Persist every gate evaluation as an immutable event (see §5.2). |
| **MEDIUM** | The "hardcode specific paths to bypass the LLM" mitigation creates a dependency cycle: the path list lives in CI config (the same surface being gated), so a change to the path list runs through the gate it is supposed to inform. | §5 mitigation | Move always-run rules to a separate, version-controlled artifact (`.merge-gate.yml`) loaded by the gatekeeper; treat changes to it as auto-`run_e2e`. |
| **MEDIUM** | Lifecycle ownership of the prompt is unspecified. Inline in `evaluate-diff.sh`? Separate file? Versioned with code under test or with CI infra? | §3 Phase 1 | Prompt is a versioned artifact (`prompts/merge-gate@v3.md`) with a `prompt_id` field in every event. |

### DIM-2 Observability

| Sev | Finding | PRD ref | Required change |
|---|---|---|---|
| **HIGH** | A `false` decision emits no signal beyond "didn't run E2E." When a regression slips, post-mortem cannot reconstruct *why* the gate skipped — there is no rationale, no confidence, no classification stored. | §3 Phase 1 | Structured output (§5.3) carrying rationale + confidence + risk_signals; persist via §5.2. |
| **HIGH** | The Phase 2 mitigation for non-determinism ("strict contextual constraints") has no observability counterpart: which user journey did Claude actually walk? Which DOM paths were exercised? Without that, flake triage is impossible. | §5 mitigation | Capture Claude Code's `--output-format stream-json` event log per run; store `tool_use` and `tool_result` events keyed by `head_sha`. |
| **MEDIUM** | No dead-letter / quarantine path. Phase 1 errors → ?; Phase 2 errors → ?; LLM returns malformed JSON → ?. | §3, §5 | Define a `merge-gate-errors` Buildkite annotation + Slack channel + auto-open GitHub issue when a gate's `fallback_reason ≠ null`. |
| **LOW** | No `_perf` capture (call latency, token count, cache hit rate). Without it the optimization headroom is invisible. | §3 Phase 1 | Include `{ms, input_tokens, output_tokens, cache_read_tokens}` in every event. |

### DIM-3 Contracts

| Sev | Finding | PRD ref | Required change |
|---|---|---|---|
| **HIGH** | Output schema is a 1-bit boolean where you need ~50 bits (decision enum, confidence, rationale, classification, risk signals, suggested journeys, fallback reason, schema version, prompt + model IDs, perf). | §3 Phase 1 ("deterministic boolean: requires_e2e") | Adopt the structured envelope in §5.3; validate with Zod / JSON Schema on the receiving side. |
| **HIGH** | "Claude 3 Haiku" is not a pinned identifier. The published research on judge drift ([Pan, *LLM-as-Judge Drift*, 2026](https://tianpan.co/blog/2026-04-23-llm-judge-drift-evaluator-upgrade-phantom-regression)) is explicit: "pin judges by snapshot ID, version their configuration alongside the candidate's, calibrate judge-vs-judge on a schedule." | §3 Phase 1 | Pin `claude-haiku-4-5-20251001` (or the snapshot of choice) in config; never auto-upgrade; record `model_id` in every event. |
| **MEDIUM** | Speculative-merge diff base is implicit. PRD says "git diff of the speculative merge commit" — but `git diff` requires two refs. The webhook payload provides both `merge_group.head_sha` (the speculative merge) and `merge_group.base_sha` (the merge target before this group). Using `HEAD~1` is wrong when multiple PRs share a merge group. | §3 Phase 1 | `git diff $BASE_SHA..$HEAD_SHA` where both come from the webhook payload, not git heuristics. |
| **MEDIUM** | No prompt-versioning contract. Prompt evolution is invisible to anyone reading historical decisions. | §3 Phase 1 | `prompt_id` + `prompt_version` in event; semver bumps require re-baselining (§5.5). |

### DIM-4 Test Fidelity

| Sev | Finding | PRD ref | Required change |
|---|---|---|---|
| **HIGH** | No defined eval methodology. Next-Step #3 says "dry-run analysis on historical closed PRs to tune accuracy and false-negative rates" — but there is no labeled gold set, no agreement metric, no false-negative budget, no re-baselining trigger. | §6 Next Steps | Build a stratified gold set of 100–200 manually labeled closed PRs (positive: verified-needed-E2E; negative: verified-safe-skip; with risk-class strata). Define agreement target (≥0.85 against gold), F1 floor on the negative class, and a quarterly re-eval cadence. |
| **HIGH** | "Hardcoded specific paths" as the *only* false-negative mitigation is brittle: doesn't scale, can't anticipate novel high-risk patterns, and conflates two surfaces (LLM prompt + CI config). | §5 mitigation | Three-tier ladder (§5.1): deterministic always-run (Tier 2) is a separate decision step *before* the LLM is called, not a sentence in the prompt. |
| **HIGH** | Phase 2 homogenization. "All E2E = Claude Code via aspire start" puts agentic test execution on the critical path of every gated PR. Not all journeys benefit from agent flexibility; some should remain deterministic Playwright (faster, debuggable, lower variance). | §3 Phase 2 | Run the Aspire host once; execute the *deterministic* journey catalog first (xUnit `IClassFixture` style, `WaitForResourceCleanup=false`); only invoke Claude Code for journeys not yet codified or for "exploratory" suggested by the gatekeeper's `suggested_journeys`. |
| **MEDIUM** | Aspire AppHost teardown can dominate test time ([dotnet/aspire#10280](https://github.com/dotnet/aspire/issues/10280)). PRD doesn't mention `WaitForResourceCleanup=false` or any Aspire-specific tuning. | §3 Phase 2 | Use `Aspire.Hosting.Testing` `DistributedApplicationTestingBuilder`; share AppHost across tests in a class; opt out of `WaitForResourceCleanup` where idempotency holds. |

### DIM-5 Hygiene

| Sev | Finding | PRD ref | Required change |
|---|---|---|---|
| **MEDIUM** | "Fat" agent image (.NET SDK + Aspire workloads + Claude Code CLI + agent binaries) is plausibly 2–5 GB. ACA Jobs do not cache images locally ([azure-container-apps#1111](https://github.com/microsoft/azure-container-apps/issues/1111) — 7 GB image takes ~5 min to pull *each time*, even with ACR Premium). The Premium SMB cache mitigates NuGet but **not image pull**. | §4.1 | Layered image strategy: (a) `merge-gate-base:YYYYMMDD` with .NET SDK + Aspire workloads (slow-changing, large), (b) `merge-gate-tip:HEAD` with Claude Code CLI + scripts (fast-changing, small). Use ACR pull-through; pre-warm via scheduled Phase 2 jobs. |
| **MEDIUM** | The PRD's `evaluate-diff.sh` reinvents path-based filtering. Buildkite ships [`if_changed`](https://buildkite.com/docs/pipelines/configure/dynamic-pipelines/if-changed) as an agent-applied attribute that does this natively at upload time without an LLM call. | §4.2 | Tier 0 of the revised design uses `if_changed` for the deterministic 70%; the LLM only sees the residual ambiguous diffs. |
| **LOW** | Two-queue (`lightweight-aca` + `heavy-aca`) is correct, but the PRD doesn't describe deprecation criteria. When does the heavy queue shrink as Tier 1 absorbs more cases? | §3, §4.2 | Define a quarterly review checkpoint: if `decision: "skip"` rate stays ≥ 70% for two quarters, evaluate halving heavy-aca min-replicas. |

### DIM-6 Architecture

| Sev | Finding | PRD ref | Required change |
|---|---|---|---|
| **HIGH** | Decision authority is owned entirely by CI infra (`evaluate-diff.sh`). Product code cannot signal "this change definitely needs E2E" via, e.g., a commit trailer (`Test-Affects: e2e`) or a CODEOWNERS-style annotation. The gate-decision contract is one-way: CI tells product. | §3, §4.2 | The decision step accepts inputs from both surfaces: (a) CI heuristics (path globs, diff size), (b) product signals (commit trailers `Test-Affects: e2e \| skip`, `.merge-gate.yml` overrides per directory). Trailers always win. |
| **MEDIUM** | Tight coupling to four vendors with no abstraction or escape hatch. Switching any of {Buildkite, ACA, Anthropic, Aspire} is a rewrite. | §3, §4 | Name the seams in design (even if you ship a single implementation): `GateDecider` interface (Anthropic Haiku impl), `EnvProvisioner` (Aspire impl), `JourneyRunner` (Playwright + Claude Code impls). Future vendor swaps become mechanical. |
| **MEDIUM** | `evaluate-diff.sh` conflates two responsibilities: *decide* and *emit Buildkite YAML*. They should be separable so the decider can be tested in isolation, mocked, and reused outside Buildkite. | §4.2 | `gate-decide` (pure function: webhook + diff → JSON envelope) + `gate-emit` (envelope → Buildkite YAML). |
| **LOW** | "Two-step CI" sequencing. Per [merge-queue.academy](https://merge-queue.academy/features/speculative-merging/), a lightweight PR-level CI before the merge queue reduces cascade-restart cost. The PRD jumps straight to in-queue gating. | §3 | Add a pre-queue CI (lint, build, unit) running on the PR branch before the PR is enqueued. |

### DIM-7 Resilience

| Sev | Finding | PRD ref | Required change |
|---|---|---|---|
| **HIGH** | No timeout on the Phase 1 LLM call. Unbounded hang = merge queue blocked indefinitely. | §3 Phase 1 | `--max-turns 1`, request-level timeout (default 5s), Buildkite step timeout 60s. On timeout: `decision: "run_e2e"`, `fallback_reason: "model_timeout"`. |
| **HIGH** | Anthropic rate limits unmodeled. Tier-4 ceiling is [4,000 RPM / 400 k TPM for Sonnet](https://docs.anthropic.com/claude/reference/rate-limits); a merge train of 30 PRs queued at once burst-fires 30 Phase 1 calls. The "Buildkite concurrency on heavy-aca" mitigation (PRD §5) protects Phase 2, not Phase 1. | §5 mitigation | (a) Concurrency cap on `lightweight-aca` queue too. (b) Use prompt caching: cache the system prompt (1-hour TTL) so cached input bills at 0.1× and counts at 0.1× toward TPM. (c) Configure `service_tier: "auto"` to fall through to Standard when Priority is exhausted. (d) Exponential backoff with jitter on 429. |
| **HIGH** | ACA Job cold-start ≈ 22 s P95 *for hello-world* per [azure-container-apps#997](https://github.com/microsoft/azure-container-apps/issues/997?timeline_page=1); a "lightweight" agent image will be worse. The "fast" Phase 1 is not fast on cold start. | §4.1 | (a) Keep `lightweight-aca` `min-replicas: 1` (always warm) instead of scale-to-zero. (b) Image-pull baseline for the smaller tip image. (c) Custom liveness probe per [Microsoft cold-start guidance](https://learn.microsoft.com/en-us/azure/container-apps/cold-start) so ACA doesn't kill slow starts. |
| **HIGH** | No graceful degradation policy. When the gatekeeper is down end-to-end, what should the merge queue do? Options: hold all merges, fall through to "run E2E always" (cost spike but safe), feature-flag bypass. | §3, §5 | Document the policy: hard outage → `decision: "run_e2e"` with `fallback_reason: "judge_unavailable"`; alert. Operator override via `.merge-gate.yml`'s `emergency_skip: true` flag. |
| **MEDIUM** | Diff-in-prompt for large PRs. A 10 k-LOC PR can blow through 100 k tokens per call. With prompt caching, the system prompt can be cached but the diff cannot. | §3 Phase 1 | Diff-summarization step (count files/lines per type, top-K hottest paths) before the LLM call; LLM sees a structured digest plus diff excerpts of changed-test files, not the raw 100 k-token blob. Bounds cost per call. |
| **MEDIUM** | No retry policy on Phase 2 transient infra errors (Aspire startup race, container pull timeout). | §3 Phase 2 | One automatic retry of Phase 2 on transient classes; never on test-failure classes. |

### DIM-8 Prose Quality

| Sev | Finding | PRD ref | Required change |
|---|---|---|---|
| **LOW** | Mild inflation: "deeply nested backend interface changes," "strict contextual constraints," "Bring Your Own Compute model." Acceptable; not chatbot-flavored. | throughout | None required. |
| **LOW** | Several mitigations are aspirational rather than concrete ("the prompt for the Phase 1 LLM must default to true if confidence is low" — but `requires_e2e: bool` has no confidence channel). The PRD's prose contradicts the PRD's schema. | §5 | Resolved by §5.3 envelope. |

---

## 4. Findings by Exarchos invariant (analogical mapping)

These invariants codify Exarchos design choices; they are applied here because the cross-cutting concern transfers, not because the PRD is constitutionally bound by them.

### INV-1 Event-sourcing integrity (analogical) — MEDIUM-HIGH

The PRD's gate decision is a transient log line. The same two reasons Exarchos enforces event-sourcing apply here:

- **Audit + replay.** Calibration requires a corpus of `(input_diff, decision, outcome)` triples. Without persisted events, there is no calibration. Greg Young: events are immutable facts you can re-fold for any analysis you didn't anticipate.
- **Compensating-event semantics.** When a post-merge regression is traced to a skipped-E2E PR, you want to emit `merge_gate.decision_overruled` against the original event so the calibration loop sees the negative. PRD has nowhere to record this.

Per the [Microsoft Azure Architecture Center *Event Sourcing pattern*](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing), the event store should be append-only with intent-named events. Map: `merge_gate.evaluated`, `merge_gate.bypassed_deterministic`, `merge_gate.escalated_to_human`, `merge_gate.decision_overruled`.

Implementation cost is small: a single SQLite/Cosmos table or NDJSON file in blob storage, indexed by `head_sha`.

### INV-3 Capability-aware tool use — MEDIUM

The PRD's Phase 2 invocation `aspire start & claude-code --prompt 'Verify checkout flow'` does not use the spec-defined Claude Code CLI flags that exist precisely for CI:

- `--bare` ([code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless.md)) — skips auto-discovery of hooks, MCP servers, plugins, CLAUDE.md. Recommended for CI determinism.
- `--output-format json` or `stream-json` — without this you cannot parse Phase 1's output reliably.
- `--max-turns N` — bounds runaway loops.
- `--dangerously-skip-permissions` — required for non-interactive runs ([Claude Codex headless guide](https://claude-codex.fr/en/advanced/headless-ci/)).
- `--include-hook-events` + `--include-partial-messages` — required if the dashboard described in §3 Phase 2 wants live progress.
- `--append-system-prompt` — preserves Claude Code's safety/coding defaults; use this rather than `--system-prompt` (which replaces them).

The structured prompt + `--output-format json` combination is what makes the LLM-as-judge contract enforceable. The PRD should require it.

### INV-4 Platform-agnosticity — MEDIUM

The PRD treats Buildkite + ACA + Anthropic + Aspire as constitutional. Even if you intend to ship a single implementation, naming the seams in the design makes future migrations mechanical instead of catastrophic. Three logical roles:

- **`GateDecider`** — input: `(base_sha, head_sha, diff_digest, signals)` → output: structured envelope. Default impl: Anthropic Haiku via Claude Code CLI. Alt impls: a local distilled classifier, a Random Forest baseline (the [Fregnan et al. supervised classifier](https://link.springer.com/content/pdf/10.1007/s10664-021-10075-5.pdf) hits AUC > 0.91 on review-change classification — useful as a deterministic shadow), or a different LLM provider.
- **`EnvProvisioner`** — input: `(commit_sha, env_spec)` → output: live URL + teardown handle. Default: Aspire AppHost on ACA. Alt: bare Docker Compose, kubectl-based, hosted preview env.
- **`JourneyRunner`** — input: `(env_url, journey_spec)` → output: pass/fail + artifacts. Default: Aspire test fixture for catalog journeys + Claude Code for novel ones. Alt: pure Playwright.

These don't need to be polymorphic interfaces if YAGNI is in play, but they should at least be three named scripts/binaries with stable inputs/outputs.

### INV-5a Tool-input ergonomics (applied to the gatekeeper prompt) — MEDIUM

The prompt is described as "a fast LLM processes the diff." That is severely under-specified. Per [Anthropic's *Define tools* and *Writing effective tools for agents*](https://www.anthropic.com/engineering/writing-tools-for-agents), the prompt should:

- Be 3–4+ sentences describing the gate's purpose and what it explicitly is NOT for ("do NOT use for security review").
- Include an output schema (JSON) with each field documented.
- Provide 3–5 worked input/output examples covering canonical positives, canonical negatives, and the ambiguous boundary cases.
- Use enums over free-text where possible (`decision: "skip" | "run_e2e" | "run_e2e_focused" | "escalate_human"`).
- Be poka-yoke: bias toward `run_e2e` on ambiguity (per the §3 DIM-3 / DIM-4 findings on over-correction risk).

Critically, Tian Pan and the [arXiv overconfidence paper](https://arxiv.org/html/2508.06225v2) both warn: **complex prompts can *increase* false-negative rate** by inviting the model to manufacture concerns. Short, schematic prompts with explicit examples beat long discursive instructions.

### INV-5b Spec-aligned output contract — HIGH

This is the load-bearing finding for the entire PRD. The full envelope is in §5.3 below.

### INV-5c Aspire-inspired control-plane verbs (applied) — MEDIUM

The Phase 2 invocation is a fire-and-forget shell command. There is no `wait`, no `describe`, no `--format json`. An operator (or downstream agent) wanting to observe or steer cannot. Three small additions:

- `gate ps --merge-group=<id>` — what's the current state of decisions in flight.
- `gate describe --head-sha=<sha>` — for a given SHA, what was the decision, the rationale, the model_id.
- `gate replay --head-sha=<sha>` — re-run the gatekeeper on the same diff with the current prompt + model, return the new envelope without affecting the merge queue. This is the workhorse for calibration and prompt-iteration sessions.

---

## 5. Revised design

### 5.1 Three-tier ladder (replaces the binary gate)

```
┌──────────────────────────────────────────────────────────────────────┐
│ merge_group webhook → gate-decide                                    │
└──────────────────────────────────────────────────────────────────────┘
                          │
            ┌─────────────┴───────────────┐
            │                             │
            ▼                             │
   ┌──────────────────┐                   │
   │ Tier 0: deterministic                │
   │   Buildkite if_changed +             │
   │   .merge-gate.yml glob rules         │
   │                                      │
   │   Matches → emit `decision: "skip"`  │
   │   Always-run paths → "run_e2e"       │
   └──────┬───────────────────────────────┘
          │ unmatched
          ▼
   ┌──────────────────────────┐
   │ Tier 1: LLM-graded       │
   │   Pinned Haiku snapshot  │
   │   System prompt cached   │
   │   Diff digest, not raw   │
   │   Structured envelope    │
   │                          │
   │   confidence ≥ θ → use   │
   │   confidence <  θ → run  │
   │   ambiguous              │
   │   classifications →      │
   │   "escalate_human"       │
   └──────┬───────────────────┘
          │
          ▼
   ┌──────────────────────────┐
   │ Tier 2: enforced E2E     │
   │   Aspire AppHost         │
   │   Catalog journeys first │
   │   (Playwright / xUnit)   │
   │   Claude Code only for   │
   │   suggested_journeys not │
   │   in catalog             │
   └──────────────────────────┘
```

**Distribution target (working assumption, must be measured against gold set):** 70 / 25 / 5. Tier 0 absorbs docs-only, lockfile, comment-only, generated-files, test-only-additions; Tier 1 handles the genuinely ambiguous middle; Tier 2 always runs for paths in the always-run list.

### 5.2 Event-sourced gate decisions

Append-only log keyed by `head_sha`. Events:

| Event type | When | Key fields |
|---|---|---|
| `merge_gate.evaluated` | After every Tier 1 call | `head_sha`, `base_sha`, `tier`, `decision`, `confidence`, `rationale`, `risk_signals`, `suggested_journeys`, `prompt_id`, `model_id`, `_perf` |
| `merge_gate.bypassed_deterministic` | Tier 0 match | `head_sha`, `rule_matched`, `decision` |
| `merge_gate.escalated_to_human` | Tier 1 returns `escalate_human` or `confidence < θ` | `head_sha`, `cause`, `assigned_to` |
| `merge_gate.fallback_engaged` | Phase 1 timeout / 5xx / parse failure | `head_sha`, `fallback_reason`, `default_decision` |
| `merge_gate.decision_overruled` | Post-hoc when a regression is traced to a skipped PR | `original_head_sha`, `regression_id`, `corrected_label`, `noted_by` |
| `merge_gate.calibration_run` | Weekly cron output | `sample_window`, `agreement_rate`, `disagreement_count` |

Storage: SQLite locally for dev, Azure Cosmos DB or blob-stored NDJSON in production. Indexed by `head_sha` and `decision` and `model_id` (for cohort analysis when the snapshot rolls).

### 5.3 Output envelope (replaces `requires_e2e: bool`)

```json
{
  "schema_version": "merge-gate.v1",
  "decision": "skip" | "run_e2e" | "run_e2e_focused" | "escalate_human",
  "confidence": 0.0,
  "rationale": "Single-file change to docs/architecture.md; no code touched.",
  "diff_classification": "docs" | "test_only" | "refactor" | "feature" |
                          "infra" | "schema" | "config" | "mixed",
  "risk_signals": [
    "touches_payment_path",
    "modifies_db_schema",
    "adds_external_integration",
    "removes_test_coverage"
  ],
  "suggested_journeys": ["checkout", "billing-history"],
  "fallback_reason": null | "model_timeout" | "model_5xx" | "rate_limit" |
                      "malformed_output" | "low_confidence" | "judge_unavailable",
  "prompt_id": "merge-gate@v3",
  "model_id": "claude-haiku-4-5-20251001",
  "_meta": {
    "head_sha": "...",
    "base_sha": "...",
    "merge_group_id": "...",
    "evaluator_tier": 1
  },
  "_perf": {
    "ms": 1820,
    "input_tokens": 4823,
    "output_tokens": 187,
    "cache_read_tokens": 4612
  },
  "next_actions": [
    { "verb": "run_buildkite_pipeline",
      "pipeline": "heavy-e2e",
      "params": { "journeys": ["checkout"] } }
  ]
}
```

Validated by Zod on the receiving side. Any `fallback_reason ≠ null` short-circuits the `decision` field to `run_e2e`.

### 5.4 Failure-mode policy (machine-readable)

```yaml
# .merge-gate.yml (committed at repo root)
schema: merge-gate.v1
always_run:
  - 'src/payments/**'
  - 'src/auth/**'
  - 'migrations/**'
  - '**/*.bicep'
  - '.github/workflows/**'
always_skip:
  - 'docs/**'
  - '**/*.md'
  - 'CHANGELOG.md'
  - 'package-lock.json'
  - 'yarn.lock'
fallback_policy:
  on_timeout:        run_e2e
  on_5xx:            run_e2e
  on_malformed:      run_e2e
  on_rate_limit:     run_e2e   # never queue-block
  on_low_confidence: run_e2e   # threshold below
confidence_threshold: 0.70
emergency_skip: false           # operator break-glass; alerts on toggle
prompt_pin:  merge-gate@v3
model_pin:   claude-haiku-4-5-20251001
```

Trailers in the PR commit message override:

```
Test-Affects: e2e          # forces run_e2e
Test-Affects: skip-safe    # requires CODEOWNERS approval; goes through gate normally but biases skip-side
```

### 5.5 Calibration & evaluation

Three loops, three cadences:

1. **Quarterly gold-set re-eval.** 100–200 manually labeled closed PRs (stratified by risk class). Run the pinned gate against the gold; report precision, recall, F1 *on the negative class* (the one that matters — false negatives ship regressions). Block deploy of a new prompt or model snapshot until F1-neg ≥ 0.90 (or whatever floor the team picks).
2. **Weekly judge-vs-judge calibration.** A different model family (Claude Sonnet, or GPT, or Gemini) re-judges a stratified random sample of last week's gate decisions. Disagreement rate above the pre-registered floor → freeze gate-driven decisions until triage completes (per [LLM-as-Judge Drift](https://tianpan.co/blog/2026-04-23-llm-judge-drift-evaluator-upgrade-phantom-regression)).
3. **Continuous shadow-mode for first 4 weeks.** Always run E2E; log the gate decision side-by-side. Compare "would-have-skipped" against actual E2E outcomes. Only flip to gating after F1-neg on shadow data clears the floor.

Disagreement triage decision tree:

- Rubric ambiguous → fix the prompt; re-baseline against gold.
- One judge has known bias → document, weight accordingly, no upgrade.
- Genuine boundary case → mark category as `escalate_human`; require human approval.
- Never: "our judge is bad, upgrade it" — that re-introduces the drift you are trying to catch.

### 5.6 Phase 2 done right

```csharp
// Pseudo-code for the Phase 2 entrypoint
var builder = await DistributedApplicationTestingBuilder
    .CreateAsync<Projects.AppHost>(args, opts =>
    {
        opts.DisableDashboard = true;
        opts.AdditionalConfiguration["DcpPublisher:WaitForResourceCleanup"] = "false";
    });

await using var app = await builder.BuildAsync();
await app.StartAsync();
await app.WaitForResources().WaitAsync(TimeSpan.FromMinutes(5));

// Stage 1: deterministic catalog journeys (Playwright via xUnit fixture)
var catalogResults = await journeyCatalog.RunAll(app, suggestedJourneys);
if (!catalogResults.AllPassed) return Fail(catalogResults);

// Stage 2: agentic E2E only for journeys NOT in the catalog
foreach (var noveJourney in gateOutput.SuggestedJourneys.Except(catalog.Journeys))
{
    var result = await ClaudeCode.RunHeadless(new()
    {
        Bare = true,
        OutputFormat = "stream-json",
        IncludePartialMessages = true,
        IncludeHookEvents = true,
        MaxTurns = 20,
        DangerouslySkipPermissions = true,    // CI-only; container-isolated
        AppendSystemPrompt = e2eSystemPrompt, // not Replace
        Prompt = $"Verify journey: {noveJourney}. Constraints: {constraints}.",
    });
    LogStreamToBuildkite(result.StreamEvents); // live progress, not 3min of silence
    if (!result.Success) return Fail(result);
}
```

### 5.7 Caching layout that survives the failure modes

| Layer | Mechanism | Mitigates | Don't expect |
|---|---|---|---|
| **Source code** | `git clone --depth=20 --filter=blob:none` on the agent | History pull dominating clone | History to be reachable for `git log` |
| **NuGet** | Premium Azure Files SMB share + SMB Multichannel + metadata caching | `dotnet restore` cold cost | First-ever package fetch |
| **Aspire workloads + .NET SDK** | Pre-baked into `merge-gate-base:YYYYMMDD` image (rebuilt monthly) | Per-job SDK install | Image to be cached on the ACA host (it isn't) |
| **Claude Code CLI + scripts** | `merge-gate-tip:HEAD` thin layer atop base | Daily script churn | Image to be cached on the ACA host (it isn't) |
| **System prompt for gatekeeper** | Anthropic prompt caching, 1-hour TTL | TPM cost on hot loops | Cache to survive idle gaps |
| **Docker layers (test app)** | ACR pull-through cache | Build steps in tests | Free wins; layers still pull |
| **Pre-warming** | Scheduled "synthetic merge" job at 8am local | First-of-day cold-start tax | Genuine 24/7 zero cold-start |

### 5.8 Vendor-substitution table (for future-proofing, not an immediate switch)

| Role | Default | Alt today | Alt later |
|---|---|---|---|
| Orchestrator | Buildkite dynamic pipeline | GitHub Actions w/ `merge_group` trigger | Anything that consumes the webhook |
| Compute | ACA Jobs (KEDA event-driven) | GitHub-hosted runners (cheaper for Tier 1) | EKS/GKE/AKS jobs |
| Judge | Anthropic Haiku snapshot | Sonnet (slower, better) | Distilled classifier (Random Forest baseline @ AUC ≥ 0.91) for Tier 1 fast path |
| Test harness | .NET Aspire AppHost | Plain Docker Compose | Hosted preview-env service |
| Journey runner | Playwright + Claude Code | Cypress | Playwright-only (drop the agent) |

Marking these in design doesn't require building them; it pays the documentation tax once so a future replatform isn't a rewrite.

---

## 6. Implementation sequence (suggested phasing)

| Phase | Weeks | Deliverable | Gate to next phase |
|---|---|---|---|
| **A** | 1–2 | Tier 0 only: Buildkite `if_changed` rules + `.merge-gate.yml`. Measure baseline. | Distribution measured: % of PRs Tier 0 absorbs. |
| **B** | 3–4 | Gold set (100–200 labeled closed PRs); shadow-mode `gate-decide` running on the gold set offline; agreement metrics computed. | F1-neg ≥ 0.90 on gold set with chosen prompt + model snapshot. |
| **C** | 5–6 | `gate-decide` deployed in shadow mode (logs decisions; always runs E2E). Event-sourced audit log live. | One full week of shadow data; F1-neg ≥ 0.90 vs actual outcomes. |
| **D** | 7–8 | Flip to gating mode for high-confidence skips only (`decision == "skip" && confidence ≥ 0.85`). All other decisions still run E2E. | No regressions traced to a skipped PR for 2 weeks; mainline-stability metric unchanged. |
| **E** | 9–10 | Calibration cron + judge-vs-judge weekly + escalation path + commit trailers + emergency-skip flag. | Calibration runs green for 2 consecutive weeks. |
| **F** | 11–12 | Resilience hardening: timeouts, rate-limit handling, prompt cache, layered images, pre-warming. Cost/latency model published. | Cost-per-PR ≤ target; P95 gate latency ≤ target. |

This is a 12-week commitment; the PRD's "Next Steps" suggests something tractable in days. The latter is unrealistic for a system on the merge-blocking critical path.

---

## 7. Cost & latency model (back of envelope)

**PRD claim:** "Decrease unnecessary full-environment provisions by 60%."

**Sketch (replace with measured numbers after Phase A–B):**

Assume 100 PRs/day, current state = 100% run E2E, E2E cost ≈ $2/run, E2E latency ≈ 10 min wall + ~$0 LLM:

- **Today:** 100 × $2 = **$200/day**, P50 gate latency = E2E latency = ~10 min.
- **Tier 0 only (Phase A):** 70 PRs absorb at $0; 30 still run E2E; **$60/day**, P50 latency = 0 for skipped, 10 min for ran. Already a 70% reduction with no LLM.
- **Tier 0 + Tier 1 (Phase D+):** 70 absorbed; 25 hit Tier 1 (~$0.001 each cached, ~2s); 5 always-run + Tier-1-says-run = 30 actually E2E; **~$60.025/day** but P50 of the Tier-1 cohort drops to 2s.

The dominant cost-saver is **Tier 0**, which the PRD entirely conflates with the LLM. The LLM's win is on *latency for the ambiguous middle*, not on cost above what Tier 0 already achieves. This reframes the success metric: Tier 1 should be measured on `(P50 latency for ambiguous PRs)`, not `(% reduction in compute).`

**LLM cost ceiling:** Tier 1 at full burst (4,000 RPM) × Haiku pricing × (5 k cached + 200 output tokens) ≈ trivial vs. one E2E run. The real risk is rate-limit-induced queue blocking, addressed by §3 DIM-7 mitigations.

---

## 8. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LLM judge drift after a snapshot date or prompt change | High over 6mo | Silent regression slip-through | §5.5 calibration loops |
| Anthropic API outage during peak merge | Medium | Merge queue blocks or all PRs skip | §5.4 fallback policy + lightweight-aca concurrency cap |
| ACA cold-start tail blows P95 latency budget | High | Phase 1 is no longer "fast" | §5.7 pre-warming + min-replicas: 1 |
| Image pull (~5 min for fat agent) negates NuGet savings | High | "Fast" Phase 1 is 5+ min on a cold node | §5.7 layered images |
| False negative ships a payment-flow regression | Low if always-run honored | Customer-visible | §5.4 always-run list + §5.6 deterministic catalog runs first |
| Gold set rots as the codebase evolves | Certain over 6mo | Calibration metrics become misleading | Quarterly gold-set rebuild (10% replacement min) |
| Aspire AppHost teardown dominates Phase 2 cost | High | Cost target missed | `WaitForResourceCleanup=false` + per-class fixtures |
| `--dangerously-skip-permissions` allows malicious diff to escape sandbox | Low | Catastrophic | ACA Job runs in dedicated VNet with no egress beyond ACR + Anthropic + GitHub; commit-isolated workspace; ephemeral storage |
| Buildkite acquisition or pricing change | Low | Replatform | §5.8 vendor-substitution table |

---

## 9. Open questions

1. **What is the team's false-negative budget?** A defensible answer is "≤ 1 production-impacting regression traced to a skipped PR per quarter." Different answers change the confidence threshold materially.
2. **Who owns `.merge-gate.yml`?** CODEOWNERS pattern: `.merge-gate.yml @platform-team @qe-team`? Or per-directory ownership?
3. **Does the team have a labeled corpus from the existing Buildkite history?** If yes, the gold set is a few days of curation, not a few weeks of labeling.
4. **What's the Anthropic tier?** This sets the rate-limit ceiling and decides whether the prompt-cache strategy is enough. Tier 4 is comfortable; Tier 1–2 needs more aggressive caching + Batch API for non-blocking reanalysis.
5. **Aspire test coverage today?** If catalog journeys don't exist yet, Phase 2 is more aspirational than the PRD reads.
6. **Pre-merge CI strategy?** The PRD jumps straight to in-queue gating. Is there a PR-level CI today (lint, unit, build)? If not, in-queue gating eats failures that should have been caught earlier and cheaper.
7. **Self-hosted vs. ACA managed identity?** The Microsoft self-hosted-runner tutorials show ACA Jobs as event-driven CI runners ([tutorial-ci-cd-runners-jobs](https://learn.microsoft.com/en-us/azure/container-apps/tutorial-ci-cd-runners-jobs?pivots=container-apps-jobs-self-hosted-ci-cd-github-actions)). Has the team picked manual-trigger vs event-driven (KEDA)? The choice affects scale-to-zero behavior and cold-start tax.

---

## 10. Next step

After this discovery merges, the natural follow-up is `/exarchos:ideate semantic-merge-queue` (or the team's equivalent planning workflow) to produce a TDD plan from this report. The plan would deliver:

- `gate-decide` (TypeScript or Go binary, fully typed envelope).
- `gate-emit` (Buildkite YAML serializer).
- `.merge-gate.yml` schema + Zod validator.
- Event-store schema (Cosmos / SQLite / NDJSON; choose later).
- Calibration scripts (gold-set runner + judge-vs-judge cron).
- Aspire test fixture refactor (catalog-first journey runner).
- Buildkite pipeline templates for Tier 0 / Tier 1 / Tier 2.
- Layered Docker images + pre-warming cron.

---

## 11. Sources

### Input artifact
- `docs/references/Semantic_Merge_Queue_PRD.pdf` — the design under audit.

### GitHub merge queue
- [Managing a merge queue — GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) — `merge_group` webhook, `head_sha`/`base_sha` payload semantics, required-status-check integration.
- [Speculative Checks — Merge Queue Academy](https://merge-queue.academy/features/speculative-merging/) — speculation depth, cascade-failure economics, two-step CI rationale.
- [Merge group webhook event and GitHub Actions workflow trigger — GitHub Changelog](https://github.blog/changelog/2022-08-18-merge-group-webhook-event-and-github-actions-workflow-trigger/) — `merge_group` trigger GA history.

### Buildkite
- [Using conditionals — Buildkite Documentation](https://buildkite.com/docs/pipelines/conditionals) — conditional expressions evaluated at upload time.
- [Using `if_changed` — Buildkite Documentation](https://buildkite.com/docs/pipelines/configure/dynamic-pipelines/if-changed) — agent-applied `if_changed` for path-based deterministic gating.
- [Buildkite SDK — Buildkite Documentation](https://buildkite.com/docs/pipelines/configure/dynamic-pipelines/sdk) — multi-language SDK for generating dynamic pipeline steps.
- [Defining your pipeline steps — Buildkite Documentation](https://buildkite.com/docs/pipelines/defining-steps) — `buildkite-agent pipeline upload` semantics.

### Azure Container Apps
- [Reducing cold-start time on Azure Container Apps — Microsoft Learn](https://learn.microsoft.com/en-us/azure/container-apps/cold-start) — co-located registry, storage mounts for large files, custom liveness probes, scheduled wake-up.
- [Jobs in Azure Container Apps — Microsoft Learn](https://learn.microsoft.com/en-us/azure/container-apps/jobs) — manual / scheduled / event-driven trigger types.
- [Tutorial: Self-hosted CI/CD runners and agents with ACA Jobs — Microsoft Learn](https://learn.microsoft.com/en-us/azure/container-apps/tutorial-ci-cd-runners-jobs) — KEDA-driven event jobs as CI runners.
- [Use storage mounts in Azure Container Apps — Microsoft Learn](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts) — Azure Files SMB/NFS mount mechanics.
- [Improve SMB Azure File Share Performance — Microsoft Learn](https://learn.microsoft.com/en-us/azure/storage/files/smb-performance) — Premium SMB Multichannel + metadata caching gains.
- [azure-container-apps#1111 — Image cache request](https://github.com/microsoft/azure-container-apps/issues/1111) — community thread documenting ~5-min pulls of 7 GB images on ACA Jobs even with ACR Premium.
- [azure-container-apps#997 — 22 s cold start hello-world](https://github.com/microsoft/azure-container-apps/issues/997?timeline_page=1) — P5/P95 cold-start measurements.

### .NET Aspire testing
- [Testing overview — Aspire (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/aspire/testing/overview) — `Aspire.Hosting.Testing` and `DistributedApplicationTestingBuilder`.
- [Manage the AppHost in tests — Aspire (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/aspire/testing/manage-app-host) — per-class lifecycle, xUnit `IClassFixture`, NUnit `OneTimeSetUp`.
- [`DistributedApplicationTestingBuilder` API reference — Microsoft Learn](https://learn.microsoft.com/dotnet/api/aspire.hosting.testing.distributedapplicationtestingbuilder?view=dotnet-aspire-13.0).
- [dotnet/aspire#10280 — disposing AppHost takes longer than the test](https://github.com/dotnet/aspire/issues/10280) — `WaitForResourceCleanup` opt-out.

### Claude Code CLI
- [Run Claude Code programmatically (headless) — code.claude.com](https://code.claude.com/docs/en/headless.md) — `--print`, `--bare`, `--output-format`, recommended CI surface.
- [CLI reference — Claude Code Docs](https://docs.claude.com/en/docs/claude-code/cli-usage) — full flag reference (`--include-hook-events`, `--include-partial-messages`, `--input-format`).
- [Headless mode and CI/CD integration — Claude Codex](https://claude-codex.fr/en/advanced/headless-ci/) — `--dangerously-skip-permissions` recipe for CI.
- [Claude Code stream-json — Background Claude](https://backgroundclaude.com/blog/stream-json) — practical stream-json consumer patterns; live CI dashboards.

### Anthropic API
- [Rate limits — Claude API Docs](https://docs.anthropic.com/claude/reference/rate-limits) — RPM / ITPM / OTPM tiering; cache reads at 0.1× toward limits.
- [Service tiers — Claude API Docs](https://docs.anthropic.com/en/api/service-tiers) — Priority / Standard / Batch trade-offs.
- [Batch processing — Claude API Docs](https://docs.anthropic.com/en/docs/build-with-claude/message-batches) — Batches API with 1-hour cache TTL.
- [Claude API Rate Limits: Production Guide — ClaudeGuide](https://claudeguide.io/claude-api-rate-limits-production) — tier table and concurrency-budget patterns.

### LLM-as-judge research
- [LLM-as-Judge Drift — Tian Pan, 2026-04](https://tianpan.co/blog/2026-04-23-llm-judge-drift-evaluator-upgrade-phantom-regression) — pin judges by snapshot ID; weekly judge-vs-judge calibration; disagreement triage.
- [Overconfidence in LLM-as-a-Judge — arXiv 2508.06225v2](https://arxiv.org/html/2508.06225v2) — TH-Score metric; high-confidence-region calibration gaps.
- [Are LLMs Reliable Code Reviewers? — arXiv 2603.00539v1](https://arxiv.org/abs/2603.00539v1) — systematic over-correction; complex prompts increase false-negative rate.
- [Bias and Uncertainty in LLM-as-a-Judge Estimation — arXiv 2605.06939v1](https://arxiv.org/html/2605.06939v1) — shared-calibration pitfalls; per-model calibration superiority.
- [Two Ways to De-Bias an LLM-as-a-Judge — arXiv 2605.09227](https://arxiv.org/html/2605.09227) — small-anchor Bayesian + neural-ODE score transport.
- [MCTS-Judge — arXiv 2502.12468](https://arxiv.org/pdf/2502.12468) — test-time compute for code-correctness judging.

### Code-review classification baselines
- [Fregnan et al., *Predicting Review Comments — Empirical Study* (Springer EMSE, 2022)](https://link.springer.com/content/pdf/10.1007/s10664-021-10075-5.pdf) — supervised classification of review changes hits AUC > 0.91 (RF baseline).
- [Magistrate: orchestrating hybrid static and semantic analysis](https://openreview.net/attachment?id=V9pJJy2uRc&name=pdf) — Delegator + IssueDetector + Aggregator agent topology for PR analysis.
- [Hong et al., *Code Review Activity Prediction* — arXiv 2404.10703v2](https://arxiv.org/html/2404.10703v2) — RF beats off-the-shelf LLM for changed-file classification.

### Event sourcing (analogical foundation for §5.2)
- [Event Sourcing pattern — Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) — append-only, intent-named events, compensating events, schema-evolution toolkit.
- [Greg Young, *Why can't I update an event?*](https://www.eventstore.com/blog/why-cant-i-update-an-event) — immutability rationale.

### Internal references (for cross-project consistency)
- `docs/research/2026-05-07-design-invariants-skill.md` — Exarchos invariant catalog used as analogical lens.
- `~/.claude/plugins/cache/lvlup-sw/axiom/0.2.7/skills/backend-quality/references/dimensions.md` — DIM-1..DIM-8 dual-mode taxonomy.

---

## 12. Revision (2026-05-14, post-review) — compose with existing platform substrate

This addendum supersedes parts of §5 and §6. The original revised design (§5) treated each fix as a greenfield CI build. That assumption was wrong. Three primitives in the lvlup-sw stack already address most of what §5 proposed — the audit's *findings* (§3, §4, §1) still stand, but the *implementation path* must compose with these primitives, not run parallel to them.

### 12.1 Three primitives the original audit failed to leverage

| Primitive | Where it lives | What it provides |
|---|---|---|
| **Exarchos eval suite** | `servers/exarchos-mcp/src/evals/` (live) + #1365 elevation in v2.10.0 | `harness.ts`, `dataset-loader.ts`, `calibration-metrics.ts`, `calibration-split.ts`, `comparison.ts`, `deduplication.ts`, `auto-triage.ts`, `trace-capture.ts`, `graders/`, `reporters/`. CI-gated via `.github/workflows/eval-gate.yml`. #1365 ships versioned datasets, HTML dashboard, calibration drift gate, cross-runtime smoke coverage. |
| **Phronesis Code Review agent** in basileus | basileus #147 (open epic); architectural decision in basileus #146 | Think-Act-Observe-Reflect loop; **Thompson Sampling** strategy selection; **budget algebra** enforcement; **tiered reflection** with NLP Sidecar; **ExecutionProfile** (instructions + tool subset + RAG collections + quality gates — the natural home for "pinned judge"); Marten event sourcing for ReviewFinding events; OntologyContextAssembler + IReranker (Cohere) for context assembly; `review_findings` ObjectSet for historical grounding. |
| **Basileus Ontology MCP Server** | basileus ADR `2026-04-18-exarchos-basileus-coordination.md` §2.2; exarchos #1143 (`exarchos_sync` fabric actions, v3.1.0) | `/mcp/ontology` endpoint with `intent_register` action — the uniform invocation surface from exarchos (CI/dev workflow harness) into basileus (agent host). Findings flow back via `task.completed` / `intent.completed` events through Strategos.Contracts envelope, surfacing via Exarchos's NotificationPipeline (PiggybackSink/AsyncSink/ElicitationSink). |

### 12.2 The architectural rule the original audit missed

Basileus #146 makes this explicit: **review-triage with semantic scoring is agent-shaped work, and agent-shaped work belongs in the agent host (basileus), not the dev workflow harness (exarchos).**

The Semantic Merge Queue's Phase 1 ("semantic gatekeeper") is exactly this category: LLM reasoning over a diff, with structured output, optional reflection, finding emission. Building it as a custom CI handler with its own LLM call, output schema, event store, and calibration loop is the cross-repo split #146 explicitly rejected.

### 12.3 Mapping the §5 design onto the substrate

| §5 component | Original recommendation | Revised recommendation (composed) |
|---|---|---|
| **Tier 0 (deterministic)** | Buildkite `if_changed` + `.merge-gate.yml` globs | **Unchanged.** Stays in CI infra. No agent involvement. |
| **Tier 1 (LLM-graded)** | Custom `gate-decide` binary calling Anthropic API; structured envelope; pinned snapshot ID; fallback policy in YAML | **Phronesis Merge Gate ExecutionProfile** in basileus (either an extension of the Phronesis Code Review agent or a sibling profile). Invoked from CI via `exarchos_sync register_intent` (#1143). Pinned judge = pinned ExecutionProfile version. Fallback policy = Phronesis quality gate + tiered-reflection thresholds. |
| **Tier 2 (E2E)** | Aspire AppHost + catalog journeys + Claude Code for novel | **Unchanged in mechanics.** `suggested_journeys` come from the Phronesis agent's structured output rather than a custom envelope. |
| **Output envelope** (§5.3) | Custom `merge-gate.v1` JSON schema, Zod-validated | **Strategos.Contracts** envelope (existing, source-of-truth for cross-repo schemas). Phronesis's `ReviewFinding` event already carries severity + classification + rationale + confidence; extend with merge-gate-specific fields where genuinely missing. |
| **Event-sourced gate decisions** (§5.2) | New SQLite/Cosmos table; six event types | **Marten event sourcing in basileus** (already in production for Phronesis Code Review). New event types for merge-gate (`merge_gate.evaluated`, `merge_gate.bypassed_deterministic`, `merge_gate.fallback_engaged`, `merge_gate.decision_overruled`) registered alongside existing ReviewFinding events. Causal-attribution service (basileus #180, G6) handles the post-hoc "regression traced to skipped PR" reasoning. |
| **Calibration loops** (§5.5) | Custom gold set + custom judge-vs-judge cron + custom drift detection | **Plug into the existing eval suite** (`servers/exarchos-mcp/src/evals/`). New dataset: `evals/datasets/<date>-merge-gate.jsonl`. New graders under `servers/exarchos-mcp/src/evals/graders/merge-gate/`. Calibration-drift gate (#1365 step 3) becomes the merge-gate's drift gate. Judge-vs-judge agreement reuses `calibration-split.ts` + `calibration-metrics.ts` semantics. |
| **Pinned judge snapshot** | `model_pin: claude-haiku-4-5-20251001` in `.merge-gate.yml` | **Pinned ExecutionProfile version** in Phronesis. ExecutionProfile already carries instructions, tool subset, RAG collections, quality gates as a versioned bundle. Snapshot bumps go through Phronesis's existing version-management surface, not a CI-config knob. |
| **Confidence threshold + escalate_human** | `confidence_threshold: 0.70` in YAML; `escalate_human` decision branch | **Phronesis budget algebra + reflection tiers**. Low-confidence already triggers tiered reflection; budget exhaustion already escalates. The four-decision enum in §5.3 (`skip` / `run_e2e` / `run_e2e_focused` / `escalate_human`) becomes a structured outcome of the Phronesis loop, not a sentence in a prompt. |
| **Diff-digest pre-summarization** (§3 DIM-7) | Custom diff-summarization step before LLM call | **OntologyContextAssembler + IReranker** in Phronesis. The agent has access to `review_findings` ObjectSet, ontology graph, and Cohere reranker — the digest is the assembler's output, not bespoke prompt-engineering. |
| **Failure-mode policy** (§5.4) | YAML table mapping error class → fallback decision | **Phronesis quality gates** + `intent.completed` envelope's `_meta.degraded` field (already part of the standard Strategos.Contracts envelope per the v2.10 Output Contract work). Fallback to `run_e2e` when basileus is unreachable — handled by Exarchos's `basileusConnected` capability gate (existing pattern from the original Hybrid Review Strategy, retained as the disconnected fallback). |
| **`gate ps` / `gate describe` / `gate replay` verbs** (INV-5c finding) | New CLI verbs | **`exarchos_sync get_record` + `query_fabric`** (#1143) cover `describe` and `ps`. `register_intent` with the same input covers `replay`. No new verbs needed; the v3.1.0 Ontology fabric actions are the surface. |

### 12.4 Revised end-to-end flow

```
GitHub merge_group webhook
        │
        ▼
┌────────────────────────────────────────────────────────────────┐
│ Buildkite agent (lightweight)                                  │
│   1. Tier 0: Buildkite if_changed + .merge-gate.yml globs      │
│      Match → emit decision locally; done.                      │
│      No match → fall through to Tier 1.                        │
│                                                                │
│   2. exarchos sync register-intent --intent merge-gate \       │
│        --base-sha $BASE --head-sha $HEAD                       │
└──────────────┬─────────────────────────────────────────────────┘
               │ /mcp/ontology
               ▼
┌────────────────────────────────────────────────────────────────┐
│ Basileus Ontology MCP Server                                   │
│   IntentProposedHandler (Wolverine)                            │
│     - Process layer: PR + target branch + merge_group_id       │
│     - Domain layer: enrich via OntologyContextAssembler        │
│       (touched modules, owners, historical findings via        │
│       review_findings ObjectSet)                               │
│     - Dispatch → Phronesis Merge Gate ExecutionProfile         │
└──────────────┬─────────────────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────────────────┐
│ Phronesis loop (Think → Act → Observe → Reflect)               │
│   - Pinned ExecutionProfile (= pinned judge + prompt + tools)  │
│   - Budget algebra: hard cap on tokens/turns                   │
│   - Tiered reflection: low-confidence triggers deeper analysis │
│   - Quality gates: malformed/timeout → standardized degraded   │
│     envelope; never silent                                     │
│   - Emits MergeGateDecision event (Marten)                     │
│   - Causal attribution (G6) records inputs for post-hoc        │
└──────────────┬─────────────────────────────────────────────────┘
               │ task.completed / intent.completed
               ▼
┌────────────────────────────────────────────────────────────────┐
│ Buildkite agent (back in CI)                                   │
│   - Reads Strategos.Contracts envelope from intent.completed   │
│   - decision == "skip"            → exit 0; merge proceeds     │
│   - decision == "run_e2e"         → upload heavy pipeline      │
│   - decision == "run_e2e_focused" → upload heavy pipeline w/   │
│                                     suggested_journeys filter  │
│   - decision == "escalate_human"  → block; comment on PR;      │
│                                     ElicitationSink notifies   │
│   - _meta.degraded == true        → fall back to run_e2e       │
└────────────────────────────────────────────────────────────────┘
```

The flow has the same three tiers as §5.1, but Tier 1 is no longer a CI-local custom binary — it's a Phronesis ExecutionProfile invoked through the standard cross-repo coordination surface.

### 12.5 What changes in the §6 implementation sequence

The original sequence (12 weeks, all greenfield) is wrong if these primitives are available. The corrected sequence:

| Phase | Original (§6) | Revised (composed) |
|---|---|---|
| **A** (1–2w) | Tier 0 only via `if_changed` | **Unchanged.** Tier 0 is pure CI; lands first regardless. |
| **B** (3–4w) | Build gold set; offline shadow | **Build gold set as `evals/datasets/<date>-merge-gate.jsonl`**; plug into existing eval-gate workflow; baseline measured against existing harness conventions. |
| **C** (5–6w) | Custom `gate-decide` deployed in shadow mode | **Phronesis Merge Gate ExecutionProfile** authored in basileus (extends or sibling-of #147 Phronesis Code Review agent). Invoked from CI via `exarchos sync register-intent` running shadow-only (always run E2E, log decision). Depends on **#1143 (v3.1.0) `register_intent` action shipping**, which is the v3.1.0 critical path. |
| **D** (7–8w) | Flip to gating mode for high-confidence skips | **Same flip**, but the confidence/threshold lives in the Phronesis ExecutionProfile, not `.merge-gate.yml`. Eval-gate calibration drift detector (#1365 step 3) is the gating signal. |
| **E** (9–10w) | Calibration cron + judge-vs-judge + escalation | **Reuses #1365 step 3 calibration drift gate**. Judge-vs-judge is a stratified comparison via the existing `calibration-split.ts`. Escalation = ElicitationSink raising a notification through NotificationPipeline. |
| **F** (11–12w) | Resilience hardening | **Reduced scope.** Anthropic rate-limit + prompt-cache strategy belongs to basileus (Phronesis is the API consumer, not CI). CI-side resilience is just retry on `register_intent` and timeout on the response. ACA cold-start + image layering still apply to the Aspire-hosted Tier 2 runner, unchanged. |

**Net effect:** roughly the same calendar time, but the artifact list shifts from "build new CI infrastructure" to "author one ExecutionProfile + one eval dataset + one set of graders + one Buildkite glue script." Most of the building was already done in basileus and `servers/exarchos-mcp/src/evals/`.

### 12.6 What the original audit got right that survives the revision

The PRD's six gaps still hold. The fix path changes; the diagnosis doesn't:

| Gap | Original fix (greenfield) | Revised fix (composed) |
|---|---|---|
| #1 Failure-mode policy | YAML `fallback_policy` table | Phronesis quality gates + `_meta.degraded` envelope flag + Exarchos `basileusConnected` capability fallback |
| #2 Output contract impoverished | Custom `merge-gate.v1` Zod schema | Strategos.Contracts envelope + `MergeGateDecision` event extending `ReviewFinding` |
| #3 No calibration plan | Custom gold set + custom drift cron | New dataset under existing `evals/datasets/`; reuse `calibration-metrics.ts` + #1365 drift gate |
| #4 Unpinned judge | `model_pin` in YAML | Versioned ExecutionProfile in Phronesis |
| #5 Resilience gaps | CI-side mitigations for all | Phronesis owns the Anthropic-API resilience; CI owns ACA + Aspire mitigations |
| #6 Phase 2 monolithic | Two-stage Aspire (catalog + agentic) | **Unchanged.** This is genuinely CI-side. (Refined further in §13.) |

The original sections §5.1 (three-tier ladder), §5.6 (Aspire test orchestration done right), §5.7 (caching layout), and §5.8 (vendor seams) remain valid in their original form. §5.2 (event store), §5.3 (envelope), §5.4 (failure-mode policy), and §5.5 (calibration loops) are superseded by §12.3 above.

### 12.7 Open coordination questions

These weren't visible to the original audit because they hinge on basileus / exarchos roadmap state that wasn't in scope:

1. **Is the Phronesis Code Review agent (basileus #147) shipping with a Merge Gate profile, or does merge-gating need a sibling ExecutionProfile?** The agent's design round (`/exarchos:ideate` per #147) is the right venue.
2. **#1143 (`exarchos_sync register_intent`) is in v3.1.0 — is the merge-queue work also v3.1.0, or earlier with a temporary direct-HTTP fallback?** The honest answer is "wait for v3.1.0" if the merge-gate isn't urgent; otherwise the fallback is the deprecated direct-HTTP path from the original Hybrid Review Strategy, with an issue to migrate after #1143 lands.
3. **Causal attribution service (basileus #180, G6) — is it ready when the merge-gate calibration loop needs it?** The "post-hoc regression traced to skipped PR" event (`merge_gate.decision_overruled` in §5.2) depends on this surface for non-trivial trace-back.
4. **Strategos.Contracts envelope — does it carry the fields a merge-gate decision needs (`decision`, `risk_signals`, `suggested_journeys`)?** If not, the contracts repo gets a PR; this is the right place for the schema to live.
5. **Eval suite #1365 timing — steps 1–2 ship in v2.10.0 preview.3 (now); steps 3–5 ship later.** A merge-gate eval dataset can land on step-1-2 substrate; the drift gate (step 3) lands later. Decide whether the merge-gate goes live without drift gating or waits.

### 12.8 What the user told me that this addendum captures

> *"Gap 3 really needs a holistic eval suite/integration. ... if we need something this sophisticated, we ought to integrate with Basileus Phronesis."*

The structural critique is correct. The original audit committed two design errors:
1. **Reinvented the eval suite** — every "calibration / gold set / drift" recommendation in §5.5 should have been "plug into `servers/exarchos-mcp/src/evals/`" with the dataset and grader as the only new artifacts.
2. **Reinvented agent-shaped work in CI infra** — every "GateDecider / structured envelope / event-sourced decisions / pinned judge / confidence threshold" recommendation in §5 should have been "Phronesis ExecutionProfile invoked via Ontology MCP Server `register_intent`."

Both errors stem from auditing the PRD against the dimensions/invariants without first checking whether the platform substrate already covers the recommended fixes. The findings are still right; the architectural posture in §12 is the corrected fix.

---

## 13. Revision (2026-05-14, post-review #2) — Workflow Builder SDK as the deterministic backbone

§12 named three substrate primitives. There is a fourth, and it changes both Tier 1 and Tier 2: the **Exarchos Workflow Builder SDK** ([#1258](https://github.com/lvlup-sw/exarchos/issues/1258), v3.0.0).

### 13.1 What #1258 is and why it changes the architecture

The SDK is a fluent TypeScript authoring API that compiles to typed JSON IR shared with Strategos via `Strategos.Contracts` (#1125). In v3.0.0 it is the **only** way to define a workflow — closed-form `hsm-definitions.ts` is deleted (DIM-5 hygiene), and the legacy custom-tools surface (`exarchos.config.ts tools:` + `registerCustomTool`) is deprecated ([#1377](https://github.com/lvlup-sw/exarchos/issues/1377)).

Combinators in P3 (#1249) — Branch, Loop, Fork, Approval, Failure — are the building blocks for any "agent walks a sequence of states with guards and validators" use case. A `workflow-authoring` skill (P9 #1255) takes a natural-language brief and emits a `.workflow.ts`; power users hand-author the same file with full LSP feedback. Both produce the identical IR.

**The architectural rule this introduces:** any design that says "Claude Code walks through {checkout / payment / login} via prompt" is the v2.x pattern. The v3.0 pattern is:

1. Encode the journey as a workflow IR (`.workflow.ts`).
2. Claude Code (or a Phronesis ExecutionProfile) **executes** the workflow — each state's transition logic is deterministic; the agent fills only the inference slots the workflow declares.
3. Journeys not in the catalog are authored on the fly via the `workflow-authoring` skill, then committed as catalog entries — the catalog grows organically.

This is the structural answer to the PRD's §5 mitigation for E2E non-determinism ("strict contextual constraints in the test prompt"). Constraints in a prompt are documentation; constraints in a typed workflow IR are *enforcement*.

### 13.2 What this means for §12.4's flow

The §12.4 flow stays correct end-to-end. Two of its components get refined:

**Tier 1 (Phronesis Merge Gate ExecutionProfile).** The judge pipeline (ingest_diff → classify → assess_risk → propose_journeys → emit_envelope) is itself a sequence of state transitions with deterministic structure. Encode it as a workflow IR; the Phronesis ExecutionProfile *executes* that workflow rather than running a free-form prompt. The Strategos.Contracts cross-product schema round-trip (#1258 acceptance gate AT-C) is what makes this possible — the same IR the SDK emits is consumed by the basileus runtime.

**Tier 2 (E2E execution).** The PRD's §5 mitigation collapses into the SDK:

| §5.6 (original) | §13 (composed) |
|---|---|
| "Catalog journeys via xUnit `IClassFixture`" | Catalog journeys are `.workflow.ts` files committed under `evals/journeys/` (or wherever the team keeps them). |
| "Claude Code for novel journeys via `--prompt 'Verify journey: X'`" | Novel journey → `workflow-authoring` skill emits `<journey>.workflow.ts` → SDK runtime executes it (with Aspire as the env provisioner). The authored workflow becomes a permanent catalog entry. |
| "Provide strict contextual constraints in the test prompt" (PRD §5) | Constraints are typed states, transition guards, and per-state validators — enforced by the runtime, not requested by prose. |
| "Capture stream-json output for live progress" | Workflow events (`workflow.transition`, `workflow.state_entered`) are the event-sourced equivalent — same observability, integrated with the rest of the platform's event log. |

Practical consequence: the `suggested_journeys` field in the merge-gate envelope (§5.3, refined in §12.3) becomes `suggested_journeys: WorkflowRef[]`, where each ref is either a catalog workflow ID or a marker that triggers the authoring skill.

### 13.3 Worked sketch — checkout-flow as a workflow IR

Pseudo-code, not validated against the actual SDK signature (which lands in P2/P3):

```ts
// evals/journeys/checkout-flow.workflow.ts
import { workflow } from '@exarchos/sdk';
import type { E2EState } from './e2e-types';

export const checkoutFlow = workflow<E2EState>('checkout-flow')
  .meta({
    description: 'Verify the canonical happy-path purchase flow',
    invariants: ['payment-path', 'order-creation'],
    suggestedFor: ['payments/**', 'cart/**', 'orders/**'],
  })
  .initial('cart')

  .state('cart')
    .onEnter(async (ctx) => ctx.app.navigate('/cart'))
    .guard('hasItems', async (ctx) => (await ctx.dom.find('[data-cart-item]')).length > 0)
    .transition('checkout', { to: 'shipping', requires: 'hasItems' })

  .state('shipping')
    .onEnter(async (ctx) => ctx.app.fillForm({ /* deterministic fixture */ }))
    .guard('shippingValid', /* ... */)
    .transition('continue', { to: 'payment', requires: 'shippingValid' })

  .state('payment')
    .onEnter(async (ctx) => ctx.app.fillStripeFixture())
    .guard('paymentValid', /* ... */)
    .transition('place-order', { to: 'confirmation', requires: 'paymentValid' })

  .state('confirmation')
    .onEnter(async (ctx) => ctx.assert.orderCreated(ctx.expectedOrderId))
    .terminal()

  .build();
```

The agent's role at runtime is filling *only* the slots that are explicitly inference-shaped — e.g., a `.discoverElement('submit button')` call inside an `onEnter` that the workflow author couldn't pin to a stable selector. State choice, transition validity, terminal assertions: not negotiable. The workflow IR is the tested artifact; the agent is a smart selector inside it.

### 13.4 What this changes in §12.5's implementation sequence

Two phases get reshaped:

| Phase | §12.5 (composed) | §13 (composed + SDK) |
|---|---|---|
| **B** (3–4w) — gold set | Build dataset for merge-gate accuracy | Build dataset **and** author 5–10 catalog journey workflows (the canonical ones the team already knows). They're reusable artifacts, not eval-specific. |
| **C** (5–6w) — Phronesis ExecutionProfile in shadow | Author Phronesis Merge Gate ExecutionProfile | Same, **plus** model the judge pipeline as a workflow IR if it would clarify (optional; the ExecutionProfile is the dispatcher either way). |
| **F** (11–12w) — resilience hardening | CI-side mitigations + image layering | **Plus** ensure the catalog of journey workflows covers ≥ 80% of the suggested-journey distribution from shadow data. Track the long-tail (workflows authored by the skill mid-run vs catalog hits) as a coverage metric — when it asymptotes, the catalog is mature. |

The SDK doesn't add calendar weeks; it changes what gets built in phases B/C/F (catalog of `.workflow.ts` files instead of ad-hoc xUnit fixtures + prompt strings).

### 13.5 The custom-tools deprecation risk

PRD-style invocations like:

```bash
aspire start & claude-code --prompt 'Verify checkout flow'
```

would, in v3.0+, sit on the legacy custom-tools surface that #1377 deprecates and that v3.0 design discipline rejects (per CLAUDE.md "agent-first CLI patterns (Aspire-inspired), not config-file-centric"). A merge-queue implementation that lands after v3.0 ships **must** be authored against the SDK. Landing it before v3.0 against the legacy surface guarantees a rewrite.

Concretely:
- If merge-queue work targets v2.x → use the SDK in *additive* shadow mode now (workflows are forward-compatible), avoid the deprecated custom-tools surface.
- If merge-queue work targets v3.0+ → the workflows are first-class; no transition cost.

### 13.6 Cross-substrate composition (all four primitives together)

The four primitives compose, they don't compete:

| Layer | Primitive | Role for the merge-queue |
|---|---|---|
| **Authoring** | Workflow Builder SDK (#1258, v3.0.0) | `.workflow.ts` files for journey catalog; optional workflow encoding for the judge pipeline itself |
| **Execution (deterministic)** | Aspire + SDK runtime (CI-side) | Walks catalog workflows during E2E; Tier 0 deterministic gating via Buildkite `if_changed` |
| **Execution (agentic)** | Phronesis Code Review agent + Merge Gate ExecutionProfile (basileus #147, ADR §2.2) | Tier 1 LLM-graded decision; novel-journey authoring via `workflow-authoring` skill |
| **Coordination** | Ontology MCP Server `register_intent` (#1143, v3.1.0) | The cross-repo invocation surface; Strategos.Contracts envelope for both directions |
| **Measurement** | Eval suite (`servers/exarchos-mcp/src/evals/`, #1365) | Gold set for merge-gate decisions; dataset for journey-coverage drift; calibration drift gate |

The merge-queue is then four small artifacts on top of these substrates:

1. `.merge-gate.yml` (Tier 0 globs + always-run paths + emergency_skip).
2. `evals/datasets/<date>-merge-gate.jsonl` + `evals/graders/merge-gate/` (gold set + graders).
3. A Phronesis Merge Gate ExecutionProfile (basileus side; sibling of the Phronesis Code Review agent or an extension of it).
4. A catalog of `evals/journeys/*.workflow.ts` for the canonical user journeys.

Plus the Buildkite glue that calls `exarchos sync register-intent` from the `merge_group` webhook.

That's it. Everything else — calibration loops, event sourcing, structured envelopes, judge pinning, drift gating, deterministic test execution, agent invocation, cross-repo coordination — is platform substrate that already exists or is in the v2.10 / v3.0 / v3.1 pipeline.

### 13.7 What the user told me that this addendum captures

> *"We can use the Exarchos CLI to encode workflows for Claude Code CLI to use so that it is more deterministic. See issue 1258 for the planned SDK."*

The structural critique extends §12: the PRD's Phase 2 ("agentic E2E via prompt") is the legacy pattern. The v3.0 pattern encodes the journeys as workflows. This:

- Makes the PRD's §5 non-determinism mitigation enforceable (typed states + guards) rather than aspirational (prose in a prompt).
- Removes the "agentic flexibility" tradeoff the original §5.6 split tried to manage — the agent's flexibility is bounded *by construction* to slots the workflow declares as inference-shaped.
- Aligns the merge-queue's authoring surface with the rest of v3.0 (workflows-as-source-of-truth) instead of the deprecated custom-tools surface.
- Composes naturally with the §12 Phronesis pivot: the same IR the SDK emits is what the basileus ExecutionProfile executes (Strategos.Contracts cross-product round-trip).

The four-substrate composition in §13.6 is the corrected end state. The original audit's six findings still hold; sections §5, §12, and §13 together describe the corrected fix path.
