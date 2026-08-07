# MCP `2026-07-28` × the Exarchos internal contract — architectural composition

**Date:** 2026-08-06
**Workflow:** `mcp-spec-2026-07-28-migration` (discovery, companion doc)
**Companion to:** [`2026-08-06-mcp-spec-2026-07-28-migration-evaluation.md`](./2026-08-06-mcp-spec-2026-07-28-migration-evaluation.md)
**Scope:** how the new spec's architectural patterns compose with the dispatch core (INV-2) and the CLI contract. Not a migration plan — that is the companion doc.

---

## 1. Thesis

> **`2026-07-28` moves MCP onto the architecture the CLI facade has had all along.**

Every headline pattern in the revision — explicit handles instead of session state, per-request self-description, polling instead of blocking, return-plus-retry instead of a server-initiated back-channel, server-directed rather than client-opted long-running work — is a pattern the CLI facade was *forced* into, because a CLI process has no session, no persistent connection, and no back-channel to its caller.

MCP was the facade that could do more. That extra capability is exactly what the revision removes.

The consequence is not merely "migration is survivable." It is that **INV-2 facade equivalence gets structurally easier to hold**, and three long-standing divergences between the CLI and MCP facades either disappear or become pure presentation. Exarchos does not need to bend to accommodate this spec; the spec has bent toward Exarchos's CLI.

This is worth stating precisely because it inverts the usual read. The ecosystem is treating `2026-07-28` as a tax on server authors who built around sessions. Exarchos never did — and the CLI facade is the reason. The parity discipline that INV-2 imposed as a *cost* turns out to have been a hedge that just paid out.

---

## 2. The two contracts, as they stand

### 2.1 The internal contract — INV-2

Quoted verbatim from `.exarchos/invariants.md` (INV-2, `dimension: facade-equivalence`, `integrity-class: substrate`):

> CLI and MCP are both facades over a single functional dispatch core. For any verb, the same DispatchContext + arguments must produce the same ToolResult. Adapters carry zero behavior — only presentation. Post-#1266, every action also registers a Zod outputSchema so parity is schema-checked in addition to byte-checked.

Enforcement is `mode: audit`, deliberately not `check`, with this audit prompt:

> Do the CLI and MCP adapters carry only presentation, with all behavior in the shared dispatch core? Flag logic added to `adapters/cli.ts` or `adapters/mcp.ts` beyond formatting, and any verb lacking a parity or registered outputSchema guarantee.

The shared core is `dispatch(tool, args, ctx) → Promise<ToolResult>`; the shared envelope is `ToolResult` / `Envelope<T>` (`success`, `data`, `error`, `next_actions`, `_meta`, `_perf`).

### 2.2 The CLI contract

| Element | Contract |
| --- | --- |
| Invocation | Process per command. No session, no daemon, no connection. |
| Identity | `featureId` as an ordinary argument. |
| State | SQLite event store; `resolveWorkflowState` is the only source of truth. |
| Flags | Auto-emitted from the action's Zod schema (`addFlagsFromSchema`, `src/adapters/schema-to-flags.ts`) — no hand-written flag table to drift. |
| Output | The `ToolResult` envelope, JSON-serialized. |
| Exit codes | `CLI_EXIT_CODES` = `SUCCESS: 0`, `INVALID_INPUT: 1`, `HANDLER_ERROR: 2`, `UNCAUGHT_EXCEPTION: 3`. DR-7 maps `errorCode` → exit code as **presentation metadata**. |
| Long-running work | Registry metadata `longRunning: true` (9 actions) drives line-buffered heartbeat emission (DR-5). |
| Streaming | `--follow` over `VIEW_FOLLOW_ACTIONS` (5 view actions), driving `runInspectFollow` → NDJSON `Frame`s. |

### 2.3 The loophole INV-2 does not close

INV-2 quantifies parity over "**the same** DispatchContext + arguments." But the contexts are never the same. `DispatchContext` carries three optional, facade-specific capability adapters, each documented in-source with the identical disclaimer:

