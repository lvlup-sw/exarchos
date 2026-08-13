# Exp 2 — Native-baseline spike: proven mechanics

**Feature:** `1670-delegation-empirical-testing` · **Requirements:** DR-3 (measured native baseline), DR-7 (fail-honest)
**Date:** 2026-07-09 · **Native binary:** `claude-code` CLI `2.1.206` · **Session model:** `claude-sonnet-5`
**Harness:** [`harness.ts`](./harness.ts) · **Raw data:** [`../data/2026-07-09/exp2-native-baseline.csv`](../data/2026-07-09/exp2-native-baseline.csv) · **Fixtures:** [`fixtures/`](./fixtures/)

This is the spike write-up DR-3 requires as a first-class deliverable. It documents the *proven* mechanics of measuring native Claude Code's delegation behavior, and records the measurement that retires the `NATIVE_FLAT_MODEL='opus'` assumption the prior #1636 benchmark shipped unmeasured.

The spike was deliberately minimal — a synthetic 3-task plan (`Sum 2+2`, `Sum 10+15`, `Uppercase 'exarchos'`) — because its job is to prove the *mechanics*, not to benchmark real work: can headless CC be driven to delegate reproducibly, and can per-subagent model + tokens be harvested? Both were proven, across two real runs, with the model-attribution mechanism exercised in both of its observed shapes.

---

## 1. How headless CC was made to treat a spec as its plan and enter delegation

Native CC is driven through the standard headless entry point — no exarchos code in the loop:

```
claude -p "<prompt>" --output-format stream-json --verbose \
  --model sonnet --allowedTools Task --max-turns 8 --dangerously-skip-permissions
```

The argv is built by [`buildClaudeArgs`](./harness.ts); `--output-format stream-json --verbose` is what makes the session emit one JSON event per line (the transcript we parse), and `--allowedTools Task` scopes the run to the delegation surface so the parent cannot wander into implementing tasks itself.

The prompt ([`buildDelegationPrompt`](./harness.ts)) wraps the spec text in an explicit *"treat this AS your plan — do not re-plan it"* frame, then instructs: *for each task, dispatch a separate `general-purpose` subagent via the Task tool, in parallel; do not implement any task yourself.* This is the reproducible mechanic for making CC regard an arbitrary spec as a fixed plan and enter delegation rather than answer directly.

**It worked in both runs.** Every dispatched subagent surfaces in the transcript as a `system` / `task_started` event keyed by `tool_use_id`, paired with a terminal `system` / `task_notification` carrying the subagent's token total and completion status. Delegation-detection off `task_started` is unambiguous — each event is a real Task dispatch — so the count of subagents is measured, never inferred.

## 2. How per-subagent model + tokens were captured

[`extractSubagents`](./harness.ts) reduces the transcript to one observation per subagent:

- **Seed** one record per `task_started` (keyed by `tool_use_id`).
- **Model + per-message tokens + tool calls** come from `assistant` events whose `parent_tool_use_id === tool_use_id` (a message the subagent streamed up to the parent transcript). The model is read directly off `message.model`; `input`/`output` tokens are summed; `tool_use` content blocks are counted as verification/tool behavior.
- **Authoritative totals + status** are overlaid from the matching `task_notification` (`usage.total_tokens`, `status`, and — for a silent subagent — the authoritative `usage.tool_uses`).

The two real runs differed in exactly one way, and that difference is itself a finding about the capture surface:

| Variant | Fixture | Subagent `assistant` streamed to parent? | Model attribution |
|---|---|---|---|
| **A — streamed** | `delegation-sonnet-3subagents.jsonl` | Yes (`parent_tool_use_id` set) | **Direct** — read off `message.model` (`modelSource: assistant`) |
| **B — notification-only** | `delegation-sonnet-notification-only.jsonl` | No (`parent_tool_use_id: null` on every `assistant`) | **Session-single inference** (`modelSource: session-single`) |

Per-*message* model linkage is therefore not reliable across runs. The always-present signal is the terminal `result.modelUsage` aggregate. [`resolveSubagentModels`](./harness.ts) back-fills any unresolved subagent from the sole session model **only when `result.modelUsage` holds exactly one key** — in which case every subagent provably ran on that one model. This is a *measured inference*, flagged `session-single`, never a guess: with zero or ≥2 session models the subagent stays `unresolved` / `null` and is counted under `unattributed`. That guard is unit-tested (a synthetic two-model session leaves subagents unresolved).

**Tokens** are captured at two granularities: the authoritative per-subagent `total` from `task_notification` (present in both variants), and the finer `input`/`output` sums from streamed assistant messages (present only in variant A). Both are in the raw CSV.

## 3. How both pipelines were driven over an identical task set

The comparison the whole feature turns on — *native vs. exarchos over the same work* — holds the **task set constant** and varies only the driver:

- **Native (this harness):** the plan is handed to `claude -p` via `buildDelegationPrompt`; native decides model + verification per subagent; the transcript is parsed for what native actually did.
- **Exarchos (Exp 1 / Exp 3 harnesses):** the *same* task set flows through `prepare_delegation` (Exp 1, the classification surface) and the `quality-ab` dispatcher (Exp 3, the implementation surface).

Because both sides consume the identical task set, the model-selection and verification claims are apples-to-apples. This harness's parser is transport-agnostic — it consumes stream-json *events*, not a `claude`-specific object — so the Claude Agent SDK fallback (held in reserve, §5) can emit the same event shape and reuse the parser unchanged.

## 4. Measured native model distribution — the `NATIVE_FLAT_MODEL='opus'` assumption, retired

[`computeModelDistribution`](./harness.ts) reduces the observations to the headline. Both runs agree:

| Run | Variant | Subagents | Per-model | Distinct models | `inheritsSingleModel` | Attribution |
|---|---|---|---|---|---|---|
| r1 | A — streamed | 3 | `{claude-sonnet-5: 3}` | 1 | **true** | per-subagent (direct) |
| r2 | B — notification-only | 3 | `{claude-sonnet-5: 3}` | 1 | **true** | session-single |

**Finding: native CC subagents INHERIT the session model; they were not assigned distinct per-subagent models.** The session was launched with `--model sonnet`, and every dispatched subagent ran on `claude-sonnet-5` — a *flat* model, not a mix.

> **Scope of the finding (N=2 spike).** Both runs **pinned** `--model sonnet` over a trivial synthetic plan, so what is measured is that native did **not override the session model per-subagent** — not that native has no default routing on an *unpinned* session. Measuring native's default per-subagent routing (the stronger open question) would need an unpinned run; this spike establishes the flat-inheritance mechanic and retires the `opus` *value* of the assumption, not the general routing behavior.

This corrects the prior benchmark on two counts:

1. **Native is flat, not a mix.** The provisional worry that native might route a *mix* (making exarchos's flat routing *less* differentiated) is not borne out: with `distinctModelCount = 1` and zero unattributed subagents, native inherited a single model. The "model selection vs native ≈ no-op" reading strengthens rather than flips — exarchos's flat routing matches native's flat inheritance.
2. **The flat model is the *session* model, not a fixed `opus`.** The specific literal `NATIVE_FLAT_MODEL='opus'` is retired: native's flat model is *whatever `--model` selected* (here `sonnet`), inherited by every subagent — not a hardcoded opus. Any "vs native" model comparison must pin native to the session model of the run, not to a constant.

The distribution is derived **only** from subagents actually observed in a real transcript. There is no code path that fabricates one.

## 5. Fail-honest (DR-7) and the SDK fallback

**Fail-honest.** If native does not enter delegation (zero `task_started` events), [`buildNativeBaselineRecord`](./harness.ts) returns a **BLOCKED** record that carries the reason and the fallbacks attempted and *structurally* has no `modelDistribution` field — verified against the `no-delegation-direct-answer.jsonl` fixture, which deliberately still carries a session-wide `result.modelUsage` (a single haiku key) that a dishonest harness could have lifted into a "distribution." It refuses. A `claude` launch failure or non-zero exit with no delegation degrades to the same BLOCKED outcome. No modeled or assumed number is ever substituted for a measured one — this is precisely the #1669 methodology sin this feature exists to undo.

**SDK fallback.** `claude -p` transcript capture proved reliable for delegation detection, token spend, and (via `result.modelUsage`) model attribution, so the primary `claude -p` mechanic is used. The one fragile surface — per-*message* subagent model linkage (variant B) — is already covered by session-single resolution for the flat-model case. The Claude Agent SDK remains the reserve path if richer per-subagent structure is ever needed; because the parser is event-shaped, an SDK path emitting the same events reuses it unchanged.

---

## Reproduce

```
tsx tests/evals/native-baseline/harness.ts <specPath> --model sonnet   # live run (spawns claude)
npx vitest run tests/evals/native-baseline/harness.test.ts             # parser fidelity + fail-honest, vs the captured fixtures
tsx tests/evals/native-baseline/emit-baseline-csv.ts                    # regenerate the CSV from the fixtures
tsx tests/evals/native-baseline/emit-baseline-csv.ts --check           # CI: fail if the committed CSV drifts from the fixtures
```

[`exp2-native-baseline.csv`](../data/2026-07-09/exp2-native-baseline.csv) is **derived from the captured fixtures**, not hand-authored: [`emit-baseline-csv.ts`](./emit-baseline-csv.ts) reduces the transcripts through the same parser the tests pin and stamps every row through the Task-001 provenance helper (`stampProvenance`, which rejects an incomplete pin), so `source=measured` + `binaryTag`/`gitSha`/`date`/`modelIds` are guaranteed present and a reader can regenerate or invalidate the table.
