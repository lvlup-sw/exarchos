# Tool-Surface Token-Economy Audit

**Date:** 2026-07-11
**Workflow:** `tool-token-economy-audit` (discovery)
**Scope:** every tool/action combination on the Exarchos MCP surface (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, hidden `exarchos_sync`), both sides of the ledger: registration cost (paid every session) and response cost (paid every call).
**Trigger:** PR #1659 fixed a ~4,400-token `exarchos_view pipeline` response; this audit asks whether the same class of waste exists elsewhere — it does, and the worst instance is ~35× larger.

---

## 1. Executive summary

| Finding | Measured | Evidence |
| --- | --- | --- |
| `assess_stack` on a 3-PR stack returns **153,844 tokens** (615 KB) with no reduction flag | live CLI run, PRs 1660/1671/1659 | §5.2, appendix A |
| `get_pr_comments` on one PR returns **37,613 tokens** (85 comments, full bodies) | live CLI run, PR 1671 | §5.2 |
| `prepare_delegation` embeds a ~**1,563-token** implementer prompt *per task* with placeholders unfilled — ~12,500 tokens on an 8-task wave, ~95% duplicated | rendered-template byte count | §5.3 |
| Tool registration costs ~**7,851 tokens per session**; a slim path that saves ~4,081 (~52%) is fully implemented but never enabled | serialized `tools/list` payloads | §5.1 |
| The #1659 economy kit (`views/output-cap.ts`) is applied to only **2 of 22** view actions | code inspection | §5.4 |
| `event query` has **no default limit** — 5,755 tokens on a 112-event stream, unbounded growth | live CLI run | §5.2 |
| Both gate runners (`check_static_analysis` on FAIL, `review_diff` always) echo raw command output / full diffs, uncapped — `review_diff` embeds the diff **twice** | code inspection | §5.2 |

The structural conclusion: **#1659 fixed one view, not the contract.**
Its caps, paging, and compact/detail machinery live in the view layer only; the shared orchestrate serializer (`format.ts`) applies no cap, no truncation, and no paging, so every orchestrate action returns its full `data` verbatim.
The remediation plan (§7) generalizes the #1659 view contract into a surface-wide response-economy contract, grounded in the industry conventions surveyed in §3.

## 2. Method

Four independent lines of evidence, gathered 2026-07-11 at HEAD `04dd8ff5`:

1. **Static surface inventory** — enumerated all 5 tools / ~105 actions from `registry.ts`; measured serialized registration payloads (description + JSON-schema chars) with the SDK's own `toJsonSchemaCompat`, i.e. exactly what a client receives on `tools/list`.
2. **Handler response-shape audit** — classified every action's response construction (bounded/unbounded, pagination, projection, echo of inputs or raw command output) with file:line evidence.
3. **Empirical measurement** — ran read-only actions through `bun dist/exarchos.js <cmd> --json` (same code path as the MCP composite tools) against live stores and live GitHub, recording each response's self-reported `_perf: {ms, bytes, tokens}` (token ≈ bytes/4, confirmed 3.99–4.00 across all sizes).
4. **External grounding** — industry standards and SoTA research on token-efficient agent tools (§3, sources in §9).

## 3. Standards and SoTA grounding

The recommendations in §6–7 are not invented here; each maps to an established convention.

### 3.1 Anthropic tool-engineering guidance

- *Writing effective tools for agents* (Sep 2025): implement **pagination, range selection, filtering, and/or truncation with sensible defaults** for any response that could consume significant context; Claude Code caps tool responses at 25,000 tokens by default.
  Truncation messages should **steer** the agent toward the narrower call (filters, pagination), and error responses should be actionable rather than opaque.
  A `response_format: concise | detailed` enum lets the agent choose verbosity; Anthropic measured concise responses at ~1/3 the tokens of detailed ones.
  Prefer semantically meaningful identifiers over UUIDs; return high-signal fields only.
