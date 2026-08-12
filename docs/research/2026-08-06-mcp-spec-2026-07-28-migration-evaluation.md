# MCP spec `2026-07-28` — migration evaluation for Exarchos

**Date:** 2026-08-06
**Workflow:** `mcp-spec-2026-07-28-migration` (discovery)
**Status:** research complete — no code changed
**Current pin:** `@modelcontextprotocol/sdk` **exact `1.29.0`** + a local `patch-package` patch
**Target:** `@modelcontextprotocol/{core,server}` v2, protocol revision `2026-07-28`

---

## 1. Verdict up front

The migration splits cleanly into three buckets, and the headline breaking changes of `2026-07-28` are **mostly not Exarchos's problem**:

| Bucket | Content | Assessment |
| --- | --- | --- |
| **Doesn't apply** | Sessions, `Mcp-Session-Id`, header routing, SSE resumability, OAuth/DCR/CIMD, load-balancer topology | Exarchos is **stdio-only, single-process, no auth**. The entire "stateless core" crisis that makes this the largest MCP revision since launch costs us ~nothing. |
| **Mechanical** | v1→v2 package split, `serveStdio`, dropping the SDK patch | Codemod + a handful of edits. Net **deletion** of local code. |
| **Architectural** | Handshake-authoritative capability resolution; elicitation → MRTR; the **Tasks surface** | Three real refactors. One is a security-model change. One is a strategic win. One is a **hard blocker**. |

**Recommendation: migrate, but stage it — and treat the Tasks surface as a go/no-go gate, not a step.**

> **Read the companion doc's §3 before planning.** Four components — CLI code-generation (MC-1), event-sourced dispatch integration (MC-2), `outputSchema` fullness (MC-3), and the dispatch↔spec↔CLI mapping (MC-4) — determine whether this migration lands on a contract that holds or one that only appears to. They are **gates, not follow-ups**, and they are sequenced into §8 below. The most severe: **106 of 118 `outputSchema` declarations are vacuous**, so the precondition INV-17 rests equivalence-by-construction on is currently a tautology for ~90% of actions.

Two findings dominate everything else:

- **The Tasks surface is a hard blocker (§5.4).** Exarchos's `#1273` task surface spans **14 non-test source files**. On a 2026-era connection the TypeScript SDK returns `-32601` for every `tasks/*` method — they are physically absent from the era's method registry. `tasks/result` and `tasks/list` are *removed from the protocol*, not renamed. There is no shim. This is the single largest cost in the migration and the only item that can make the answer "not yet."
- **Exarchos's capability/trust model is anchored to the `initialize` handshake (§5.2)** — precisely the thing the spec deletes. This is the most interesting finding: the migration *forces* a change that is a genuine correctness improvement, and it lands on the POLA capability gates (`enforceReadonlyGate`, `enforceSharedMutatingGate`, `mintCapabilitiesForKind`).

One strategic frame, from `docs/system-design.html` § *"How one runtime serves many harnesses"*: Exarchos's stated architecture is **"conform where a standard converged, enforce where none did"** — with MCP named explicitly as a converged standard to conform to. Under that doctrine, tracking the spec is not a dependency bump; it is an **architectural commitment**. Falling behind on MCP is falling out of conformance with the one artifact the doc says replaces per-harness rendering.

---

## 2. What actually shipped

`2026-07-28` is the fifth MCP spec revision (previous: `2025-11-25`) and the largest since launch. The headline is a **stateless protocol core**.

Changes that matter to *any* implementer:

1. **No handshake, no sessions.** `initialize`/`notifications/initialized` and `Mcp-Session-Id` are gone (SEP-2575, SEP-2567). Protocol version, client info, and client capabilities travel in `_meta` on **every request** under reserved `io.modelcontextprotocol/*` keys. Cross-call state moves to **explicit server-minted handles passed as ordinary tool arguments**.
2. **`server/discover`.** Servers **MUST** implement it; clients **MAY** call it for up-front version selection or as a back-compat probe.
3. **MRTR (Multi Round-Trip Requests)** (SEP-2322) replaces server-initiated `elicitation/create`, `sampling/createMessage`, and `roots/list`. A handler returns `resultType: "input_required"` with `inputRequests`; the client **retries the original call** with `inputResponses`. All results now carry a required `resultType` (`"complete"` | `"input_required"`).
4. **Tasks leave the core** into the `io.modelcontextprotocol/tasks` extension (SEP-2663). `tasks/result` → polling via `tasks/get`; `tasks/update` added; **`tasks/list` removed** (it cannot be scoped safely without sessions).
5. **`ping`, `logging/setLevel`, `notifications/roots/list_changed` removed.** Log level is per-request via `io.modelcontextprotocol/logLevel` in `_meta`; a server **MUST NOT** emit `notifications/message` for a request that omitted the key.
6. **`subscriptions/listen`** — one client-opened, opt-in stream replaces the HTTP GET endpoint and `resources/subscribe`.
7. **Full JSON Schema 2020-12** for tool `inputSchema`/`outputSchema` (SEP-2106). Inputs keep the `type: "object"` root; outputs are unrestricted; `structuredContent` may be any JSON value.
8. **Cache hints** — `ttlMs` + `cacheScope` on `tools/list`, `prompts/list`, `resources/list`, `resources/read` (SEP-2549).
9. **W3C Trace Context in `_meta`** — `traceparent`, `tracestate`, `baggage` key names fixed (SEP-414).
10. **Formal extensions framework** (SEP-2133) — reverse-DNS IDs, negotiated via an `extensions` map, versioned independently. MCP Apps, Tasks, EMA are the first official extensions.
11. **Deprecations** (SEP-2577): **Roots, Sampling, Logging**, plus legacy HTTP+SSE. Annotation-only, with a **12-month minimum** removal window under the new lifecycle policy (SEP-2596).
12. `-32002` (resource not found) → standard `-32602` (SEP-2164).
13. Auth hardening: RFC 9207 `iss` validation, `application_type` in DCR, issuer-bound credentials, **DCR deprecated in favor of CIMD**.

