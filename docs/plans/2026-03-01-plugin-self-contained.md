# Implementation Plan: Plugin Self-Contained Script Resolution

## Source Design
Refactor brief in workflow state `refactor-plugin-self-contained`. No formal design doc — this is a refactor driven by GitHub issue #942 and plugin convention audit.

## Scope
**Target:** Full brief — all three layers (MCP server, skills, rules progressive disclosure)
**Excluded:** Companion installer changes (remains as optional enhancement for power users)

## Summary
- Total tasks: 7
- Parallel groups: 2
- Estimated test count: 14
- Brief coverage: 5 of 5 goals covered
- Rules migration: 7 rule files → `skills/*/references/` via progressive disclosure

## Spec Traceability

| Brief Goal | Task(s) | Status |
|-----------|---------|--------|
| G1: MCP orchestrate resolves scripts from plugin root | T1, T2 | Planned |
| G2: Skills reference orchestrate actions, not bash paths | T3, T4 | Planned |
| G3: Rules progressive disclosure | T5, T7 | Planned |
| G4: Plugin works from marketplace install | T1-T7 (all) | Planned |
| G5: No regression for companion installer users | T2 (fallback) | Planned |

## Task Breakdown

### Task 1: Add EXARCHOS_PLUGIN_ROOT env var to plugin.json

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `PluginJson_McpServerEnv_IncludesExarchosPluginRoot`
   - File: `src/plugin-validation.test.ts`
   - Assert: plugin.json `mcpServers.exarchos.env` contains `EXARCHOS_PLUGIN_ROOT` key with value `${CLAUDE_PLUGIN_ROOT}`
   - Expected failure: env object lacks `EXARCHOS_PLUGIN_ROOT`
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add env var to plugin.json
   - File: `.claude-plugin/plugin.json`
   - Add `"EXARCHOS_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}"` to `mcpServers.exarchos.env`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] No refactoring needed — simple config addition

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after adding env var
- [ ] No extra changes beyond plugin.json env addition

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: Update resolveScript() to use EXARCHOS_PLUGIN_ROOT with fallback

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `resolveScript_WithPluginRoot_ResolvesFromPluginScripts`
   - File: `servers/exarchos-mcp/src/utils/paths.test.ts`
   - Mock `process.env.EXARCHOS_PLUGIN_ROOT` to `/plugins/cache/exarchos`
   - Assert: `resolveScript('verify-doc-links.sh')` returns `/plugins/cache/exarchos/scripts/verify-doc-links.sh`
   - Expected failure: resolveScript ignores env var, returns `~/.claude/scripts/` path
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST FAIL

2. [RED] Write test: `resolveScript_WithoutPluginRoot_FallsBackToClaudeHome`
   - File: `servers/exarchos-mcp/src/utils/paths.test.ts`
   - Delete `process.env.EXARCHOS_PLUGIN_ROOT` (unset)
   - Mock `os.homedir()` to `/home/testuser`
   - Assert: `resolveScript('foo.sh')` returns `/home/testuser/.claude/scripts/foo.sh`
   - Expected failure: test should PASS (current behavior) — verifying backward compat
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST PASS (compat verification)

3. [GREEN] Update `resolveScript()` to check env var first
   - File: `servers/exarchos-mcp/src/utils/paths.ts`
   - Check `process.env.EXARCHOS_PLUGIN_ROOT` — if set, return `path.join(envVar, 'scripts', scriptName)`
   - Fallback: existing behavior (`path.join(os.homedir(), '.claude', 'scripts', scriptName)`)
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST PASS

4. [REFACTOR] Update existing test to explicitly unset env var
   - Ensure pre-existing `resolveScript` test still passes
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Plugin-root path used when env var is set
- [ ] Fallback to ~/.claude/scripts/ when env var is unset
- [ ] No change to existing orchestrate files (they already call resolveScript)

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**Dependencies:** Task 1
**Parallelizable:** No (depends on Task 1 for env var context)

---

### Task 3: Create run_script orchestrate action

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `RunScript_ValidScript_ReturnsStructuredResult`
   - File: `servers/exarchos-mcp/src/orchestrate/run-script.test.ts`
   - Call handler with `{ script: "verify-doc-links.sh", args: ["--docs-dir", "docs/"] }`
   - Mock `execFileSync` to return stdout "All links valid"
   - Assert: result contains `{ passed: true, exitCode: 0, stdout: "All links valid" }`
   - Expected failure: handler doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST FAIL

