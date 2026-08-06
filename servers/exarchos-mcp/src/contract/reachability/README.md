# Generated reachability graph — the closure capstone (P05-05)

**The program's closure capstone (CTR-013).** This module proves the
structural-closure objective end to end:

> Every public action reaches **one implementation, one owned effect path where
> applicable, one output contract, and one packaged proof.**

It does not invent a new authority. It **assembles a reachability graph** from
the authorities the earlier packages already froze, and **gates on closure**:
every public action must have exactly **one complete path** from its authored
ActionId all the way to its packaged proof fixture. A break — or an ambiguity —
at any hop is a closure failure that names the action and the broken hop.

## The node chain (one path per public action)

```
ActionId → schema → route → handler → [owner] → output → artifact → fixture
(authored) (shipped) (dispatch) (dispatch) (P04-01) (shipped) (shipped)  (packaged)
```

| Hop | Authority consumed | Independent of the compile pass? | A break means |
| --- | --- | --- | --- |
| **schema** | the checked-in `compiler/generated/proof-fixtures.json` — shipped input/output schema **digests**, compared against the live compile | shipped artifact | the shipped schema baseline disagrees with the live contract (stale / hand-edited artifact) |
| **route** | the **shipped composite router** for the action's tool — its real `switch (action)` / dispatch-table / branch arm ([`dispatch-routes.ts`](./dispatch-routes.ts)) | runtime wiring | no shipped router routes the action name (registration ↔ dispatch drift), or two arms do |
| **handler** | `BINDING_TABLE` ← `core/dispatch.ts::COMPOSITE_HANDLER_LOADERS` — one non-serializable handler per tool | runtime wiring | the tool has no (or two) handler bindings |
| **owner** *(conditional)* | P04-01 `EFFECT_OWNERSHIP` via the [provider map](./providers.ts) | runtime wiring | a **mutating** action's effect path has no (or two) effect owners |
| **output** | the checked-in `proof-fixtures.json` — shipped output-kind + error-family contract, non-empty and equal to the live compile's | shipped artifact | the shipped output contract is empty or has drifted from the live contract |
| **artifact** | the checked-in `cli/generated/cli-surface.json` — the shipped client command for the ActionId | shipped artifact | the packaged client surface exposes no (or two) commands for the action |
| **fixture** | the checked-in `proof-fixtures.json` baseline | shipped artifact | the packaged proof baseline omits the action |

### Why the "independent" column is load-bearing

The closure **denominator** (`actions`) comes from `compile(deriveMetaModel())`.
A hop materialized by re-deriving something from *that same compile output* is a
**tautology**: it resolves to exactly one for every action by construction, can
never surface a break, and inflates the headline number with evidence it does not
have.

Four hops were built that way and have been re-pointed:

| Hop | Was (tautological) | Now (independent) |
| --- | --- | --- |
| `route` | `generateRegistration(contract.descriptors)` — one ref per descriptor, ActionIds unique ⇒ always exactly 1 | the shipped composite routers' real action-level dispatch tables |
| `schema` | `contract.schemas.actions[actionId]` — populated for every descriptor by the same pass | shipped schema **digests** in `proof-fixtures.json`, compared to the live compile |
| `output` | the descriptor's own `outputKinds`/`errorCodes` — the meta-model sets both non-empty for every action (`outputKinds` is a global constant) | the shipped output contract in `proof-fixtures.json`, non-empty **and** equal to the live compile's |
| `artifact` | `contract.proofFixtures.actions` — one per descriptor from the same pass | the shipped `cli-surface.json` client command |

`HOP_AUTHORITIES` in [`graph.ts`](./graph.ts) records the authority class of each
hop, and [`kill-fixtures.test.ts`](./kill-fixtures.test.ts) proves **every** hop
can drop the census by mutating the real upstream authority. A future hop cannot
join the headline number without such a proof — the ratchet test asserts the
killed-hop set equals `REACHABILITY_HOPS`.

The **owner hop is conditional** — "one owned effect path *where applicable*". A
pure (read-only) action legitimately skips it (`status: not-applicable`); only a
mutating action is required to resolve exactly one effect owner. This is modeled
explicitly (`ActionNode.mutates`), not special-cased.

**Ambiguity is a closure failure too.** Two handler bindings for a tool, two
effect owners for a tool, two routing arms for an action, or two shipped commands
for an ActionId resolve a hop to `ambiguous` (count > 1) — exactly one complete
path is required, so "which of the two?" fails closed just like absence.

## Layout

