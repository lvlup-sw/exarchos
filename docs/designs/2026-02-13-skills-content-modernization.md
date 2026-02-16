# Design: Skills Content Modernization & Hook Synergy

## Problem Statement

The Exarchos content layer (12 skills, 11 commands, 11 rules — ~43,500 words) evolved organically without the structured metadata and progressive disclosure patterns documented in Anthropic's [Complete Guide to Building Skills for Claude](docs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf). Three specific gaps:

1. **No YAML frontmatter** — None of the 12 SKILL.md files have structured metadata. Skills lack name, description, trigger phrases, version, or MCP server declarations. This prevents compatibility with Anthropic's official skill format and future auto-triggering.

2. **Monolithic content** — 7 of 12 skills load all content in a single SKILL.md with no references/ directory. The two worst offenders (quality-review at 2,040 words, implementation-planning at 1,370 words) load entirely into context when invoked. Only 3 skills (refactor, debug, delegation) demonstrate mature progressive disclosure.

3. **No integration with hook architecture** — The in-progress progressive-disclosure-hooks design creates a tool registry and hook CLI, but the content layer doesn't consume these. The 1,701-word `mcp-tool-guidance.md` rule is hand-maintained with 286 hardcoded tool references that drift from the MCP server's actual registration.

### Relationship to Existing Designs

This design addresses the **content layer** — complementary to two in-progress MCP layer designs:

| Design | Layer | Status |
|---|---|---|
| Progressive Disclosure & Hooks | MCP server (tools, hooks, registry) | In progress (delegate phase) |
| SDLC Telemetry & Benchmarks | MCP server (instrumentation, views) | Designed |
| **This design** | **Content (skills, commands, rules)** | **New** |

---

## Chosen Approach

**Two-phase implementation:**

**Phase 1 (independent):** Add YAML frontmatter to all 12 skills. Split the 2 largest monolithic skills into SKILL.md + references/. Add error handling patterns and troubleshooting sections. This can ship immediately with no dependencies.

**Phase 2 (after hooks ship):** Integrate the content layer with the progressive-disclosure-hooks tool registry. Generate `mcp-tool-guidance.md` from registry metadata. Extend `SubagentStart` hook to inject skill-aware context. Add validation scripts to skills that coordinate MCP calls.

---

## Technical Design

### 1. YAML Frontmatter Specification

Every SKILL.md gains a frontmatter block following Anthropic's format:

```yaml
---
name: brainstorming
description: >-
  Collaborative design exploration for new features and architecture decisions.
  Use when the user says "let's brainstorm", "let's ideate", "explore options",
  or runs /ideate. Presents 2-3 distinct approaches with trade-offs, then
  documents the chosen approach as a design document.
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: ideate
---
```

**Field decisions:**

| Field | Value | Rationale |
|---|---|---|
| `name` | kebab-case matching folder name | Anthropic requirement |
| `description` | WHAT + WHEN + trigger phrases | Guide's most important recommendation |
| `metadata.mcp-server` | `exarchos` | Links skill to MCP server for future integration |
| `metadata.phase-affinity` | Workflow phase name | Consumed by Phase 2 hook integration |
| `metadata.category` | `workflow` \| `utility` \| `standards` | For catalog generation |

**Trigger phrase guidelines** (from guide):
- Include 3-5 phrases users would actually say
- Include the slash command that invokes the skill
- Include negative triggers for skills that could over-fire

**All 12 skills with proposed descriptions:**

| Skill | Proposed Description Summary |
|---|---|
| brainstorming | Design exploration. Trigger: "brainstorm", "ideate", "explore options", `/ideate` |
| implementation-planning | TDD implementation plans from design docs. Trigger: "plan implementation", "create tasks", `/plan` |
| delegation | Dispatch tasks to agent teammates in worktrees. Trigger: "delegate", "dispatch tasks", `/delegate` |
| quality-review | Two-stage code review (spec compliance + code quality). Trigger: "review code", "check quality", `/review` |
| spec-review | Design-to-plan delta analysis. Trigger: "review plan", "check coverage", plan-review phase |
| synthesis | Create pull request from feature branch. Trigger: "create PR", "synthesize", `/synthesize` |
| debug | Bug investigation and fix workflow. Trigger: "debug", "fix bug", "investigate issue", `/debug` |
| refactor | Code improvement workflow (polish or overhaul tracks). Trigger: "refactor", "clean up", `/refactor` |
| workflow-state | Checkpoint and resume workflow state. Trigger: "save progress", "checkpoint", `/checkpoint` |
| git-worktrees | Git worktree management for parallel development. Trigger: "create worktree", "worktree setup" |
| dotnet-standards | .NET/C# coding standards and conventions. Trigger: working with .cs files, .NET projects |
| sync-schemas | Synchronize TypeScript types from backend OpenAPI specs. Trigger: "sync schemas", `/sync-schemas` |