2. [RED] Write test: `RunScript_ScriptFails_ReturnsFailure`
   - File: `servers/exarchos-mcp/src/orchestrate/run-script.test.ts`
   - Mock `execFileSync` to throw with exit code 1 and stderr "2 broken links found"
   - Assert: result contains `{ passed: false, exitCode: 1, stderr: "2 broken links found" }`
   - Expected failure: handler doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST FAIL

3. [RED] Write test: `RunScript_PathTraversal_RejectsUnsafePaths`
   - File: `servers/exarchos-mcp/src/orchestrate/run-script.test.ts`
   - Call handler with `{ script: "../../../etc/passwd" }`
   - Assert: throws or returns error (rejects path traversal)
   - Expected failure: handler doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST FAIL

4. [RED] Write test: `RunScript_UsesResolveScript_ForPathResolution`
   - File: `servers/exarchos-mcp/src/orchestrate/run-script.test.ts`
   - Spy on `resolveScript`
   - Assert: handler calls `resolveScript` with the script name
   - Expected failure: handler doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST FAIL

5. [GREEN] Implement run_script handler
   - File: `servers/exarchos-mcp/src/orchestrate/run-script.ts`
   - Parse input: `script` (required, string), `args` (optional, string[])
   - Validate: reject scripts with path traversal (`..`, absolute paths)
   - Resolve path via `resolveScript(script)`
   - Execute via `execFileSync(path, args, { encoding: 'utf-8', timeout: 30000 })`
   - Return: `{ passed: exitCode === 0, exitCode, stdout, stderr, script }`
   - Handle errors: capture exit code and stderr from thrown errors
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST PASS

6. [GREEN] Register in orchestrate composite
   - File: `servers/exarchos-mcp/src/orchestrate/composite.ts`
   - Add `run_script` action to the handler registry
   - Add to Zod action enum
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST PASS

7. [REFACTOR] Extract input validation to shared utility if pattern is reused
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Valid scripts execute and return structured results
- [ ] Failed scripts return exit code and stderr
- [ ] Path traversal attacks are rejected
- [ ] Script path resolved via resolveScript (env var aware)
- [ ] Action registered in composite handler

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**Dependencies:** Task 2
**Parallelizable:** No (depends on Task 2 for resolveScript)

---

### Task 4: Update skill markdown — replace bash script references with orchestrate calls

**Phase:** Content change (no production code — markdown only)

**Changes:** Replace all `~/.claude/scripts/<name>.sh` bash references in skill markdown with appropriate orchestrate calls.

**Pattern A — Scripts with existing specific orchestrate actions:**

| Script | Orchestrate Action | Skills Affected |
|--------|-------------------|-----------------|
| `check-tdd-compliance.sh` | `check_tdd_compliance` | spec-review, quality-review, implementation-planning |
| `verify-ideate-artifacts.sh` | `check_design_completeness` | brainstorming |
| `verify-plan-coverage.sh` | `check_plan_coverage` | implementation-planning (worked-example) |

**Pattern B — Utility scripts → generic `run_script` action:**

All other scripts use:
```typescript
exarchos_orchestrate({
  action: "run_script",
  script: "<script-name>.sh",
  args: ["--flag", "<value>"]
})
```

**Files to update (24):**