| Field | In-source doc |
| --- | --- |
| `rootsClient` | *"When the client declares the `roots` capability via the initialize handshake… Optional — CLI / direct-call contexts omit it and dispatch falls back to the cwd-walk branch."* |
| `elicitationClient` | *"When the client declares the `elicitation` capability via the initialize handshake… Optional — CLI / direct-call contexts omit it and dispatch falls back to the legacy INVALID_INPUT contract."* |
| `taskStore` | *"When wired, dispatch inspects the dispatched args for the SDK `task: { ttl? }` augmentation key and… routes through `runTasksAugmented`… When absent, [the legacy one-shot envelope]."* |

**The behavioural divergence between the facades lives in the context, not in the adapters** — so INV-2's audit prompt, which inspects `adapters/cli.ts` and `adapters/mcp.ts`, structurally cannot see it. The invariant is honestly stated and correctly enforced; it just does not reach the place where the facades actually differ.

Every one of those three fields exists to expose an MCP capability that the CLI has no way to express: a server-initiated `roots/list` request, a server-initiated `elicitation/create` request, and an SDK task lifecycle bound to a live connection. **All three are exactly what `2026-07-28` removes, deprecates, or restructures.**

---

## 3. Pattern-by-pattern composition

### 3.1 Stateless core + explicit handles → the CLI's model, adopted

The spec's guidance:

> Dropping the protocol-level session doesn't force your application to be stateless. If your server needs to carry state across calls, mint an explicit handle from a tool and have the model pass it back as an argument. We found this works better than session state hidden in the transport — the model can see the handle and thread it between tools.

That is a description of the CLI contract (§2.2): identity is an argument, state is in SQLite, the process is the request. The CLI has no session because it *cannot* have one; the spec now says that was the right shape.

**Composition:** clean, and mostly already done. `featureId` is the handle. The canonical existence check is already `rehydrate`/`get` → `_meta.workflowExists`, never a transport- or filesystem-derived signal — a discipline recorded in CLAUDE.md and earned through an RCA. There is no hidden session state to find because the design never had a place to put it.

**The one new concept:** `requestState` (§3.3) is a *second* kind of handle with a different lifetime — per-flow, signed, TTL'd, untrusted on return. Do not collapse it into `featureId`. Thread `featureId` **inside** a minted `requestState` payload.

### 3.2 Tasks — two inversions, both toward the CLI

The Tasks extension changes two things beyond the wire-level breakage catalogued in the companion doc.

**Inversion 1: blocking → polling.** `tasks/result` (block until done) is removed; `tasks/get` (poll) is the lifecycle driver.

Exarchos already anticipated this pairing. From `src/adapters/cli.ts:239`, on `VIEW_FOLLOW_ACTIONS`:

> **Invariant (INV-2 — CLI `--follow` and MCP `tasks/get` polling produce byte-equivalent transitions):** every member MUST be backed by a pure `ViewProjection` fold — no `eventStore.append`, no `emit`, no `*.polled` events. Repeated polls must be a no-op against the EventStore so the polling cadence under `--follow` (and the MCP-side `tasks/get` retry path) doesn't mutate the timeline they are observing.

The facades were **already** paired on `tasks/get`-style polling, with an audited purity guarantee (five view handlers verified as pure folds, with a source-file idempotency cross-check in CI). The method the spec deletes — `tasks/result` — is precisely the one with **no CLI analogue**, because a CLI cannot block on a connection that does not exist.

> **The 2026 Tasks lifecycle deletes the MCP-only half of the pairing and keeps the half INV-2 already guaranteed.**

One wrinkle to fix, not inherited: `tasksGet` in `src/mcp/tasks-methods.ts` documents a side effect — *"emits a `task.polled` event on the namespaced stream (handled inside the store's `getTask`)."* That is the exact write-on-poll the `VIEW_FOLLOW_ACTIONS` invariant forbids for the view arm. When polling becomes the *primary* task lifecycle rather than an occasional check, a write per poll is a timeline-pollution and write-amplification problem. **Re-basing `tasks/get` on the same pure-fold discipline is the right move, and the invariant text to justify it is already written.**

**Inversion 2: client-opt-in → server-directed.** Today a client opts in per call via the `task: { ttl }` augmentation key, gated on `isTaskSupportDeclared()`. Under the extension, *"task creation is server-directed: the client advertises the extension and the server decides when a call should run as a task."*

