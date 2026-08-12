# Verification of the Exarchos-in-Pi embedding spec — discovery report

- **Status:** Discovery deliverable (verification + critical examination)
- **Workflow:** `pi-embedding-spec-verification` (discovery)
- **Subject:** `docs/specs/2026-07-09-exarchos-pi-embedding.md` (untracked draft at time of audit)
- **Method:** four independent audit lanes — (1) Pi API citations vs the pinned package, (2) Exarchos seam citations vs `servers/exarchos-mcp/src/**`, (3) Pi behavioral research (package docs, official repo, web) against the spec's open questions, (4) fit assessment against `lvlup-sw/basileus/docs/system-design.html` for sandboxed autonomous coding workers, optimizing long-horizon task success and cost.
- **Primary sources:** `@earendil-works/pi-coding-agent@0.80.5` (pinned) and `@0.80.6` (latest), extracted from npm — `dist/**/*.d.ts` declarations, `docs/`, `examples/`, `CHANGELOG.md`; `github.com/earendil-works/pi`; `pi.dev`; Exarchos engine source; `.exarchos/invariants.md`; Exarchos `docs/system-design.html`; basileus `docs/system-design.html`.

## Verdict

The design is **architecturally sound and unusually well-cited** — the load-bearing seams all exist, the line numbers are almost all exact on both the Pi and Exarchos sides, and the alternatives analysis holds up.
It should proceed to decomposition **after amendment**.
The audit found two mechanism-level errors (DR-7 tier-2, DR-3's clear mechanism), one significant existing-vs-unbuilt gap presented as existing contract (DR-4, ~40% unbuilt), an under-specified cost model (prompt-cache economics — the single most consequential gap for the basileus use case), and, for basileus specifically, the load-bearing worker seam (state egress from the sandbox to the control plane) sitting outside the spec's frame.
Two of the spec's seven open questions are already answerable from the pinned package.
DR-9 and DR-10 are correctly scoped; DR-10's churn firewall should not be trimmed.

Separately: two of the spec's three "Grounds on" citations — `docs/research/2026-07-09-exarchos-pi-harness-extension.md` and `docs/research/2026-07-09-exarchos-in-pi-governance-embedding.md` — do not exist on disk and never existed in git history.
The claims those docs were said to prove were re-derived from primary sources here (and mostly held), but the spec's cited evidentiary base is partly phantom and must be fixed (commit the docs or drop the citations).

## Part 1 — Pi API citation audit (pinned `0.80.5`)

All spec citations to "types.d.ts" resolve to `dist/core/extensions/types.d.ts`; cited line numbers are accurate.

| # | Spec claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `pi.appendEntry` (`:907`) — durable `custom` entry, out of LLM context | **CONFIRMED** | Doc comment: "state persistence (not sent to LLM)"; `CustomEntry { type:"custom" }`; `session-format.md:252` |
| 2 | `pi.sendMessage` (`:895`) — `custom_message`, in LLM context | **CONFIRMED** | "Unlike CustomEntry, this DOES participate in LLM context"; persisted entry type `custom_message` |
| 3 | `pi.sendUserMessage` (`:903`) — injects a user turn | **CONFIRMED** | "Always triggers a turn" |
| 4 | `tool_call` deny via `{ block, reason }` (`:766`) | **CONFIRMED** | `ToolCallEventResult { block?, reason? }`; runtime `runner.js:659`; used by `permission-gate.ts`, `protected-paths.ts`, `plan-mode` |
| 5 | Blocked call answered as its own `tool_result` (`:778`), same-turn continue | **INCORRECT citation / PARTIAL** | `:778` is `ToolResultEventResult` — the *post-execution* result modifier; a blocked call never executes, so it is never the vehicle for the deny reason. The block→model delivery lives in the `pi-agent-core` dependency, not provable from the pinned declarations |
| 6 | `context` hook (`:489`) can modify messages | **CONFIRMED + stronger** | `ContextEventResult.messages` **wholesale-replaces** the (deep-copied) message array for that LLM call; handlers chain; official prune example in `docs/extensions.md:645-649` |
| 7 | `session_before_compact` (`:799`) — governance-authored summary | **CONFIRMED** | Result `{ cancel?, compaction? }`: veto or supply full `CompactionResult` (`summary`, `firstKeptEntryId`, …); `keepRecentTokens` is the real settings name (default 20,000); `examples/extensions/custom-compaction.ts` |
| 8 | "~15 events" bound | **CONFIRMED with correction** | The full extension event surface is **33 events**; ~15 is what the extension would bind, not the platform total |
| 9 | `createReadOnlyTools()` "(SDK)" | **CONFIRMED** | `tools/index.d.ts:38`, re-exported from the package SDK entry (`index.d.ts:17`, `sdk.d.ts:72`); excludes edit/write by construction (INV-11) |
| 10 | Extensions jiti-loaded TypeScript | **CONFIRMED** | `loader.js` uses `createJiti(...).import(extensionPath)`; `jiti@2.7.0` direct dependency |
| 11 | `/fork`, `/clone`, `/tree` | **CONFIRMED** | `/fork`/`/clone` create a new `.jsonl` with `parentSession`; `/tree` repositions the active leaf in-file |
| 12 | `--mode json \| rpc \| print` headless | **CONFIRMED with spelling fix** | Print mode is `-p`/`--print`, not `--mode print`; only `json`/`rpc` use `--mode`. Extensions load and receive core events in **all four modes**; `ctx.ui.*` are no-ops when `hasUI:false` (json/print) |
| 13 | `.jsonl` entry types `custom` / `custom_message` | **CONFIRMED** | Exact string match in `session-manager.d.ts:66,94`; format documented and versioned (v3) |
| 14 | Runtime tool re-scoping (open question 4) | **CONFIRMED — question already answered** | `pi.setActiveTools(names)` (`:921`) + `getActiveTools`/`getAllTools`; the shipped `plan-mode` example uses it to remove edit/write — exactly DR-7 tier-1 |
| 15 | Programmatic clear/branch mid-flight | **PARTIAL — key DR-3 caveat** | `newSession`/`fork`/`navigateTree`/`switchSession` exist only on `ExtensionCommandContext`; docs state they deadlock in event handlers. The only in-loop "clear" is `context`-hook view replacement (or `ctx.compact()`) |
| 16 | Churn 0.80.5→0.80.6 | **Near-zero** | Single hunk (`ProviderModelConfig.cost`), none of the bound surfaces; `extensions/index.d.ts` and `sdk.d.ts` byte-identical |

The closest shipped analog to the whole governance-controller pattern is `examples/extensions/plan-mode/index.ts`, which combines `setActiveTools` (tier-1), `tool_call` block (tier-2), `context` message replacement, `before_agent_start` injection, and an `appendEntry` cursor re-read on `session_start` — effectively a working prototype of DR-2/DR-5/DR-7.

## Part 2 — Exarchos seam citation audit

| # | Spec claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `dispatch(tool, args, ctx)` at `dispatch/core/dispatch.ts:532`; `DispatchContext` at `:52` | **CONFIRMED (minor drift)** | Signatures exact; `DispatchContext` also requires `enableTelemetry` (spec's `{ stateDir, eventStore }` omits it) plus 12 optional fields |
| 2 | Composition root `dispatch/core/context.ts:101`, `index.ts:182` | **PARTIAL (lines off; path clean but driver-entangled)** | Real seam is `initializeContext(stateDir, options)` at `context.ts:94` (EventStore at `:103-104`); server-side construction at `index.ts:224`. Reusable without the MCP SDK, but production requires the Bun-backed `SqliteBackend` — exactly DR-9's problem |
| 3 | `handleRehydrate` (`workflow/rehydrate.ts:405`), `hydrateFromSnapshotThenTail` (`:163`), `deliveryPath:"direct"` | **CONFIRMED (exact)** | `direct` is the default and returns the document by value |
| 4 | `EventStore.append` at `store.ts:302` | **CONFIRMED (path imprecise)** | Real path `event-store/store.ts:302` |
| 5 | `projectionSequence` as ETag | **PARTIAL — semantic drift the code itself flags** | It is a count of *handled* events; `rehydrate.ts:193-196` warns it diverges from the store sequence when unhandled event types appear, and snapshot persistence deliberately uses `lastEventSequence`. Adequate for change-detection; not the monotonic store version "ETag" implies |
| 6 | Existence via `rehydrate`/`get` → `_meta.workflowExists` | **PARTIAL** | Only `rehydrate` sets `workflowExists`; `get` does not — the "/get" half of the convention (also in CLAUDE.md) is unbacked |
| 7 | `workflow.projection_degraded` + state-store-only envelope | **CONFIRMED** | `buildDegradedResponse` (`rehydrate.ts:265`, emit at `:297`), `fallbackSource:'state-store-only'` |
| 8 | DR-4 doc contract "per the runtime's rehydrate contract" | **SPLIT — see Part 4** | schema/upgrade/serialize/prose-lint seams real; budget + shedding + gate ledger + DR-N anchors unbuilt |
| 9 | `next_actions` on `ToolResult` (INV-12) | **CONFIRMED** | `format.ts:66`; populated in `dispatch.ts:1039-1040` |
| 10 | INV-7/INV-8 concurrency | **CONFIRMED** | WAL (`sqlite-backend.ts:603`), in-transaction stream-version gate under `BEGIN IMMEDIATE` with `VersionConflictError(expected, actual)` (`:256-302`), `idempotency_claims` PK `(streamId, idempotencyKey)` |
| 11 | `bun:sqlite` at `storage/sqlite-backend.ts:1` is the sole Bun coupling | **CONFIRMED** | Repo-wide, the only production `bun:sqlite` import; no `Bun.*` APIs in engine runtime code |
| 12 | better-sqlite3 shim usable under Node | **CONFIRMED test-only — DR-9 is genuinely required** | Shim wired only via a vitest `resolve.alias` whose comment says "test-only"; better-sqlite3 is a devDependency; no `imports`/`exports` conditions exist. The engine does not run under production Node today |
| 13 | Publish `@lvlup-sw/exarchos-mcp` with an exports map | **Name/main confirmed; exports map does not exist** | No `exports`, `files`, or `publishConfig`; current distribution is the single binary. The npm-library surface is unbuilt (as DR-9 implies, but state it as new work) |
| 14 | `no-legacy-runtime-deps` guard | **CONFIRMED** | `src/storage/__tests__/no-legacy-runtime-deps.test.ts`; DR-9's "relax only for the Node target" correctly identifies the blocker |
| 15 | "Extends the INV-2 parity harness" | **PARTIAL — thinner than implied** | Parity tests exist but envelope-parity renders one payload through `toEnvelope` twice; there is no deep-equal dispatch-level suite over the four verbs to "extend" |
| 16 | CLI is a client of the dispatch core | **CONFIRMED** | `adapters/cli.ts` imports and calls `dispatch` directly — substantiates DR-1 by construction |
| 17 | `createReadOnlyTools` | **Not in this repo** | It is Pi SDK surface (correctly attributed); Exarchos-side INV-11 enforcement is the capability resolver + agent-spec YAML |
| 18 | Grounding research docs | **ABSENT — never committed** | Both cited docs missing from disk and from `git log --all` |
| 19 | "INV-2 reframed by system-design.html" | **MIXED — in-flight, not settled** | The catalog still reads "CLI and MCP are both facades"; `system-design.html` carries the reframing prose but flags the catalog edit as tracked in #1608. The design's conclusion is compatible with both framings |

## Part 3 — The spec's open questions, updated

1. **Threshold `θ` policy** — still open, but reframe: for coding-loop workloads the dominant phase shape is a long implement/fix loop with few phase boundaries, so `θ` will be the *common* trigger there, not the safety net (see Part 5D).
2. **`context` cadence & ordering** — partially closed. `context` fires before each LLM call; no documented re-fire-on-retry guarantee exists (the sibling header hook explicitly does **not** re-fire), but retries reuse the already-constructed payload, so an injected banner or applied clear **cannot be lost on a retry**. Overflow retries rebuild context and re-fire the hook. The real hazard is **multi-extension chaining**: `context` handlers run in load order and each can replace the array — a later-loaded extension can drop the governance banner or undo a clear. The design must assert load-order precedence or re-assert defensively.
3. **Recent-tail budget on clear** — still open; now compounded by the working-set finding (Part 5D): for coding workers the tail must preserve the engineering working set (current diff, failing test output), not just conversation.
4. **Tool-menu re-scoping** — **CLOSED: YES.** `pi.setActiveTools()` is public runtime surface with a shipped reference implementation (plan-mode). Tier-1 prevent is fully supported. New caveat: changing tool definitions invalidates the prompt cache from the tool-definition breakpoint at each phase transition — budget it.
5. **Fork semantics** — largely closed. Fork/clone create a new session file (`parentSession` header) and Pi resets and rebinds the extension runtime around it (`session_shutdown` → `session_start{reason:"fork", previousSessionFile}`), so the controller gets exactly the events DR-6 needs to re-establish the cursor. `/tree` stays in-file and is interceptable (`session_before_tree`).
6. **Non-interactive governance** — **CLOSED: YES, with a caveat.** Extensions load and receive core loop events under json/rpc/print; `hasUI:false` in json/print makes all `ctx.ui.*` no-ops. DR-8's `ctx.ui.notify` surfacing silently disappears in exactly the CI/delegation runs this question is about — surface via the event stream/stdout as well. Pi's RPC mode is a full documented JSON protocol (plus SDK `createAgentSession` for in-process embedding) — two viable drive surfaces for autonomous workers.
7. **Snapshot cadence** — still open; unchanged.

## Part 4 — Design assumptions critically examined

### 4.1 DR-3's mechanism is misdescribed (correctable, and the correction is cleaner)

Session-level operations (`newSession`, `fork`, `navigateTree`) are command-context-only and documented to deadlock in event handlers, so the "automatic, mid-session, no user command" clear **cannot** be a session branch.
The only in-loop mechanism is `context`-hook replacement: return `[rehydration doc, …bounded tail]` and the model's next call sees exactly that.
Three consequences the spec must absorb:

- It clears the **model's per-turn view**, not the transcript: the hook receives a deep copy, the `.jsonl` is untouched, and the replacement must be re-asserted on every subsequent `context` fire.
- The right formalization is therefore not "clear as an event" but **a persistent view function**: `view(fullMessages, projection) → trimmedMessages`, applied on every `context` fire, where "clear" just moves the cut point. This is *more* deterministic and idempotent than the spec's framing (and INV-1-cleaner: the full conversational record survives in Pi's log while the window stays disposable), and it dissolves the retry worry (question 2 above).
- The `handoff.ts` example (fresh session + carried summary) confirms Pi's own "clear-and-rehydrate" posture exists but is user-command-gated — available as a manual escape hatch, not the automatic path.

