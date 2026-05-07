# Insights Friction Discovery — Solutions, Skill Triage, Roadmap Alignment

**Date:** 2026-05-07
**Workflow:** `insights-friction-discovery`
**Source signal:** `/insights` report covering 213 sessions / 359 commits / 2026-04-07–2026-05-07
**Scope:** Triage friction patterns and "On The Horizon" suggestions against the post-2026-05-06 roadmap, factoring in #1109 invariants and axiom DIM-1..DIM-8 dimensions.

## Bottom line

Two of three "On The Horizon" autopilots already exist as scoped issues in v2.11.0, and one of them (`#1119` autonomous merge orchestrator) is **already closed and shipped**. The insights report is reading older session data — the current frontier is narrower than it suggests. Most of the recommended Custom Skills/Hooks **duplicate production code already in `dispatch-guard.ts` + `merge-orchestrate.ts`**. The genuinely new opportunities are: (1) machine-readable invariants consumed by `/ideate`, (2) closing the non-implementer worktree-isolation gap (`#1220`), and (3) a long-tail spike on epic-level autopilot — gated on v2.11.0.

---

## 1. Friction → root cause → solutions

### F1. Worktree & parallel-agent coordination breakdowns

**Axiom dimensions:** DIM-1 Topology (silent degraded instances), DIM-4 Test Fidelity (guards exist but aren't exercised on subagent boot), DIM-7 Resilience (no merge-time rollback for non-implementer changes).

**Root causes:**
- `exarchos-fixer` / `exarchos-scaffolder` subagents do **not** auto-provision isolated worktrees, only `exarchos-implementer` does. Parallel dispatch corrupts the main worktree (`#1220`, OPEN, v2.9.0).
- `git stash` storage is shared across worktrees; one agent's pop can pull a sibling's WIP (project memory `feedback_subagent_stash_hazard.md`).

**State of solutions:**
- **Shipped:** `#1119` autonomous merge orchestrator — `dispatch-guard.ts` DR-1 (ancestry validation) + DR-2 (worktree assertion) compose into `prepare-delegation.ts`; `merge-orchestrate.ts` records rollback SHA and resets on failure. Auto-trigger via `next-action@v1` projection — runtime-portable, no platform hooks (`#1109` MCP-parity invariant satisfied).
- **Open and well-scoped:** `#1220` — extend the `implementer`-only worktree provisioning to all write-tool subagent types. This is the highest-value remaining item for F1.
- **Net new (small):** Emit `dispatch.preflight` and `stash.detected` events from the existing guards so the friction is *visible* in telemetry instead of relying on memory-of-incident (DIM-2 Observability gap).

### F2. Design philosophy misalignment requiring redirects

**Axiom dimensions:** DIM-3 Contracts (constraints aren't a typed input to the design step), DIM-8 Prose Quality (default-pattern drafts before constraints land).

**Root cause:** Axioms (`agent-first CLI`, Aspire conventions, `#1109` invariants, basileus-forward boundary) live in CLAUDE.md prose, scattered design docs, and project memory. The `/ideate` skill does not consume them as a structured input on first turn — they only surface after the user pushes back.

**State of solutions:**
- CLAUDE.md added a "Design Philosophy" section (visible in current head). This catches a fraction of the cases.
- **Net new:** A `docs/architecture/invariants.md` (or `.exarchos/invariants.yml`) that the `/ideate` skill loads into its first synthesis pass. Aligns with the v3.1.0 Workflow Builder SDK's `workflow-authoring` skill (#1255), which faces the same constraint-discovery problem.

### F3. Output token limits & tool-selection misses

**Axiom dimensions:** DIM-2 Observability (no signal when narration is approaching the cap), DIM-5 Hygiene (selection rules exist but only as prose).

**Root causes:**
- Long-horizon orchestrations narrate verbosely; output-token cap truncates mid-work.
- Tool-selection rules (`playwright-cli` not Chrome extension; `gh` not browser; `rtk` for token-cost ops) live in CLAUDE.md as advice, not as structured hints surfaced by tool results.

**State of solutions:**
- CLAUDE.md "Local Repro & Verification" entry covers playwright-cli redirect.
- **Net new (low cost):** Telemetry-driven hint — the `exarchos_view telemetry` action already tracks per-tool tokens; emit a `quality_hint` when output-tokens-per-turn exceeds a threshold, surfaced via the next_actions hint envelope (aligns with v2.10.0 Agent Output Contract HATEOAS).

---

## 2. Skill / hook / feature evaluation

| Recommendation | Verdict | Reasoning |
|---|---|---|
| **Custom Skill: pre-flight base-branch + worktree audit** | **REJECT — duplicates shipped code.** | `dispatch-guard.ts` DR-1/DR-2 already runs at every `delegate` and the `merge-orchestrate.ts` handler closes the merge-time half. Adding a skill on top is DIM-5 hygiene noise. The remaining gap is `#1220` (non-implementer subagents), which is a *plumbing* fix, not a skill. |
| **Hook: PreToolUse/PostToolUse worktree CWD validation** | **DEFER — violates `#1109` MCP parity.** | Hooks are Claude-Code-specific. The current event-sourced guard pattern is portable to Codex / Cursor / OpenCode / Copilot per the post-#1181 capability model. Adding a hook reintroduces a platform-specific path the architecture has explicitly avoided. The same outcome is achievable with a `dispatch.preflight` event + per-runtime delegation skills already consuming `next_actions`. |
| **Headless mode for shepherd loops** | **PARTIAL ALIGN — fold into `#1120`.** | Headless is the *delivery channel* for the self-healing shepherd, not a separate effort. The `#1120` design already covers classification + parallel fix dispatch. File a sibling task under #1120 for a long-running daemon entry point if the design doesn't explicitly call it out. |
| **Custom Skill: `/preflight-dispatch`, `/shepherd-loop`, etc.** | **REJECT — already exist.** | `commands/` has `delegate.md`, `shepherd.md`, `rehydrate.md`, `cleanup.md`, `oneshot.md`, `discover.md`, `tdd.md`, `synthesize.md`. We are not skill-poor; we are constraint-loading-poor (F2). |

---

## 3. "On The Horizon" triage

| Suggestion | Status | Milestone fit | Action |
|---|---|---|---|
| **(a) Self-Healing Parallel Agent Fleets** (`exarchos_orchestrate --self-heal`) | **Already shipped.** `#1119` CLOSED; design `docs/designs/2026-04-26-autonomous-merge-orchestrator.md`. Insights report reflects pre-shipment friction. | n/a (done) | Verify telemetry shows the orchestrator is firing in production sessions. The user's friction count likely drops on next `/insights` run. |
| **(b) Autonomous PR Shepherd Until Merge** | **In flight as `#1120`** (OPEN, v2.11.0). Design `docs/designs/2026-04-17-self-healing-shepherd.md`. | v2.11.0 — Autonomous Orchestration | No new issue needed. Confirm design covers headless / long-running mode; if not, file a sibling. |
| **(c) Roadmap-To-Merged-Epic Autopilot** (`exarchos epic --autopilot`) | **Premature — composes (a)+(b)+`#1121` TDD swarm + ideate-to-plan automation.** No issue exists. | post-v2.11.0; candidate for v2.13 or v3.0.x | File a `status:backlog` design spike. Gate on v2.11.0 completion + telemetry from #1120 in production. Strategic-framing check: this is *local-tier* orchestration — must not duplicate Basileus's Phronesis loop. |

---

## 4. Backlog (proposed issues)

Prioritized by leverage. Numbered for triage; not yet filed.

1. **`docs(architecture): machine-readable invariants consumed by /ideate`** — Extract `#1109` constraints, agent-first/Aspire patterns, axiom dimensions, basileus boundary into `docs/architecture/invariants.md` with structured front-matter; wire `commands/ideate.md` to load it on first turn. **Milestone:** v2.10.0 (precedes v3.1.0 authoring skills which will reuse it). **Addresses:** F2.
2. **`feat(events): emit dispatch.preflight + stash.detected events from dispatch-guard.ts`** — DIM-2 observability for guards that already run silently. Cheap; unlocks telemetry-based triage and future autopilot signals. **Milestone:** v2.10.0 (Output Contract — hints/envelope home). **Addresses:** F1, F3.
3. **`feat(telemetry): output-token hint via next_actions when narration spikes`** — Surface a `quality_hint` from `exarchos_view telemetry` when per-turn output tokens cross a threshold; let runtimes self-checkpoint. **Milestone:** v2.10.0. **Addresses:** F3.
4. **(Already filed) `#1220` subagent worktree isolation for non-implementer types** — Confirm scoped + prioritized in v2.9.0. No new issue. **Addresses:** F1 (highest residual leverage).
5. **`feat(shepherd): long-running headless daemon entry point` (sibling of `#1120`)** — Only if `#1120` design doesn't already cover. **Milestone:** v2.11.0.
6. **`spike: roadmap-to-merged-epic autopilot — design only`** — `status:backlog`, no milestone. Gate on v2.11.0 closure. Must include human-checkpoint UX, basileus-overlap analysis, and a small-epic integration test plan. **Addresses:** "On The Horizon (c)".

---

## 5. Cross-cutting verification

This discovery itself touches `#1109` invariants only as analysis input — no code or schema changes here. The proposed backlog items must each carry the `## #1109 Invariant Verification` block when filed:

- Items 1, 2, 3, 5, 6: event-sourcing integrity (events emitted? projections read? reconstructable?), MCP parity (CLI ↔ MCP envelope identical?), basileus-forward (no MCP-second-class assumptions?), capability resolution (no runtime yaml reads?).
- Item 4 (`#1220`) is plumbing in the subagent harness — verification block applies on the implementing PR.

## 6. Out of scope

- Per-PR "ultrareview"-style autonomous review composition — Phronesis territory (basileus / v3.2.0).
- Custom-user-authored workflows beyond what `#1258` v3.1.0 already covers — gated on Workflow Builder SDK landing.
- GUI surfaces — explicitly excluded by `feedback_extensibility_design_envelope.md`.