Exarchos already has the server-side decision, and it is already facade-neutral: **`longRunning: true` in the registry** (9 actions), which the CLI already consumes to drive DR-5 heartbeats.

| | Today | Under 2026 |
| --- | --- | --- |
| CLI | `longRunning` registry metadata → heartbeats | unchanged |
| MCP | client sends `task: { ttl }` → task envelope | `longRunning` registry metadata → task handle |

The augmentation key was the divergence. Removing it makes **one registry declaration** drive long-running behaviour on both facades — which is what INV-2 wanted and what `longRunning` was already shaped for. This is the single cleanest composition in the whole revision.

**Counter-current: `tasks/list` is removed** (unscopable without sessions). That could create a *new* divergence — the CLI can enumerate, MCP cannot. It should not, because Exarchos's task store is **event-sourced and scoped by stream/featureId, not by session**, so the spec's rationale does not bind us. The correct response is to express enumeration as an ordinary domain verb on `exarchos_view` rather than a protocol method. A domain verb is facade-neutral by construction; a protocol method never was. **Losing `tasks/list` is a nudge toward the more INV-2-compliant design.**

### 3.3 MRTR — the divergence-collapsing change

This is the deepest composition, and the one worth the most attention.

`elicitation/create` is structurally un-CLI-able: the *server* initiates a request to the *client* mid-call over a held-open channel. There is no CLI shape for that, which is why `elicitationClient` is optional with an `INVALID_INPUT` fallback, and why the resolution ladder reads *"explicit > roots > cwd > elicitation > INVALID_INPUT"* — with elicitation last "because it requires a transport round-trip."

MRTR restructures this into: **handler returns `input_required` + `inputRequests` + `requestState`; caller re-invokes with `inputResponses`.**

That shape is facade-neutral. It is a *return value* and a *re-invocation* — two things every facade has:

| Facade | `input_required` renders as | Re-invocation is |
| --- | --- | --- |
| MCP | `resultType: "input_required"` | the client's automatic retry |
| CLI (interactive) | a prompt on stdin | the same process, next loop iteration |
| CLI (scripted) | a non-zero exit + the missing-field list + an opaque `requestState` token | the operator's next command, passing the token |
| Direct in-process | a discriminated return | the caller's next call |

So `elicitationClient` stops being a **context capability** and becomes a **result shape**. Under INV-2 that is a category change with real consequences: it moves from "behaviour that differs by context" to "one envelope, rendered differently per facade" — i.e. from a parity hole to exactly the presentation-only difference INV-2 sanctions.

Three things make this concrete rather than aspirational:

1. **The SDK ships a legacy shim**, so an `inputRequired()` handler runs unchanged on 2025-era connections. The refactor is not gated on the era cutover.
2. **`requestState` makes the flow resumable across processes.** A signed, TTL'd, self-contained blob is precisely what a CLI needs to continue a multi-step interaction across separate invocations — something the current `elicitationClient` can never offer, since it dies with the connection. **MRTR gives the CLI a capability it does not have today.** That is a rare direction of travel and the strongest single argument for adopting MRTR early.
3. **`resultType` is a required discriminator on every result.** The `ToolResult` envelope already has `success: boolean` as its discriminator. These are orthogonal axes — `input_required` is neither success nor failure — so the envelope needs a third state rather than an overload of `success: false`. Getting this wrong is the most likely way to corrupt the contract: an `input_required` mapped onto `success: false` would flow into the DR-7 `errorCode` → exit-code table and surface as `INVALID_INPUT: 1`, which is a lie. **A distinct exit code for "needs input" is required** — the current 0–3 table has no slot for it.

### 3.4 `subscriptions/listen` vs. `--follow`

Both are **caller-opened, opt-in** streams. The spec's model — the client opens one stream and opts into specific notification types, and *"the server never sends an un-requested notification type"* — is structurally the same consent model as `--follow`: nothing streams unless the caller asked.

`tasksFollow` (the DR-4 Tasks arm) is currently built on `notifications/tasks/status`, which is absent from the 2026 method maps. Re-basing it on `subscriptions/listen` (or on `tasks/get` polling) is required work — but the underlying carrier is untouched: `runInspectFollow` over the DR-1 subscription contract, with both facades emitting byte-identical `Frame`s from one subscription. **Only the MCP-side wire changes; the shared carrier, the frames, and the CLI arm are unaffected.** That is the INV-2 layering working as designed.