### 2.1 TypeScript SDK v2

The monolithic package is split, and **the protocol revision is a separate opt-in from the package upgrade**:

| v1 | v2 |
| --- | --- |
| `@modelcontextprotocol/sdk` | `@modelcontextprotocol/client` |
| | `@modelcontextprotocol/server` |
| | `@modelcontextprotocol/core` (public Zod `*Schema` constants) |
| | `@modelcontextprotocol/core-internal` (private — never import) |
| built-in HTTP framework support | `@modelcontextprotocol/{node,express,hono,fastify}` |

Critical property, quoted from the SDK's own migration guide:

> Nothing in v2 puts a 2026-07-28 byte on the wire by default: a hand-constructed `Client`/`Server`/`McpServer` keeps speaking the 2025-era protocol it was written for. Serving or speaking 2026-07-28 is always an explicit opt-in.

**This decouples the two migrations, and it is the single most important scheduling fact in this document.** We can take the v2 package split now — mechanically, low-risk, reversible — and defer the era switch until the Tasks question is answered and clients actually negotiate 2026.

Other v2 facts relevant to us:
- Requires **Node ≥20** — we already declare `>=20.0.0`. ✅
- Requires **`zod ^4.2.0`** — we are on `^4.4.3`. ✅
- ESM-first with a CJS build alongside. We are ESM/NodeNext. ✅
- A **codemod** handles the mechanical renames; it rewrites the nearest `package.json` walking up, and in a workspace it *reports* member changes rather than applying them. Our MCP server has its own manifest, so this needs a per-package run.
- v1 and v2 packages have **different names and can coexist** — incremental migration is explicitly supported. Correct order: add v2 → rewrite sources → remove v1 last.
- Server-over-stdio era opt-in is `serveStdio(() => buildServer())` from `@modelcontextprotocol/server/stdio`, replacing `server.connect(new StdioServerTransport())`. It serves **both eras** unless passed `{ legacy: 'reject' }`; the opening exchange pins the connection's era.
- **There is no in-memory 2026-era serving entry.** `InMemoryTransport.createLinkedPair()` connects 2025-era instances **only**. See §7 — this has direct consequences for our test suite.

---

## 3. Exarchos's current MCP footprint

Verified by inspection of `servers/exarchos-mcp/` at `main` (30831d05f).

| Surface | State | Migration exposure |
| --- | --- | --- |
| **Transport** | stdio only. One call site: `src/adapters/cli.ts:579-585`, dynamic-imported under the `mcp` subcommand for cold-start budget (DR-5) | **Low** — one edit |
| **HTTP / sessions / auth** | none | **None** |
| **Tools** | 4 visible composite + 1 hidden `exarchos_sync` | Low |
| **Resources / Prompts** | **none registered** (`src/registry.ts:3698-3699` — deliberately deferred) | **None** — no `resources/*` or `prompts/*` migration surface, and no `-32002` exposure |
| **Elicitation** | wired at `src/adapters/mcp.ts:405-418` via `server.server.elicitInput`; 3 non-test files | **Medium** — but with a legacy shim (§5.3) |
| **Roots** | `RootsClient` + handshake-scoped cache + `roots/list_changed` invalidation; 4 non-test files incl. `src/workspace/discovery.ts` | **Medium** — deprecated, not removed |
| **Tasks** | full `#1273` surface: `taskStore` on the server ctor, advertised `tasks: { list, cancel, requests: { tools: { call } } }` capability, `tasks/{get,result,cancel}` primitives, task-augmented `tools/call`, event-sourced task store, CLI `--follow` sharing the code path; **14 non-test files** | **HIGH — blocking** (§5.4) |
| **Capability resolver** | `snapshot(handshake)` is **handshake-authoritative**; feeds POLA bundles + readonly/shared-mutating gates | **HIGH — architectural** (§5.2) |
| **Logging** | no `logging` capability declared, no `sendLoggingMessage` usage; `pino` to stderr | **None** ✅ — already on the recommended path |
| **Sampling** | not used | **None** ✅ |
| **MCP client** | **none in production** — only `src/evals/benchmarks/exp1-binary-driver.ts` and test fixtures | **Low** — no `versionNegotiation` work on a shipping path |
| **JSON Schema** | already emits **native draft-2020-12** at `tools/list`, via the local SDK patch (`#1366`) | **Win** (§5.6) |
| **Experimental caps** | `experimental: { 'claude/channel': {} }` | Should become a reverse-DNS extension ID (§6.6) |
| **SDK pin** | exact `1.29.0`, guarded by `src/__tests__/sdk-pin-policy.test.ts` because the Tasks/SEP-1686 surface is `@experimental` | The guard's stated rationale is *precisely* the risk that materialized |