### 4.2 DR-7 tier-2's citation is wrong and its mechanism is unproven at type level

`types.d.ts:778` is the post-execution `tool_result` modifier and can never carry a blocked call's deny reason (a blocked call never executes).
The deny itself (`{ block, reason }`) is real; how the reason reaches the model — and whether the model continues within the same turn — is implemented in the `pi-agent-core` dependency, outside the pinned package's declarations.
The tier-2 acceptance criterion currently has no type-level backing; add an integration probe (block a call, assert the model receives the reason in-turn) to the acceptance criteria.

### 4.3 DR-4 presents ~40% unbuilt semantics as existing contract

Built today: the rehydration projection (schema, versioned upgrade path, deterministic serialize under prose-lint), snapshot-then-tail fold with no LLM call, `tokenEstimate`, `projectionSequence`, `_meta.workflowExists`, the degraded path, and document fields for phase, task board, decisions, and next steps.
Unbuilt but written as given:

- The **~2,500-token budget** — no enforcement constant anywhere in src; only a post-hoc estimate. The figure lives in README/CLAUDE.md as aspiration.
- **Governance-aware shedding** (open-gates-retain / closed-gates-degrade-first) — no such logic in `serialize.ts`.
- The **gate ledger** — `reducer.ts:813` deliberately keeps `gate.executed` **out of** the rehydration projection, and non-blocking review verdicts are not folded. The document cannot "always carry" a gate ledger today.
- **`DR-N` provenance anchors** — `artifacts` is a bare string record; no anchor field exists.

