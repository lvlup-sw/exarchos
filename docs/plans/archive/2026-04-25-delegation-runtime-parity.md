# Implementation Plan — Delegation Runtime Parity

> **Design:** [`2026-04-25-delegation-runtime-parity.md`](../designs/2026-04-25-delegation-runtime-parity.md)
> **Workflow:** `delegation-runtime-parity` (phase: plan)
> **TDD Iron Law:** No production code without a failing test first.

---

## Phase Overview

| Phase | Tasks | Parallelizable | Depends on |
|---|---|---|---|
| **P0 — Foundation** | 1, 2, 3 | No (sequential) | — |
| **P1 — Adapters** | 4a–4e | Yes (5-way fan-out) | P0 |
| **P2 — Composition root** | 5, 6 | No | P1 |
| **P3 — Runtime YAML** | 7a–7e | Yes (5-way fan-out) | P0 (capabilities), P1 (file paths) |
| **P4 — Prose layer** | 8, 9, 10 | Partial (8 then 9‖10) | P0 (capability vocabulary) |
| **P5 — Validation & CI** | 11, 12, 13 | Yes (3-way fan-out) | P2, P4 |
| **P6 — Cleanup** | 14, 15 | No | P5 |

Total: 22 tasks (5 adapters + 5 YAMLs counted as parallel tracks).

---

## P0 — Foundation (sequential)

### Task 1: Define capability vocabulary
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `Capability_RejectsUnknownVerb_ZodFails`
   - File: `servers/exarchos-mcp/src/agents/capabilities.test.ts`
   - Expected failure: file does not exist
   - Assert: `Capability.parse('fs:read')` succeeds; `Capability.parse('bogus')` throws ZodError
2. **[RED]** Write test: `Capability_AllVocabularyMembersValid_AllParse`
   - Same file
   - Iterate over the 10 capability strings from design §3, each parses
3. **[GREEN]** Implement `capabilities.ts`
   - File: `servers/exarchos-mcp/src/agents/capabilities.ts`
   - Export `Capability` Zod enum with the 10 verbs from design §3
   - Export `type Capability = z.infer<typeof Capability>`
4. **[REFACTOR]** Add brief one-line JSDoc per capability member if non-obvious

**Dependencies:** None
**Parallelizable:** No (foundation)

---

### Task 2: Rewrite `AgentSpec` registry to capability-declared
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `AgentSpec_DeclaresCapabilities_NotClaudeTools`
   - File: `servers/exarchos-mcp/src/agents/definitions.test.ts` (new)
   - Assert: `IMPLEMENTER.capabilities` contains `'subagent:spawn'`, `'fs:write'`, `'shell:exec'`, `'mcp:exarchos'`
   - Assert: `IMPLEMENTER` does NOT have a `tools` field (Claude-shaped)
2. **[RED]** Write test: `AgentSpec_RejectsUnknownCapability_TypecheckFails`
   - Same file
   - Use `// @ts-expect-error` against an invalid capability string
3. **[GREEN]** Rewrite `definitions.ts`
   - File: `servers/exarchos-mcp/src/agents/definitions.ts`
   - Replace `tools: string[]` with `capabilities: Capability[]`
   - Translate existing 4 specs (`IMPLEMENTER`, `FIXER`, `REVIEWER`, `SCAFFOLDER`) per design §3 mapping table
   - Update `types.ts` accordingly
4. **[REFACTOR]** Co-locate spec body content (description, system prompt) so adapters can read consistently

**Dependencies:** Task 1
**Parallelizable:** No

---

### Task 3: Define `RuntimeAdapter` interface
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `RuntimeAdapter_TypeContract_HasRequiredMembers`
   - File: `servers/exarchos-mcp/src/agents/adapters/types.test.ts`
   - Compile-time assertion via `satisfies RuntimeAdapter` against a stub
2. **[GREEN]** Implement `adapters/types.ts`
   - File: `servers/exarchos-mcp/src/agents/adapters/types.ts`
   - Export `RuntimeAdapter` interface per design §4
   - Export `Runtime = 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot'`
   - Export `ValidationResult = { ok: true } | { ok: false; reason: string; fixHint: string }`