### 3.5 Cache hints — two different layers, do not conflate

A trap worth flagging explicitly, because the names collide.

| | Exarchos `_cacheHints` | Spec `ttlMs` / `cacheScope` |
| --- | --- | --- |
| Layer | inside the response body | protocol-level, on list results |
| Answers | "where does the stable prefix end, so the **model's** prompt cache can split?" | "how long is this `tools/list` fresh, and is it shareable?" |
| Shape | `{ type: 'cache_boundary', position: 'after:…', kind: 'ephemeral', ttl: '1h' }` | `ttlMs: number`, `cacheScope: 'private' \| 'public'` |
| Gate | capability `anthropic_native_caching`; `EXARCHOS_DISABLE_CACHE_HINTS=1` | SDK `ServerOptions.cacheHints` |
| Facade reach | **facade-neutral** — rides in the envelope, so the CLI gets it too | **MCP-only** — protocol metadata |

They are complementary. `_cacheHints` is an LLM-prompt-cache concern; `ttlMs`/`cacheScope` is an HTTP-`Cache-Control`-style protocol concern. Adopting the standard does **not** supersede the proprietary one, and conflating them would break the DR-14 boundary.

The composition note that matters: `ttlMs`/`cacheScope` is a **new MCP-only surface with no CLI analogue** — a divergence appearing where others are closing. It is benign, because it is transport metadata about the transport's own catalog, which is presentation in INV-2's sense. But it is worth noticing that `_cacheHints` chose the *other* design (in-envelope, hence facade-neutral) and that the choice is why the CLI benefits from it for free.

One real interaction: `applyCacheHints` consults the `CapabilityResolver`, which under 2026 becomes per-request (§3.7). A capability-gated envelope field derived from a per-request envelope is *more* correct than one derived from a connection-scoped snapshot — the same improvement as §3.7, arriving in the response-formatting path.

### 3.6 Extensions framework + `server/discover` — the introspection Exarchos already has

Exarchos has an unusually strong introspection surface: `describe(actions)`, `describe(eventTypes)`, `emissionGuide`, `topology`, `config`, plus a registry that already carries per-action metadata (`longRunning`, `posture`, `surface`, `outputSchema`).

`server/discover` (MUST-implement, cacheable via its own `ttlMs`/`cacheScope`) is the standard place to advertise identity, versions, and extensions. The extensions framework gives reverse-DNS IDs, an `extensions` negotiation map, and independent versioning — a sanctioned home for `experimental: { 'claude/channel': {} }`, and for any protocol-level vocabulary the DKG / remote-agent work needs.

**The composition question this raises is a governance one.** The registry is the single source of truth for action identity, and the CLI's flags already auto-emit from it. `server/discover` is a second place where server identity and capability get declared. Under the *conform-where-a-standard-converged* doctrine, `server/discover` should be **derived from the registry**, never hand-maintained beside it — the same discipline that keeps `addFlagsFromSchema` from drifting. If discovery output is authored separately, it becomes a new drift surface of exactly the kind the skills-renderer `skills:guard` exists to prevent.

### 3.7 Per-request capability resolution — the CLI already had the answer

Covered as a migration cost in the companion doc; here is the composition angle.

`CapabilityResolver` is a mutable closure snapshotted once per handshake. Under 2026, capabilities arrive per request in `ctx.mcpReq.envelope`. Note what the CLI does today: **it constructs a fresh resolver per process, because a process is one invocation.** The CLI's resolver lifetime is already per-request — it just gets there by having no choice.

So "make the resolver request-scoped" is not a new design. It is **adopting the CLI's lifetime on the MCP side**, which is the same move as every other item in this document. It also retires a bug class the code already had to patch around: CodeRabbit MAJOR #1423 fixed cross-handshake roots-cache bleed by clearing the cache inside `snapshot()` — a fix that is unnecessary when the resolver cannot outlive the request.

