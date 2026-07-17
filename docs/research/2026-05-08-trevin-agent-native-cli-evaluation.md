# Evaluating Trevin Chow's "10 Principles for Agent-Native CLIs" Against Exarchos

**Date:** 2026-05-08
**Workflow:** `trevin-agent-native-cli-evaluation` (discovery)
**Source essay:** [10 Principles for Agent-Native CLIs](https://x.com/trevin/status/2051316002730991795) — Trevin Chow, 2026-05-01 (also at trevinsays.com)
**Pairs with:** [`docs/architecture/runtime.md`](../architecture/runtime.md), [`docs/research/2026-05-08-marten-event-store-lessons.md`](2026-05-08-marten-event-store-lessons.md), `.claude/skills/design-invariants/SKILL.md`
**Verdict:** **Conditional adopt — five concrete additions, two confirmations, one rejection.** Exarchos already satisfies Tier 1 (the defensive five) by construction — INV-2 facade equivalence + INV-5b output contract + RT-5 idempotency cover them. Tier 2 (the empowering five) is where the essay sharpens our roadmap: three principles map cleanly to existing v2.10–v2.12 issues and need only minor scope additions; two are genuinely new affordances worth filing; one (profiles) is wrong-shape for an event-sourced workflow runtime and should be explicitly declined.

## Concern stated by the requester

> "Look at this essay and evaluate the proposals; should we adopt any, modify them, etc?"

The essay is a CLI-design taxonomy, not an event-store taxonomy. Where the Marten audit ([2026-05-08-marten-event-store-lessons.md](2026-05-08-marten-event-store-lessons.md)) tested the substrate, Trevin's piece tests our **agent-facing surface**. That surface is governed by INV-5a (input ergonomics), INV-5b (spec-aligned output contract), INV-5c (Aspire-inspired control-plane verbs), and INV-5d (action-discriminator pattern). Most of what the essay prescribes is already canonical in those invariants. What's left is a small set of crystallized additions Cloudflare and HeyGen have shipped that Exarchos hasn't named yet.

## Method

1. Fetched the essay verbatim via Jina reader (X.com paywall blocked direct fetch and Exa).
2. Decomposed the essay into its 10 principles (5 defensive, 5 empowering) plus the underlying "agents-are-primary" thesis.
3. Cross-referenced each principle against:
   - Runtime guarantees RT-1..RT-6 ([runtime.md §2](../architecture/runtime.md#2-runtime-guarantees))
   - Invariants INV-1..INV-5d ([design-invariants skill](../../.claude/skills/design-invariants/SKILL.md))
   - Open issues across milestones v2.10.0 (Agent Output Contract), v2.11.0 (Autonomous Orchestration), v2.12.0 (Process Lifecycle Verbs)
4. Classified each into one of four buckets: **already adopted**, **partial / extend scope**, **adopt as new issue**, **reject (wrong-shape)**.
5. Prioritized the additions by leverage and substrate-coupling (same rubric as the Marten report).

## The essay in one paragraph

Trevin Chow's "10 Principles for Agent-Native CLIs" (2026-05-01, replaces his March "7 Principles" piece) argues that CLIs should be designed for agents as the **primary** consumer, with humans benefiting downstream — a thesis Cloudflare's Wrangler-rebuild post and HeyGen's CLI launch have crystallized. The principles split into two tiers. Tier 1 (defensive — keep you in the game): non-interactive by default, structured/parseable output, errors that enumerate the valid set, safe retries with explicit mutation boundaries, bounded responses (including the tool-description token surface). Tier 2 (empowering — compound the more agents use you): cross-CLI vocabulary consistency (Cloudflare's `get`-not-`info`/`--force`-not-`--skip-confirmations`/`--json`-not-`--format=json` schema rules), three-layer introspection (`--help` + machine-readable `agent-context` + skill manifests), async-aware execution with `--wait` and a durable job ledger, persistent identity through profiles, and two-way I/O (`--deliver=stdout|file|webhook` for artifacts, `feedback` for friction reports). The load-bearing detail underneath: enforce all of this mechanically via schema/codegen, not human review — Cloudflare's TypeScript schema generates Wrangler, the SDKs, the Terraform provider, and the MCP server from one source.

## Per-principle analysis

### Tier 1 — Don't break the agent

#### Principle 1: Non-interactive by default

**Status: ALREADY ADOPTED by construction.**

Exarchos has no interactive prompt path. The dispatch core is pure functional (`dispatch(verb, args, ctx) → ToolResult`); there is no terminal between the agent and the verb. INV-2 facade equivalence forbids adapter-local interactive paths — anything that diverged from the byte-equivalent envelope would fail the parity harness. INV-5b's error envelope (`validTargets` / `expectedShape` / `suggestedFix`) is the structural equivalent of "honest TTY detection that treats non-TTY as headless": the agent self-corrects from the response payload rather than being prompted.

**Lesson:** Confirms our framing. The only place this could regress is if a future installer or `cli init` flow added a TUI step. Worth flagging in the design-invariants skill as a deterministic check — but the framework is right.

#### Principle 2: Structured, parseable output

**Status: ALREADY ADOPTED, MIGRATING TO SPEC-NATIVE CARRIER.**

This is the entirety of INV-5b. Default output is JSON. `cli.ts` standardizes on `--json` (verified in [`servers/exarchos-mcp/src/adapters/cli.ts:58`](../../servers/exarchos-mcp/src/adapters/cli.ts) — already the Cloudflare-recommended flag name, not `--format=json`). Stdout/stderr separation is enforced (heartbeats to stderr per `cli.ts:388`). Post-#1287, MCP responses use `structuredContent` + registered `outputSchema` instead of JSON-in-text — that's the spec-native flavor of the same principle.

**Lesson:** Confirms the v2.10 #1287 migration is on the right axis. One worth-checking detail: exit-code taxonomy. The essay calls out a "stable taxonomy if you can manage it." Verify that `cli.ts` exit-code mapping is documented and stable — if not, that's a small CI gate.

#### Principle 3: Errors that teach, and enumerate

**Status: FRAMEWORK EXISTS, COVERAGE IS PARTIAL.**

INV-5b acceptance question 2 asks: "Does every error response carry `validTargets`, `expectedShape`, `suggestedFix`?" `format.ts:32-47` already carries those fields. The **enumeration** discipline — when the rejection is an enum violation, the error names the valid set — is partially satisfied (HSM transition errors enumerate `validTargets`; capability-mismatch errors enumerate the negotiated set). Coverage gaps likely exist for:
- Unknown event types (validator currently rejects with generic "Unknown event type" per the discovery memory note in `INV-1` — should enumerate registered types)
- Unknown workflow types post-#1313 (mandatory `workflow_type` column)
- Unknown action discriminators on composite tools

**Recommendation (M-A):** Audit `format.ts` error envelopes and confirm `validTargets` is populated wherever an enum is the cause. Treat this as a v2.10 quality gate alongside #1287/#1288, not a separate epic. Sibling to the existing INV-5b acceptance discipline.

#### Principle 4: Safe retries and explicit mutation boundaries

**Status: ALREADY DESIGNED, CONFIRMED BY MARTEN AUDIT.**

RT-5 (idempotent at-least-once delivery) is enforced at the storage layer post-#1259 via `UNIQUE INDEX (idempotency_key)`. RT-4 (single writer per stream) handles concurrent retry collisions via OCC. Workflow-state CAS is `withStateRetry` + `VersionConflictError`. `--dry-run` defaulting is INV-5c discipline. `#1303` makes `idempotencyKey` + `expectedSequence` mandatory at every append site.

The essay's most distinctive contribution here is the **submit-poll-collect arc** framing: "If the agent's first invocation submits a job and then loses connection mid-poll, the second invocation needs to find the in-flight job, not start a new one." This maps almost exactly onto:
- Marten R-2 / `#1314` `fetchForWriting` — load aggregate, decide, append, OCC-commit. A re-dispatched `merge_orchestrate` would `fetchForWriting('feature-id', 'merge-orchestrator@v1')`, see `phase === 'in-flight'`, and reattach instead of starting fresh.
- `#1304` (mergeOrchestrator as projection) — makes the in-flight state a fold over `merge.*` events, so re-entry is automatic.
- `#1308` (bounded retry-with-backoff) — gives the recovery path explicit policy.

**Lesson:** The essay validates the full v2.11 substrate-shaping cluster. No new ask; sharpens the framing for `fetchForWriting` consumers.

#### Principle 5: Bounded responses, at every layer

**Status: PARTIAL — RUNTIME LAYER ADOPTED, DESCRIPTION-SURFACE LAYER IS THE GAP.**

Runtime-bounded responses: covered. INV-5a's pagination + sensible-defaults discipline applies. v2.12 `ps` is bounded by liveness-event filters; v2.12 `wait` blocks rather than returning a stream.

Description-surface layer: the essay's novel contribution is treating tool descriptions and `outputSchema.description` as a **token budget** that costs every agent on every call. Cloudflare's Code Mode MCP serves over 3,000 operations in <1,000 tokens by aggressive collapsing; "Most MCP servers I've seen burn 1,000 tokens on a single tool's description."

Exarchos partially addresses this:
- INV-5d composite-tool collapse — 4 visible tools instead of 30+ (the structural complement to deferred loading).
- Per-action `describe` — agents pull schemas progressively rather than upfront.
- `#1262` (output-token hint via `next_actions` when narration spikes) — telemetry-side.
- `#1286` (MCP Resources for action docs, playbooks, invariants) — moves long-form prose out of tool descriptions entirely.

**Gap:** No CI-enforced budget per tool description. The four composite-tool descriptions can drift to bloat without a guard.

**Recommendation (R-E):** Add a build-time CI gate that asserts each `tools/list` entry's description (and each registered `outputSchema` description sum) stays under a documented per-action budget — analogous to the `assertRuntimeTokenCoverage` pre-flight in the skills renderer. Land as a sibling to the existing skills:guard vocabulary lint. v2.10 or v2.11.

### Tier 2 — Empower the agent

#### Principle 6: Cross-CLI vocabulary consistency

**Status: LARGELY ADOPTED, ONE CI GATE WORTH ADDING.**

Cloudflare's banned-vocabulary list:
- `get` not `info` — Exarchos uses `get` (✓ — `exarchos_workflow({action: "get"})`)
- `list` not `ls` — varies; `view` action surfaces `pipeline`/`tasks`/`workflow_status`. These are noun-shaped per INV-5c (Aspire verbs), which is intentional — composite tools group, actions verb. Probably fine, but a vocabulary CI gate would catch any drift.
- `--force` not `--skip-confirmations` — N/A (no destructive prompt path; Principle 1 makes this moot)
- `--json` not `--format=json` — **already satisfied** ([`cli.ts:951`](../../servers/exarchos-mcp/src/adapters/cli.ts) detects `--json` directly)

The strong claim here ("manually enforcing consistency through reviews is Swiss cheese") is the **mechanical-enforcement** thesis Cloudflare ships. Exarchos already has a parallel: `npm run skills:guard` re-renders skills and fails CI on any vocabulary drift. The essay nudges us to extend that pattern.

**Recommendation (R-A):** Add a CLI vocabulary CI gate that fails on banned verb/flag aliases (`info`, `ls`, `--skip-*`, `--format=json`, etc.). Zero-cost given current state — the gate would mostly be a regression preventer. Sibling to `skills:guard`. v2.10 or v2.11.

#### Principle 7: Three-layer introspection

**Status: PARTIALLY ADOPTED. LAYER 2 (`agent-context`) IS THE BIGGEST CONCRETE GAP.**

| Layer | Question it answers | Exarchos status |
|---|---|---|
| 1: `--help` | What does this command do? (human-shaped) | Exists |
| 2: `agent-context` | What's the shape of everything? (versioned, machine-readable JSON) | **Missing** |
| 3: skill manifest | When would I use this? (long-form workflow) | Exists (`skills/<runtime>/<name>/SKILL.md`) |

We have per-action `describe` (INV-5d), but no top-level "describe everything in one call" verb. MCP `tools/list` is the spec equivalent for the MCP carrier; there is no CLI analog. Cloudflare's `/cdn-cgi/explorer/api` is the runtime-endpoint version of the same idea; the essay recommends a top-level subcommand.

This dovetails with three already-filed initiatives:
- `#1260` (machine-readable invariants consumed by `/ideate`) — supplies the data
- `#1286` (MCP Resources for action docs) — alternative carrier for the same data on the MCP side
- `#1090` epic v2.12 lifecycle verbs — the natural home

**Recommendation (R-B):** File a v2.12 issue: `exarchos agent-context` top-level verb returning versioned JSON: `{schema_version, composite_tools: {<name>: {actions: {<name>: {input, output, annotations, describe}}}}, event_types, workflow_types, hsm_topologies}`. MCP equivalent: extend `exarchos_view({action: "describe"})` (or add `agent_context` action) to return the same shape. Make the schema_version the primary source-of-truth tag. Pairs with `#1260` and `#1286`.

#### Principle 8: Async-aware execution

**Status: STRONG FIT — v2.12 EPIC ALREADY MATCHES.**

The essay describes `--wait` (blocks until completion via internal poll loop), a `jobs list/get/prune` parent command, and a persistent local job ledger (`~/.<cli>/jobs.jsonl`). The Exarchos analogs already in flight:

| Essay primitive | Exarchos analog | Issue |
|---|---|---|
| `--wait` flag on submitting commands | `exarchos wait --workflow=<id> --phase=<target>` | `#1105` |
| `jobs list` | `exarchos ps` (lists in-flight workflows via liveness events) | `#1103` |
| `jobs get <id>` | `exarchos describe --feature-id=<id>` | `#1104` |
| `jobs prune` | `exarchos prune` | already exists |
| Persistent job ledger | SQLite event store + liveness events (`<surface>.executing_started` per `#1309`) | post-#1259 |
| MCP-spec form | Tasks SEP-1686 dispatch-core integration | `#1283` |

The essay sharpens one detail: `--wait` should ideally be a **flag on the submitting command** (not a separate `wait` verb — `mycli video render --wait`), so the agent doesn't have to chain submit + wait in two turns. v2.12's `wait` verb is the polling form; adding `--wait` on long-running orchestrate actions (e.g. `merge_orchestrate`, `shepherd`) collapses two turns into one.

**Recommendation (R-D):** File a v2.12 issue: add `--wait` flag on long-running orchestrate actions that internally polls until terminal. Same handler that `wait` invokes; just sugar over the same primitive. Pairs with `#1283` (Tasks SEP-1686) — the spec-native version is `tools/call` returning a `task` then `tasks/result` blocking, which is exactly `--wait` in MCP form.

#### Principle 9: Persistent identity through profiles

**Status: WRONG-SHAPE FOR EXARCHOS. REJECT.**

The essay's premise: "Stateless leaf-shaped CLIs make every invocation re-specify the same eight flags. The fix is a profile system." (`mycli profile save my-podcast --avatar=lila --voice=warm-en --webhook=...` then `--profile=my-podcast` on subsequent calls.)

Exarchos's CLI takes very few invocation-time flags. State lives in:
- The event store (per workflow)
- `.exarchos.yml` (per project — INV-3 cements this as the only config file)
- Posture declaration in agent spec YAML (per agent)
- Runtime profiles in `runtimes/<name>.yaml` (per harness — but not read at runtime; only at skill-render time, per INV-3)

The persistent identity Exarchos cares about is the **workflow** (event-sourced) and the **agent posture** (declared once, capability-resolved per session). There is no "bundle of CLI invocation flags I'd save once and reuse" problem to solve. Adding a profile system would create a fifth source of configuration without a corresponding pain point.

**Recommendation:** Decline. Document in the no-list so future designers don't re-import the pattern. Workflow state is the persistent identity; the workflow-identity model is event-sourced rather than file-based.

#### Principle 10: Two-way I/O

**Status: PARTIALLY ADOPTED + ONE STRONG NEW ADDITION.**

Two sub-primitives:

**(a) `--deliver=stdout|file:path|webhook:url` for artifact routing.** The essay's framing is "fewer steps between agent output and a finished artifact" (HeyGen). Exarchos has `#1106` (`exarchos export`: event log + state bundle to file). The `webhook:url` sink is forward-pointer territory: it's structurally how Basileus federation would receive Exarchos events. INV-3 (basileus-forward) makes this a natural fit — the same payload shape that `export` produces would post to the Basileus ontology channel. For now, file: and stdout: sinks satisfy the principle.

**Lesson:** `#1106` already covers the immediate need. Document `webhook:url` as a reserved future sink so the schema supports it when Basileus federation lands.

**(b) `feedback <text>` for friction reports.** **Genuinely new.** The essay's pitch: "Agents hit friction constantly: flags rejected for the wrong reason, race conditions in async paths, error messages that don't enumerate. Most of it never gets reported because there's no channel." The proposed shape is `<cli> feedback "..."` writing locally to JSONL by default, optional upstream POST configurable via env var.

This is a perfect fit for Exarchos because:
- We already run a manual dogfood loop (`/exarchos:dogfood` skill: "Review failed tool calls in this session, diagnose root causes, and triage into code bug / docs issue / user error"). `feedback` is the in-runtime version of the same instinct.
- INV-1 (event-sourcing): `feedback.recorded` is naturally an event type. Lands on a shared `meta` stream or a per-feature stream.
- INV-3 (basileus-forward): the upstream POST endpoint is the federation pattern in miniature. A `.exarchos.yml` config (`feedback.upstream: <url>`) keeps it on the right config surface.
- The MEMORY notes already document several real-world friction items (`task.assigned` projection bugs `#1179`/`#1180`, `check_design_completeness` filename bug, TDD-gate per-commit heuristic false-negatives). Each of these would have surfaced earlier with an in-CLI feedback channel.

**Recommendation (R-C):** File a v2.11 or v2.12 issue: `exarchos feedback <text>` action on `exarchos_workflow` (or new top-level — TBD per INV-5d). Emits `feedback.recorded` event with `{message, sessionContext, configuredEndpoint?}`. Optional upstream POST controlled by `.exarchos.yml`. Surfaced in `agent-context` (R-B) so agents can discover the channel. Naturally pairs with `/exarchos:dogfood`.

### Underlying assumption: agents-as-primary-customer

**Status: ALREADY ABSORBED.**

CLAUDE.md "Design Philosophy" cements this: *"New feature designs must follow agent-first CLI patterns (Aspire-inspired), not config-file-centric or human-first designs."* The runtime.md framing makes it explicit: "Agents are first-class participants, not external clients" (§7). INV-5a/b/c/d operationalize the consequences.

The essay's framing is sharper than ours in one place. It says: *"Designing for humans first and bolting on agent support is what produces the inconsistent, prompt-prone, stdout-only CLIs the first five principles exist to correct."* That's a quotable formulation worth absorbing into INV-5a's worked examples.

## What the essay validates

Five Exarchos design choices the essay's published patterns affirm:

1. **Composite tools / namespace collapse (INV-5d).** Trevin's principle 6 ("cross-CLI vocabulary consistency") and the Cloudflare schema-rules quote both arrive at the same mechanical-enforcement instinct that drives our four-composite-tools pattern.
2. **Event store as the durable job ledger.** Trevin's `~/.<cli>/jobs.jsonl` proposal is the same shape, lower fidelity. Our SQLite event store + liveness events is a strict superset.
3. **`describe` as a first-class action (INV-5d).** Trevin's three-layer introspection puts `describe` in layer 2; we already require it on every composite tool.
4. **`--json` as canonical machine flag (INV-5b).** Cloudflare-validated; we already do this.
5. **`--dry-run` defaulting (INV-5c).** Trevin's principle 4 calls this out explicitly.

## What the essay doesn't help with

Three concerns the essay has no opinion on:

1. **Cross-runtime portability (INV-4).** The essay treats CLI as a single artifact; Exarchos renders skills + commands + rules per-runtime via `build-skills.ts`.
2. **Cooperative agents serializing on shared state.** The essay's mental model is one agent → one CLI → one backend. Exarchos's model is multiple agents in parallel worktrees → one shared event store with OCC. This is the [Marten lessons](2026-05-08-marten-event-store-lessons.md) territory, not Trevin's.
3. **HSM phase guards / workflow topology.** Trevin's CLI taxonomy assumes the backend has whatever state model it has. Our HSM is doing work the essay doesn't reach into.

## Recommendations (prioritized)

### R-A (P1, CONSISTENCY GATE): CLI vocabulary CI gate

**Driver:** Principle 6 mechanical-enforcement thesis. We already use `--json` (not `--format=json`) and `get`/`list` verbs, but there's no guard against drift.

**Steps:**
1. Add `npm run cli:vocab-guard` that scans `cli.ts` and the registry for banned tokens (`info`, `ls`, `--skip-confirmations`, `--format=json`, `--format json` as a verb-followed-by-positional, etc.).
2. Fail CI on any match.
3. Document the canonical vocabulary in `docs/architecture/cli-vocabulary.md` (or extend INV-5c references).

**Issue to file:** Yes. v2.10 or v2.11. Sibling to `skills:guard`.

### R-B (P1, INTROSPECTION): `agent-context` top-level verb

**Driver:** Principle 7 layer 2. The largest concrete gap the essay surfaces.

**Steps:**
1. Design a versioned JSON shape: `{schema_version, composite_tools, event_types, workflow_types, hsm_topologies, runtime_profile, available_features}`.
2. Implement as `exarchos agent-context` (CLI) + `exarchos_view({action: "agent_context"})` (MCP), routing through the same dispatch handler (INV-2).
3. Pull schema content from the same registry that powers per-action `describe` — single source of truth.
4. Cross-link to `#1260` (machine-readable invariants) — `agent-context` is the consumption surface for that data.
5. Cross-link to `#1286` (MCP Resources) — Resources are an alternative carrier for the same shape on the MCP side.

**Issue to file:** Yes. v2.12. Adds to the v2.12 epic `#1090`.

### R-C (P1, CLOSED-LOOP DOGFOOD): `feedback` verb

**Driver:** Principle 10b. New affordance with clear value (validates our manual `/exarchos:dogfood` loop).

**Steps:**
1. Add `feedback` action on a composite tool (likely `exarchos_workflow` per INV-5d, since we want the visible-tool count stable).
2. Append `feedback.recorded` event with `{message, sessionContext, configuredEndpoint?}` to a shared meta stream.
3. Optional upstream POST via `.exarchos.yml` `feedback.upstream: <url>` (INV-3 — config consolidates here).
4. Surface presence/absence of upstream channel in `agent-context` (R-B) so agents discover the affordance.
5. Pair with `/exarchos:dogfood` skill: dogfood reads recent `feedback.recorded` events and triages.

**Issue to file:** Yes. v2.11 (autonomous orchestration milestone is the right home — feedback is the agent-to-runtime back-channel that enables genuine autonomy).

### R-D (P2, ASYNC ERGONOMICS): `--wait` flag on long-running orchestrate actions

**Driver:** Principle 8 — collapses submit + poll into one turn for the agent.

**Steps:**
1. Add `--wait` flag on `merge_orchestrate`, `shepherd`, future TDD-swarm actions.
2. Internal: same handler that v2.12 `wait` (`#1105`) invokes — sugar over the same primitive.
3. MCP-spec equivalent: Tasks SEP-1686 (`#1283`) `tools/call` → `tasks/result` blocking.
4. Document the mapping clearly: CLI `--wait` = MCP `tasks/result` blocking = same poll semantics.

**Issue to file:** Yes. v2.12 (sibling to `#1105` and `#1283`).

### R-E (P2, TOKEN BUDGET): MCP description token-budget CI gate

**Driver:** Principle 5 description-surface layer. Cloudflare's "<1,000 tokens for 3,000 operations" is the bar.

**Steps:**
1. Add a build-time check that asserts each composite-tool description + each registered `outputSchema.description` sum stays under a documented per-action budget (e.g., 200 tokens per action).
2. Mirror the `assertRuntimeTokenCoverage` pre-flight pattern in `build-skills.ts`.
3. Fail CI on overrun with a per-action breakdown.

**Issue to file:** Yes. v2.10 or v2.11. Sibling to `skills:guard`.

### M-A (MEDIUM, SCOPE EXTENSION): Audit error envelopes for `validTargets` enumeration coverage

**Driver:** Principle 3 — errors that enumerate. Framework exists; coverage is partial.

**Steps:**
1. Audit `format.ts` error sites for enum-violation paths.
2. Confirm `validTargets` is populated for: unknown event type (enumerates registered types), unknown workflow type (post-#1313 enumerates declared types), unknown action discriminator on composite tool (enumerates registered actions), unknown capability key.
3. Treat as a v2.10 quality gate inside the existing `#1287`/`#1288` schema-migration scope.

**Issue to file:** No new issue — fold into the v2.10 `#1287` scope as an acceptance criterion.

## What we should NOT take from the essay

To keep the no-list explicit:

| Trevin primitive | Why we say no |
|---|---|
| Profile system (`profile save / use / list`) | Wrong shape. Workflow state is event-sourced persistent identity; per-invocation flag burden doesn't exist; would create a fifth config source competing with `.exarchos.yml` (INV-3). |
| Local `~/.<cli>/jobs.jsonl` ledger | Already redundant — SQLite event store + liveness events is a strict superset, and is queryable. |
| TypeScript schema as single source generating CLI + SDK + Terraform + MCP | Cloudflare's pattern is the right end-state for a single-vendor API surface. Exarchos's surface is intentionally smaller (4 composite tools + actions); the equivalent investment goes into the action-discriminator pattern + `describe` + `agent-context` (R-B), not codegen. Revisit if the action count crosses ~50. |

## The minimum-viable adoption set

If only one piece lands: **R-B (`agent-context` top-level verb)**. Largest single gap; biggest forward-compat leverage; pairs with three already-filed issues (`#1260`, `#1286`, `#1090`).

If two: **R-B + R-C (`feedback` verb)**. Closes the agent-to-runtime back-channel; enables autonomy in the v2.11 sense by giving agents a way to report friction without leaving the CLI.

If three: **R-B + R-C + R-A (CLI vocabulary CI gate)**. Mechanical-enforcement of consistency; cheap to add; regression preventer.

R-D (`--wait` sugar) and R-E (description token-budget gate) are P2 — useful but not load-bearing.

M-A (error-envelope enum coverage) folds into existing v2.10 work.

## Verdict

The essay is concretely useful as a CLI-design taxonomy stress test. Tier 1 confirms that our INV-5b output contract + INV-2 facade equivalence + RT-5 idempotency cover the defensive five by construction. Tier 2 surfaces three additions worth filing (R-A, R-B, R-C) and two scope-sharpening notes (R-D, R-E) for already-planned work. One principle (profiles) is wrong-shape for an event-sourced workflow runtime and should be explicitly declined to prevent future drift.

The framing — *Exarchos is a single-machine event-sourced process manager with cooperative agents* — survives intact. The essay sharpens five surface-level affordances within it.

The deeper convergence: Trevin Chow, Cloudflare, HeyGen, and Exarchos are independently arriving at the same conclusion — agents are the primary consumer; consistency must be enforced mechanically; introspection is a first-class API not an afterthought; and async ops need durable, recoverable state. We've been right about the framing. The essay is independent confirmation plus a small addendum.

## Sources

### External

- Trevin Chow, [*10 Principles for Agent-Native CLIs*](https://x.com/trevin/status/2051316002730991795) (X.com, 2026-05-01) — also published at [trevinsays.com](https://trevinsays.com/) and [trevinchow.com/blog](https://trevinchow.com/blog/). Replaces his March 2026 *7 Principles for Agent-Friendly CLIs*.
- Cloudflare *We rebuilt Wrangler around a TypeScript schema* post (April 2026) — referenced by the essay. Single-schema generation across CLI / SDK / Terraform / MCP; `--force` not `--skip-confirmations`; `/cdn-cgi/explorer/api` for runtime introspection.
- HeyGen CLI launch post (April 2026) — referenced by the essay. `--deliver` artifact routing; SKILL.md fleet alongside CLI.
- Anthropic, [*Writing effective tools for agents*](https://www.anthropic.com/engineering/writing-tools-for-agents) (2025-09-11) — already cited under INV-5a/b/d.
- Anthropic, [*Code execution with MCP*](https://www.anthropic.com/engineering/code-execution-with-mcp) (2025-11-04) — already cited under INV-5b/d. Validates Principle 5's description-budget framing.

### Internal

- [`docs/architecture/runtime.md`](../architecture/runtime.md) — canonical runtime architecture; the framing this report tests against.
- [`docs/research/2026-05-08-marten-event-store-lessons.md`](2026-05-08-marten-event-store-lessons.md) — companion piece evaluating the substrate side. Together these two reports cover surface (Trevin) and substrate (Marten).
- [`.claude/skills/design-invariants/SKILL.md`](../../.claude/skills/design-invariants/SKILL.md) + references — INV-1..INV-5d operational skill consulted throughout.
- [`docs/designs/archive/2026-05-08-durable-event-store-substrate.md`](../designs/archive/2026-05-08-durable-event-store-substrate.md) — `#1259` substrate spike; Tier 1 principles 1, 2, 4 cite this.
- [`docs/designs/archive/2026-04-18-strategic-framing-exarchos-basileus.md`](../designs/archive/2026-04-18-strategic-framing-exarchos-basileus.md) — local vs remote tiers; informs the `feedback` upstream-POST design (R-C).

### Issues referenced

- `#1090` epic v2.12 process lifecycle verbs — natural home for R-B and R-D
- `#1103` `exarchos ps` — Principle 8 analog
- `#1104` `exarchos describe` — Principle 8 analog
- `#1105` `exarchos wait` — Principle 8 analog (R-D extends)
- `#1106` `exarchos export` — Principle 10a coverage
- `#1259` durable event-store substrate — RT-5 idempotency (Principle 4)
- `#1260` machine-readable invariants — R-B data source
- `#1262` output-token hint — Principle 5 telemetry
- `#1283` Tasks SEP-1686 dispatch-core integration — R-D MCP-spec form
- `#1286` MCP Resources — Principle 5 + R-B alternative carrier
- `#1287` outputSchema + structuredContent migration — Principle 2
- `#1288` `next_actions` in registered outputSchema — M-A scope
- `#1304` mergeOrchestrator as projection — Principle 4 in-flight reattach
- `#1308` bounded retry-with-backoff — Principle 4 recovery policy
- `#1309` `merge.executing_started` liveness event — Principle 8 ledger signal
- `#1313` mandatory `workflow_type` column — M-A enumeration
- `#1314` `fetchForWriting` primitive — Principle 4 in-flight reattach