None of this invalidates DR-4 as a requirement; it invalidates DR-4's provenance framing. Mark these four as new engine work in the decomposition, or the plan will under-scope.

### 4.4 The cost model ignores prompt caching — the most consequential gap

Pi is deeply cache-aware (`cacheControlFormat:"anthropic"` places breakpoints on the system prompt, last tool definition, and last user/assistant text; `showCacheMissNotices` surfaces misses; long-retention TTL support; per-message `cacheRead`/`cacheWrite` accounting), and its own skills design advertises "progressive disclosure **without busting the prompt cache**."
The spec's economics count injected tokens only:

- **R2's "near-zero idle-token cost" holds for idle turns only.** On injection turns, cost depends entirely on placement: an **appended** (end-of-array) banner leaves the earlier prefix cached; a literal **"prepend"** — the word DR-5 and the flow diagram use — busts the entire request cache every time the banner changes. Placement is load-bearing and must be pinned (end-of-array).
- **Every clear resets the cache in full.** That is unavoidable — but it is *equivalent to native compaction*, which also rewrites the prefix. DR-3's honest advantage over compaction is eliminating the lossy, non-deterministic summarization LLM call (and context-rot avoidance), not cache cost. The spec's "efficient" framing should say so, or the economics read as oversold.
- **Per-phase `setActiveTools` invalidates from the tool-definition breakpoint** at every phase transition — cheaper than a clear, non-zero, currently unbudgeted.
- θ interacts with cache retention: frequent θ-clears on a long task can make cache-write churn the dominant line item. The θ policy (open question 1) should be co-designed with cache economics, not just window pressure.