---

### 2. Monolithic Skill Splitting

Two skills need splitting. The pattern follows refactor's mature model: SKILL.md as the "control panel" (<1,000 words), detailed content in references/.

#### 2.1 quality-review (2,040 → ~800 + references)

**Current:** All review criteria inline — SOLID principles, error handling patterns, security checklist, TypeScript specifics.

**Proposed structure:**
```
skills/quality-review/
├── SKILL.md              (~800 words — overview, two-stage process, flow)
└── references/
    ├── spec-compliance-checklist.md   (~400 words — design alignment checks)
    ├── code-quality-checklist.md      (~500 words — SOLID, DRY, naming)
    ├── security-checklist.md          (~200 words — OWASP patterns)
    └── review-report-template.md      (~200 words — output format)
```

**Splitting principle:** SKILL.md describes the workflow (when to read which checklist), references contain the criteria themselves. Claude reads the relevant checklist only when it reaches that review stage.

#### 2.2 implementation-planning (1,370 → ~700 + references)

**Current:** Planning rules, TDD phases, parallel group strategy, and task extraction logic all inline.

**Proposed structure:**
```
skills/implementation-planning/
├── SKILL.md              (~700 words — planning overview, phase workflow)
└── references/
    ├── task-extraction-guide.md       (~300 words — how to extract tasks from design)
    ├── parallel-group-template.md     (~200 words — grouping strategy)
    └── plan-document-template.md      (~200 words — output format)
```

---

### 3. Content Optimization Guidelines

Apply the guide's recommendations across all skills:

**Word limits:**
- SKILL.md body: ≤2,000 words (guide recommends ≤5,000; we use a tighter budget because our skills compose with commands, rules, and shared prompts)
- Individual reference files: ≤1,000 words
- Total skill (SKILL.md + all references): ≤5,000 words

**Current compliance:**

| Skill | Total Words | Status |
|---|---|---|
| refactor | 11,198 | Over (phases are large, but only 1-2 load per track) |
| debug | 4,374 | OK (references load on demand) |
| delegation | 3,255 | OK |
| quality-review | 2,040 | Over (monolithic — split resolves this) |
| implementation-planning | 1,370 | Over (monolithic — split resolves this) |
| All others | <1,000 each | OK |

**Refactor exception:** The refactor skill's 11,198 total words are acceptable because phase documents are mutually exclusive — the polish track never loads overhaul phases and vice versa. Effective per-invocation cost is ~3,500 words.

**Instructions for skill authors:**
- Put the workflow in SKILL.md, put the details in references/
- Use bullet points and numbered lists over prose
- Include examples inline only if they're ≤5 lines; longer examples go to references/
- Reference bundled files explicitly: "Consult `references/checklist.md` for the full criteria"

---

### 4. Error Handling & Troubleshooting

Add standardized troubleshooting sections to skills that coordinate MCP calls. Following the guide's pattern:

```markdown
## Troubleshooting

### MCP Tool Call Failed
If an Exarchos MCP tool returns an error:
1. Check the error message for specific guidance
2. Verify the workflow state file exists: `workflow:get` with the featureId
3. If state is corrupted, use `workflow:cancel` with `dryRun: true` to inspect

### State Desync
If workflow state doesn't match git reality:
1. Run `workflow:reconcile` (or the reconcile hook post-hooks-design)
2. Review discrepancies before proceeding
3. Update state to match git truth, not vice versa
```

**Skills needing troubleshooting sections:**
- delegation (MCP calls for team spawn, task management)
- synthesis (MCP calls for stack operations, PR creation)
- debug (MCP calls for state transitions, event emission)
- workflow-state (checkpoint/resume failure modes)

---

### 5. Tool Registry Integration (Phase 2)

After the progressive-disclosure-hooks design ships, the tool registry becomes the source of truth for tool metadata. The content layer consumes it in three ways:

#### 5.1 Generated mcp-tool-guidance.md