The security review flagged in the companion doc still applies: `resolveEffectiveCapabilities` is documented as handshake-authoritative specifically to *"prevent runtime widening of trust boundaries via stale yaml defaults,"* and it backs `enforceReadonlyGate`, `enforceSharedMutatingGate`, and `mintCapabilitiesForKind`. Changing where authority comes from is a trust-boundary change even when it is an improvement.

---

## 4. Net effect on the three divergent context fields

| Field | Today | Under `2026-07-28` | Net |
| --- | --- | --- | --- |
| `rootsClient` | MCP-only server-initiated `roots/list`; CLI falls back to cwd-walk | Roots deprecated → tool params + config. `.exarchos.yml` + cwd-walk is already the facade-neutral shape | **Field dies.** CLI's fallback becomes the single path |
| `elicitationClient` | MCP-only server-initiated request; CLI falls back to `INVALID_INPUT` | MRTR → `input_required` is a **result shape** every facade can render | **Field dies.** Becomes presentation (needs a new exit code) |
| `taskStore` | MCP-only, client-opt-in via `task: { ttl }` | Server-directed from `longRunning` registry metadata — already facade-neutral | **Field survives; its trigger becomes shared** |

> All three facade-divergent capability adapters either disappear or become facade-neutral. INV-2 can move from *"parity given the same context"* — with contexts that are never the same — toward **parity, unqualified**.

That is a structural improvement to the invariant, not merely a code cleanup, and it is available as a *consequence* of a migration we have to do anyway.

---

## 5. Concrete CLI-contract consequences

1. **A new exit code for `input_required`.** `CLI_EXIT_CODES` (0–3) has no slot for "needs input." Mapping it to `INVALID_INPUT: 1` via the DR-7 table would be wrong — the input was not invalid, it was incomplete-by-design, and the call is resumable. Add a distinct code; keep the mapping presentation-only per DR-7.
2. **`requestState` needs a CLI carrier.** A scripted CLI resuming an MRTR flow must pass the token back. `addFlagsFromSchema` derives flags from the action schema, and `requestState` is *protocol* state, not action state — so it needs a reserved flag (e.g. `--request-state`) handled like the existing `task` augmentation key: **stripped before `.strict()` schema validation**, exactly as `dispatch()` already strips `task`. That strip-before-validate pattern is the precedent; reuse it rather than inventing a second one.
3. **`--follow` and `tasks/get` converge further.** Already paired by the INV-2 comment; the 2026 lifecycle removes the unpaired blocking method. Re-base `tasks/get` on the same pure-fold discipline and drop the `task.polled` write (§3.2).
4. **`longRunning` becomes load-bearing on both facades.** Today it drives CLI heartbeats only. Under server-directed tasks it also decides which MCP calls return a task handle. It graduates from CLI presentation metadata to a shared behavioural declaration — which means **the parity harness must start covering it**.
5. **Interactive vs. scripted CLI is now a real distinction.** MRTR gives an interactive CLI a stdin prompt loop and a scripted CLI a resumable token. That is new surface area; decide deliberately rather than letting it emerge.

---

## 6. Risks specific to composition