3. **[REFACTOR]** None needed

**Dependencies:** Task 1, Task 2
**Parallelizable:** No

---

## P1 — Adapters (5-way parallel after P0)

Each adapter is one task with the same shape: RED snapshot/parse test → GREEN adapter → REFACTOR. Adapters are independent — five worktrees in parallel.

### Task 4a: Claude adapter (regression-critical)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `ClaudeAdapter_LowerImplementer_ByteIdenticalToCurrentOutput`
   - File: `servers/exarchos-mcp/src/agents/adapters/claude.test.ts`
   - Snapshot the current `agents/implementer.md` (read from disk pre-change) into a fixture
   - Assert: `claudeAdapter.lowerSpec(IMPLEMENTER).contents === fixture`
   - Repeat for `fixer`, `reviewer`, `scaffolder`
2. **[RED]** Write test: `ClaudeAdapter_AgentFilePath_ReturnsAgentsName`
   - Assert: `claudeAdapter.agentFilePath('implementer') === 'agents/implementer.md'`
3. **[RED]** Write test: `ClaudeAdapter_ValidatesUnsupportedCapability_ReturnsError`
   - Pass a synthetic spec requiring a capability not in Claude's `supportedCapabilities`; assert `validateSupport` returns `{ ok: false, ... }`
4. **[GREEN]** Implement `adapters/claude.ts`
   - File: `servers/exarchos-mcp/src/agents/adapters/claude.ts`
   - Lower capabilities → `tools` array, `hooks` block, `mcpServers`, `isolation`
   - Reuse logic from `generate-cc-agents.ts` (do not delete that file yet — Task 14)
5. **[REFACTOR]** Extract capability-to-Claude-tool mapping table to a top-of-file constant

**Dependencies:** Task 3
**Parallelizable:** Yes (with 4b–4e)
**Branch:** `feat/runtime-parity-adapter-claude`

---

### Task 4b: Codex adapter
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `CodexAdapter_LowerImplementer_EmitsValidTOML`
   - File: `servers/exarchos-mcp/src/agents/adapters/codex.test.ts`
   - Use `@iarna/toml` (or equivalent) to parse the output; assert structure has `name`, `description`, `developer_instructions`
2. **[RED]** Write test: `CodexAdapter_FallbackFlag_ProducesInlinePromptInvocation`
   - Set `customAgentResolutionWorks: false` (config flag); assert generator emits both the TOML and an inline-prompt fallback record
3. **[RED]** Write test: `CodexAdapter_AgentFilePath_ReturnsCodexAgentsPath`
   - Assert: `codexAdapter.agentFilePath('implementer') === '.codex/agents/implementer.toml'`