### 4.5 Smaller corrections

- `projectionSequence` is a count of handled events, not the monotonic store version; the code itself flags the divergence and snapshots use `lastEventSequence`. Either justify the weaker token for cache-invalidation (it is sufficient: it advances iff the projection changed) or key on `lastEventSequence`.
- `_meta.workflowExists`: cite `rehydrate` only, or add the field to `get` (the CLAUDE.md convention has the same gap).
- Mode spelling: `-p`/`--print`; only `json`/`rpc` use `--mode`.
- "~15 events": the platform surface is 33; ~15 is the bound subset.
- Line-cite fixes: `initializeContext` at `context.ts:94` (EventStore `:103-104`), server construction `index.ts:224`, `event-store/store.ts:302`; `DispatchContext` requires `enableTelemetry`.
- INV-2: present the reframing as in-flight (#1608), not settled; the design survives either framing.
- DR-1's "extends the INV-2 parity harness": the existing harness is a narrow envelope check; budget for building the dispatch-level deep-equal suite, not extending one.

### 4.6 DR-9 / DR-10 assessment

DR-9 is verified as genuinely required and correctly targeted: sole Bun coupling confirmed, shim test-only, no exports map, and the `no-legacy-runtime-deps` guard is precisely the blocker DR-9 plans to relax for the Node target only.
DR-10 is proportionate — arguably necessary — and should not be trimmed: the bound hook surface was byte-stable across 0.80.5→0.80.6, but the macro-history is churny (package/org rename, session format v1→v3 with a role rename, `pi-ai` root API moved to `/compat` and scheduled for removal, ~3 releases in one day, pre-1.0, auto-closed new-contributor PRs, effectively single-lead bus factor).
Add one item to DR-10's contract test: the **multi-extension `context` chaining order** contract (Part 3, question 2), since a co-installed extension is as real a threat to the banner as an API rename.

## Part 5 — Fit as the basileus worker harness (long-horizon success / cost)

### 5.1 The slot is already reserved

basileus's system design names the in-VM composition explicitly — "coding harness (swappable) ⊕ Exarchos engine" — and its U-13 candidate ("context is a view, the log is the state") *is* DR-3's thesis.
This design is the concrete proposal for a slot basileus already carved; the question is coverage, not concept.

### 5.2 Requirements scorecard

Against fourteen worker-side harness requirements extracted from the basileus system design: **6 satisfied, 5 partial, 2 gaps.**

Satisfied: separable governance engine (DR-1/9/10); warm local state, no per-action boundary crossing (DR-1/2); fail-closed gates as events (DR-7 + verification ladder); read-only posture-scoped sub-agents (DR-7/INV-11); declarative tool subset (DR-7 tier-1, now grounded in `setActiveTools`); config-not-code workload agnosticism (INV-6).
Partial: headless drive (works, but `ctx.ui.notify` no-ops and the non-interactive question was left open); zero-egress (governance needs no network, but event export is unaddressed); durability into Marten (local log deterministic, no bridge); state fingerprint (`projectionSequence` is exactly the "projection sequence" half of basileus's fingerprint concept; tree-hash pairing and fork-replay unwired); pause/resume (covered iff `.exarchos` rides the persistent sandbox filesystem — eviction is not).
Gaps: **budget integration** (no token/budget events; θ is blind to basileus's Budget Algebra and cache state) and **provenance/identity** (Exarchos events carry idempotency keys, not per-action agent identity/OBO provenance).

### 5.3 Tensions

- **INV-15 scope-out is not a conflict.** "Single-machine, cooperative" holds *within* one sandbox; distribution stays in basileus's tier (its own INV-3 anticipates the crossing). Caveat: DR-8's two-process concurrency story is over-built for a single-writer sandbox, while the cross-tier coordination that actually matters is out of frame.
- **The biggest gap is state egress.** DR-2 resolves Pi-session-vs-`.exarchos`; the basileus-relevant pair is `.exarchos` (in-VM) vs **Marten** (the durable authority at the orchestrator). Snapshot/pause/resume is covered by DR-6; **eviction and diagnostic fork destroy the VM filesystem**, and the spec specifies no export/sync of the event log or projection to the control plane. basileus's fingerprint concept shows the projection is *meant* to be exportable — the seam needs its own DR (or a companion spec), not silence.
- **DR-6 solves the wrong fork problem for this consumer.** It spends its budget on Pi's human tree ops; the fork basileus needs is programmatic snapshot-fork/diagnostic-fork of the whole sandbox. Not harmful — just not the seam that matters headless.
- **Three tool-scoping authorities with no precedence:** Exarchos phase gate (DR-7), basileus ExecutionProfile subset, and the control-plane gate can disagree; the design should state the composition rule (intersection, with the phase gate narrowing only).
- **Two disconnected budget loops:** governance clears trigger on θ; basileus cost governance runs Budget Algebra and tier-escalation. Neither sees the other. The clear trigger should accept an external budget signal (or at minimum emit token/cache telemetry events basileus can fold).
- **`sendUserMessage` (tier-3) is more load-bearing headless** — nobody nudges a stalled model in a sandbox — yet the spec treats it as an exception. Fine, but the acceptance criteria should exercise it under `--mode json`/rpc.

### 5.4 Long-horizon / cost lens on the context strategy

What it gets right is exactly what basileus needs: a fresh compact window over a deterministic, LLM-free, replayable fold (matches U-13, the audit posture, and the fingerprint concept), plus semantic clear boundaries token-based compaction cannot see.
Three weaknesses for multi-hour autonomous coding:

1. **Prompt-cache economics unaccounted** (Part 4.4) — for a cost-measured fleet this can dominate; both the clear cadence and banner placement need cache-aware treatment, and cache telemetry should flow into the budget events.
2. **No engineering working set.** DR-4 preserves *where you are* (phase, gates, tasks, spec reference) but not *what you were holding* — source under edit, the current diff, the failing test output. After a clear, a coding worker re-reads all of it, uncached. The rehydration document (or the retained tail policy) needs a working-set section; otherwise every clear taxes exactly the long tasks the design is meant to serve.
3. **Long single phases defeat the semantic-boundary advantage.** basileus's dominant shape is a long act/fix loop inside one phase; there, clears fall back to θ — the trigger the spec itself ranks inferior. Consider sub-phase semantic boundaries (e.g., per task completion, per gate execution) as additional clear points.

## Part 6 — Recommended amendments (in priority order)

1. **Rewrite DR-3's mechanism** as a persistent per-call view function over the `context` hook (append-only session, replaced view, re-asserted every fire); name session ops as command-gated and unusable in-loop; rename "clears the conversational transcript" to "clears the model's view".
2. **Fix DR-7 tier-2:** correct the `:778` citation; state that in-turn deny-reason delivery is implemented in `pi-agent-core` and add an integration probe to the acceptance criteria.
3. **Add cache economics** to DR-3/DR-5/DR-7: pin banner placement to end-of-array; state that clears reset the cache (win over compaction = no summarization call + determinism, not cache); budget `setActiveTools` invalidation per phase transition; make θ cache/budget-aware.
4. **Re-scope DR-4's provenance:** mark the token-budget enforcement, governance shedding, gate ledger (currently deliberately excluded by the reducer), and `DR-N` anchors as new engine work.
5. **Close open questions 4 and 6 in the spec** (`setActiveTools`; headless-yes with `ctx.ui.*` caveat) and update DR-8 to surface errors via the event stream/stdout, not only `ctx.ui.notify`.
6. **Add the chaining-order contract** (multi-extension `context` precedence / defensive re-assertion) to DR-10's contract test.
7. **For the basileus consumer, add (or spin off) the missing seams:** state egress of `.exarchos`/projection to the control plane on eviction/fork; budget-loop integration (θ ↔ Budget Algebra, cache telemetry events); tool-scoping precedence rule; a working-set section in the rehydration document or tail policy.
8. **Repair the evidentiary base:** commit the two grounding research docs or drop the citations; fix the line cites in Part 4.5; present INV-2's reframing as in-flight (#1608); correct `--mode print` → `-p/--print`; qualify "~15 events" and "extends the parity harness".

## Sources

- `@earendil-works/pi-coding-agent@0.80.5` and `@0.80.6` (npm tarballs: `dist/core/extensions/types.d.ts`, `dist/core/extensions/runner.d.ts`, `dist/core/sdk.d.ts`, `dist/index.d.ts`, `dist/tools/index.d.ts`, `docs/extensions.md`, `docs/compaction.md`, `docs/session-format.md`, `docs/rpc.md`, `docs/json.md`, `docs/models.md`, `docs/settings.md`, `docs/custom-provider.md`, `docs/usage.md`, `docs/sessions.md`, `examples/extensions/{plan-mode,permission-gate,protected-paths,custom-compaction,handoff,subagent}`, `CHANGELOG.md`, `README.md`)
- <https://github.com/earendil-works/pi> · <https://pi.dev> · <https://rfc.earendil.com/keyword/pi/>
- Exarchos: `servers/exarchos-mcp/src/**` (dispatch, context, rehydrate, event-store, storage, adapters, projections/rehydration), `.exarchos/invariants.md`, `docs/system-design.html`, `src/storage/__tests__/no-legacy-runtime-deps.test.ts`, `vitest.config.ts`, `servers/exarchos-mcp/package.json`
- basileus: `docs/system-design.html`, `docs/designs/2026-04-18-strategic-framing-exarchos-basileus.md`
- Audited spec: `docs/specs/2026-07-09-exarchos-pi-embedding.md` (untracked draft; its cited grounding docs `docs/research/2026-07-09-exarchos-pi-harness-extension.md` and `docs/research/2026-07-09-exarchos-in-pi-governance-embedding.md` were absent from disk and git history at audit time)
