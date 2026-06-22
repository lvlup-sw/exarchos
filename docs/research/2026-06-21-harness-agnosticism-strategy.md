# A cheaper path to harness agnosticism: conform to converged standards, enforce the rest at chokepoints

- **Status:** discovery report — completed, refined through a design-review loop (2026-06-21)
- **Workflow:** `harness-agnosticism-strategy` (discovery)
- **Relates to:** `docs/system-design.html` · roadmap #1599 (Z2 runtime supervision, Z3 SDK/IR) · #1574 (worktree lifecycle manager) · #1579 (capability-boundary, INV-11) · #1485 (AGENTS.md as universal binding surface) · INV-2 / INV-4 / INV-11 / INV-15 · the gen-time-placeholder-vs-runtime-resolution thread

---

## BLUF

The drift you are fighting is real, but the *mechanism* you built — render per-harness artifacts from one source + a CI guard that fails on drift — is the industry consensus, independently reinvented by every serious tool (Ruler, rulesync, yaah, `vercel-labs/skills`), each shipping the same drift guard.
You did not over-build; you re-derived the consensus.
The leverage is not a better renderer — it is **rendering less, and enforcing what's left differently.**

Three findings, each pressure-tested in review:

1. **Skills collapse onto a standard.** Of the 7 placeholder tokens, 5 encode the bespoke subagent/chain concern and live in only ~5 delegation skills; the ~80 procedural skills vary on one thing — the MCP tool prefix. Author skills against **bare logical tool names** (the agent's own tool list is the resolver) and the per-harness skills fan-out collapses onto one standard `SKILL.md`, distributable by an off-the-shelf installer (`vercel-labs/skills`). No install-time resolution needed.
2. **The CLI should become a client of the MCP contract, not a sibling.** One dispatch core, two facades is *today's* INV-2 — and it preserves the very drift the move should kill. Layer it: **CLI → MCP contract layer → dispatch core**, with the CLI's surface **codegen'd** from the tool `input`/`outputSchema`. Equivalence becomes structural; the parity harness shrinks to a codegen golden test. The 2026-07-28 MCP spec RC (full JSON Schema output schemas) makes this materially stronger.
3. **The moat is enforced at chokepoints, not rendered at bindings.** "Our moat is hooks / subagents / worktree isolation" is a trap if it means rendering those per harness. The runtime YAMLs prove it: `isolation:worktree` is `native` only on Claude and `advisory` everywhere else — render-parity is not enforcement-parity. Move **state** invariants into the dispatch/MCP handler and **space** invariants into a spawn-bounded **launcher** (`exarchos <harness>`); the generator shrinks to thin on-ramps. The invariants then hold *by construction on any harness*, implemented once.

The unifying move: **stop differentiating per harness wherever a standard converged (skills, instructions, MCP), and relocate the invariants that have no standard onto chokepoints every harness must pass through.**
This lowers cleanly into the roadmap (Z2 runtime supervision, Z3 SDK/IR + the MCP-RC migration) and reframes three invariants (INV-2, INV-4, INV-11) from "render N, prove parity" to "conform + enforce by construction."

**Decided in review:** the launcher **owns worktree creation** (amending #1574's reconcile-harness-created premise), scoped to **worktree confinement only** (composing #1579; container/microVM sandboxing stays out — a #1574 non-goal / INV-3 territory).
**Next:** this report + the issue-delta plan in §7, filed as a net-new epic slotted into #1599.

---

## 1. The question, stated precisely

The brief conflates two independent axes; separating them is half the answer.

- **Facade axis — CLI vs MCP.** One dispatch core, two presentations, proven byte-equal by a parity harness (INV-2). Finding 2 sharpens *how* this should be structured — but it is not where the bulk of the harness drift lives.
- **Harness axis — the runtime profiles.** This is the cost. Exarchos ships **six runtime profiles** (`claude`, `codex`, `cursor`, `copilot`, `opencode`, `generic`) and renders, per profile, several *concerns*: instructions, skills, slash-commands, MCP wiring, hooks, subagent definitions, worktree-isolation behavior. The drift-remediation effort and the structural guards all defend this axis.

"Workload agnosticism" (the brief's other phrase) is a **third, orthogonal axis** = INV-6: the runtime makes no assumption about *which workflow type* runs; specifics live in topology.
That is addressed by the topology layer today and the v3.0 Workflow Builder SDK / IR endpoint (#1258) tomorrow — not a harness problem, and unchanged by anything below.

So the answerable question is: **for each per-harness concern, is there now a converged standard to conform to instead of rendering a bespoke tree — and where there isn't, what is the cheapest place to enforce the guarantee?**

---

## 2. Where the cost is today (internal map)

A single-source → per-runtime fan-out, capability-driven (it branches on declared capability, never a runtime-name literal — the INV-4 discipline), plus guards that fail CI on any drift.

**Sources of truth:** `runtimes/*.yaml` (6 profiles: capabilities + 7 placeholder tokens); `skills-src/<name>/SKILL.md` (~85 skills) + `references/` + optional `SKILL.<runtime>.md`; `hooks-src/`, `commands/`, and the agent-spec registry + 5 per-runtime adapters.

**Fan-out machinery (the maintenance surface):**
`src/build-skills.ts` (~1,885 LOC, the renderer: capability-gated elision, `{{CALL}}` macro, `{{TOKEN}}` substitution, stale cleanup); `src/placeholder-lint.ts` + `src/vocabulary-lint.ts`; `src/skills-guard.ts` (~413 LOC) + `src/hooks-guard.ts` (~171 LOC) + `runtimes:guard` + `lint:inv6`.

**Cost (approximate, from the code audit):** ~500+ generated skill files (≈85 × 6, plus references), ~4.8 MB from ~1 MB source — a **~5:1 generated-to-source ratio**; ~3,500 LOC of renderer/adapter + ~2,000 LOC of guard/lint tests.

Prior internal work already named the pain (`2026-04-25-delegation-platform-agnosticity.md`, `…-delegation-runtime-parity.md`, `2026-04-10-review-guard-contract-drift.md`, `2026-05-20-runtime-invariants-gap-analysis.md`).
The verdict — confirmed below — is that the mechanism is sound; the opportunity is to **feed it less and enforce the rest elsewhere.**

---

## 3. The external landscape

### 3.1 Convergence verdict, concern by concern

What each harness honors *natively* (no per-harness shim), mid-2026. Confidence + sources in §8.

| Concern | Converged? | Standard | Native in {Claude, Codex, Cursor, Copilot, OpenCode} | Implication |
|---|---|---|---|---|
| **Tools / context** | **Yes** | **MCP** (Anthropic → Linux Foundation AAIF) | all five ✅ | The spine. Keep — and make it the single agent surface (§4.2). |
| **Agent instructions** | **Partial → Yes** | **AGENTS.md** (OpenAI → AAIF) | Codex/Cursor/Copilot/OpenCode ✅ · **Claude ❌ (`CLAUDE.md`; bridge via `@AGENTS.md`)** | Collapse onto AGENTS.md + a managed-block shim (§4.3). |
| **Skills** | **Yes (2025-12-18)** | **Agent Skills / `SKILL.md`** (agentskills.io) | all five ✅ (converging on `.agents/skills`) | The per-harness fan-out is largely redundant (§4.1). |
| **Slash commands** | **No** (being absorbed into Skills) | none; MCP `prompts` = partial | bespoke files; Claude merged commands into skills | Author macros as explicitly-invoked skills. |
| **Hooks / lifecycle** | **No (fragmented)** | none | incompatible per harness (JSON config vs OpenCode plugin code; Codex/Copilot thin) | Stays bespoke → enforce in dispatch + launcher (§4.3). |
| **Subagents (in-session)** | **No** | A2A/ACP standardize different problems | only Claude/Codex/OpenCode have it, 3 incompatible formats | Stays bespoke → launcher (§4.3). |
| **Worktree isolation** | **No** | none; patterns only (Container Use, devcontainers) | each rolls its own; Claude native | Stays bespoke → launcher (§4.3). |

### 3.2 Tooling — and the "harness-wrapper"

The colleague's `harness-wrapper copilot` maps to one of two mechanisms, both real:

- **Build-time generators** (write per-harness files from one source) — **Exarchos's current architecture.** Ruler (rules + MCP + experimental skills/subagents, ~32 tools), rulesync (the broadest: rules + MCP + commands + subagents + skills + hooks, ~30 tools, `--check` guard), yaah (`yaah generate --agent …`, the closest public match to `harness-wrapper copilot`). **`vercel-labs/skills`** (`npx skills add <repo>`) installs one `SKILL.md` folder into ~20 agents, **symlinking by default** (`--copy` fallback), with the **skills.sh** directory and a proposed `.agents/manifest.json` for versioned/integrity-checked distribution (issue #559). *That it symlinks one folder to N agents is the thesis in miniature: once the format converged, distribution is a copy, not a render.*
- **Runtime launchers** (wrap the CLI at start; don't generate files) — **VibeKit** (`vibekit claude`): forwards flags, layers redaction/logging/sandbox. Solves security/observability, not config sync — but it is the canonical "one command wraps every harness" shape, and it is the lineage of the launcher in §4.3 (used there for *enforcement*, not just observability).

Adjacent: **MCP hubs** (MCPHub, 1MCP) collapse N servers behind one endpoint — the one slice where a runtime approach beats generate-then-guard for MCP config. **Worktree orchestrators** (parallel-code, Worktrunk, swarm-git) are a *separate* category; none does config sync, confirming worktree isolation is inherently bespoke.

### 3.3 The MCP spec is about to change underneath this (2026-07-28 RC)

The `2026-07-28` MCP Specification Release Candidate (locked 2026-05-21, final 2026-07-28) is the largest revision since launch and is directly relevant:

- **Full JSON Schema 2020-12 for tools (SEP-2106):** `inputSchema` and **`outputSchema`** lifted to full JSON Schema; `structuredContent` may be any JSON value. This is what makes codegen of the CLI *rendering* layer possible (§4.2).
- **Stateless core:** `initialize`/session removed; `Mcp-Method`/`Mcp-Name` routing; `ttlMs`/`cacheScope` on list/read results. A remote MCP server now runs behind a plain load balancer — a tailwind for the v3.2 remote-MCP axis (held against the single-machine frame, INV-3/INV-15).
- **Tasks graduates to an extension** (server-directed long-running work via task handles) — relevant to Exarchos's long-running work + Z2 lifecycle verbs.
- **Error code change:** missing-resource `-32002` → JSON-RPC `-32602` (SEP-2164).
- **Breaking, with a 10-week Tier-1 validation window.** The exarchos MCP adapter needs a migration regardless — which is the right window to land §4.2's codegen.

### 3.4 The consensus

"Generate per-harness files + verify with a drift guard" is the **de-facto pattern**, independently reinvented, each shipping the same guard recipe.
Practitioners explicitly reject the obvious shortcut — **symlinks** — for the reasons that bite Exarchos too (Windows breakage, fragile across clones, *cannot bridge format differences*) — **except** for the Agent Skills standard, where the format *is* shared, which is exactly why `vercel-labs/skills` can symlink one folder to N agents.
The architecture is validated. The win is to shrink what must be generated and relocate enforcement.

---

## 4. Three findings

### 4.1 Skills — bare logical names collapse the procedural majority

The per-harness skill render substitutes 7 placeholder tokens. Sorted by what they serve, the divergence is lopsided:

| Token | Injects | Serves | Collapse? |
|---|---|---|---|
| `MCP_PREFIX` | `mcp__plugin_exarchos_exarchos__` (Claude plugin) vs `mcp__exarchos__` (bare) | invocation | **collapses** (bare names) |
| `COMMAND_PREFIX` | `/exarchos:` · `/` · `""` | invocation | **collapses** (commands → skills) |
| `TASK_TOOL` | `Task` · `spawn_agent` · `task` · `[sequential]` | subagent (bespoke) | stays — in ~5 orchestration skills |
| `SPAWN_AGENT_CALL` | full spawn block (4 incompatible shapes) | subagent (bespoke) | stays |
| `CHAIN` | `Skill({…})` (Claude only) vs prose | chaining (bespoke) | stays |
| `SUBAGENT_COMPLETION_HOOK` | `TeammateIdle` vs poll vs inline | subagent (bespoke) | stays |
| `SUBAGENT_RESULT_API` | `TaskOutput` · `wait_agent` · inline | subagent (bespoke) | stays |

**Five of seven tokens encode the bespoke subagent/chain concern and appear only in the ~5 delegation/orchestration skills.** The ~80 procedural skills vary on one thing: the MCP prefix.

**Resolution mechanism — bare logical names (decided), not install-time resolution.** Author skills against the bare logical tool name ("call the `exarchos_workflow` tool"); the agent's own tool list *is* the resolver. The multi-harness case is the deciding argument:

- Today each harness reads its **own** dir (`skillsInstallPath` differs per YAML), so install-time resolution would write one resolved copy per harness — no conflict.
- But the standard converges on a **shared** path (`.agents/skills` — codex and generic already point there): one physical file read by N harnesses *cannot* carry a single baked prefix. And even within one harness the prefix depends on plugin-vs-bare wiring.
- Therefore the prefix is a property of the agent's **live tool list**, not a static fact → bare names is primary; install-time resolution is an unnecessary mechanism we should **not** build.

**Vendoring.** `vercel-labs/skills` already distributes one `SKILL.md` folder to ~20 agents (symlink/copy), with skills.sh + a manifest proposal. Lean on it (or its pattern) instead of our skills fan-out for the procedural majority. It carries none of our placeholder/orchestration deltas — which is exactly why the ~5 orchestration skills stay rendered by us.

**Net:** retire the per-runtime skills fan-out + the bulk of `skills-guard`/vocabulary-lint for the ~80 procedural skills; keep build-render only for the ~5 orchestration skills (whose tokens *are* the moat).

### 4.2 Facades — make the CLI a client of the MCP contract, and codegen it

The original framing ("two sibling facades; demote the CLI") was wrong, and review corrected it. Two siblings over one core is *today's* INV-2, and it preserves the drift the move should kill (hence the standing parity harness). The right structure is a layering:

```
CLI  (exarchos <verb>)            argv + flags → render (tables, exit codes, dry-run — INV-5c)
   ↓  in-process call (no stdio server — the handler is a function)
MCP contract layer                Zod schemas · 4 composite tools · result envelope (INV-5a/b/d)   ← agents connect here
   ↓
dispatch core                     dispatch(verb, args, ctx)
```

- **Not inheritance of behavior, and nothing tunnels the MCP protocol** — the CLI *calls the MCP request handler in-process*, then renders. The MCP contract becomes the single invocation surface; the CLI is a thin presentation client over it.
- **Partly already true:** CLI flags auto-emit from the same per-action Zod schemas the MCP tools use, so the surfaces can't diverge in the dimensions that matter.
- **Codegen the presentation (the endpoint).** Today only the flags are generated (from `inputSchema`). The 2026-07-28 RC lifts `outputSchema` to full JSON Schema with arbitrary `structuredContent` (SEP-2106), so the *rendering* can be generated from each tool's output schema too — closing the last hand-written gap. Hand-code shrinks to presentation **policy** (pretty-print, exit-code mapping, dry-run affordance — INV-5c) as templates over the generated surface; the parity harness becomes a **codegen golden test**, and spec churn like `-32002 → -32602` (SEP-2164) propagates for free.
- **Equivalence by construction** — this *refines* INV-2 (from "prove two independently-authored facades match" to "prove the renderer presents the envelope"). It is the same principle as §4.3 applied to the facade axis.
- **Timing:** the RC is a breaking, stateless rework; the MCP adapter needs a Tier-1-window migration regardless — fold the codegen-from-contract refactor into that same touch of the contract layer.

The earlier content-layer cleanup still applies on top: retire `preferredFacade` and the CLI branch of `{{CALL}}` so skills standardize on MCP (the CLI-as-agent path survives only as the `generic`/zero-MCP-wiring fallback).

### 4.3 The moat — enforce at chokepoints, not bindings (the real answer to the premise)

"Our moat is hooks / subagents / worktree isolation" is a trap if it means *render those three per harness, better than anyone.* The runtime YAMLs show why:

| Capability | claude | codex | cursor | copilot | opencode | generic |
|---|---|---|---|---|---|---|
| `isolation:worktree` (INV-11) | native | advisory | advisory | advisory | advisory | — |
| hooks · `canInjectContext` | yes | yes | yes | no | no | no |
| `subagent:spawn` | native | native | native | native | native | — |

The moat invariants are **structurally real on Claude and advisory hopes everywhere else.** And the uncomfortable corollary: **the structural guards prove the *artifacts don't drift*; they do nothing to prove the *invariant holds equally*.** A skill can render byte-perfectly for opencode and still not confine the agent, because opencode has no native isolation primitive. **Render-parity ≠ enforcement-parity.**

The fix is to separate the **binding layer** (per-harness artifacts) from the **enforcement layer** (where the invariant holds), and move enforcement onto the two chokepoints every harness must pass through regardless of native capability:

- **State / temporal invariants → the dispatch core + MCP handler.** Every harness reaches the MCP server. Anything you'd reach for a *hook* to enforce — a gate, a verification-ladder obligation, intent-before-effect — is more robust as a **required step in the MCP action handler** than as a per-harness hook config. This is already true for INV-1/8/9/13; generalize it. Hooks downgrade to optional early-feedback UX.
- **Spatial / isolation invariants → a spawn-bounded launcher (`exarchos <harness>`).** The launcher spawns the harness itself, so it creates the worktree, `chdir`s in, and confines the process (cwd + filesystem boundary) so the agent **cannot escape — identically on every harness.** A generator *structurally cannot* do this (it writes files and exits; it never controls how the process runs), which is why worktree isolation off-Claude is intrinsically advisory under it. The launcher makes INV-11's "by construction" true cross-harness, implemented once.

**Hook migration sorts cleanly into three buckets** (only one stays per-harness): enforcement → migrate into the MCP handler; lifecycle (SessionStart/End equivalents) → the launcher emits these uniformly at spawn/exit; on-ramp/context-injection → keep, thin, only where `canInjectContext`.

**AGENTS.md injection without corruption** uses the converged industry answer — **managed-block / marker insertion** (Ruler, agentsgen, syncagents): write only between idempotent `<!-- BEGIN exarchos (managed) --> … <!-- END -->` markers, back up first, never touch hand-written content. For Claude, the managed block holds a one-line `@AGENTS.md` import. Better still, the launcher can inject orientation **ephemerally at spawn** (transient system-prompt append / env), mutating no repo files at all; managed-block insertion is the fallback for direct launches.

**The generator's job shrinks to thin on-ramps** that route each harness into the chokepoints (an AGENTS.md/skill that says "use the exarchos MCP tools," a small callback hook for early feedback, a subagent stub that delegates to the launcher). On-ramps are small, stable, low-drift — and that, not full per-harness behavior, is what the structural guards should defend.

**Composition with #1574 (worktree lifecycle manager), and the decided fork.** The WLM is the event-sourced reconciler — ownership reservation, INV-10 liveness, GC, merge serialization through the unchanged `merge_orchestrate`. The launcher is the spawn-time **actuator**: a *producer* of the `worktree.*` + `<surface>.executing_started`/terminal events the WLM consumes (the #1577 role — it must not define a parallel liveness model), and a *consumer* of the WLM's worktree assignment + merge serialization (WLM-4 / #1578).

- **Topology:** parallel **sibling** task worktrees off the feature base (per the worktree base-selection rule), **one level deep** (Codex caps `max_depth=1`), **never nested** (nesting is the node_modules / `.claude/worktrees` footgun).
- **Decided fork — the launcher owns worktree creation.** #1574 today is premised on "harnesses own creation; the WLM reconciles (no pool)." The launcher owning creation is a **simplification** — it deletes the reconcile-foreign complexity, the CC-native-isolation override footgun (#1568), and a chunk of #1301/#1579 — at the cost of amending #1574's premise. **This report adopts launcher-owns-creation and proposes amending #1574 accordingly.**
- **Decided scope — worktree confinement only.** cwd + filesystem boundary (composing #1579's "INV-11 by construction"). Container / microVM sandboxing is **out** — a stated #1574 non-goal and INV-3 / basileus territory; not smuggled in under the INV-15 banner.
- **INV-15 line:** a launcher that sets up → execs the harness → tears down on exit is bounded by the child's lifetime, **not a daemon.** It enforces at spawn/exit; mid-flight liveness stays event-sourced (the Z2 verbs query the log). **The launcher owns space; the event log owns time.**

---

## 5. Synthesis & recommendation

**Conform-and-shrink, then enforce-at-chokepoints.** One coherent move across the three findings:

1. **Conform the standardized concerns** (skills, instructions, MCP) onto the open standards — retiring the per-harness format/location fan-out and the bulk of the skills/instructions guard surface. Skills via bare logical names + a single standard `SKILL.md` (vendor via `vercel-labs/skills`); instructions via AGENTS.md + a managed-block `CLAUDE.md` shim; MCP as the spine.
2. **Layer the facade** — CLI as a client of the MCP contract, presentation codegen'd from `input`/`outputSchema`, folded into the 2026-07-28 MCP-RC migration. Equivalence becomes structural.
3. **Relocate the unstandardized invariants to chokepoints** — state into the dispatch/MCP handler, space into a spawn-bounded launcher that owns worktree creation and enforces confinement. The generator shrinks to thin on-ramps.

**Invariant reframes** (the durable form of the same guarantees):

- **INV-4** — from "skills/workflows are not coupled to one harness; six runtimes first-class" (satisfied by N renderings) → **"emit standard-conformant artifacts + a thin shim only where no standard exists."** First-class = the standard carries it, we shim the gaps.
- **INV-2** — from "two interchangeable facades proven equal by a parity harness" → **"the CLI is a presentation client over the MCP contract; equivalence holds by construction."** The parity harness becomes a codegen golden test.
- **INV-11** — from "task-isolated agent cannot write outside its worktree, by construction" (true only on Claude today) → **enforced by the launcher at the process boundary, true cross-harness.**

This is a behavior-preserving lowering, the Z3 discipline: the standards convergence *reduces what the Workflow Builder SDK / IR (#1258) must lower into* (skills/instructions become "emit standard artifact," not "emit per-runtime registry"), and the launcher + dispatch chokepoints are the Z2 runtime-supervision substrate done as enforcement rather than observation.

---

## 6. Risks & what to re-verify

- **Time-sensitivity (highest).** The Agent Skills standard is recent (2025-12-18); re-verify each harness's native `.agents/skills` / `SKILL.md` read-paths against current official docs before committing engineering — the skills collapse rests on it. The MCP 2026-07-28 spec is an RC (final 2026-07-28); treat `outputSchema`/stateless details as RC-stable, not shipped.
- **Per-harness extensions don't standardize** (Claude invocation-control/subagent-exec, Codex `agents/openai.yaml`, experimental `allowed-tools` on Claude+Codex only). Skills relying on them stay in the bespoke bucket — which is the ~5 orchestration skills anyway.
- **Launcher vs INV-15.** Keep it spawn-bounded; the moment it wants to poll/supervise mid-flight, that's the boundary — route liveness through events, not a resident process.
- **Amending #1574 is a real premise change.** Launcher-owns-creation deletes the reconcile path but must preserve #1574's ownership-reservation, GC, and merge-serialization guarantees; treat the amendment as a design-review item, not a silent swap.
- **Codegen must preserve INV-5c affordances** (queryable, dry-run, exit codes) as policy templates over the generated surface — codegen the mechanical surface, not the policy.
- **`vercel-labs/skills` symlinks by default** — verify `--copy` behavior on the platforms we support before relying on it; it distributes the standard only (no deltas).

---

## 7. Issue deltas & roadmap integration

Per the review decision, net-new work lands as its own **epic + sub-issues**, slotted into #1599 by zone/milestone/dependency. **Filed 2026-06-22** as epic **#1601** with sub-issues **#1602–#1608** (mapping in the table); the #1574 amendment was folded into that issue's description.

**Epic #1601:** *Standards-first harness agnosticism — conform-and-shrink + chokepoint enforcement.*
One-line: collapse skills/instructions/MCP onto the converged standards and relocate the unstandardized moat invariants (hooks/subagents/worktree) onto the dispatch and launcher chokepoints; reframe INV-2/4/11.

| Sub-issue | Zone / milestone | Depends on | One-line |
|---|---|---|---|
| **A · #1602 · Skills collapse via bare logical names** | Z3-lowering / v2.12 | gen-time→runtime thread, #1485 | Author the ~80 procedural skills against bare tool names; retire their per-runtime fan-out + guards; keep build-render for the ~5 orchestration skills; evaluate `vercel-labs/skills` for distribution. |
| **B · #1605 · AGENTS.md instruction on-ramp** | Z2 / v2.12 | #1485 | Single AGENTS.md + one-line `@AGENTS.md` `CLAUDE.md` shim via idempotent managed-block insertion (backed up); ephemeral spawn injection where the launcher is used. |
| **C · #1606 · Facade as MCP-contract client + presentation codegen** | Z3 / v3.0 | **D (#1604)** | Layer CLI → MCP contract → core; codegen argv from `inputSchema` + rendering from `outputSchema`; parity harness → codegen golden test; refine INV-2. |
| **D · #1604 · MCP adapter migration to 2026-07-28 (stateless)** | Z3 / v3.0 | MCP RC final | Migrate the exarchos MCP server/adapter to the stateless spec (handshake/session removal, `Mcp-Method` routing, `ttlMs`, full-JSON-Schema output, `-32602`). Prerequisite for C; Tier-1 validation window. **Supersedes/reframes the 2025-11-25 MCP-Tasks cluster** (#1283, #1454, #1280, #1453, #1279, #1320, #1285). |
| **E · #1603 · `exarchos <harness>` launcher — spatial enforcement** | Z2 / v2.12 | #1574, #1579 | Spawn-bounded launcher owning worktree creation + confinement (cwd + fs boundary); producer/actuator feeding the WLM; parallel siblings, one level; INV-15-bounded; INV-11 by construction. |
| **F · #1607 · Hooks → dispatch; lifecycle → launcher** | Z2 / v2.12 | E (#1603), #1577 | Migrate enforcement hooks into MCP handlers; emit SessionStart/End lifecycle events from the launcher; demote remaining hooks to thin on-ramps. |
| **G · #1608 · Invariant reframes (INV-2/4/11)** | Z3 / v3.0 | A–F | Catalog edits in `.exarchos/invariants.md`: INV-4 = conformance + thin shim; INV-2 = layered equivalence-by-construction; INV-11 = launcher-enforced cross-harness. |

**Delta to existing #1574 (not a new issue):** amend the WLM design from "reconcile harness-created worktrees (no pool)" to **"Exarchos owns creation via the launcher"** — folding sub-issue E's ownership into #1574's lifecycle and noting the deletions it enables (#1568 footgun, reconcile-foreign path, part of #1301/#1579). Recorded in #1574's description (not a comment).

**Slotting rationale:** A/B/E/F are Z2/v2.12 (runtime + binding consolidation, near-term, independent of the MCP migration). C/D/G are Z3/v3.0, gated on the MCP-RC final + the adapter migration (G's INV-2 reframe rides C). The epic lowers into #1258's IR (skills/instructions/facade become "emit standard artifact / codegen from contract"), satisfying the Z3 SDK-lowering discipline.

**MCP-Tasks supersession (actioned 2026-06-22):** #1604 overtakes the 2025-11-25 / SEP-1686 Tasks & transport work (parent epic #1440 already closed). Dispositions applied, consolidating 7 issues → 2 open:
- **Closed obsolete:** #1454 (held-SSE `tasks/subscribe` removed), #1280 (Logging deprecated).
- **Consolidated into #1283** (now the single rebased Tasks-lifecycle issue, v3.0.0): #1453 (orchestration verbs) + #1320 (`--wait`) — one dispatch-core path, two facades.
- **Folded into #1604:** #1279 (one-shot `notifications/cancelled` = base-protocol conformance).
- **Rebased, kept distinct:** #1285 (elicitation → Multi-Round-Trip), v3.0.0.

Survivors: #1283 (Tasks lifecycle) and #1285 (elicitation), both depending on #1604. Closed issues carry a description banner pointing to where their scope now lives.

---

## 8. Open questions for `/ideate`

1. **Launcher ↔ #1574 amendment:** confirm launcher-owns-creation as the WLM design change, and define the migration from the current reconcile model.
2. **Generator's residual shape:** what is the minimal on-ramp set per harness (AGENTS.md block, callback hook, subagent stub), and which guards survive on it?
3. **Codegen policy surface:** how are INV-5c affordances (dry-run, queryable, exit codes) expressed as templates over the codegen'd CLI?
4. **MCP-RC migration sequencing:** does D (stateless migration) bundle with C (codegen) in one v3.0 slice, and how does it interact with the v3.2 remote axis?
5. **`vercel-labs/skills`:** adopt as the distributor, vendor the pattern, or own the long-tail `generic` profile?

---

## 9. Sources

**Open standards (primary):** Agent Skills — https://agentskills.io · https://github.com/agentskills/agentskills · AGENTS.md — https://agents.md · https://github.com/openai/agents.md · MCP/AAIF — https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation · MCP Registry — https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/

**MCP 2026-07-28 RC:** https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ (SEP-2106 full JSON Schema output; stateless core; Tasks extension; SEP-2164 error code)

**Per-harness native support (primary):** Claude skills — https://code.claude.com/docs/en/skills · memory — https://code.claude.com/docs/en/memory · Codex skills — https://developers.openai.com/codex/skills/ · subagents — https://developers.openai.com/codex/subagents · Cursor skills — https://cursor.com/docs/context/skills · hooks — https://cursor.com/docs/hooks.md · Copilot skills — https://docs.github.com/en/copilot/concepts/agents/about-agent-skills · OpenCode — https://opencode.ai/docs/skills/ · /agents/ · /commands/

**Tooling:** Ruler — https://github.com/intellectronica/ruler · rulesync — https://github.com/dyoshikawa/rulesync · yaah — https://github.com/dirien/yet-another-agent-harness · VibeKit — https://github.com/superagent-ai/vibekit · **vercel-labs/skills** — https://github.com/vercel-labs/skills · skills.sh · skills-handler — https://github.com/vercel-labs/skills-handler · manifest proposal — https://github.com/vercel-labs/skills/issues/559 · MCPHub — https://github.com/samanhappy/mcphub · 1MCP — https://github.com/1mcp-app/agent

**Adjacent protocols / patterns:** A2A — https://github.com/a2aproject/A2A · ACP — https://agentclientprotocol.com · Container Use — https://zed.dev/blog/container-use-background-agents

**Internal:** `docs/system-design.html` · roadmap #1599 · #1574 (`docs/designs/2026-06-21-worktree-lifecycle-manager.md`) · #1577 · #1579 · `docs/designs/2026-04-25-delegation-runtime-parity.md` · `docs/research/2026-04-25-delegation-platform-agnosticity.md` · `docs/research/2026-05-20-runtime-invariants-gap-analysis.md` · `docs/rca/2026-04-10-review-guard-contract-drift.md`