The registry's build script (`scripts/generate-docs.ts`, already specified in the hooks design) generates `rules/mcp-tool-guidance.md` from `TOOL_REGISTRY` metadata. This replaces the current 1,701-word hand-maintained file.

**Generated content includes:**
- Composite tool names and available actions
- Phase-valid action mappings
- Role-based tool access (lead vs. teammate)
- Anti-pattern table (old name → new composite pattern)

**Benefits:**
- Eliminates 286 hardcoded tool references that drift
- Single source of truth — edit the registry, content updates automatically
- Smaller output (only documents what exists, no aspirational patterns)

#### 5.2 Per-Skill Tool Manifests

For skills that heavily reference MCP tools (delegation, synthesis), the build script generates `references/tool-manifest.md` containing only the tools relevant to that skill's phase affinity:

```markdown
<!-- Auto-generated from tool registry. Do not edit. -->
## Available Tools (delegate phase)

### exarchos_orchestrate
Actions: team_spawn, team_message, team_broadcast, team_shutdown,
         team_status, task_claim, task_complete, task_fail

### exarchos_workflow
Actions: get, set (phase transitions, task updates)

### exarchos_event
Actions: append (lifecycle events), query (history lookup)
```

Skills reference this file instead of hardcoding tool names:
```markdown
Consult `references/tool-manifest.md` for available MCP tools in this phase.
```

#### 5.3 Skill-Aware SubagentStart Hook

The `SubagentStart` hook (already designed in progressive-disclosure-hooks §2.4) currently injects phase-specific tool guidance. Extend it to also read the active skill's frontmatter:

```typescript
// In cli.ts subagent-context command
const skillMeta = readSkillFrontmatter(activeSkillPath);
const phaseTools = getPhaseTools(currentPhase);
const guidance = `
Your role: ${skillMeta.description}
Phase: ${currentPhase}
Available tools:
${formatToolList(phaseTools)}
`;
process.stdout.write(guidance);
```

This gives subagents both tool access information AND skill context, reducing the prompt engineering needed in delegation templates.

---

### 6. Validation Scripts (Phases 2-5 Complete)

**Status:** Phases 2-5 completed. 24 validation scripts implemented across 8 skill categories, following the guide's recommendation to use code over language instructions for critical checks. All scripts follow a consistent pattern: `set -euo pipefail`, exit codes (0=pass, 1=fail, 2=usage), markdown output. Each has a co-located `.test.sh` integration test.

**Implemented scripts by category:**

| Category | Scripts | Status |
|----------|---------|--------|
| **Synthesis** | `pre-synthesis-check.sh`, `reconstruct-stack.sh`, `check-coderabbit.sh` | ✓ Phase 2 |
| **Delegation** | `setup-worktree.sh`, `post-delegation-check.sh`, `extract-fix-tasks.sh`, `needs-schema-sync.sh` | ✓ Phase 3 |
| **Git Worktrees** | `verify-worktree.sh`, `verify-worktree-baseline.sh` | ✓ Phase 3 |
| **Quality Review** | `review-verdict.sh`, `static-analysis-gate.sh`, `security-scan.sh` | ✓ Phase 4 |
| **Planning** | `spec-coverage-check.sh`, `verify-plan-coverage.sh`, `generate-traceability.sh`, `check-tdd-compliance.sh`, `check-coverage-thresholds.sh` | ✓ Phase 4 |
| **Refactor** | `assess-refactor-scope.sh`, `check-polish-scope.sh`, `validate-refactor.sh`, `verify-doc-links.sh` | ✓ Phase 5 |
| **Debug** | `investigation-timer.sh`, `select-debug-track.sh`, `debug-review-gate.sh` | ✓ Phase 5 |
| **Misc** | `verify-ideate-artifacts.sh`, `reconcile-state.sh`, `validate-dotnet-standards.sh` | ✓ Phase 5 |

**Integration test coverage:** 7 test files verify that each SKILL.md properly references its validation scripts and documents exit code routing:
- `validate-synthesis-skill.test.sh`
- `validate-delegation-skill.test.sh`
- `validate-worktree-skill.test.sh`
- `validate-quality-review-skill.test.sh`
- `validate-planning-skill.test.sh`
- `validate-refactor-skill.test.sh`
- `validate-debug-skill.test.sh`
- `validate-misc-skills.test.sh` (covers brainstorming, workflow-state, dotnet-standards)

These complement the quality gate hooks from the progressive-disclosure-hooks design — hooks enforce at the MCP tool boundary, scripts validate within the skill workflow.