The pin-policy guard deserves a note. It was written (`#1292`) because the Tasks surface was marked `@experimental` and "a minor bump is an explicit, reviewed decision rather than something `npm install` should pick up implicitly." That judgment held: the experimental surface it was protecting is the one the spec has now removed from the core. The guard did its job — it means we are choosing this migration, not discovering it in a broken CI run.

---

## 4. What does *not* apply

Worth stating explicitly, because the ecosystem discourse around this release is dominated by concerns Exarchos does not have:

- **Sessions / sticky routing / shared session stores** — no HTTP transport.
- **`Mcp-Method` / `Mcp-Name` headers, WAF/CDN header stripping** — Streamable HTTP only.
- **SSE resumability removal, `Last-Event-ID`** — not used.
- **All six auth SEPs, DCR → CIMD** — no OAuth surface. This is the area the maintainers say implementers spend most of their integration time; our cost is zero.
- **`-32002` → `-32602`** — we register no resources.
- **Load-balancer / serverless / edge deployment benefits** — the *point* of the release. We capture none of it today.

**Caveat with a shelf life.** Zero of the above applies to *local stdio* Exarchos. The v3.2 milestone is **DKG / Remote Agents**, and memory records claiming as remote-only. If any part of that grows a remote MCP surface, every row above flips from "N/A" to "design input" — and the stateless core becomes a large *tailwind* rather than a cost. Designing that surface against `2026-07-28` from day one is dramatically cheaper than retrofitting it. **This is the strongest strategic argument for doing the work now rather than at the 12-month deprecation wall.**

---

## 5. The five real migration surfaces

### 5.1 Package split + `serveStdio` — mechanical, do first

Two changes:

```ts
// src/adapters/cli.ts — before
const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([
  import('./mcp.js'),
  import('@modelcontextprotocol/sdk/server/stdio.js'),
]);
const server = createMcpServer(ctx);
await server.connect(new StdioServerTransport());

// after (era opt-in)
const [{ createMcpServer }, { serveStdio }] = await Promise.all([
  import('./mcp.js'),
  import('@modelcontextprotocol/server/stdio'),
]);
await serveStdio(() => createMcpServer(ctx));
```

Notes:
- The dynamic-import shape that protects the DR-5 cold-start budget is preserved.
- `serveStdio` serves **both eras** by default; the opening exchange pins the connection. This is the compatibility hedge — one binary, both eras, no client coordination required.
- **One factory instance is pinned per connection**, so `createMcpServer(ctx)` must be safe to call per connection. It already is (invoked once per `exarchos mcp`), but the factory contract is now explicit.
- Run the codemod against `servers/exarchos-mcp/` specifically (workspace-member manifests are reported, not rewritten). `--dry-run` first to get the exact package set.
- `sdk-pin-policy.test.ts` reads `dependencies['@modelcontextprotocol/sdk']` and will need retargeting to the v2 package names — keep the exact-pin policy; the rationale (opt into surface changes deliberately) is now *more* justified, not less.

**This step alone puts zero 2026 bytes on the wire.** It is safe to land independently.

### 5.2 Handshake-authoritative capability resolution — the architectural one

`src/capabilities/resolver.ts` snapshots the `initialize` handshake:

```ts
snapshot(handshake) {
  clientRootsDeclared = handshake.capabilities?.roots?.listChanged === true;
  cachedRoots = undefined;
  clientElicitationDeclared = /* presence-gated */;
  clientTaskSupportDeclared = /* presence-gated */;
}
```

That snapshot is load-bearing for Exarchos's **trust model**, not just feature detection. It feeds `resolveEffectiveCapabilities` (documented as "handshake-authoritative … prevents runtime widening of trust boundaries via stale yaml defaults"), `resolvePosture`, `mintCapabilitiesForKind`, `enforceReadonlyGate`, and `enforceSharedMutatingGate` — the compile-time-plus-runtime POLA machinery behind INV-3 / INV-11 / DR-14.

Under `2026-07-28` on a 2026-pinned connection:
- `getClientCapabilities()` / `getClientVersion()` return **`undefined`** — no `initialize` ever runs.
- Per-request identity is read from **`ctx.mcpReq.envelope`** (typed `Partial<RequestMetaEnvelope>`), lifted by the protocol layer out of `params._meta` before handlers run.