4. **[GREEN]** Implement `adapters/codex.ts`
   - Lower capabilities → TOML; `developer_instructions` constructed from spec body + capability descriptions
   - Honor `customAgentResolutionWorks` flag (default `false` until #15250/#14579 resolve)
5. **[REFACTOR]** None needed

**Dependencies:** Task 3
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-adapter-codex`

---

### Task 4c: OpenCode adapter
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `OpenCodeAdapter_LowerImplementer_EmitsModeSubagentFrontmatter`
   - File: `servers/exarchos-mcp/src/agents/adapters/opencode.test.ts`
   - Parse YAML frontmatter; assert `mode === 'subagent'`, `tools.write === true`, `tools.read === true`
2. **[RED]** Write test: `OpenCodeAdapter_AgentFilePath_ReturnsOpencodeAgentsPath`
3. **[RED]** Write test: `OpenCodeAdapter_PermissionTaskFiltering_RestrictsScope`
   - Assert frontmatter includes `permission.task` configured per spec
4. **[GREEN]** Implement `adapters/opencode.ts`
   - Markdown with YAML frontmatter; tools as boolean object
5. **[REFACTOR]** None needed

**Dependencies:** Task 3
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-adapter-opencode`

---

### Task 4d: Cursor adapter
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `CursorAdapter_LowerImplementer_EmitsCursor25Frontmatter`
   - File: `servers/exarchos-mcp/src/agents/adapters/cursor.test.ts`
   - Assert frontmatter has `model: inherit`, `readonly: false`, `is_background: false`
2. **[RED]** Write test: `CursorAdapter_AgentFilePath_ReturnsCursorAgentsPath`
   - Assert: `.cursor/agents/implementer.md`
3. **[GREEN]** Implement `adapters/cursor.ts`
4. **[REFACTOR]** None needed

**Dependencies:** Task 3
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-adapter-cursor`

---

### Task 4e: Copilot adapter
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `CopilotAdapter_LowerImplementer_EmitsAgentMdExtension`
   - File: `servers/exarchos-mcp/src/agents/adapters/copilot.test.ts`
   - Assert path ends in `.agent.md`
2. **[RED]** Write test: `CopilotAdapter_AgentFilePath_ReturnsCopilotAgentsPath`
   - Assert: `.github/agents/implementer.agent.md` (project scope) or `~/.copilot/agents/implementer.agent.md` (user scope)
3. **[GREEN]** Implement `adapters/copilot.ts`
4. **[REFACTOR]** None needed

**Dependencies:** Task 3
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-adapter-copilot`

---

## P2 — Composition root

### Task 5: Unified `generate-agents.ts` (replaces `generate-cc-agents.ts`)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `GenerateAgents_AllRuntimes_ProducesFilePerRuntimePerSpec`
   - File: `servers/exarchos-mcp/src/agents/generate-agents.test.ts`
   - Use a temp directory; run generator; assert 5 runtimes × 4 specs = 20 files exist
2. **[RED]** Write test: `GenerateAgents_UnsupportedCapability_ThrowsBuildError`
   - Inject a synthetic spec requiring `team:agent-teams` for OpenCode; assert generator throws with fix hint per design §5
3. **[RED]** Write test: `GenerateAgents_MissingAdapter_ThrowsBuildError`
4. **[GREEN]** Implement `generate-agents.ts`
   - File: `servers/exarchos-mcp/src/agents/generate-agents.ts`
   - Walk `definitions.ts`, fan out across `RuntimeAdapter[]`, validate, write
   - Update `.claude-plugin/plugin.json` (Claude only)
5. **[REFACTOR]** Extract the adapter registry as a single `ADAPTERS: Record<Runtime, RuntimeAdapter>` constant

**Dependencies:** Tasks 4a–4e
**Parallelizable:** No
**Branch:** `feat/runtime-parity-composition-root`

---

### Task 6: Wire `generate-agents.ts` into build pipeline
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `BuildPipeline_GenerateAgents_RunsBeforeBuildSkills`
   - File: `servers/exarchos-mcp/src/agents/build-integration.test.ts`
   - Assert `npm run build:skills` invokes `generate-agents.ts` as a pre-step (or that `package.json` scripts wire them in correct order)
2. **[GREEN]** Update `package.json`
   - Add `"generate:agents": "tsx servers/exarchos-mcp/src/agents/generate-agents.ts"`
   - Update `"build:skills": "npm run generate:agents && ..."`
3. **[REFACTOR]** None

**Dependencies:** Task 5
**Parallelizable:** No

---

## P3 — Runtime YAML updates (5-way parallel after P0)

Each runtime YAML gets `supportedCapabilities` + corrections. Five worktrees in parallel.

### Task 7a: `claude.yaml` — declare full capability support
**Phase:** RED → GREEN

1. **[RED]** Write test: `ClaudeYaml_SupportedCapabilities_IncludesAllVerbs`
   - File: `servers/exarchos-mcp/src/runtimes/claude.test.ts` (or extend existing yaml-loader test)
   - Assert all 10 capabilities present
2. **[GREEN]** Edit `runtimes/claude.yaml`
   - Add `supportedCapabilities: [fs:read, fs:write, shell:exec, subagent:spawn, subagent:completion-signal, subagent:start-signal, mcp:exarchos, isolation:worktree, team:agent-teams, session:resume]`

**Dependencies:** Task 1
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-yaml-claude`

---

### Task 7b: `codex.yaml` — declare capabilities, keep workaround spawn call
**Phase:** RED → GREEN

1. **[RED]** Write test: `CodexYaml_SupportedCapabilities_ExcludesClaudeOnlyHooks`
   - Assert `team:agent-teams`, `session:resume`, `subagent:completion-signal`, `subagent:start-signal` are NOT in the list
2. **[GREEN]** Edit `runtimes/codex.yaml`
   - Add `supportedCapabilities: [fs:read, fs:write, shell:exec, subagent:spawn, mcp:exarchos, isolation:worktree]`
   - Leave `SPAWN_AGENT_CALL` workaround in place; add comment referencing the fallback flag

**Dependencies:** Task 1
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-yaml-codex`

---

### Task 7c: `opencode.yaml` — declare capabilities, fix `Task` call
**Phase:** RED → GREEN

1. **[RED]** Write test: `OpencodeYaml_SpawnAgentCall_PointsToGeneratedAgentName`
   - Assert `SPAWN_AGENT_CALL` template references `subagent_type: "exarchos-implementer"` (which now exists on disk after Task 4c)
2. **[GREEN]** Edit `runtimes/opencode.yaml`
   - Add `supportedCapabilities: [fs:read, fs:write, shell:exec, subagent:spawn, mcp:exarchos, isolation:worktree]`
   - Verify `SPAWN_AGENT_CALL` is correct (no behavior change; just confirm)

**Dependencies:** Task 1, Task 4c
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-yaml-opencode`

---

### Task 7d: `cursor.yaml` — refresh stale claim, switch to native subagents
**Phase:** RED → GREEN

1. **[RED]** Write test: `CursorYaml_HasSubagents_True`
   - Assert `hasSubagents: true`
2. **[RED]** Write test: `CursorYaml_SpawnAgentCall_UsesTaskTool`
   - Assert `SPAWN_AGENT_CALL` references `Task({subagent_type: ...})` not the prose-degradation marker
3. **[GREEN]** Edit `runtimes/cursor.yaml`
   - Set `hasSubagents: true`
   - Add `supportedCapabilities: [fs:read, fs:write, shell:exec, subagent:spawn, mcp:exarchos]`
   - Update `SPAWN_AGENT_CALL` to native Cursor 2.5 `Task` invocation

**Dependencies:** Task 1, Task 4d
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-yaml-cursor`

---

### Task 7e: `copilot.yaml` — switch from `/delegate` to local `task --agent`
**Phase:** RED → GREEN

1. **[RED]** Write test: `CopilotYaml_SpawnAgentCall_UsesLocalTaskAgent`
   - Assert `SPAWN_AGENT_CALL` contains `task --agent` and NOT `/delegate`
2. **[GREEN]** Edit `runtimes/copilot.yaml`
   - Add `supportedCapabilities: [fs:read, fs:write, shell:exec, subagent:spawn, mcp:exarchos]`
   - Replace `/delegate "..."` with `task --agent <name>` programmatic form
   - Remove the YAML's "we knowingly picked the wrong primitive" comment

**Dependencies:** Task 1, Task 4e
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-yaml-copilot`

---

## P4 — Prose layer

> **Revision (2026-04-25, post-design-review + axiom backend-quality):** original Tasks 8/9/10 were sequential and shared the same files (`src/build-skills.ts`, `skills-src/delegation/SKILL.md`). After dimensional review (DIM-1 topology, DIM-3 contracts, DIM-5 hygiene) they collapse into two waves:
>
> - **Wave A** (this plan's Task 8 + Task 9, plus typed contracts and reference-pruning): renderer pipeline + source migration in one cohesive change.
> - **Wave B** (Task 10): vocabulary lint, dispatched only after Wave A's source migration lands.
>
> The original Task 8/9/10 sub-steps remain authoritative as RED-test seeds; the wave shape just bundles them sensibly.

### Wave A — Renderer pipeline + source migration (Task 8 + Task 9 bundled)
**Phase:** RED → GREEN → REFACTOR
**Branch:** `feat/runtime-parity-wave-a-renderer`
**Files:** `src/build-skills.ts`, `src/runtimes/types.ts`, `skills-src/delegation/SKILL.md`, `skills-src/delegation/references/*`, `runtimes/*.yaml`

#### Typed contracts (DIM-3, must land first)

1. **`RuntimeTokenKey` enum** in `src/runtimes/types.ts` — union of every placeholder key valid in skill prose (existing 5 + Wave A additions). Build pre-flight asserts every runtime YAML defines every token in the enum, or fails with the offending runtime/token pair.
2. **Guard parser consumes `SupportedCapabilityKey`** (already typed). `<!-- requires:not-a-cap -->` produces a build error citing file/line/unknown capability. Same for `<!-- requires:native:not-a-cap -->`.
3. Both guard forms supported with explicit semantics:
   - `<!-- requires:cap -->...<!-- /requires -->` — block included if `cap ∈ {native, advisory}`.
   - `<!-- requires:native:cap -->...<!-- /requires -->` — block included only if `cap = native`.
   - Nested guards are honored (outer guard elides everything inside before inner is evaluated).

#### Token table (decision policy: tokenize when a sensible non-Claude rendering exists, otherwise guard)

| Token | Claude | OpenCode | Cursor | Codex | Copilot |
|-------|--------|----------|--------|-------|---------|
| `{{SUBAGENT_COMPLETION_HOOK}}` | `TeammateIdle hook` | `subagent completion signal (poll-based)` | same as OpenCode | same as OpenCode | same as OpenCode |
| `{{SUBAGENT_RESULT_API}}` | `TaskOutput({ task_id, block: true })` | `[poll subagent result]` | `[poll subagent result]` | `wait_agent({ task_id })` | `task` output (inline) |

Anything not in the table that requires Claude-only behavior (e.g. `TaskList`/`TaskUpdate`/`SendMessage`, `agentId`, the `SubagentStart` hook, the `agent-team` mode) becomes a guard, not a token. Wave A is empowered to extend the table if a clean fallback emerges during implementation; the rule is the constraint.

#### Reference-file pruning (DIM-5)

Renderer scans the per-runtime rendered SKILL.md for `references/<file>` links and copies only the ones actually linked to `skills/<runtime>/<name>/references/`. So when the link to `agent-teams-saga.md` is wrapped `<!-- requires:team:agent-teams -->` and elided on non-Claude runtimes, the file is also not copied for those runtimes. Avoids per-line guards in long Claude-only references (`agent-teams-saga.md`, parts of `implementer-prompt.md`).

#### Build-time hard errors (DIM-2)

Each is a separate aggregated diagnostic, not a fatal-on-first-hit error.

- Unknown token: `{{TYPO}}` referenced in source where no runtime defines it.
- Unknown guard capability: `<!-- requires:typo -->` where `typo ∉ SupportedCapabilityKey`.
- Token defined in some runtimes but used where another runtime's render path lacks a definition.
- Orphan markdown after elision (empty list item, heading-only block with no body).
- Idempotency: `buildAllSkills` invoked twice produces byte-identical output (assert in test; `skills:guard` CI already validates this externally).

#### RED tests (extends original Task 8 + Task 9 set)

1. `BuildSkills_SubagentCompletionHookToken_RendersPerRuntime` (orig 8.1)
2. `BuildSkills_SubagentResultApiToken_RendersPerRuntime` (orig 8.2 generalized)
3. `BuildSkills_TokenWithoutDefinition_FailsBuild` (DIM-2)
4. `BuildSkills_RequiresGuard_ElidesUnsupportedSection` (orig 9.1)
5. `BuildSkills_RequiresNativeGuard_AdvisoryRuntimeElides` (DIM-4 — assert `<!-- requires:native:session:resume -->` is included on Claude, elided on OpenCode/Cursor/Codex/Copilot where `session:resume` is `advisory`)
6. `BuildSkills_UnknownGuardCapability_FailsBuild` (DIM-3)
7. `BuildSkills_NestedGuards_Respected` (orig 9.2)
8. `BuildSkills_OrphanReferenceFile_NotCopied` (DIM-5 — guarded link elided ⇒ referenced file not in output)
9. `BuildSkills_RenderIdempotent` (DIM-7)

#### GREEN

- Implement renderer pipeline (token expansion → guard elision → reference pruning → idempotency check).
- Migrate `skills-src/delegation/SKILL.md` and references to use tokens/guards per the policy table.
- Wrap `agent-teams-saga.md` link in `<!-- requires:team:agent-teams -->`.
- Wrap `agentId`/session-resume guidance in `<!-- requires:native:session:resume -->`.

#### REFACTOR

Document the token table and guard syntax inline in `skills-src/SKILL_AUTHORING.md` (create if absent) or top of `src/build-skills.ts`.

**Dependencies:** Task 1, Tasks 7a–7e
**Parallelizable:** No (collapses two former tasks)

---

### Wave B — Vocabulary lint (Task 10)
**Phase:** RED → GREEN
**Branch:** `feat/runtime-parity-wave-b-lint`
**Depends on:** Wave A merged
**Files:** `src/build-skills.ts` (lint hook), `src/build-skills.test.ts`

#### Lint scope

- Runs **post-render**, per-runtime, against rendered output bytes.
- Forbidden terms (typed catalog, exported for reuse): `TeammateIdle`, `SubagentStart`, `TaskOutput`, `TaskList`, `TaskUpdate`, `SendMessage`, `TeamCreate`, `TeamDelete`, `agentId`.
- Allowed contexts the lint must respect:
  - Inside a fenced code block whose info-string contains `runtime:claude-only`
  - Capability identifiers (e.g. literal string `team:agent-teams` as a YAML/code symbol) — explicit exclusion to avoid false positives
- Failure message format: `<file>:<line>: forbidden term '<term>' in <runtime> render — wrap in <!-- requires:<cap> --> or tokenize as {{...}}`.

#### RED tests

1. `VocabularyLint_ForbiddenTermInClaudeRenderInsideGuard_Passes` (orig 10.2)
2. `VocabularyLint_ForbiddenTermInOpenCodeRender_FailsCI` (extends orig 10.1 with cross-runtime case)
3. `VocabularyLint_CapabilityIdentifierNotFlagged` (false-positive guard)

#### GREEN

Extend the existing `lintPlaceholders` pre-flight (or add a sibling post-render lint pass) in `src/build-skills.ts`.

**Dependencies:** Wave A merged
**Parallelizable:** No (single concern; small change)

---

## P5 — Validation & CI (3-way parallel after P2/P4)

### Task 11: Snapshot regression test for Claude agent files
**Phase:** RED → GREEN

1. **[RED]** Write test: `GenerateAgents_ClaudeOutput_MatchesSnapshot`
   - File: `servers/exarchos-mcp/src/agents/generate-agents.test.ts`
   - Snapshot fixtures: copies of current `agents/{implementer,fixer,reviewer,scaffolder}.md` captured before any registry rewrite
   - Assert: post-refactor `generate-agents.ts` for Claude produces byte-identical output
2. **[GREEN]** No new code; this is the regression gate that confirms Task 4a's promise

**Dependencies:** Task 5
**Parallelizable:** Yes (with Tasks 12, 13)
**Branch:** `feat/runtime-parity-snapshot-claude`

---

### Task 12: Per-runtime smoke validation
**Phase:** RED → GREEN

1. **[RED]** Write test: `GenerateAgents_AllRuntimeOutputs_WellFormed`
   - File: `servers/exarchos-mcp/src/agents/generate-agents.test.ts` (extend)
   - For each runtime × spec, parse the generated artifact:
     - Claude/OpenCode/Cursor/Copilot: parse YAML frontmatter via `gray-matter`, assert required fields
     - Codex: parse TOML via `@iarna/toml`, assert required fields
2. **[GREEN]** No new code if Task 5 already produces well-formed output; else fix adapters

**Dependencies:** Task 5
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-smoke-validation`

---

### Task 13: Extend `skills:guard` CI check to cover `agents/` drift
**Phase:** RED → GREEN

1. **[RED]** Write test: `SkillsGuard_AgentsDirDrift_FailsCheck`
   - File: `src/build-skills.test.ts`
   - Stage a hand-edit to `agents/implementer.md` post-generate; run guard; assert non-zero exit
2. **[GREEN]** Extend `npm run skills:guard` (in `package.json` and underlying script)
   - After running `generate-agents` and `build-skills`, run `git diff --exit-code agents/ skills/`

**Dependencies:** Task 5, Task 6
**Parallelizable:** Yes
**Branch:** `feat/runtime-parity-ci-guard`

---

## P6 — Cleanup

### Task 14: Delete `generate-cc-agents.ts` and obsolete tests
**Phase:** REFACTOR

1. Verify Task 11 snapshot test passes (Claude output unchanged).
2. Delete:
   - `servers/exarchos-mcp/src/agents/generate-cc-agents.ts`
   - `servers/exarchos-mcp/src/agents/generate-cc-agents.test.ts`
3. Update `servers/exarchos-mcp/src/agents/generated-drift.test.ts` to reference `generate-agents.ts`
4. Confirm no remaining imports of the deleted file

**Dependencies:** Task 11
**Parallelizable:** No
**Branch:** `feat/runtime-parity-delete-cc-generator`

---

### Task 15: Documentation — capability matrix in README
**Phase:** GREEN

1. Generate the runtime × capability matrix from `runtimes/<name>.yaml` `supportedCapabilities`
2. Add to README's runtime section, replacing the implicit-tier framing
3. Update README to describe two-tier model per design §7
4. Update relevant CLAUDE.md / docs that reference the old "5 Tier 1 + graceful" framing

**Dependencies:** Tasks 7a–7e
**Parallelizable:** No (depends on all YAML updates)
**Branch:** `feat/runtime-parity-readme`

---

## Parallelization Summary

```
P0 (sequential)
 └─ Task 1 → Task 2 → Task 3
                       │
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
P1: 4a, 4b, 4c, 4d, 4e (5 worktrees parallel)
        │
        ▼
P2: Task 5 → Task 6 (sequential)
        │
        │ (P3 can start in parallel with P2 after P0)
        ▼
P3: 7a, 7b, 7c, 7d, 7e (5 worktrees parallel; 7c/7d/7e need their respective adapter files to exist)
        │
        ▼
P4: Task 8 → (Task 9 ‖ Task 10)
        │
        ▼
P5: 11 ‖ 12 ‖ 13 (3 worktrees parallel)
        │
        ▼
P6: Task 14 → Task 15
```

**Maximum concurrent tracks:** 5 (during P1 adapter fan-out; same during P3 YAML fan-out).

**Critical path length:** P0 (3 sequential) → P1 (longest adapter ≈ Claude due to snapshot) → P2 (2 sequential) → P4 (3 mostly-sequential) → P5 (parallel) → P6 (2 sequential) ≈ 13 sequential task-slots.

---

## Branch Topology

Integration branch: `feat/delegation-runtime-parity`

All task branches above target the integration branch via `--base feat/delegation-runtime-parity`. Final PR from integration branch targets `main`. No stacked PRs needed; all task work merges into the integration branch first.

---

## Risk Notes

- **Task 4a (Claude adapter)** is regression-critical. The snapshot test in Task 11 is the gate that proves we haven't broken the working Claude path. If snapshots diverge, fix the adapter — do not update the snapshot blindly.
- **Task 10 (vocabulary lint)** must run on the full skill source after Task 9 lands the guards. Order matters; otherwise lint fails on legitimate Claude content not yet wrapped.
- **Task 7c (OpenCode YAML)** depends on Task 4c (OpenCode adapter) producing real files; otherwise the spawn call points at agents that don't exist on disk. Verify Task 4c's output paths before merging Task 7c.
- **Task 14 (deletion)** must not run before Task 11 confirms snapshot parity. Order strictly: 11 → 14.

---

## Sources

- Design: `docs/designs/2026-04-25-delegation-runtime-parity.md`
- Discovery: `docs/research/2026-04-25-delegation-platform-agnosticity.md`
- Existing source paths verified: `servers/exarchos-mcp/src/agents/{definitions,generate-cc-agents,types}.ts`, `runtimes/*.yaml`, `skills-src/delegation/{SKILL.md,references/}`