- *Effective context engineering for AI agents*: the goal is the **smallest set of high-signal tokens** per step; tools define the agent's information contract and must promote efficiency on both sides.
- *Code execution with MCP*: progressive disclosure of tool definitions (load what the task needs) cut a 150k-token surface to 2k in Anthropic's example — the registration side of the ledger matters, not just responses.

### 3.2 MCP specification (2025-06-18)

- `CallToolResult` distinguishes `content` (what the model reads) from `structuredContent` (typed data for programmatic/client use), with an optional `outputSchema` for validation.
  Community guidance (ChatForest, FutureSearch) converges on: **`content` = lean, token-optimized summary; `structuredContent` = full typed payload**; the two need not be formatted identically.
- `tools/list` supports cursor pagination; cursor-based `has_more` metadata inside tool results is the emerging convention for large result sets (mirrors #1659's `page:{total,offset,limit,hasMore}`).

### 3.3 Real-world precedent: GitHub MCP server

The closest industrial analogue to this audit, executed over v0.31.0 → v1.1.0:

- **Minimal-types pattern** — replace raw API payloads with hand-picked field subsets; `issue_read` dropped from 1,527 to 281 tokens (**−82%**), `list_*` tools 5–94% depending on tool, via flattening, URL-field elimination, zero-value removal, and fill-rate filtering.
- **CSV output for list tools** (feature-flagged) — a further 16–25% on list-heavy responses.
- **Schema-side token tax is real and separately measured** — community measurement put the GitHub server's 26-tool registration at ~3,546 tokens/turn, with ~20% of schema bytes non-semantic and strippable.

### 3.4 Research literature (2026)

- The "MCP tax": eager schema injection costs 10k–60k tokens/turn in multi-server deployments; lazy/two-phase schema loading recovers ~95% of it (Tool Attention, arXiv:2604.21816).
  Tool-schema compression is an enabling layer at constrained budgets (arXiv:2605.26165).
- **Caution on format swaps:** token-optimized serializations (TOON/TRON) save 18–27% but cost measurable accuracy and cascade multi-turn parsing failures (*Notation Matters*, arXiv:2605.29676).
  Structural fixes (field pruning, caps, pagination) deliver larger savings with no accuracy risk — this audit therefore recommends **no serialization-format change**.
- IETF draft ADOL (draft-chang-agent-token-efficient) proposes caller-driven output field selection (`requireOutput`) — the standards-track version of `fields` projection, which Exarchos already implements on `workflow get`.

## 4. The house precedent: the #1659 view contract

`docs/specs/2026-07-09-refactor-pipeline-view-economy.md` (Rev 3, shipped `585c154c`) established the internal contract this audit generalizes.
Its reusable patterns, hereafter **P1–P5**:

- **P1 — compact by default, `detail:true` opt-in** (DR-1): strip nested maps that duplicate adjacent scalars.
- **P2 — small default window** (DR-2): ≤10 entries when `limit` is omitted; locked by a token-budget test asserting `estimateOutputTokens < 1000`.
- **P3 — explicit paging metadata** (DR-3): `page:{total,offset,limit,hasMore}` with deterministic order.
- **P4 — degenerate rows excluded** from page and totals (DR-4).
- **P5 — scoped default + always-on perceivability** (DR-6/7): `scope` + `unscopedTotal` on every response so hidden rows are visible, with an escape hatch (`scope:'all'`).

Supporting kit: `views/output-cap.ts` (caps, `estimateOutputTokens`, summary fallback, `narrowAffordance` next-action hint on truncation) and a 280-token registry-description budget (DR-8).
These match §3.1–3.3 point for point — the contract is sound; the problem is coverage (§5.4).

## 5. Findings

### 5.1 Registration side: the per-session schema tax

Measured serialized `tools/list` payloads (description + inputSchema; tok ≈ chars/4):

| Tool | Actions | Schema props | Description (full) | inputSchema | Total |
| --- | --- | --- | --- | --- | --- |
| `exarchos_orchestrate` | 69 | 108 | ~3,013 tok | ~1,949 tok | **~4,962 tok** |
| `exarchos_view` | 22 | 29 | ~785 | ~542 | ~1,327 |
| `exarchos_workflow` | 10 | 19 | ~632 | ~467 | ~1,098 |
| `exarchos_event` | 4 | 13 | ~131 | ~334 | ~465 |
| **Visible surface** | **105** | **169** | **~4,560** | **~3,291** | **~7,851 tok/session** |

- F-1 **The slim-registration path is dead code.**
  Every tool carries an authored `slimDescription`, and `buildToolDescription(tool, ctx.slimRegistration ?? false)` supports it (`adapters/mcp.ts:458`), but `ctx.slimRegistration` is never set true in production (`core/dispatch.ts:60` declares it only).
  Enabling it drops descriptions from ~4,560 to ~480 tokens — **~4,081 tokens (~52%) recovered per session with zero new code**, on the model of §3.4's lazy-loading literature and the existing `describe` action as the on-demand detail path.
- F-2 `exarchos_orchestrate` is 63% of the surface: 69 actions whose Zod schemas merge into one 108-property flattened union (`buildRegistrationSchema`, `registry.ts:500`).
  The flattened-union design is load-bearing (same-name/different-type collisions throw, `registry.ts:529`), so schema shrink must come from field consolidation and description budgets, not tool splitting.

### 5.2 Response side: measured and code-audited offenders

Empirical `_perf` measurements (live stores + live GitHub; full table in appendix A):

| Action | Measured | Boundedness | Root cause (file:line) |
| --- | --- | --- | --- |
| `assess_stack` (3 PRs) | **153,844 tok** | unbounded, no reduction flag | `orchestrate/assess-stack.ts:188-196, 592-605` |
| `get_pr_comments` (1 PR) | **37,613 tok** | unbounded, no limit/fields | `orchestrate/vcs/get-pr-comments.ts:22` |
| `event query` (112-event stream, default) | 5,755 tok | **no default limit** | `event-store/tools.ts:497-510` |
| `event describe --emissionGuide` | 1,795 tok | single large string | — |
| `review_diff` | n/m (code) | full raw diff in `data.diff` **and** re-embedded in `data.report` | `orchestrate/review-diff.ts:157-165` |
| `check_static_analysis` (FAIL path) | n/m (code) | entire raw stderr/stdout of failing lint/typecheck in report | `orchestrate/pure/static-analysis.ts:447-451, 519` |
| `check_pr_comments` | n/m (code) | one line per comment, unbounded count | `orchestrate/check-pr-comments.ts:98-102` |
| `list_prs` (direct) | 74 tok (small repo state) | no default window | `assess-stack.ts:455-468` |

**Anatomy of the `assess_stack` payload** (615,374 B measured):

- `status.prs[*].unresolvedComments` = 340,753 B (**55%**): each comment ships `body` (truncated to `COMMENT_BODY_LIMIT=200`, `assess-stack.ts:80-85`) **plus untruncated `fullBody`** (`:189,193`) **plus** a nested `actionItem` object — the same CodeRabbit text serialized up to three times.
- `actionItems` = 209,142 B (**34%**): 109 items whose `raw` field repeats the full comment markdown a fourth time.
- `fullBody` is **dead weight**: the comment annotates it "consumed by review provider adapters (#1159)", but adapters parse the raw comment *inside* `queryPrComments` (`:156`) before the result is built, and `classifyActionItems` reads only `body.slice(0,100)` and `actionItem` (`:262`) — nothing downstream reads `fullBody`.
- Volume is comment-driven: PR 1660 (1 resolved comment) → 126 B; PR 1671 (30 comments) → 343 KB; PR 1659 (26) → 58 KB.
  The shepherd loop calls `assess_stack` once per iteration, so the cost compounds; `emitGateExecutedEvents` (`:349-374`) additionally appends one `gate.executed` event per check per PR per iteration (write amplification, same root).

**Where reduction levers exist, they work** — the gap is that the largest actions have none:

- `workflow get --fields` → −72% (229→65 tok); `--query` → −76%.
- `event query --limit` → linear and effective (5,755 → 1,490 @ 20 → 435 @ 5).
- `describe` is correctly bounded (1–10 actions, `registry.ts:794`) — the right verbose escape hatch.
- `view telemetry --compact` is a **no-op** at measured sizes (85→85 tok) — an economy flag that doesn't economize.

### 5.3 Wave-scaled boilerplate: `prepare_delegation`

`prepare-delegation.ts:447` renders `implementerPrompt: renderImplementerPrompt({riskTier, boundaryTouching})` per task and returns it on every `taskClassifications[]` entry (`:1474-1480`).
The rendered body measures **6,252 B ≈ 1,563 tokens**, and because only tier/boundary feed the render, the `{{taskDescription}}`/`{{requirements}}`/`{{filePaths}}` placeholders are left unfilled (the orchestrator fills them at dispatch, per the comment at `:128-131`).
An 8-task wave therefore returns ~12,500 tokens of which ~95% is byte-identical boilerplate differing only by a few-hundred-byte verification note — a textbook P1 (DR-1) violation, and larger than the original 4,400-token pipeline-view waste for any wave ≥3 tasks.

### 5.4 Structural gaps in the envelope and serializer

- F-3 **The economy kit does not cover the orchestrate surface.**
  `format.ts` (shared orchestrate serializer; envelope at `:83-106`, `wrap` at `:155`) applies no cap, truncation, or paging; `views/output-cap.ts` is hard-wired to `pipeline` and `worktrees` only — **2 of 22 views**, 0 of 69 orchestrate actions.
  The remaining ~20 views return raw materialized projections (`views/tools.ts:433, 919, 950, 993, 1113, 1371, 1590, …`).
- F-4 **Every response is serialized twice on the wire**: `toMcpResult` (`adapters/mcp.ts:173-185`) returns `content:[{type:'text', text: JSON.stringify(env)}]` *and* `structuredContent: env`.
  Nuance: the MCP spec *recommends* returning both, and most clients feed only `content` to the model, so this is wire/transport overhead rather than a guaranteed 2× model-token cost.
  The real miss is the **opportunity**: the spec's split exists precisely so `content` can be a lean summary while `structuredContent` carries the full typed payload (§3.2); today both are the identical full envelope.
- F-5 The only surface-wide backstop is the summary fallback at 32,000 × 0.8 = **25,600 tokens** (`capabilities/resolver.ts:209-248`) — a catastrophic-overflow guard, not an economy mechanism (assess_stack's 153k measured payload shows it is not effective as one).
- F-6 Envelope floor: `_perf` + `next_actions:[]` + `_meta:{}` ride on every response (`telemetry/middleware.ts:199`, `format.ts:155-172`) — ~40–60 tokens/call; acceptable, but worth including in any future per-action budget.

### 5.5 Incidental defects surfaced (filed for follow-up, not economy items)

- B-1 `view pipeline` throws `VIEW_ERROR` on stores containing a legacy `__migration__` stream row (fails the `^[a-z0-9-]+$` streamId regex), taking the whole view down.
- B-2 `check_ci` is broken against current `gh` (`Unknown JSON field: "conclusion"` — gh renamed it to `state`).
- B-3 `assess_stack --pr-numbers 1660,1671,1659` (CSV) fails coercion; only a JSON array works (consistent with the known object-only `coerceFlags` behavior).
- B-4 `view telemetry --compact` has no effect (§5.2).
- B-5 Store split: the CLI reads `~/.exarchos/state/exarchos.db` while this session's plugin MCP server wrote the audit workflow to the legacy `~/.claude/workflow-state/exarchos.db` — the two surfaces disagree about which workflows exist.
- B-6 Doc/build drift: `rehydrate`/`deliveryPath` are advertised in the plugin server's registration but absent from the freshly built CLI at HEAD (`workflow get` is the read path there); also `view worktrees`/`ps`/`invariants_effective` are registered in the plugin but unknown to the HEAD CLI build.

## 6. Optimization catalog (pattern → standard → where it applies)

| # | Pattern | Grounding | Applies to |
| --- | --- | --- | --- |
| O-1 | Drop dead/duplicate fields (minimal-types) | GitHub MCP minimal types (−82%); Anthropic "high-signal fields only" | `assess_stack` (`fullBody`, `actionItems.raw` dedupe), `review_diff` (diff embedded twice) |
| O-2 | Compact default + `detail:true` opt-in | DR-1; AWS "default to 5 fields, detail on demand" (−⅔) | `prepare_delegation` prompts, remaining 20 views, `runbook` schemas, `rehydrate` playbook prose |
| O-3 | Default window + `page` metadata | DR-2/3; Anthropic pagination-with-sensible-defaults; MCP cursor convention | `event query`, `get_pr_comments`, `check_pr_comments`, `list_prs`, `assess_stack` comments/checks |
| O-4 | Truncate raw command output with steering suffix | Anthropic truncation guidance ("N more lines; re-run with …") | `check_static_analysis` FAIL detail, `check_integration_suite` load-failure list |
| O-5 | Serializer-level token backstop | Claude Code's 25k default cap; DR-2 budget tests | extend `output-cap.ts` into `format.ts` so **every** action has a ceiling |
| O-6 | Slim registration + on-demand `describe` | Anthropic progressive disclosure (−98.7% anecdote); lazy-loading literature; GitHub schema-tax finding | flip `slimRegistration` on; `describe` already exists as the detail path |
| O-7 | `content` = lean summary, `structuredContent` = full data | MCP spec 2025-06-18 + community consensus | `toMcpResult`, after verifying client injection behavior |
| O-8 | Counts-not-transcripts | in-house model: `prepare_synthesis` returns counts (`prepare-synthesis.ts:320-328`) | any gate tempted to echo runner output |
| O-9 | Do **not** swap serialization format (TOON/CSV) | *Notation Matters*: 18–27% savings, accuracy regressions | rejected for now; revisit only behind a flag after O-1..O-5 land |

## 7. Prioritized remediation plan

Ranked by measured waste × call frequency; each item names its pattern and expected recovery.

1. **R-1 `assess_stack` minimal types** (O-1, O-3): delete `fullBody` (dead), collapse `actionItems[].raw` to a reference into `unresolvedComments`, cap comments per PR with `page` metadata, reduce `checks[]` to counts + failing-check detail.
   Expected: 153,844 → low thousands (>95% recovery) on the measured stack; compounds per shepherd iteration.
2. **R-2 `get_pr_comments` window + projection** (O-3): default limit (~20) + `page` + `fields`; steer to narrower calls in the truncation notice.
   Expected: 37,613 → ~2–4k default.
3. **R-3 `prepare_delegation` prompt dedupe** (O-2): return the rendered prompt once (or behind `detail:true` / `outputFormat:'prompt-only'`), with per-task `{riskTier, note}` deltas.
   Expected: ~12,500 → ~2k on an 8-task wave.
4. **R-4 serializer backstop** (O-5): lift `output-cap.ts` into `format.ts` with a per-action default budget (e.g. 2,000 tok), summary fallback, and `narrowAffordance`-style steering; add DR-2-style token-budget tests per action so regressions fail CI.
   This is the structural fix that removes the *class* of bug.
5. **R-5 `event query` default limit** (O-3): default `limit` (e.g. 25 newest) + `page`; unbounded only by explicit request.
6. **R-6 flip slim registration** (O-6): set `slimRegistration: true`, keep `describe` as the on-demand detail path; validate with the existing eval suite (skills reference full action signatures — check for prompt-drift).
   Expected: ~4,081 tok/session recovered.
7. **R-7 gate-output truncation** (O-4, O-8): cap `check_static_analysis` FAIL `detail` at first N lines + count, `review_diff` to stat-summary + capped hunks (never embed the diff twice).
8. **R-8 generalize the view contract** (O-2, O-3): apply compact/`page`/scope to the remaining ~20 views; fix `--compact` no-op (B-4).
9. **R-9 envelope split** (O-7): make `content` a compact rendering and keep the full envelope in `structuredContent` — *after* verifying how the plugin's host clients inject each field.
10. **R-10 codify as an invariant**: add a dev-catalog entry (candidate INV-16, "response-economy contract": every action declares a default token budget, unbounded output requires an explicit escape hatch, budgets are test-enforced), so the next new action can't ship unbounded.

Sequencing note: R-1/R-2/R-5 are independent point fixes shippable immediately; R-4 should land before R-8 so view migration rides the shared backstop; R-6 is config + eval validation; B-1..B-6 should be filed as separate issues (B-2 blocks shepherd CI checks today).

## 8. Appendix A — empirical measurement table (abridged)

`bun dist/exarchos.js <cmd> --json`, HEAD `04dd8ff5`, 2026-07-11; `_perf` values are the server's own self-report (token ≈ bytes/4).
Raw outputs preserved at the measuring session's scratch dir (`results.tsv`, `assess.json`).

| Action / flags | _perf.bytes | _perf.tokens | ms |
| --- | --: | --: | --: |
| `orchestrate assess_stack` (PRs 1660,1671,1659) | 615,374 | 153,844 | 1,736 |
| `orchestrate get_pr_comments` (PR 1671) | 150,452 | 37,613 | 564 |
| `event query` telemetry stream, default (112 ev) | 23,019 | 5,755 | 2 |
| `event describe --emissionGuide` | 7,138 | 1,795 | 1 |
| `event query --limit 20` | 5,960 | 1,490 | 1 |
| `orchestrate runbook` (list) | 2,731 | 683 | 1 |
| `orchestrate describe` (3 actions) | 2,512 | 628 | 1 |
| `orchestrate doctor` | 1,768 | 442 | 15 |
| `workflow get` (full state) | 916 | 229 | 1 |
| `workflow get --fields [phase,workflowType]` | 259 | 65 | 1 |
| `workflow get --query phase` | 224 | 56 | 1 |
| `view telemetry` (default / `--compact` / `--limit 5`) | 339 | 85 | 4 |
| small views (`team_performance`, `convergence`, `workflow_status`, …) | 77–152 | 20–38 | 2–4 |
| empty views (`tasks`, `stack_status`) | 26 | 7 | 1–2 |

n/m = not measured live (blocked or requires a failing run); sized from code inspection instead.
`view pipeline` was unmeasurable on the test store due to B-1.

## 9. Sources

External:

- Anthropic — *Writing effective tools for agents* (2025-09-11): <https://www.anthropic.com/engineering/writing-tools-for-agents>
- Anthropic — *Effective context engineering for AI agents*: <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic — *Code execution with MCP*: <https://www.anthropic.com/engineering/code-execution-with-mcp>
- MCP specification 2025-06-18, Tools (structuredContent/outputSchema, cursors): <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- AWS — *MCP tool design: practical approaches and tradeoffs* (2026-07-09): <https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/>
- GitHub MCP server — minimal types & list optimization: PR #2016, PR #2022 (issue_read −82%), release v1.1.0 (CSV output), discussion #2567 (schema token tax)
- *Notation Matters* (TOON/TRON accuracy costs): arXiv:2605.29676
- *Tool Attention* (lazy schema loading, MCP tax): arXiv:2604.21816
- *Tool-Schema Compression Enables Agentic RAG*: arXiv:2605.26165
- IETF draft ADOL (caller-driven output selection): draft-chang-agent-token-efficient-02

Internal:

- `docs/specs/2026-07-09-refactor-pipeline-view-economy.md` (DR-1..DR-10) + commit `585c154c` (PR #1659)
- `servers/exarchos-mcp/src/` — `registry.ts`, `adapters/mcp.ts`, `format.ts`, `views/output-cap.ts`, `views/tools.ts`, `orchestrate/assess-stack.ts`, `orchestrate/prepare-delegation.ts`, `orchestrate/review-diff.ts`, `orchestrate/pure/static-analysis.ts`, `event-store/tools.ts`
- Live `_perf` measurements, 2026-07-11 (appendix A)