So `snapshot()` must move from **connection-scoped, called once** to **per-request, derived from the envelope**.

**This is an improvement, and worth framing as one.** The current model has a real latent hazard the code already fights: a comment at `resolver.ts:145` records CodeRabbit MAJOR `#1423` — the roots cache is handshake-scoped and stale entries "belong to a different client session and must not carry over," fixed by clearing the cache inside `snapshot()`. That whole class of bug — mutable resolver state whose validity depends on which handshake last fired — **disappears** when capabilities are derived per request from the request's own envelope. Per-request derivation is strictly more precise than a connection-scoped snapshot, and it is the same "explicit handle beats hidden transport state" argument the spec authors make.

Design implications to work through:
- `CapabilityResolver` becomes **request-scoped** (or keeps its interface but takes an envelope per call). The current mutable-closure `createInMemoryResolver` is the wrong lifetime for the 2026 era.
- The dual-era window matters: on a 2025-pinned connection the envelope is absent and the handshake is authoritative; on 2026 the reverse. The resolver needs **one seam serving both**, which is exactly the INV-2 facade-equivalence pattern already used elsewhere in this codebase.
- **Security review required.** Anything touching `enforceSharedMutatingGate` / `mintCapabilitiesForKind` changes a trust boundary. This is not a mechanical refactor and should not be delegated as one.

### 5.3 Elicitation → MRTR — do this early, it is *not* era-gated

Today (`src/adapters/mcp.ts:405-418`) elicitation is a server-initiated request: `server.server.elicitInput(...)`, awaited inline, requiring a held-open bidirectional channel. Under MRTR the handler instead **returns**:

```ts
return inputRequired({
  inputRequests: { count: inputRequired.elicit({ /* schema */ }) },
  requestState: await stateCodec.mint({ step: 'awaiting-count' }),
});
```

…and the client **retries the original call** with `inputResponses`.

**The decisive property:** the SDK ships a **legacy shim** — on 2025-era connections each embedded request is sent as a real server→client request and the handler is re-entered with the collected responses. Per the SDK guide, "the same handler runs unchanged on 2025-era connections through the legacy shim."

**Therefore this refactor can land before any era cutover and improves the code on the current wire.** It converts an inline `await` on a client round-trip into an explicit, resumable state machine — which is a better fit for Exarchos's event-sourced design regardless of protocol version.

Two contract details that will bite if missed:
- **`inputResponses` are per round — replaced on every re-entry, never accumulated.** Multi-step flows must thread prior answers through `requestState` as a discriminated union of phases and `switch` on the phase, not probe which keys arrived.
- **`requestState` round-trips through the client and is therefore untrusted input.** It must be integrity-protected. The SDK provides `createRequestStateCodec({ key, ttlSeconds?, bind? })` (HMAC-SHA256, **signed not encrypted** — the client can base64url-decode the payload), wired via `ServerOptions.requestState.verify`. Do not hand-roll this, and do not put anything confidential in it.

The dispatch-side fallback (`ctx.elicitationClient !== undefined` → else `INVALID_INPUT`) has a history of being silently dead — CodeRabbit MAJOR `#1424` records that `createElicitationClient` had no production caller, so the branch never fired outside tests. **Any MRTR rewrite needs a test that proves the production path is live**, not merely that the fixture works.

### 5.4 Tasks — the blocker

**This is the item that decides the schedule.**

The spec moved Tasks to the `io.modelcontextprotocol/tasks` extension. The TypeScript SDK's treatment is harder than "moved":

> Task methods are excluded from the typed method maps: `RequestMethod` / `RequestTypeMap` / `ResultTypeMap` / `NotificationTypeMap` have no `tasks/*` or `notifications/tasks/status` entries.
> Inbound `tasks/*` requests → `-32601`.

Methods deleted by a revision are **physically absent from that era's registry** — "an inbound `tasks/get` on a 2026-era connection gets `-32601` even if a handler is registered," and sending `tasks/*` toward a 2026-era peer throws `SdkError(MethodNotSupportedByProtocolVersion)` before it reaches the transport. The documented interop path is the **explicit-schema custom-method form**: `request({ method: 'tasks/get', params }, GetTaskResultSchema)`.

Against Exarchos's 14-file surface:

| Exarchos surface | Fate under `2026-07-28` |
| --- | --- |
| `tasks/get` | Survives conceptually — now the **polling** primitive. Must be re-registered through the extension/custom-method path. |
| `tasks/result` (`tasksResult`) | **Removed from the protocol.** Polling `tasks/get` returns the result. |
| `tasks/cancel` (`tasksCancel`) | Survives; extension-scoped. |
| `tasks/list` | **Removed** — cannot be scoped safely without sessions. We *advertise* `tasks: { list: {} }`. |
| `tasks/update` | **New** — client→server input. No Exarchos implementation. |
| Advertised `tasks` capability object | Replaced by the `extensions` map with a reverse-DNS ID. |
| SDK auto-wiring via `taskStore` on the ctor | Gone. `tasks-methods.ts` documents the SDK's `setRequestHandler` wiring as "the authoritative on-wire surface"; that premise no longer holds on 2026. |
| Task-augmented `tools/call` (`task: { ttl }`) | Task creation is now **server-directed**: the client advertises the extension, the **server** decides when a call runs as a task. Inverts our current opt-in. |
| `tasksFollow` / DR-4 streaming arm | Depends on `notifications/tasks/status`, also absent from the 2026 maps. Needs re-basing on `subscriptions/listen` or on `tasks/get` polling. |

Mitigating factors, and they are genuine:
- `tasks-methods.ts` carries `RESERVED(issue: #1273, owner: exarchos, expires: 2027-01-31) — reserved dead stub; deletion at expiry if unadopted`. **Part of this surface may be unadopted.** Establishing what is actually load-bearing on a shipping path is the cheapest possible first move and could shrink this item dramatically.
- The CLI `--follow` arm and the event-sourced task store are **Exarchos-internal** (INV-2 facade equivalence). Only the **MCP-facing wire** is affected. The store, the projection, and the CLI facade survive untouched.
- `serveStdio`'s dual-era default means 2025-era clients keep the current `tasks/*` wire working during the transition.

**Recommended posture: scope this before committing to an era cutover date.** A focused audit answering "which of the 14 files touch the MCP wire vs. the internal store, and which are the `RESERVED` stub" converts this from an unknown into an estimate. That audit is the true first task of any migration plan.

### 5.5 Roots — deprecated, 12-month clock, low urgency

Roots is deprecated (SEP-2577), replacement: **tool parameters and configuration**. `notifications/roots/list_changed` is **removed** from the core.

Exarchos uses roots for workspace discovery (`src/workspace/discovery.ts`), with a documented cwd-walk fallback that was — per the `#1290` comment block — the *only* live path until the handshake observers were wired. So the fallback is exercised and real.

Deprecation is annotation-only with a ≥12-month window, so there is no forcing function. But the direction of travel is clear, and the replacement ("tool parameters and configuration") is a shape Exarchos already has in `.exarchos.yml`. **Treat as a follow-up, not part of the migration.** Note that `invalidateRootsCache()` loses its trigger on 2026-era connections when `notifications/roots/list_changed` disappears — the cache becomes either request-scoped (see §5.2) or stale.

### 5.6 The SDK patch can be deleted — a clean win

`servers/exarchos-mcp/patches/@modelcontextprotocol+sdk+1.29.0.patch` (5.5K) exists to force `target: 'draft-2020-12'` at the `tools/list` boundary and to splice `type: 'object'` onto discriminated-union-rooted schemas, because SDK 1.29.0 emits draft-7 by default. `docs/research/2026-05-13-zod-v4-decision-record-addendum.md` §4 promoted this from SHOULD to **HARD GATE**, enforced by `tools-list-2020-12.test.ts`.

**SEP-2106 makes full JSON Schema 2020-12 the spec-level requirement.** The upstream behaviour we patched in is now the standard, so:
- the patch, the `patch-package` `postinstall`, and the `patch-package` dependency can likely all go;
- `tools-list-2020-12.test.ts` **stays** — it becomes a conformance test against upstream instead of a guard on a local patch;
- schemas gain composition (`oneOf`/`anyOf`/`allOf`), conditionals, and `$ref`/`$defs`; output schemas are unrestricted and `structuredContent` may be any JSON value, not only an object.