| File | Role |
| --- | --- |
| `graph.ts` | The **pure** model: `ReachabilityInputs`, `HOP_AUTHORITIES`, `resolveHops`, `evaluateClosure`, `buildReachabilityGraph`, `serializeReachabilityGraph`, and explicit `reachabilityNodes` / `reachabilityEdges` expansion. No I/O — every seeded break is unit-testable. |
| `providers.ts` | The governed `EFFECT_PROVIDERS` connective map (tool → effect area + owner), **validated** against the live `EFFECT_OWNERSHIP` ledger (two-way ratchet: unbacked / duplicate providers are flagged). |
| `dispatch-routes.ts` | The **shipped dispatch-route authority**: reads each composite router module dispatch actually imports and extracts the `(tool, action)` pairs it really routes (`switch (action)` arms, `Readonly<Record<string, …Handler>>` dispatch tables incl. computed keys, and explicit `action === '…'` branches). Fails loud on any structural surprise. |
| `shipped-artifacts.ts` | Strict, fail-loud readers for the **checked-in** artifacts other generation passes ship: `proof-fixtures.json` (digests + bound output contract) and `cli-surface.json` (the packaged client command per ActionId). |
| `collect.ts` | The **impure** adapter: `collectReachabilityInputs()` materializes the inputs from the live authorities; `LIVE_CLOSURE_EXCEPTIONS` is the governed known-unclosed list (empty). |
| `generate.ts` | The generator + drift baseline (`buildLiveReachabilityGraph`, `serializedGraphBaseline`, `generateReachabilityArtifact`). |
| `generated/reachability-graph.json` | The **checked-in** reviewable closure artifact, drift-guarded by `generated.test.ts`. |
| `kill-fixtures.test.ts` | The **anti-tautology proof**: for every hop, a mutation of the REAL upstream authority drops the census below 100%. |
| `regenerate.mjs` | The Node regeneration runner (see below). |

## The effect-owner seam (dispatch → ledger)

The `owner` hop bridges two authorities that do not name each other: dispatch
(`COMPOSITE_HANDLER_LOADERS`, tool → handler **module**) and the effect ledger
(`EFFECT_OWNERSHIP`, module-**prefix** → owner). [`providers.ts`](./providers.ts)
is the small governed map between them; every entry is validated against the live
ledger, so a renamed/moved/removed owner trips validation rather than silently
mis-reporting a `missing owner` break.

## The authored-workflow seam (P07-02)

The chain's origin is the **authored ActionId** (authored in the tool registry).
Binding each ActionId to a specific shared-IR built-in workflow definition is the
**P07-02** surface, authored in parallel. That refinement is a *pluggable origin
attribute*, not a required hop here — the graph does not block on it.

## Closure finding (the honest number)

The live tree achieves **complete closure: 120 of 120 public actions are fully
closed** — every applicable hop resolves to exactly one. `LIVE_CLOSURE_EXCEPTIONS`
is therefore **empty**; no action is excepted. If the tree ever regresses, the
gate reports precisely which action breaks at which hop, and a genuinely-unclosed
action must be recorded in the governed exceptions list with a reason (a stale
exception — one that is actually closed — is itself flagged).

The number is unchanged from the first publication of this capstone, but **what
it measures changed**: it previously counted four hops that could not fail
(see the re-pointing table above), so only `handler`, `owner` and `fixture`
carried teeth. All seven hops now resolve against an independent authority and
all seven are proven killable.

### What each hop is worth (strength, honestly graded)

- **Strongest — real runtime wiring.** `route` (the shipped composite router
  actually routes the action name), `handler` (dispatch's real composite-handler
  loader map), `owner` (the P04-01 effect ledger). Breaking any of these breaks
  the running server, and the census sees it.
- **Real but narrower — shipped-artifact agreement.** `schema`, `output`,
  `artifact`, `fixture` compare the live contract against **checked-in artifacts
  emitted by different generation passes**. These catch shipped drift (a stale,
  half-regenerated, or hand-edited baseline); they are *not* runtime execution
  proof. They are counted because they can genuinely fail — not because they
  prove the handler runs.
- **Not claimed at all.** The census does not execute any handler. It proves the
  routing/binding/ownership wiring and artifact agreement are complete, not that
  each action behaves correctly — that is the P03-09 oracle's job.

### Verified vs. simulated

- **Verified** (real, in-tree): every hop runs over a live authority, and
  `kill-fixtures.test.ts` demonstrates each one dropping the census when the real
  authority is broken.
- **Route-hop caveat (read this).** The action-level routing table is *code*, not
  data — four composites route with `switch (action)` and orchestrate routes
  through an object literal plus explicit branch arms — so `dispatch-routes.ts`
  reads the router **source** that dispatch dynamically imports rather than
  executing it. Scanner fidelity is pinned two ways: the scanned set must equal
  the live registry's action set per tool, and for the one composite that exposes
  its dispatch table as a runtime value (`orchestrate`'s `ACTION_HANDLER_KEYS`)
  the scanned set must be a superset of it. A scan that goes wrong makes the
  census FALL (fail-loud), never rise.
- **Simulated / not exercised here**: `dist/` is not built in this workspace, so
  the *binary* packaging of the fixture (bundling `proof-fixtures.json` into the
  shipped artifact) is not exercised. The packaged-proof hop is verified at the
  checked-in-baseline boundary; downstream release packaging (P05-01/-02/-03)
  owns the binary inclusion.

## Regenerating the checked-in graph

`generated.test.ts` fails when the checked-in artifact drifts from a fresh build.
To re-approve after an intentional change (a registry edit, a new binding, an
effect-ledger change):

```sh
# from the repo root (or servers/exarchos-mcp)
node servers/exarchos-mcp/src/contract/reachability/regenerate.mjs
```

`regenerate.mjs` reproduces vitest's `bun:sqlite` → node-shim alias (the
generator pulls `bun:sqlite` in transitively via the binding table → dispatch),
then runs the TS generator via tsx. Commit the updated
`generated/reachability-graph.json`.