| Skill | Files | Scripts Referenced |
|-------|-------|--------------------|
| brainstorming | `SKILL.md` | verify-ideate-artifacts.sh |
| spec-review | `SKILL.md`, `references/worked-example.md`, `references/review-checklist.md` | check-tdd-compliance.sh, review-diff.sh |
| quality-review | `SKILL.md` | check-tdd-compliance.sh, review-diff.sh, verify-review-triage.sh |
| implementation-planning | `SKILL.md`, `references/worked-example.md` | check-tdd-compliance.sh, generate-traceability.sh, verify-plan-coverage.sh, spec-coverage-check.sh, check-coverage-thresholds.sh |
| synthesis | `SKILL.md`, `references/synthesis-steps.md`, `references/github-native-stacking.md` | validate-pr-body.sh, pre-synthesis-check.sh, reconstruct-stack.sh, check-coderabbit.sh, validate-pr-stack.sh |
| delegation | `references/workflow-steps.md`, `references/fix-mode.md`, `references/worktree-enforcement.md` | post-delegation-check.sh, needs-schema-sync.sh, extract-fix-tasks.sh, setup-worktree.sh |
| refactor | `references/polish-track.md`, `references/overhaul-track.md`, `references/doc-update-checklist.md`, `references/explore-checklist.md` | assess-refactor-scope.sh, check-polish-scope.sh, validate-refactor.sh, verify-doc-links.sh |
| debug | `references/hotfix-track.md`, `references/thorough-track.md` | select-debug-track.sh, investigation-timer.sh, debug-review-gate.sh |
| workflow-state | `SKILL.md` | reconcile-state.sh |
| git-worktrees | `SKILL.md` | verify-worktree-baseline.sh, verify-worktree.sh |
| dotnet-standards | `SKILL.md` | validate-dotnet-standards.sh |
| shared | `prompts/context-reading.md` | extract-task.sh, review-diff.sh |
| shepherd | `references/fix-strategies.md` | reconstruct-stack.sh |

**Verification:**
- [ ] No remaining `~/.claude/scripts/` references in any skill markdown
- [ ] All script invocations use either specific orchestrate actions or `run_script`
- [ ] Exit code interpretation preserved (passed: true/false maps to original exit 0/1)

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }` (content-only)

**Dependencies:** Task 3 (run_script action must exist)
**Parallelizable:** Yes (independent of Task 5)

---

### Task 5: Session-start safety rules via progressive disclosure

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `SessionStart_IncludesSafetyRulesInContextDocument`
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.test.ts`
   - Set `process.env.EXARCHOS_PLUGIN_ROOT` to a temp dir containing `rules/rm-safety.md`
   - Assert: result `contextDocument` contains "rm Safety" content
   - Expected failure: session-start doesn't read rules
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST FAIL

2. [RED] Write test: `SessionStart_GracefulWhenNoRulesDirectory`
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.test.ts`
   - Set `process.env.EXARCHOS_PLUGIN_ROOT` to a temp dir WITHOUT rules/
   - Assert: result `contextDocument` is empty or unchanged (no crash)
   - Expected failure: session-start crashes on missing dir
   - Run: `cd servers/exarchos-mcp && npm run test:run` - SHOULD PASS (graceful)

3. [GREEN] Update session-start handler to read safety rules from plugin root
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.ts`
   - Read `process.env.EXARCHOS_PLUGIN_ROOT`
   - If set, look for `rules/rm-safety.md` at plugin root
   - Append safety rule content to contextDocument (minimal — L1 progressive disclosure)
   - Graceful fallback if rules/ doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST PASS

4. [GREEN] Update hooks.json to pass plugin root to session-start command
   - File: `hooks/hooks.json`
   - Add `--plugin-root "${CLAUDE_PLUGIN_ROOT}"` to SessionStart hook command arg
   - Update CLI router to parse `--plugin-root` and set as env var
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST PASS

5. [REFACTOR] Extract rule reading to a shared utility if reusable
   - Run: `cd servers/exarchos-mcp && npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Safety rules (rm-safety.md) appear in session-start contextDocument
- [ ] No crash when rules/ directory is missing
- [ ] Plugin root passed correctly via hook command arg

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**Dependencies:** Task 1 (needs EXARCHOS_PLUGIN_ROOT pattern)
**Parallelizable:** Yes (independent of Tasks 3-4)

---

### Task 6: Documentation updates

**Phase:** Content change (no production code — markdown only)

**Changes:**
1. Update `CLAUDE.md`:
   - Add section noting scripts resolve from plugin root via `EXARCHOS_PLUGIN_ROOT`
   - Note rules follow progressive disclosure: safety in session-start, domain rules in skills
   - Remove references to `~/.claude/scripts/` as the primary path

2. Update `docs/designs/2026-02-17-distribution-strategy.md`:
   - Document self-contained plugin architecture
   - Note `run_script` orchestrate action for utility scripts
   - Update script resolution flow diagram

**Verification:**
- [ ] CLAUDE.md reflects new architecture
- [ ] Distribution strategy doc updated

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }` (content-only)

**Dependencies:** Tasks 1-5, 7 (all implementation complete)
**Parallelizable:** No (final task)

---