---

## Integration Points

### With Progressive Disclosure & Hooks Design

| Hook/Component | Content Layer Integration |
|---|---|
| Tool Registry | Generates `mcp-tool-guidance.md` and per-skill `tool-manifest.md` |
| `SubagentStart` hook | Reads skill frontmatter for context injection |
| Quality gate hooks | Complemented by per-skill validation scripts |
| CLI entry point | Gains `generate-docs` command for content generation |

### With SDLC Telemetry Design

| Component | Content Layer Integration |
|---|---|
| `_perf` field | Skills can reference token costs in troubleshooting ("If responses are large, use `fields` projection") |
| Usage hints | Generated tool manifests include optimization hints |
| Benchmark baselines | Per-skill token budgets can be verified against telemetry |

### With Installer

The installer (`src/install.ts`) requires no changes for Phase 1 — YAML frontmatter is valid Markdown and doesn't affect symlink-based installation. Phase 2 requires the build step to run before installation (generate docs from registry).

### With Existing Patterns Preserved

- Command → skill reference pattern (`@skills/<name>/SKILL.md`) unchanged
- Rules loading pattern unchanged
- Shared prompts library unchanged
- Test scripts (`.test.sh`) extended, not replaced

---

## Testing Strategy

### Phase 1 Tests (Content Changes)

**Structural validation** (extend existing `.test.sh` scripts):
- Every SKILL.md has valid YAML frontmatter with required fields (`name`, `description`)
- `name` matches folder name in kebab-case
- `description` is ≤1,024 characters with no XML angle brackets
- SKILL.md body is ≤2,000 words
- Each reference file is ≤1,000 words
- All `references/` files referenced in SKILL.md actually exist

**Manual verification:**
- Invoke each slash command, verify skill loads correctly with frontmatter present
- Verify split skills (quality-review, implementation-planning) still produce correct outputs
- Check that references are read at appropriate points, not loaded eagerly

### Phase 2 Tests (Hook Integration)

**Generated content:**
- Build script produces valid Markdown for `mcp-tool-guidance.md`
- Generated tool manifests match registry's phase mappings
- No stale references to old tool names in generated output

**Hook integration:**
- `SubagentStart` hook reads frontmatter and produces correct context
- Validation scripts exit with correct codes for pass/fail scenarios

---

## Migration Plan

### Phase 1 (No Dependencies)

1. Add YAML frontmatter to all 12 SKILL.md files
2. Split quality-review into SKILL.md + references/
3. Split implementation-planning into SKILL.md + references/
4. Add troubleshooting sections to delegation, synthesis, debug, workflow-state
5. Update `.test.sh` scripts for frontmatter validation
6. Update CLAUDE.md to document frontmatter convention

### Phase 2 (After Hooks Design Ships)

7. Add `generate-docs` command to CLI entry point
8. Generate `mcp-tool-guidance.md` from tool registry
9. Generate per-skill `tool-manifest.md` files
10. Extend `SubagentStart` hook for skill-aware context
11. Add validation scripts to delegation and synthesis
12. Update skills to reference generated manifests instead of hardcoded tool names

---

## Open Questions

1. **Frontmatter and Claude Code behavior** — Does Claude Code read YAML frontmatter from `~/.claude/skills/*/SKILL.md` today? If so, the `description` field may affect auto-triggering immediately. If not, frontmatter is purely metadata until Anthropic adds support. **Action:** Test empirically before shipping.

2. **Phase affinity in frontmatter** — The `metadata.phase-affinity` field links skills to workflow phases. Should this be a single phase or an array? Skills like workflow-state span multiple phases. **Recommendation:** Array of phases.

3. **Generated content git tracking** — Should generated files (`mcp-tool-guidance.md`, `tool-manifest.md`) be gitignored or committed? Committed means they're visible in PRs; gitignored means they're build artifacts. **Recommendation:** Committed, with a `<!-- Generated from tool registry. Do not edit. -->` header.

4. **Shared prompts fate** — The `skills/shared/prompts/` directory (498 words) contains reusable templates. Should these gain frontmatter too, or remain as-is? **Recommendation:** Remain as-is — they're not skills, they're shared resources.

5. **allowed-tools field** — The Anthropic guide supports `allowed-tools` in frontmatter to restrict tool access. Should we adopt this for our skills? It would be informational today (Claude Code may not enforce it) but could become meaningful. **Recommendation:** Add to Phase 2 when the tool registry can validate against it.