| # | Risk |
| --- | --- |
| C1 | **`resultType` vs. `success` conflation.** `input_required` is neither success nor failure. Overloading `success: false` corrupts the DR-7 error→exit-code mapping and every `Envelope<T>` consumer. Needs a third state, designed once, at the envelope level. |
| C2 | **`requestState` is untrusted input crossing a trust boundary.** Signed (HMAC-SHA256), **not encrypted** — the client can base64url-decode it. Use `createRequestStateCodec`; never hand-roll; never put anything confidential in it; bind to principal + originating method + expiry. |
| C3 | **`task.polled` write-on-poll.** Already contrary to the `VIEW_FOLLOW_ACTIONS` purity invariant; becomes a write-amplification and timeline-pollution problem once polling is the primary lifecycle. |
| C4 | **Dual-era divergence is a *third* facade.** During the `serveStdio` dual-era window there are effectively CLI, MCP-2025, and MCP-2026 behaviours. In a repo that just finished a test de-divergence wave (#1705), keep this window short and deliberate. |
| C5 | **`server/discover` as a second source of truth.** Must be derived from the registry, not authored beside it, or it becomes a drift surface. |
| C6 | **INV-2's audit prompt still cannot see context-carried divergence.** Even after the three fields resolve, the invariant text should be tightened so the next capability adapter does not reopen the hole silently. |

---

## 7. Recommendations

1. **Tighten INV-2** to quantify over the *facade*, not the context — something like: *"any behavioural difference between facades must be expressible as a difference in the rendered presentation of one shared `ToolResult`; capability adapters on `DispatchContext` that gate behaviour are INV-2 violations, not exemptions."* This is the durable structural fix, and §4 is what makes it newly achievable. Author it through `/exarchos:invariants` rather than hand-editing the catalog.
2. **Design the `input_required` envelope state before writing any MRTR code.** It touches `Envelope<T>`, the DR-7 exit-code table, the parity harness, and every consumer. It is the one decision here that is expensive to revisit (C1).
3. **Adopt MRTR early** — the legacy shim means it works on today's wire, and it hands the CLI a resumable-flow capability it does not currently have (§3.3).
4. **Make `longRunning` the single task trigger** for both facades, and extend the parity harness to cover it (§3.2).
5. **Drop the `task.polled` write from `tasks/get`** and re-base it on the pure-fold discipline the view arm already proves (C3).
6. **Derive `server/discover` from the registry** (C5).
7. **Keep `_cacheHints` and `ttlMs`/`cacheScope` separate**, and note that the in-envelope design is why the CLI gets prompt-cache hints for free — a useful precedent when deciding where future hints live (§3.5).

---

## 8. Open questions

1. **Does the interactive CLI get a stdin prompt loop for `input_required`, or is the scripted token-passing flow the only mode?** Affects whether the CLI grows an interactive surface it has so far avoided.
2. **Should the removed `tasks/list` come back as an `exarchos_view` domain verb?** §3.2 argues yes on INV-2 grounds; it is a scope call.
3. **Does `longRunning` alone carry enough signal to decide server-directed task creation**, or does it need a per-action threshold/TTL now that it becomes behavioural rather than presentational?
4. **Where does `requestState` sit relative to the event store?** A signed opaque blob and a durable event stream are two different persistence stories for one flow. Minting `requestState` *from* an event-stream position would unify them — worth exploring, not obviously right.
5. **Does the DKG / remote-agent work want an `io.exarchos.*` extension** for its protocol-level vocabulary, now that the extensions framework is the sanctioned path (§3.6)?

---

## 9. Sources

**Specification / SDK** — as enumerated in the companion doc's §10; the load-bearing ones here are the [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), the [release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/) (explicit-handle guidance, server-directed tasks), the [release candidate post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) (SEP-2260 consent model, `tasks/list` removal rationale), and [Supporting protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html) (`requestState`, `inputRequired`, legacy shim, `subscriptions/listen`, cache-hint defaults).

**Repository** (inspected at `main` @ `30831d05f`)
- `.exarchos/invariants.md` — INV-2 (lines 400–438), verbatim summary + audit prompt
- `servers/exarchos-mcp/src/core/dispatch.ts` — `dispatch()` signature; `DispatchContext` (the three optional capability adapters); `task` strip-before-validate precedent
- `servers/exarchos-mcp/src/adapters/cli.ts` — `CLI_EXIT_CODES`; DR-7 error→exit mapping; `VIEW_FOLLOW_ACTIONS` + the INV-2 `--follow`/`tasks/get` purity comment (line 239); DR-5 `longRunning` heartbeats
- `servers/exarchos-mcp/src/adapters/schema-to-flags.ts` — `addFlagsFromSchema`
- `servers/exarchos-mcp/src/registry.ts` — `longRunning` metadata (9 actions)
- `servers/exarchos-mcp/src/format.ts` — `ToolResult` / `Envelope<T>`; `CacheHints`; `applyCacheHints`
- `servers/exarchos-mcp/src/mcp/tasks-methods.ts` — `tasksGet` `task.polled` side effect; `tasksFollow` DR-4 arm
- `servers/exarchos-mcp/src/dispatch/tasks-augmented.ts` — `task: { ttl }` client-opt-in augmentation
- `servers/exarchos-mcp/src/capabilities/resolver.ts` — handshake-authoritative resolution; `ANTHROPIC_NATIVE_CACHING`