Verify empirically before deleting — confirm v2 emits 2020-12 *and* handles our DU-rooted schemas (the patch's second fix), since that was a separate gap from the `target` flag. Exarchos was early here; the ecosystem caught up. **This is a net reduction in maintenance surface and should be called out as a benefit of migrating, not a task.**

---

## 6. How to fully leverage the changes

Beyond compliance, several changes map unusually well onto things Exarchos already believes.

### 6.1 `requestState` is the same idea as Exarchos's event-sourced handles

The spec's guidance for cross-call state — *"mint an explicit handle from a tool and have the model pass it back as an argument… the model can see the handle and thread it between tools"* — is a description of how Exarchos already works. `featureId` **is** that handle; the SQLite event store is the durable state behind it; `rehydrate`/`get` → `_meta.workflowExists` is already the canonical existence check rather than any transport- or filesystem-derived signal.

**Exarchos is already spec-conformant on the hardest part of the revision.** The protocol moved toward the architecture we chose. This should be stated in the design doc, and it lowers the risk of the whole migration: there is no hidden session state to find, because the design never leaned on any.

The one place to be deliberate: `requestState` and `featureId` are **different-lifetime handles**. `requestState` is per-MRTR-flow, signed, TTL'd, untrusted-on-return; `featureId` is durable workflow identity. Do not collapse them — thread `featureId` *inside* a minted `requestState` payload for a multi-round flow.

### 6.2 MRTR is the missing approval-gate primitive

Exarchos's workflow model is full of points where the machine should stop and ask a human: plan-gate approval, the `discover_bridge` opt-in (author-confirmed, never auto-run), destructive `prune` confirmation, `/synthesize` mark-ready. Today these are prose instructions in skills — the agent is *told* to ask.

MRTR makes "stop and ask, then resume" a **protocol-level, resumable, auditable** construct: the server returns `input_required`, the client is obliged to answer, and the flow resumes with the answer attached. Combined with SEP-2260 (a server may only send requests to the client while actively processing a client request — "a user is never prompted out of nowhere, and every elicitation traces back to something they or their agent started"), this is a materially better substrate for a governance system than an instruction in a skill file.

Speculative but worth designing against: an `input_required` round is a natural **event** on the feature stream. `state.patched`-style link events already exist for the discover bridge; an approval that is a protocol round-trip *and* a durable event is strictly better provenance than an approval that is a prose convention.

### 6.3 Cache hints — a direct token-economy lever

`ttlMs` + `cacheScope` on `tools/list`, plus **deterministic ordering** so clients "can cache tool catalogs and keep upstream prompt caches stable across reconnects."

Memory records the `#1679` tool token-economy audit finding **slim registration at ~52% of session tax**. Cache hints attack exactly that cost, from the protocol side, in a way no amount of local slimming can: a cached catalog is not re-sent, and a *stably ordered* catalog does not invalidate the client's upstream prompt cache.

The SDK defaults are conservative (`ttlMs: 0`, `cacheScope: 'private'`) — i.e. **the benefit is opt-in and we get none of it by default**. Configure via `ServerOptions.cacheHints`. Exarchos's tool catalog is static per binary version, so a long TTL is safe and the deterministic-ordering requirement is trivially satisfiable. **This is the highest value-per-unit-effort item in the entire evaluation** and should be measured against the `#1679` baseline.

### 6.4 W3C Trace Context — the token-attribution seam, standardized

SEP-414 fixes `traceparent` / `tracestate` / `baggage` key names in `_meta`, so "a trace that starts in a host application can follow a tool call through the client SDK, the MCP server, and whatever the server calls downstream" as one span tree.

Memory records the token-attribution architecture as having **the `SubagentStop` hook as the only seam**. Trace context is a second, standardized seam — one that crosses the harness boundary and is not Claude-Code-specific. For a system whose stated doctrine is *conform where a standard converged*, a standard propagation format for cross-agent correlation is squarely on-thesis, and it is a better foundation for delegation-wave attribution than a per-harness hook.

Related: deprecating protocol Logging in favor of **stderr and OpenTelemetry** ratifies what Exarchos already does (`pino` → stderr). No work; note it as validation.

### 6.5 MCP Apps — a real pipeline view

MCP Apps (SEP-1865) lets servers ship interactive HTML rendered by the host in a sandboxed iframe, with templates declared ahead of time so hosts can prefetch, cache, and security-review them. UI-initiated actions route through the same JSON-RPC base protocol, so they pass the same audit and consent path as a direct tool call.

Exarchos's `exarchos_view` surface (pipeline view, workflow status, task detail) is today text rendered into the agent's context — which costs tokens on every look. A rendered pipeline view would be **cheaper and better**: the view leaves the context window entirely.

This is genuinely new capability rather than migration, so it belongs on the roadmap, not the migration plan. It must be reconciled against the recorded design envelope — memory holds *"Extensibility & authoring envelope: agent-first + power-user, no GUI"*. **MCP Apps is a GUI.** The reconciliation is arguable (a read-only rendered view is not an authoring GUI, and it *reduces* token cost rather than adding a config surface), but it is a genuine tension with a recorded decision and needs an explicit ADR — not a quiet adoption.

### 6.6 The extensions framework fits Exarchos's own shape

Extensions get reverse-DNS IDs, an `extensions` negotiation map, independent versioning, and their own repos. Two consequences:

- The current `experimental: { 'claude/channel': {} }` should become a properly-identified extension. `experimental` was always the unversioned escape hatch; there is now a real path.
- Exarchos's governance vocabulary (workflow phases, verification tiers, gates, event streams) is exactly the kind of thing that "ships as an opt-in extension and stabilizes there." If the DKG / remote-agent work needs protocol-level vocabulary, an `io.exarchos.*`-style extension is now the sanctioned mechanism rather than a fork or an `experimental` blob.

### 6.7 `server/discover` as capability advertisement

Servers **MUST** implement `server/discover`. Exarchos already has strong introspection (`describe(actions)`, `emissionGuide`, `topology`, `config`). `server/discover` is a standard place to advertise identity, supported versions, and extensions — and it carries its own `ttlMs`/`cacheScope`, so discovery results are cacheable too. Low cost (largely SDK-provided), and it is the client's cheapest route to "what is this server."

---

## 7. Risks and unknowns

| # | Risk | Assessment |
| --- | --- | --- |
| **R0** | **Vacuous `outputSchema` false confidence (MC-3).** 106 of 118 declarations are `EnvelopeSchema(z.unknown())`, yet INV-17 names `outputSchema` totality as the precondition for equivalence-by-construction and INV-2 claims parity is "schema-checked in addition to byte-checked." For ~90% of actions that check cannot fail — which reads as coverage while providing none. **Highest severity across both documents**, because every other verification claim in this migration inherits it. Same defect class as the vacuous `withSession` gate (#1692). |
| R1 | **Tasks surface cost is unbounded until scoped** | The one item that can flip the recommendation. 14 files, but an unknown fraction is `RESERVED` dead stub. **Audit before planning.** |
| R2 | **No client speaks 2026 yet?** | Anthropic's own post says support is "being rolled out across Claude products soon." If Claude Code does not negotiate `2026-07-28`, an era cutover buys **zero** user-visible benefit today. **Unverified — must be checked before scheduling the cutover.** The dual-era `serveStdio` default makes this a scheduling question, not a blocker. |
| R3 | **Capability resolution is a trust boundary** | §5.2 touches POLA gates. Needs security review, not a routine delegate wave. |
| R4 | **No in-memory 2026-era transport** | `InMemoryTransport.createLinkedPair()` is **2025-era only**. Our integration tests (`tools-call`, `tools-list`, `tools-list-2020-12`, `elicitation-roundtrip.fixture`, `cli-parity`, `perf-validation`) are built on it. 2026-era coverage requires driving `createMcpHandler` through its fetch function or **spawning `serveStdio` as a child process** — i.e. real process tests. Given the recorded Windows-lane flakiness and spawn-timeout flakes, **new child-process tests are a flakiness risk on a lane that is already fragile.** Budget for this explicitly; it may be the second-largest cost after Tasks. |
| R5 | **Patch removal may not be clean** | The patch has two fixes (`target` flag; DU-root `type: 'object'` splice). SEP-2106 clearly covers the first. The second is a Zod-v4-to-JSON-Schema emission detail that may persist. Verify empirically. |
| R6 | **Dual-era divergence** | While `serveStdio` serves both eras, behaviour differs per connection (envelope vs. handshake; `tasks/*` alive vs. `-32601`). This is a **new axis of test-matrix divergence** in a repo that just finished a de-divergence wave (#1705). Keep the dual-era window short and deliberate. |
| R7 | **Codemod × monorepo** | The MCP server has its own manifest; the codemod rewrites one manifest and only *reports* workspace members. Run per-package with `--dry-run` first. |
| R8 | **`logLevel` absence is opt-out** | On 2026 connections `ctx.mcpReq.log()` emits nothing unless the client sets `io.modelcontextprotocol/logLevel`, and **the SDK client does not auto-attach it**. Handler logs go silently missing. We use stderr/pino so exposure is low — but anything that migrates *to* `ctx.mcpReq.log()` inherits this trap. |

---

## 8. Recommended sequencing

Staged so each phase is independently valuable and independently revertible. **Phases 0–2 put no 2026 bytes on the wire.**

**Phase 0 — Scope the blocker (do this first, it is cheap)**
- Audit the 14-file Tasks surface: MCP-wire vs. internal store vs. `RESERVED` dead stub.
- Verify whether Claude Code (and the other Tier-1 harnesses) negotiate `2026-07-28` today (**R2**).
- Output: a real estimate for §5.4, and a decision on cutover timing.

**Phase 1 — v2 package split (mechanical, no era change)**
- Codemod `servers/exarchos-mcp/` with `--dry-run`, then apply.
- Retarget `sdk-pin-policy.test.ts` to the v2 package names; keep the exact-pin policy.
- Attempt patch removal; keep `tools-list-2020-12.test.ts` as a conformance test (**R5**).
- Gate: full suite green, no wire change, `npm run build` + MCP-server typecheck (which the root typecheck skips).

**Phase 1.5 — MC-3 gate: tighten `outputSchema` (blocks Phase 2)**
- 106 of 118 declarations are `EnvelopeSchema(z.unknown())`. Tighten them, and make a vacuous declaration a **finding** rather than a pass under INV-17's audit; add a downward ratchet on the count.
- **Why it blocks MRTR:** `input_required` is a fourth emittable shape. Vacuous schemas absorb it with no test failing, so landing MRTR first banks a silent pass and widens the gap between the declared and real contract.
- Correct INV-17's totality triple while here — `withCappedShape` covers baseline ∪ capped; `degraded` is a `_meta` flag.

**Phase 2 — MRTR rewrite of elicitation (works on the *current* wire via the legacy shim)**
- **Design the `input_required` envelope state first** — it is neither `success: true` nor `success: false`, and overloading the latter corrupts the DR-7 exit-code mapping. This is the decision most expensive to revisit.
- Convert `elicitInput` call/await into `inputRequired(...)` returns.
- **MC-2:** mint the resumption handle in the dispatch core from the event store; let the MCP facade wrap it in the SDK's signed `requestState` (`createRequestStateCodec` — do not hand-roll the HMAC). One core contract, two renderings.
- Add a test proving the **production** path is live, not just the fixture (the `#1424` lesson).

**Phase 3 — Per-request capability resolution**
- Re-lifetime `CapabilityResolver` from connection-scoped to request-scoped.
- One seam serving both eras (INV-2 facade equivalence).
- **Security review on the POLA gates.** Not a routine delegate wave.

**Phase 4 — Era cutover**
- Swap to `serveStdio(factory)`; keep dual-era (do **not** pass `legacy: 'reject'`).
- Land the Tasks re-platform per Phase 0's findings.
- Add 2026-era test coverage via child-process `serveStdio` (**R4** — budget for flakiness).

**Phase 4.5 — MC-1 / MC-4: close the generated-surface and mapping gaps**
- **MC-1:** registry descriptors for the 8 hand-written top-level CLI verbs (retiring 14 `.command(...)` registrations across 1,565 lines), a reserved-flag concept in the generator, and presentation derived from the envelope discriminator. Start with `merge_orchestrate`, which is defined twice — once as the only `posture: 'shared-mutating'` action, once by hand. Add a `skills:guard`-style drift gate.
- **MC-4:** resolve `hidden: true` (a CLI-reachable tool absent from the MCP contract contradicts the #1608 reframe); make `longRunning` the single task trigger and extend the parity harness to cover it.
- Tighten INV-2 to quantify over the *facade* rather than the context and arguments, so the next capability adapter cannot reopen the hole silently.

**Phase 5 — Leverage (each independently valuable, none blocking)**
- **Cache hints on `tools/list`** — highest value-per-effort; measure against the `#1679` baseline.
- W3C trace context as a second token-attribution seam.
- `server/discover` advertisement.
- Reverse-DNS extension ID replacing `experimental: { 'claude/channel': {} }`.
- Roots → tool parameters + config (12-month clock, no urgency).
- **MCP Apps for `exarchos_view` — ADR first** (§6.5 tension with the no-GUI envelope).

---

## 9. Open questions

1. **Does Claude Code negotiate `2026-07-28` today?** Determines whether Phase 4 has any user-visible benefit or is pure future-proofing. (R2)
2. **How much of the `#1273` Tasks surface is live vs. `RESERVED` dead stub?** The single largest unknown. (R1)
3. **Does the v3.2 DKG / remote-agent work grow a remote MCP surface?** If yes, the stateless core is a large tailwind and §4's "does not apply" column inverts — design against `2026-07-28` from day one.
4. **Is `patch-package` fully removable**, or does the DU-root fix survive? (R5)
5. **Does MCP Apps clear the "no GUI" envelope?** Needs an explicit ADR, not a quiet adoption. (§6.5)
6. **Does the task-augmented `tools/call` inversion — server-directed instead of client-opt-in — change the delegation model?** Under the extension, the *server* decides when a call becomes a task. Exarchos's dispatch semantics assume the client opts in via `task: { ttl }`.

---

## 10. Sources

**Specification**
- [Key Changes — `2026-07-28` changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/) — Soria Parra & Delimarsky
- [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP 2026-07-28 spec: stateless core, coming to Claude](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)

**TypeScript SDK**
- [Upgrading from v1.x to v2](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html)
- [Supporting protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html)

**Ecosystem analysis**
- [Every breaking change in the 2026-07-28 MCP spec](https://mcpmigrate.dev/blog/mcp-spec-2026-07-28-migration-guide)
- [What's new in the MCP 2026-07-28 specification](https://appwrite.io/blog/post/mcp-goes-stateless-in-the-2026-07-28-specification) — Appwrite
- [2026-07-28 MCP: stateless, MRTR, routable headers, authorization hardening](https://4sysops.com/archives/2026-07-28-model-context-protocol-mcp-stateless-multi-round-trip-routable-headers-authorization-hardening/) — 4sysops

**Repository (inspected at `main` @ `30831d05f`)**
- `docs/system-design.html` — § *How one runtime serves many harnesses* (conform/enforce doctrine)
- `servers/exarchos-mcp/src/adapters/mcp.ts` — server construction, capabilities, elicitation + roots wiring
- `servers/exarchos-mcp/src/adapters/cli.ts` — stdio transport wiring (`mcp` subcommand)
- `servers/exarchos-mcp/src/capabilities/resolver.ts` — handshake-authoritative capability + POLA gates
- `servers/exarchos-mcp/src/mcp/tasks-methods.ts`, `src/mcp/elicitation-method.ts`
- `servers/exarchos-mcp/src/dispatch/core/dispatch.ts`, `src/workspace/discovery.ts`, `src/registry.ts`
- `servers/exarchos-mcp/patches/@modelcontextprotocol+sdk+1.29.0.patch`
- `servers/exarchos-mcp/src/__tests__/sdk-pin-policy.test.ts`, `src/__tests__/integration/tools-list-2020-12.test.ts`
