# DR-9 — `content` vs `structuredContent` model-context injection: verification note

> **Type:** Verification / decision-oriented research (DR-9 gate)
> **Date:** 2026-07-12
> **Feature:** `tool-token-economy-remediation` — see [the spec](../specs/2026-07-12-tool-token-economy-remediation.md) (DR-9, Task 016 → Task 017)
> **Question:** For each Tier-1 runtime — Claude Code first — which MCP `CallToolResult` field does the host client inject into the **model's context window**: the legacy `content` text block, the typed `structuredContent`, or both? A lean `content` only saves *model-visible* tokens on a runtime that injects `content`.
> **Decision:** **DEFER the gated lean rendering** (Task 017's `renderContent` stays byte-identical) until the live reproduction below evidences Claude Code injecting `content` (not `structuredContent`) **and** a lean rendering cuts model-visible tokens ≥30% across ≥3 representative actions. The unconditional `renderContent(env)` seam lands regardless — see §6.

---

## TL;DR

- Today `toMcpResult` (`servers/exarchos-mcp/src/adapters/mcp.ts:173`) serializes the **full envelope twice**: once as `content[0].text` (`JSON.stringify(env)`) and once as `structuredContent` (the same `env`). Anything a lean `content` would save is *host-visible only if that host injects `content` into the model's prompt*.
- **Which field is injected is a host implementation choice, not an MCP-protocol guarantee.** The spec defines the *wire* shape (server → client); it does not mandate what the client feeds the LLM. So the token win of a lean `content` is per-runtime and must be *measured*, not assumed.
- **From static analysis alone (code + MCP spec) none of the six Tier-1 runtimes' injection behavior can be *evidenced*.** Claude Code, Codex, Copilot, Cursor, and OpenCode are closed / not inspectable from this repo; "generic" is a family, not one client. The MCP spec's backwards-compat SHOULD (carry the serialized JSON in a `TextContent` block) tells us `content` is *always populated*, but not that any given host *injects* it into model context.
- **DR-9's own INV-4 clause makes the current-evidence verdict a DEFER:** "any Tier-1 runtime whose injection behavior cannot be evidenced ⇒ defer." Right now *every* runtime is un-evidenced, so the rule returns DEFER by construction. The reproduction in §5 is the instrument that can flip this to GO.
- **The seam is not gated.** `renderContent(env)` (Task 017's floor) lands byte-identically whether the verdict is GO or DEFER. Only the *lean rendering that fills the seam* is gated on the evidence below.

---

## 1. Current behavior (verifiable — code)

`toMcpResult` maps an Exarchos `Envelope` onto the MCP `CallToolResult` carrier. Verbatim from `servers/exarchos-mcp/src/adapters/mcp.ts:173`:

```ts
export function toMcpResult(env: Envelope<unknown> | ErrorEnvelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env) }],
    structuredContent: env as unknown as { [x: string]: unknown },
    isError: env.success === false,
  };
}
```

The same `env` object is emitted **twice** over the wire:

- `content[0].text` = `JSON.stringify(env)` — the whole envelope as a text block.
- `structuredContent` = `env` — the whole envelope as a typed object.

The in-repo characterization already pins this mirror: `servers/exarchos-mcp/src/__tests__/integration/tools-call.test.ts` asserts `JSON.parse(content[0].text)` deep-equals `structuredContent`. So the double-serialization is a *tested invariant today*, not an accident — which is exactly why the DR-9 split needs a deliberate seam rather than an ad-hoc trim.

**Consequence:** on any host that injects `content` into the model prompt, the model pays for the *full* envelope even though the machine-parseable copy is already in `structuredContent`. That is the token the lean rendering targets. On any host that injects `structuredContent` (and ignores `content` for the model), a lean `content` costs the model nothing to lose — it was never in the prompt — so the change is no-loss (and still trims the wire payload).

## 2. The question (why this is not free)

A lean `content` (e.g. a one-line summary + `next_actions`, with the full payload left in `structuredContent`) only reduces **model-visible tokens** if the host injects `content` into the model's context. Restated as a decision variable per runtime:

| Host injects into model context | Effect of a lean `content` |
| --- | --- |
| `content` only | **Saves** model tokens (the win DR-9 targets). |
| `structuredContent` only | **No model-token change** — `content` was never in the prompt. No-loss; still trims wire bytes. |
| both | Saves model tokens **iff** the model doesn't then need the full payload from `content`; risk of dropping model-needed detail. |
| unknown / unevidenced | **Cannot guarantee** the model-visible contract holds ⇒ INV-4 defer. |

The crux: this table is filled by *host behavior*, and host behavior is not fixed by the protocol (§3). It must be observed (§5).

## 3. What the MCP spec does and does not guarantee (verifiable — spec)

Grounded in the Tools / Structured Content sections of MCP revisions **2025-06-18** (which introduced `structuredContent` + tool `outputSchema`) and **2025-11-25** (current; same structured-content model). The repo runs `@modelcontextprotocol/sdk` `1.29.0` (`servers/exarchos-mcp/package.json`).

**What the spec *does* say (load-bearing here):**

1. When a tool declares an `outputSchema`, the server SHOULD return schema-conforming results in `structuredContent`. Every visible Exarchos tool advertises the LCD `EnvelopeSchema(z.unknown())` as its `outputSchema` (`adapters/mcp.ts` `LCD_OUTPUT_SCHEMA`), so populating `structuredContent` is spec-correct.
2. **For backwards compatibility, a tool returning structured content SHOULD *also* return the serialized JSON in a `TextContent` block.** This is precisely the double-serialization in §1, and the code comment at `adapters/mcp.ts:164` cites it. It guarantees `content` is *populated* for clients that predate `structuredContent`.

**What the spec *does not* say (the reason DR-9 needs empirical verification):**

- It does **not** specify which field a host injects into the **LLM's context window**. The spec's scope is the server↔client *wire* contract (what the `CallToolResult` carries), not the host's *prompt-assembly* policy (what the client feeds the model). Presentation of tool results to the model is implementation-defined and out of the protocol's scope.
- Therefore "we populate `structuredContent`, so the model sees less if `content` is lean" is **not derivable from the spec**. It is a claim about a specific client's prompt assembler, which the spec deliberately leaves to the client.

This is why the acceptance criterion frames the injection question as "unknown by design" (spec line 219) and gates the rendering on measured evidence rather than a spec citation.

## 4. Per-runtime injection behavior — what is verifiable *from here*

Tier-1 runtimes (the INV-4 platform axis, six entries — `runtimes/{claude,codex,copilot,cursor,opencode,generic}.yaml`). "Verifiable from here" = derivable from this repo's code + the public MCP spec, **without a live session**. Be honest: for the model-context-injection question, almost nothing is statically verifiable, because every one of these is a closed or heterogeneous host whose prompt assembler is not in this repo.

### 4.1 Claude Code (primary runtime)

- **Statically verifiable:** Claude Code is the reference host for the plugin packaging (`.claude-plugin/` registers the `exarchos` MCP server). It is a closed-source client; **its prompt-assembly logic — which `CallToolResult` field it renders into the model's `tool_result` block — is not inspectable from this repo.**
- **Prior (NOT evidence):** the legacy `content` `TextContent` block is the universal, pre-`structuredContent` channel every MCP client understands, and the historical norm across hosts has been to render `content` text into the model-visible `tool_result`. That makes "Claude Code injects `content`" the *plausible* hypothesis — but it is a hypothesis, and DR-9's rule requires it be *demonstrated*, not assumed. Claude Code releases move quickly; a version that reads `structuredContent` preferentially would invert the answer.
- **Verdict from here:** **UN-EVIDENCED.** Resolve via §5 against the specific Claude Code version in use.

### 4.2 Codex, Copilot, Cursor, OpenCode

- **Statically verifiable:** each ships an MCP client (they are Tier-1 harnesses with hooks per `runtimes/*.yaml`), but none of their prompt assemblers live in this repo. Whether each injects `content`, `structuredContent`, or both into its model context is **not determinable statically.**
- Cursor and Copilot in particular have their own tool-result rendering UIs; UI rendering ≠ model-context injection, and the two can diverge (a client may *show* structured JSON in a panel while injecting only a `content` summary into the prompt, or vice-versa). Do not infer injection from what a UI displays.
- **Verdict from here:** **UN-EVIDENCED** for all four.

### 4.3 Generic

- **Statically verifiable:** `generic.yaml` is a *family* of MCP-speaking clients, not a single implementation. There is no single injection behavior to evidence; different generic clients will differ.
- **Verdict from here:** **UN-EVIDENCED** and, for the lean-rendering guarantee, arguably un-evidenceable in the general case — a lean `content` cannot be *guaranteed* safe for an arbitrary unknown client that might inject `content`. This is the sharpest INV-4 constraint (see §6).

### 4.4 Summary table

| Runtime | Injection behavior verifiable from here? | Verdict |
| --- | --- | --- |
| Claude Code | No (closed client; prompt assembler not in repo) | UN-EVIDENCED — resolve via §5 |
| Codex | No | UN-EVIDENCED |
| Copilot | No | UN-EVIDENCED |
| Cursor | No | UN-EVIDENCED |
| OpenCode | No | UN-EVIDENCED |
| Generic | No (a family, not one client) | UN-EVIDENCED (un-evidenceable in general) |

The only thing the spec + code *do* pin: `content` and `structuredContent` are both always fully populated today (§1, §3). What each host *does with them for the model* is exactly the gap §5 closes.

## 5. Reproduction steps — empirically confirm Claude Code's injection

Goal: determine, for a specific Claude Code version, whether the model-visible `tool_result` carries the `content` text, the `structuredContent`, or both. Written so a follow-up run can execute it verbatim.

### 5.1 Marker experiment (primary — decides the GO precondition)

1. **Wire the server into a live Claude Code session.** Install/enable the `exarchos` MCP server (plugin packaging or `exarchos mcp`) so `tools/list` shows the visible composite tools.
2. **Introduce a differ marker in a throwaway build of `toMcpResult`** so `content` and `structuredContent` disagree by a unique sentinel each (do NOT commit this; it is instrumentation):
   ```ts
   // TEMPORARY instrumentation — not for commit
   export function toMcpResult(env: Envelope<unknown> | ErrorEnvelope) {
     const nonce = 'DR9-' + Math.random().toString(36).slice(2, 10);
     return {
       content: [{ type: 'text' as const,
         text: JSON.stringify({ ...env, __marker: `CONTENT_SEEN_${nonce}` }) }],
       structuredContent: { ...(env as object),
         __marker: `STRUCTURED_SEEN_${nonce}` } as { [x: string]: unknown },
       isError: env.success === false,
     };
   }
   ```
   The `content` copy carries `CONTENT_SEEN_<nonce>`; the `structuredContent` copy carries `STRUCTURED_SEEN_<nonce>`. Same call, two distinguishable markers.
3. **Issue one tool call** from the live session — e.g. ask the agent to run a read-only `exarchos_view` action so a `CallToolResult` comes back through the instrumented `toMcpResult`.
4. **Observe which marker reaches the model.** Two independent readouts (run both; they should agree):
   - **Transcript inspection (authoritative):** open the session JSONL under `~/.claude/projects/<project-dir>/*.jsonl`, find the `tool_result` for that call in the messages sent to the model, and grep for `CONTENT_SEEN_` vs `STRUCTURED_SEEN_`. Whichever marker is present *in the model-visible message* is the injected field.
   - **Model echo (corroborating):** in the same turn, ask the model to repeat verbatim any token it can see matching `*_SEEN_DR9-*`. The marker it echoes is the one in its context. (Echo alone is weaker — the model can hallucinate — so treat the transcript as authoritative and the echo as a cross-check.)
5. **Classify:**
   - only `CONTENT_SEEN_*` reaches the model ⇒ **Claude Code injects `content`** ⇒ GO precondition *met* (proceed to §5.2).
   - only `STRUCTURED_SEEN_*` ⇒ injects `structuredContent` ⇒ lean `content` is **no-loss** for Claude Code but yields **no model-token win** ⇒ DR-9 GO precondition *not* met on the token-benefit axis.
   - both markers reach the model ⇒ injects both; a lean `content` still saves tokens but verify the model doesn't lose payload it needs (re-run a task that requires deep fields).
6. **Remove the instrumentation.** Revert the throwaway `toMcpResult` before any commit.

### 5.2 Token-benefit measurement (the ≥30% / ≥3-actions half of the rule)

Only meaningful if §5.1 classified Claude Code as injecting `content` (or both). Pick **≥3 representative actions** spanning small/medium/large payloads — suggested: `get_pr_comments`, `assess_stack` (the audit's heaviest — ~153,844 tok measured), and a populated `exarchos_view` action.

1. For each action, capture the **model-visible** token count of today's full-envelope `content` (the JSON string the model actually receives — measure the injected text, not the wire bytes).
2. Prototype a lean `renderContent(env)` (summary line + `next_actions`, full payload left in `structuredContent`) and capture the model-visible token count of the lean `content` for the same action + inputs.
3. Compute reduction per action: `1 − lean/full`. **GO requires ≥30% on every one of the ≥3 actions** (DR-9 reads "across ≥3 representative actions" as a floor met by each, not an average that a single big win can carry).

### 5.3 Per-runtime replication (INV-4 sweep)

Repeat §5.1 for each remaining Tier-1 runtime that can host the server (Codex, Copilot, Cursor, OpenCode, and at least one concrete "generic" client). For each: record `content` / `structuredContent` / both / *could-not-run*. A runtime you cannot drive to a verdict stays **UN-EVIDENCED** and triggers the INV-4 defer clause in §6.

## 6. Decision — apply DR-9's rule literally

DR-9's decision rule (spec line 120): implement the lean rendering **only if**

1. the primary runtime (Claude Code) **demonstrably injects `content`** (not `structuredContent`) into model context, **AND**
2. a lean rendering **reduces model-visible tokens ≥30% across ≥3 representative actions**;
3. runtimes evidenced to inject `structuredContent` are **no-loss by construction**;
4. **any Tier-1 runtime whose injection behavior cannot be evidenced ⇒ defer (INV-4** — the guarantee must exist on every runtime's path).

**Applying the rule to the evidence available at authoring time (static analysis only):**

- Condition (1) — Claude Code injecting `content` — is **UN-EVIDENCED** (§4.1). It has a plausible prior but no demonstration.
- Condition (2) — the ≥30% / ≥3-action measurement — has **not been taken** (requires the live prototype in §5.2).
- Clause (4) is **decisive on its own:** *every* Tier-1 runtime is currently un-evidenced (§4), so the INV-4 defer trigger fires regardless of the Claude Code prior.

### Recommendation: **DEFER the gated lean rendering.**

Task 017 lands the `renderContent(env)` seam **byte-identical** (see §7); the *lean rendering* is **not** implemented in this pass. The deferral is evidence-recorded per DR-9's "if verification shows no model-token benefit … the rendering is explicitly deferred with the evidence recorded" path — here the evidence recorded is that the benefit is *unverified*, not disproven, and INV-4 forbids shipping a model-visible change on unevidenced runtime paths.

**This DEFER is designed to be flipped to GO by the §5 run.** The verdict becomes GO when a live run demonstrates **all** of:

- §5.1 classifies Claude Code as injecting `content` (or both, with no lost model-needed payload); **and**
- §5.2 shows ≥30% model-visible reduction on each of ≥3 representative actions; **and**
- §5.3 leaves **no** Tier-1 runtime un-evidenced in a way that could inject `content` — i.e. each runtime is either (a) evidenced to inject `structuredContent` (no-loss by construction — a lean `content` is safe there) or (b) evidenced to inject `content` and included in the ≥30% measurement. A runtime that could inject `content` but is un-evidenced keeps the verdict at DEFER (INV-4).

Practically, the `generic` family (§4.3) is the hardest gate: because it is not a single client, "no un-evidenced content-injecting runtime" may be unsatisfiable for it in general. If so, GO is still reachable by scoping the lean rendering behind a capability/runtime signal so un-evidenced clients keep receiving the full `content` — but that is a Task 017 design question, out of scope for this note; the note's job is to record that the blanket-lean verdict is DEFER on current evidence.

## 7. The seam is unconditional (records the Task 017 floor)

Independent of the §6 go/no-go, Task 017 extracts the inline `content` construction in `toMcpResult` into a single `renderContent(env)` function that is **byte-identical** to today's `JSON.stringify(env)`, pinned by a characterization test (`toMcpResult_RenderContentSeam_BytesIdenticalToInline`). This lands on **both** the GO and DEFER paths:

- It is the structural split point between the **contract** (`structuredContent`, the canonical envelope) and its **presentation** (`content`, a rendering of it) — the first instance of the split the system-design §05 facade-codegen generalizes across facades (spec "Presentation seam (§05 down-payment)", line 174).
- Deferring the *rendering* must **not** defer the *split point* (spec acceptance, line 118). On a DEFER verdict `renderContent` simply stays byte-identical; a future GO fills the same seam with the lean rendering with no re-plumbing.
- Discipline reminder for Task 017: capping/economy logic lives in the shared core (`core/economy.ts`, `core/dispatch.ts`), never in the adapter; `renderContent` only *renders*. New response shapes fall out of the shared envelope + `renderContent`, never a hand-added `cli-format.ts` branch.

---

## References

- Feature spec — `docs/specs/2026-07-12-tool-token-economy-remediation.md`: DR-9 (acceptance + decision rule, lines 113–122), "Presentation seam (§05 down-payment)" (line 174), Task 016 / Task 017 (lines 571–611), open-question "DR-9 client injection behavior" (line 219).
- Current carrier mapping — `servers/exarchos-mcp/src/adapters/mcp.ts:173` (`toMcpResult`) and the backwards-compat SHOULD comment at `adapters/mcp.ts:164`.
- Mirror characterization pinning the double-serialization — `servers/exarchos-mcp/src/__tests__/integration/tools-call.test.ts`.
- MCP specification — Tools / Structured Content, revisions **2025-06-18** (introduced `structuredContent` + `outputSchema` + the "SHOULD also return the serialized JSON in a `TextContent` block" backwards-compat guidance) and **2025-11-25** (current). SDK in use: `@modelcontextprotocol/sdk` `1.29.0`.
- INV-4 (platform-agnosticity, the six-runtime axis) — `.exarchos/invariants.md` INV-4; the defer trigger for un-evidenced runtime paths.