### Task 7: Migrate rules to skills/*/references/ via progressive disclosure

**Phase:** Content change (no production code — file moves + cross-references)

**Rules Migration Map:**

| Rule File | Destination Skill | Target Path |
|-----------|------------------|-------------|
| `rules/rm-safety.md` | shared | `skills/shared/references/rm-safety.md` |
| `rules/coding-standards.md` | shared | `skills/shared/references/coding-standards.md` |
| `rules/tdd.md` | shared | `skills/shared/references/tdd.md` |
| `rules/mcp-tool-guidance.md` | shared | `skills/shared/references/mcp-tool-guidance.md` |
| `rules/skill-path-resolution.md` | shared | `skills/shared/references/skill-path-resolution.md` |
| `rules/telemetry-awareness.md` | shared | `skills/shared/references/telemetry-awareness.md` |
| `rules/pr-descriptions.md` | synthesis | `skills/synthesis/references/pr-descriptions.md` |

**Progressive Disclosure Levels:**
- **L1 (session-start):** `rm-safety.md` — injected via session-start contextDocument (Task 5)
- **L2 (skill body):** Skills reference their rules via `@skills/<name>/references/<rule>.md` or inline instructions
- **L3 (on-demand):** Full rule content in `references/` directory — loaded when skill is invoked

**Steps:**
1. Copy each rule file to its target `skills/*/references/` path
2. Update `plugin.json` skills entries if needed (references are auto-included with skill)
3. Verify skill SKILL.md files already reference these conventions (most do via `@skills/` pattern)
4. Remove `rules/` directory entries from plugin distribution (rules no longer standalone)
5. Update CLAUDE.md to note rules are distributed via skills, not standalone directory

**Note on `rules/` directory retention:** The `rules/` directory at the plugin root is still loaded by Claude Code's plugin system as global rules. Files here are auto-injected into every conversation. After migration:
- `rm-safety.md` stays in `rules/` (L1 — always loaded) AND copies to `skills/shared/references/`
- All other rules move to `skills/*/references/` only — they become L2/L3 progressive disclosure
- This reduces context overhead: 6 rules no longer auto-injected into every conversation

**Verification:**
- [ ] All 7 rule files have a copy in appropriate `skills/*/references/` directory
- [ ] Only `rm-safety.md` remains in `rules/` (L1 safety — always loaded)
- [ ] 6 non-safety rules removed from `rules/` directory
- [ ] Skills that reference these rules can still resolve them via `@skills/` pattern
- [ ] No broken cross-references in skill markdown

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }` (content-only)

**Dependencies:** Task 4 (skill markdown updates complete — avoid merge conflicts)
**Parallelizable:** Yes (independent of Task 5)

---

## Parallelization Strategy

```
Task 1: plugin.json env var (foundation)
    │
    ├─── Task 2: resolveScript update
    │        │
    │        └─── Task 3: run_script orchestrate action
    │                 │
    │                 └─── Task 4: Skill markdown updates ──┐
    │                              │                         │
    │                              └─── Task 7: Rules ──────┤
    │                                   migration            │
    └─── Task 5: Session-start safety rules ────────────────┤
                                                             │
                                                    Task 6: Documentation
```

**Parallel groups:**
- **Group A:** Task 5 (session-start safety rules) — runs after T1
- **Group B:** Task 7 (rules migration) — runs after T4
- Groups A and B run in parallel

**Sequential chains:**
- T1 → T2 → T3 → T4 → T7
- T1 → T5
- T5 + T7 → T6

## Deferred Items

| Item | Rationale |
|------|-----------|
| Companion installer refactoring | Out of scope per brief — remains as optional enhancement |
| New plugin.json keys for scripts/rules | No Anthropic API support — would require upstream changes |
| Per-skill scripts/ directories | Future optimization — scripts stay centralized for now |
| Full rule content in session-start | Violates D3 context economy — safety-only is sufficient |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `resolveScript()` uses EXARCHOS_PLUGIN_ROOT with fallback
- [ ] `run_script` orchestrate action works end-to-end
- [ ] No `~/.claude/scripts/` references remain in skill markdown
- [ ] Safety rules appear in session-start output
- [ ] Rules migrated to `skills/*/references/` (only `rm-safety.md` in `rules/`)
- [ ] Documentation updated
- [ ] Ready for review
