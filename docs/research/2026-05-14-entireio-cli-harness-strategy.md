# entireio/cli Harness-Compatibility Audit & Lessons for Exarchos

**Author:** Reed Salus  
**Date:** 2026-05-14  
**Workflow:** `discover-entireio-cli-harness-strategy`  
**Status:** Synthesizing → ready for review

## Executive summary

entireio/cli ([github.com/entireio/cli](https://github.com/entireio/cli)) — a Go-based session-capture CLI ("Entire") — supports 8 first-class agent harnesses (Claude Code, Codex, Copilot CLI, Cursor, Factory AI Droid, Gemini CLI, OpenCode, Pi) plus a registry-extensible **external-binary protocol**. Its compatibility strategy is **runtime-time adapter dispatch**, not template-time substitution: each harness is a Go package implementing a small required `Agent` interface plus optional capability interfaces (`HookSupport`, `FileWatcher`, `TranscriptAnalyzer`, `Launcher`, `SkillDiscoverer`, `SubagentAwareExtractor`, etc.). A central registry (`agent.Register()` from each package's `init()`) plus a normalized lifecycle event seam (`ParseHookEvent → DispatchLifecycleEvent`) decouples the core capture/checkpoint logic from any per-harness specifics.

Exarchos solves a **superficially similar but structurally different** problem: it ships **prose-shaped behavior** (skill markdown, slash-command markdown) to many harnesses, where the differences are syntactic (tool prefixes, spawn primitives, slash sigils) rather than protocol-level. Today this is handled at **build time** via `{{TOKEN}}` placeholder substitution against `runtimes/<name>.yaml` maps, plus `<!-- requires:* -->` capability guards, plus the `{{CALL tool action {json}}}` macro that renders both an MCP and a CLI fallback form for facade equivalence (DR-5).

The two approaches converge on **the same design discipline** (capability-driven composition, normalized seams, external-system boundary versioning) while diverging on the rendering substrate (Go interfaces vs. Markdown templates). This report extracts five concrete lessons that can pressure Exarchos's design without trading away INV-4 (platform-agnosticity), INV-2 (facade equivalence), or the workflow-agnostic skill model.

---

## 1. What entireio actually does

### 1.1 Architecture in one screen

```
┌──────────────────────────────────────────────────────────────┐
│  Required `Agent` interface (cmd/entire/cli/agent/agent.go)  │
│  ├── Identity:    Name, Type, Description, IsPreview,        │
│  │                DetectPresence, ProtectedDirs               │
│  ├── Transcript:  ReadTranscript, ChunkTranscript,           │
│  │                ReassembleTranscript                        │
│  └── Legacy:      session/resume helpers (in-flight refactor)│
│                                                               │
│  Optional capability interfaces (composition, not inheritance)│
│  ├── HookSupport:           hook lifecycle (Claude, Codex,    │
│  │                          Copilot, OpenCode, Vogon, Pi)     │
│  ├── FileWatcher:           file-based detection (Aider-style)│
│  ├── ProtectedFilesProvider, TranscriptAnalyzer,              │
│  │   PromptExtractor, TranscriptPreparer, TokenCalculator,    │
│  │   TextGenerator, TranscriptCompactor, HookResponseWriter,  │
│  │   RestoredSessionPathResolver, TestOnly, Launcher,         │
│  │   SkillDiscoverer, SessionBaseDirProvider,                 │
│  │   SubagentAwareExtractor                                   │
└──────────────────────────────────────────────────────────────┘
                               ▲
                               │ implements
       ┌───────────────────────┼───────────────────────┐
       │                       │                       │
┌──────┴──────┐         ┌──────┴──────┐         ┌──────┴──────┐
│  claudecode │   ...   │   geminicli │   ...   │   external  │
│  (in-tree)  │         │  (in-tree)  │         │ (3rd-party  │
└─────────────┘         └─────────────┘         │  binary RPC)│
                                                └─────────────┘
```

Key observations:

- **Required surface is intentionally small** (5 identity + 3 transcript methods). Adding a new agent does not require implementing 30 methods.
- **15+ optional capability interfaces** let agents opt in to richer features (token accounting, transcript compaction, structured hook responses, restored-session resolution, subprocess launching, skill discovery, subagent-aware extraction). Type assertions like `agent.AsHookSupport(ag)` are the dispatch mechanism.
- **A dedicated `external.Agent` adapter** (`cmd/entire/cli/agent/external/`) implements `Agent` by **subprocessing a third-party binary** and parsing JSON. The contract is a `ProtocolVersion`-stamped `InfoResponse` plus a fixed set of subcommands (`info`, `detect`, `read-transcript`, `chunk-transcript`, `reassemble-transcript`, etc.). This makes the integration set **publicly extensible without forking**.

### 1.2 Per-harness installation

`entire enable --agent <name>` calls each agent's `InstallHooks(ctx, localDev, force)` method, which writes to that harness's **native config file** while preserving unknown keys. Examples:

- **Claude Code:** writes to `.claude/settings.json` `hooks.SessionStart/SessionEnd/Stop/UserPromptSubmit/PreToolUse/PostToolUse` arrays. Preserves unknown hook types (`Notification`, `SubagentStop`) and unknown `permissions` fields. Distinguishes "Entire-owned hook" via two recognized command prefixes (`entire ` and `go run ${CLAUDE_PROJECT_DIR}/cmd/entire/main.go `) so old/new installs can be cleanly removed.
- **OpenCode:** writes a TypeScript plugin file at `.opencode/plugins/entire.ts` that imports `@opencode-ai/plugin` and dispatches `event` callbacks (`session.created`, `message.updated`, `message.part.updated`, `session.status`, `session.compacted`, `session.deleted`, `server.instance.disposed`) by `Bun.spawn`-ing `entire hooks opencode <hook-name>` with a JSON payload on stdin. Importantly, the file's header reads: `Auto-generated by 'entire enable --agent opencode'. Do not edit manually — changes will be overwritten on next install.`
- **Codex:** writes to `.codex/hooks.json` and `.codex/config.toml`.
- **Gemini:** writes to `.gemini/settings.json` plus a `test-hooks.sh`.

The **content per harness is not a single template** — each adapter package owns its config-file shape and write logic. Where two harnesses' user-facing markdown is nearly identical (e.g., `.claude/commands/dev.md` and `.gemini/commands/dev.md` differ only in the `.claude` ↔ `.gemini` directory string), entireio appears to **write both files programmatically rather than render from one source through a token system**.

### 1.3 The lifecycle-event seam

Every adapter that supports hooks implements:

```go
ParseHookEvent(ctx, hookName string, stdin io.Reader) (*Event, error)
```

This is the **core contribution surface for new agent implementations** (per the doc comment on `HookSupport.ParseHookEvent`). It translates a harness-native hook payload into a normalized `Event` that the harness-agnostic `DispatchLifecycleEvent` then routes through the strategy layer. Returning `nil` is legal — it means "this hook has no lifecycle significance."

### 1.4 Observability and resilience posture

- Hooks **skip silently** when the repo is not a git repo, or when Entire is disabled — "hooks shouldn't prevent the agent from working."
- The OpenCode plugin uses `Bun.spawnSync` (not async) for `turn-end` and `session-end` because `opencode run` exits on the same `session.idle` event that triggers `turn-end`; an async hook would be killed before completing.
- All hook errors are logged structurally via `logging.WithComponent(ctx, "hooks")` + `slog`, never propagated as user-facing failures.

---

## 2. What Exarchos does

### 2.1 Templating substrate

- `skills-src/<name>/SKILL.md` is the source of truth, containing `{{TOKEN}}` placeholders and `<!-- requires:capability -->` guards.
- `runtimes/<name>.yaml` (six files: `claude.yaml`, `codex.yaml`, `copilot.yaml`, `cursor.yaml`, `opencode.yaml`, `generic.yaml`) declares per-harness `placeholders` map, `capabilities`, `supportedCapabilities` map, `preferredFacade`, `skillsInstallPath`, `detection` heuristics.
- `src/build-skills.ts` walks `skills-src/`, runs a vocabulary lint pre-flight (`assertRuntimeTokenCoverage`), substitutes placeholders, expands `{{CALL tool action {json}}}` macros into either MCP `tool_use` syntax or `Bash(exarchos ... --json)` form depending on `preferredFacade`, copies the skill's `references/` verbatim into each per-runtime variant, and writes to `skills/<runtime>/<name>/SKILL.md`.
- A `SKILL.<runtime>.md` structural override mechanism allows per-runtime body replacement when token substitution alone is insufficient.
- `npm run skills:guard` re-renders and fails CI on any `git diff skills/` drift.

### 2.2 Facade equivalence (INV-2)

CALL macros render **both** the primary form **and** an HTML-comment fallback to the opposite facade. Example:

```
mcp__plugin_exarchos_exarchos__exarchos_workflow({ "action": "init", ... })
<!-- If MCP is unavailable, fall back to: Bash(exarchos workflow init ... --json) -->
```

The fallback is a single line so an agent reading the rendered source can scan it without parsing multi-line comments. This is a deliberate INV-2 affordance: facade equivalence means each side is a complete substitute for the other.

### 2.3 Capability map

`runtimes/<name>.yaml` declares `supportedCapabilities` with three states: `native`, `advisory`, `unsupported` (omission). The renderer gates `<!-- requires:cap -->` blocks (any non-omitted level passes) and `<!-- requires:native:cap -->` blocks (only `native` passes). Capability identifiers must be members of `SupportedCapabilityKey` in `src/runtimes/types.ts` — typos fail the build.

### 2.4 Distribution

Exarchos ships as a Claude Code plugin via the `lvlup-sw` marketplace. The `.claude-plugin/` manifest registers commands, skills, and rules. There is no per-harness installer that writes into a host's `.claude/settings.json` or `.gemini/settings.json` programmatically — installation is plugin-mediated (or, for non-Claude harnesses, prose-installed via `skillsInstallPath`).

---

## 3. Side-by-side comparison

| Dimension | entireio/cli | Exarchos |
|---|---|---|
| **Substrate** | Go interfaces + per-harness packages | Markdown templates + per-runtime YAML |
| **Dispatch time** | Runtime (`Get(name)`, type assertion) | Build time (`render(body, placeholders)`) |
| **Required adapter surface** | 8 methods (5 identity + 3 transcript) | 1 file (`runtimes/<name>.yaml`) |
| **Optional capabilities** | 15+ Go interfaces, type-asserted | 1 enum (`SupportedCapabilityKey`) gated by `<!-- requires:* -->` |
| **Per-harness install target** | Writes native config file (`.claude/settings.json`, `.codex/config.toml`, etc.) | Plugin manifest (Claude only); prose for others |
| **Extensibility for unknown harnesses** | `external.Agent` + binary RPC protocol with `ProtocolVersion` | Hardcoded 6-runtime set + `generic.yaml` fallback |
| **Lifecycle observation** | Hooks normalize to `Event` → `DispatchLifecycleEvent` | None — no agent-side hook surface |
| **Preview / stability flag** | `IsPreview() bool` per agent | None — all 6 runtimes presented as equal |
| **Test fidelity** | E2E runners actually invoke each agent CLI (`e2e/agents/<name>.go`) | Lint + unit tests on rendered output; no actual harness invocation |
| **Per-harness quirk docs** | `cmd/entire/cli/agent/<name>/AGENT.md` per agent | Inline comments in `runtimes/*.yaml` |
| **Facade equivalence** | Single facade (CLI); no MCP equivalent yet | Dual facade (MCP + CLI) with rendered fallback comment |

The rows are not symmetric judgments — they highlight where each project has invested. Exarchos's facade equivalence (INV-2) is **stronger than entireio's**; entireio has not paid that cost yet. Conversely, entireio's adapter extensibility, lifecycle hooks, and E2E test fidelity have no Exarchos analogue.

---

## 4. Lessons applied through `/design-invariants` and `/axiom:design`

This section runs the candidate lessons through Exarchos's invariants (INV-1..INV-6) and the axiom dimension taxonomy (DIM-1..DIM-8) before recommending. The pairing rule from `axiom:design`: project-specific guidance takes precedence on conflict.

### Lesson A — Adopt a versioned external-runtime contract

**What entireio does:** `external.Agent` calls a third-party binary's `info` subcommand and rejects connections whose `ProtocolVersion` does not match. Anyone can ship an agent integration by writing a binary that responds to a fixed JSON CLI protocol.

**Exarchos analogue:** Today, adding a runtime requires a code change: edit `src/runtimes/types.ts` (`SupportedCapabilityKey`), add `runtimes/<name>.yaml`, update the renderer fixtures, etc. Six first-class runtimes are hardcoded; `generic.yaml` is the fallback for everything else but is intentionally lowest-common-denominator and elides hook-driven flows entirely.

**Invariant pressure:**
- **INV-4 (Platform-Agnosticity):** strengthens it. The acceptance question "Is every new token declared in all six `runtimes/*.yaml` files?" assumes a fixed set; an external-contract version would extend INV-4 to "is every new token declared in the published `RuntimeMap@vN` schema, and does each token have a renderer-tested example?"
- **INV-5a (Input ergonomics):** an `exarchos runtime register --manifest path/to/runtime.yaml` verb composes naturally with the agent-first CLI surface.
- **INV-5d (Action discriminator):** a new top-level `runtime` verb (or an action on `exarchos_orchestrate`) — discriminator placement becomes a design question.

**DIM pressure:**
- **DIM-1 (Topology):** moving from build-time-fixed to runtime-discoverable changes the loading topology. Per the dimension's lifecycle-ownership question, who creates a runtime adapter and where does its single source of truth live? The answer should remain: for first-party runtimes, in-tree under `runtimes/`; for third-party, a manifest under `~/.exarchos/runtimes/<name>.yaml` (or wherever) with explicit precedence rules.
- **DIM-3 (Contracts):** a `runtimeMapVersion: 1` field on `runtimes/<name>.yaml` is the seam. Without it, third-party manifests will silently break on schema evolution.
- **DIM-7 (Resilience):** a malformed third-party manifest must fail loud at registration, not at first render — the current `assertRuntimeTokenCoverage` pre-flight is the right pattern to extend.

**Recommendation:** Add a `runtimeMapVersion: 1` field to `runtimes/<name>.yaml` now (zero behavior change, sets the seam). Defer the actual third-party-runtime registration mechanism until v3.0 Authoring lands — but design the `RuntimeMap` type as if it were already public.

### Lesson B — Per-runtime preview / stability flag

**What entireio does:** `IsPreview() bool` per agent. The TUI, docs, and `entire status` surface preview-ness to the user.

**Exarchos analogue:** None. All six runtimes are presented as peers, but the practical reality (per `runtimes/codex.yaml`) is that some runtimes have known upstream bugs (`customAgentResolutionWorks` flag for Codex CLI #15250 / #14579) and some capabilities are advisory rather than native.

**Invariant pressure:**
- **INV-4 (Platform-Agnosticity):** strengthens honesty. A `stability: stable | preview | experimental` field on `runtimes/<name>.yaml` makes the support-matrix table in INV-4's reference doc machine-readable.
- **INV-5b (Output contract):** the `exarchos_view runtime` action (if it exists) should report stability so agents can choose conservative defaults.

**DIM pressure:**
- **DIM-3 (Contracts):** a self-described stability level **is** part of the contract. Adding it later is a breaking schema change for any third-party consumer.

**Recommendation:** Add a `stability` field to `runtimes/<name>.yaml` (default: `stable` for the four most-tested, `preview` for runtimes with known upstream bugs). Surface it in any `--list-runtimes` style output and in the rendered fallback comments so agents know when they are on a less-trodden path.

### Lesson C — E2E render-fidelity tests per runtime

**What entireio does:** `e2e/agents/<name>.go` actually subprocess-launches each agent CLI in a sandbox and asserts the captured session matches expectations. The `ForEachAgent` test fixture exercises every test scenario across every registered agent.

**Exarchos analogue:** `npm run test:run` covers placeholder substitution, vocabulary lint, capability-guard expansion. **No test actually loads a rendered SKILL.md into a Codex/Cursor/Copilot/OpenCode harness and confirms the agent can follow it.** This is a fidelity gap — the kind DIM-4 calls out by name ("test setup matches production wiring; mocks are used only at true infrastructure boundaries").

**Invariant pressure:**
- **INV-4 (Platform-Agnosticity):** today INV-4 enforces *syntactic* correctness (placeholder coverage, vocabulary, guard syntax). It does not enforce *semantic* correctness (does Codex actually execute `spawn_agent({...})` when the rendered SKILL says to?). Adding render-fidelity tests turns INV-4 into a load-bearing runtime contract.

**DIM pressure:**
- **DIM-4 (Test Fidelity):** this is the canonical violation. From the dimension's example: "All tests use the same EventStore instance for producer and consumer, but production has two separate instances that were never connected — 4192 tests pass, system is broken." The Exarchos analogue: all tests render and lint, but no test confirms that Codex CLI accepts the `spawn_agent(...)` call we templated into `delegation/SKILL.md`.

**Recommendation:** Add a CI job (matrix per runtime) that:
1. Renders `skills-src/_smoke/SKILL.md` against the runtime.
2. Launches the runtime CLI in a sandbox (Docker for Cursor, npx for Claude, etc.).
3. Asserts the agent invokes the expected MCP tool with the expected discriminator.

The test scenarios should be lifted from existing `e2e/` patterns. Start with two harnesses (Claude as control, Codex as the most-divergent) before fanning out. This is also a natural lever for the v3.0 Authoring surface — a community-contributed runtime adapter must pass this CI to be merged.

### Lesson D — Fine-grained "describe per-harness quirks" docs

**What entireio does:** `cmd/entire/cli/agent/<name>/AGENT.md` per agent — a "living one-pager" updated as Phases 2 and 3 of integration discover new behavior. The `agent-integration` skill's research phase produces this file as its primary deliverable.

**Exarchos analogue:** Inline comments in `runtimes/<name>.yaml`. These are well-written (the Codex YAML's recon findings block is a model of the genre) but they are mixed in with the data and not discoverable.

**Invariant pressure:**
- **INV-4 (Platform-Agnosticity):** strengthens it. Externalizing per-runtime quirks into a dedicated file makes the support contract clearer and creates a natural home for upstream-bug tracking, recon links, and adapter-version notes.

**DIM pressure:**
- **DIM-5 (Hygiene):** YAML comments rot. A separate Markdown doc per runtime is more durable and reviewable.

**Recommendation:** Move recon findings, upstream-bug tracking, and adapter-version notes from `runtimes/<name>.yaml` comment blocks into `runtimes/<name>.md`. The YAML keeps only data + light pointer-comments to the doc. This is a low-risk, high-clarity refactor that costs ~30 minutes per runtime.

### Lesson E — Lifecycle-hook surface (long-horizon, defer)

**What entireio does:** Each adapter's `InstallHooks` writes to the host's native config so the harness fires `entire hooks <agent> <hook-name>` callbacks on lifecycle events. The CLI then normalizes to a single `Event` type and dispatches.

**Exarchos analogue:** None — Exarchos observes an agent's progress only through MCP tool calls the agent itself initiates. There is no out-of-band signal when the agent starts/stops, encounters a tool-use error, or is compacted.

**Invariant pressure:**
- **INV-1 (Event-sourcing integrity):** lifecycle hooks are a clean source of new event types (`agent.started`, `agent.compacted`, `agent.tool_use_failed`). All would slot into the existing event-store model without state mutation.
- **INV-2 (Facade equivalence):** lifecycle hooks are a third surface, not equivalent to MCP or CLI — they are an *observer* surface. Either INV-2 needs an explicit "observer surfaces are exempt" carve-out, or hooks must be addressable via both MCP and CLI verbs (probably the latter).
- **INV-3 (Basileus-forward):** Basileus's `agent` verb is reserved for AgentHost work. Exarchos lifecycle hooks must not encroach on that namespace.

**DIM pressure:**
- **DIM-2 (Observability):** this is the dimension's core ask — "fallback behavior is visible, never silent." Today an Exarchos workflow has no signal that the agent driving it has been compacted or has crashed. Lifecycle hooks would close that gap.
- **DIM-7 (Resilience):** entireio's "skip silently if not in git repo / not enabled" pattern is the right posture; hooks must never prevent the agent from working.

**Recommendation:** **Defer.** Lifecycle-hook installation is a v2.10/v2.11 axis (the "Process Lifecycle" milestone per [project_milestone_themes]). The right time to design it is when [#1275 (MCP Resources)](https://github.com/lvlup-sw/exarchos/issues/1275) and [#1180 (task.assigned projection)](https://github.com/lvlup-sw/exarchos/issues/1180) are in flight, since they share the "out-of-band signal" topology question. File a tracking issue now referencing this lesson; do not implement until the milestone window.

### Lessons not to adopt

- **Go-style optional capability interfaces.** Exarchos's `<!-- requires:* -->` guards + `SupportedCapabilityKey` enum already encode fine-grained capability composition. Translating to a structurally-typed mechanism would not be a win for prose-shaped content and would lose the build-time linting affordance (`SupportedCapabilityKey` typos fail the build today).
- **Programmatic mutation of `.claude/settings.json`.** Exarchos is plugin-distributed. Direct config-file mutation is what plugins exist to avoid. If lifecycle hooks ever land (Lesson E), the install path should remain plugin-manifest-mediated for Claude and prose-only for non-Claude harnesses — not a programmatic settings.json writer.
- **Single-file slash-command duplication.** entireio writes `.claude/commands/dev.md` and `.gemini/commands/dev.md` as nearly-identical content with directory-string substitution. Exarchos's `{{TOKEN}}` system is already strictly better at this — any move toward duplicate files would regress maintainability.

---

## 5. Recommendations summary

| # | Recommendation | Invariants pressured | Effort | Timing |
|---|---|---|---|---|
| 1 | Add `runtimeMapVersion: 1` field to `runtimes/<name>.yaml` | INV-4, DIM-3 | 1 hr | Now (zero-risk seam) |
| 2 | Add `stability: stable \| preview \| experimental` field | INV-4, DIM-3 | 1 hr | Now (alongside #1) |
| 3 | E2E render-fidelity CI job (start with Claude + Codex) | INV-4, DIM-4 | 1-2 days | v2.10 candidate |
| 4 | Externalize per-runtime quirks into `runtimes/<name>.md` | INV-4, DIM-5 | 30 min × 6 | Sprint-of-opportunity |
| 5 | Lifecycle-hook surface (observer events) | INV-1, INV-2, DIM-2, DIM-7 | weeks | Defer to v2.10/v2.11 milestone |

Recommendations 1+2 are immediate, near-zero-cost contract additions that protect future flexibility. Recommendation 3 is the highest-value test investment to close the only material DIM-4 gap. Recommendation 4 is hygiene. Recommendation 5 is the long horizon — file a tracking issue, do not implement.

---

## 6. Sources

- [entireio/cli on GitHub](https://github.com/entireio/cli) — Go-based CLI; this audit uses commit at `main` as of 2026-05-14.
- `cmd/entire/cli/agent/agent.go` — required + optional Agent interfaces.
- `cmd/entire/cli/agent/registry.go` — registry, `DetectAll`, `AgentForTranscriptPath`.
- `cmd/entire/cli/agent/external/external.go` — external-binary protocol.
- `cmd/entire/cli/agent/claudecode/hooks.go` — native config-file install with key preservation.
- `cmd/entire/cli/agent/claudecode/generate.go` — `claude --print` integration as `TextGenerator`.
- `cmd/entire/cli/hook_registry.go` — lifecycle dispatcher seam.
- `.opencode/plugins/entire.ts` — auto-generated plugin file shape and async/sync hook dispatch rationale.
- `.claude/skills/agent-integration/SKILL.md` — the entireio agent-integration skill (3-phase pipeline: research → write-tests → implement, E2E-first TDD).
- Exarchos: `src/build-skills.ts`, `runtimes/{claude,codex,generic}.yaml`, `skills-src/delegation/SKILL.md`.
- Exarchos invariant: `.claude/skills/design-invariants/references/INV-4-platform-agnosticity.md`.
- Axiom dimensions: `axiom:skills/backend-quality/references/dimensions.md`.

## 7. Followups

- **No implementation work in this discovery.** All recommendations require separate `/exarchos:ideate` or `/exarchos:plan` workflows.
- **Recommendation 1+2** (`runtimeMapVersion` + `stability`) is well-scoped for `/exarchos:oneshot` if appetite exists.
- **Recommendation 3** (E2E render-fidelity) is a `/exarchos:ideate` candidate — the Codex sandbox setup alone deserves a design discussion.
- **Recommendation 5** (lifecycle hooks) needs a GitHub issue referencing this report, marked for v2.10/v2.11 triage.
