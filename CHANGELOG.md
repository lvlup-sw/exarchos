# Changelog

All notable changes to Exarchos are documented in this file. Organized by semver release.

## [Unreleased]

## [2.6.0] - 2026-04-12

### Features
- `oneshot` workflow type with pure event-derived choice state (plan → implementing → {completed | synthesize}) (#1010)
- `prune_stale_workflows` orchestrate action for bulk pipeline hygiene (dry-run default, DI-testable safeguards, `workflow.pruned` audit event) (#1010)
- `request_synthesize` + `finalize_oneshot` orchestrate actions for oneshot choice state (#1010)
- `synthesize.requested` + `workflow.pruned` event types (#1010)
- `synthesisPolicy` optional init arg (`always` / `never` / `on-request`) for oneshot workflows, persisted in `workflow.started` event (#1010)
- `/exarchos:oneshot` and `/exarchos:prune` slash command skills with `references/` subdirectories (#1010)
- `OneshotPhaseSchema` enum for type-safe phase validation (#1010)
- Skill layer extensions threading oneshot through workflow-state, cleanup, shepherd, delegation skills (#1010)
- HSM topology introspection via `exarchos_workflow describe` with `topology` parameter (#979)
- Event emission catalog via `exarchos_event describe` with `emissionGuide` parameter (#979)
- CLI `topology [type]` and `emissions` commands for plugin-free introspection (#979)
- Cross-runtime skill rendering pipeline: single-source `skills-src/` → 6 runtime variants under `skills/<runtime>/` (Claude Code, Codex, Copilot CLI, Cursor, OpenCode, generic LCD fallback) (#1071)
- `exarchos install-skills [--agent <runtime>]` CLI with runtime auto-detection from PATH and environment variables (#1071)
- Cursor sequential-fallback mode for runtimes without an in-session subagent primitive (#1071)
- Build pipeline: `npm run build:skills` orchestrator with placeholder substitution, reference copying, override detection, and stale-source cleanup (#1071)

### Bug Fixes
- `handleList` now returns `_checkpoint` so `prune_stale_workflows` threshold filter works in production (caught by integration test; unit tests missed it due to stubbing) (#1010)
- `INITIAL_PHASE` now includes `oneshot → plan` so ES v2 rematerialized oneshot workflows start in the correct phase (#1010)
- `handlePruneStaleWorkflows` no longer double-accounts on event-append failure (caught by CodeRabbit review) (#1010)
- Removed `augmentWithSemanticScore` Phase 4 deprecation stubs and `basileusConnected` parameter plumbing from review triage (#1077)

### Hardening
- Fail-closed validation on malformed `handleList` entries (malformed entries bucketed separately, never reach `candidates` or `pruned`) (#1010)
- Input validation on `thresholdMinutes` (positive integer) and `now` (valid ISO) before batch runs (#1010)
- `oneshotPlanSet` guard tightened to require non-empty `artifacts.plan` (`planSummary` alone is insufficient, whitespace trimmed) (#1010)
- `request_synthesize` runtime phase guard rejects terminal phases (#1010)

### Internal
- `TERMINAL_PHASES` extracted to shared `workflow/terminal-phases.ts` (was duplicated) (#1010)
- `handlePruneStaleWorkflows` decomposed via `prunePruneCandidate` helper (~110 → ~60 lines) (#1010)
- New `adaptArgsWithStateDirAndEventStore` adapter in composite router for handlers needing both `stateDir` and `eventStore` (#1010)

### Documentation
- Comprehensive documentation coverage pass for v2.6.0: new oneshot-workflow guide, updated reference/learn/architecture pages
- Placeholder vocabulary reference (`docs/references/placeholder-vocabulary.md`) and runtime notes (`docs/references/runtime-notes.md`) (#1071)
- Skill authoring guide (`docs/skills-authoring.md`) covering edit workflow, vocabulary, adding runtimes, and CI checks (#1071)

### Tooling
- `npm run skills:guard` CI check — rebuilds skills in-place and fails on `git diff` to catch drift from forgotten rebuilds or direct edits to generated files (#1071)
- Per-runtime snapshot tests at `test/migration/snapshots.test.ts` — 78 baselines pinning every generated SKILL.md (#1071)
- Tier-1 runtime smoke harness at `test/smoke/runtime-smoke.test.ts` — validates per-runtime substitution correctness (Claude unconditional, others gated behind `SMOKE=1`) (#1071)

## [2.5.0] - 2026-03-09

**First public release.** Lazy schema loading, runbook protocol, typed agent specs, and a documentation site — reducing tool registration overhead by 83% while making workflows self-describing.

### Features
- Slim registration mode cutting MCP tool description payload from ~3,045 to ~500 tokens (#972)
- `describe` action on all 4 visible composite tools for on-demand schema loading (#972)
- Runbook protocol: 5 machine-readable orchestration sequences with runtime schema resolution (#972)
- Gate metadata with blocking/advisory classification and convergence dimension (#972)
- Native subagent integration: agent spec registry with `agent_spec()` MCP action and template variable interpolation (#973)
- Resume-aware fixer flow with `agentId`/`agentResumed`/`lastExitReason` on TaskSchema, `subagent-stop` hook, `TASK_FIX` runbook (#973)
- `nativeIsolation` parameter on `prepare_delegation` to skip worktree blockers for native agents (#973)
- Event type schema discovery via `describe(eventTypes)` on `exarchos_event` (#976)
- `mcpServers` allowlist on agent specs restricting subagent MCP access (#976)
- Model inheritance (`'inherit'`) replacing hardcoded `'opus'` on agent specs (#976)

### Bug Fixes
- Activate PID lock and sidecar fallback to prevent concurrent event store corruption (#971)
- Coerce stringified arrays in `fields` parameter
- Restore missing `overhaul-plan-review` transition in docs (#978)
- Add `describe` fallback to runbook annotations, clarify platform tiers
- Sync MCP server version, remove build-time agent generation
- Remove invalid `agents` field from plugin manifest

### Documentation
- VitePress documentation site with 38 pages across 5 sections (#974)
- README refresh for 2.5.0 — typed agents, runbooks, lazy schema

## [2.4.4] - 2026-03-08

### Features
- Open issues consolidation (#968, #952, #350) (#970)

### Bug Fixes
- Use gh api for backfill releases to avoid workflow scope requirement
- Fix release and project-automation workflow failures

### Documentation
- Refactor README for accuracy, add architecture section, hide sync tool

## [2.4.3] - 2026-03-07

### Bug Fixes
- Accept both error codes in concurrent init race test
- Support flexible design/plan formats in validation scripts

### CI
- Add automated release workflow and backfill script

### Chores
- Release hardening — sensitive doc removal, governance, CI guards (#969)

## [2.4.2] - 2026-03-06

### Bug Fixes
- Support flexible design/plan formats in validation scripts
- Redistribute diagram layout after flywheel removal
- Address dogfood findings, update diagram
- Restore skill description guardrails and add workflowType to brainstorming

## [2.4.0] - 2026-03-04

### Features
- Schema-driven CLI surface with config-driven custom workflows (#963)
- New local skills for project-level customization
- README updates and VHS terminal recordings

### Bug Fixes
- Unified binary with explicit `mcp` subcommand
- Integrate hook CLI commands into unified binary

### Refactoring
- Remove project-specific sync-schemas skill
- Reduce plugin token footprint by 57%

### Chores
- Prune plugins and claude/memory files

## [2.3.8] - 2026-03-02

### Features
- Add visual assets for GA release

### Bug Fixes
- Update subagent-context test counts for 5 new orchestrate actions, overhaul README
- Add direct-push completion path for debug hotfixes and tag universal transitions (#957, #958)

### Documentation
- Refresh community-facing README references
- Revise visual asset specs for GA release

## [2.3.7] - 2026-03-02

### Bug Fixes
- Add 5 missing orchestrate actions to registry, add sync test

## [2.3.6] - 2026-03-02

### Features
- Add event emission source registry and boundary data validation (#955)

### Bug Fixes
- Remove stale @planned annotation from team.disbanded (#954)

## [2.3.5] - 2026-03-02

### Bug Fixes
- Remove deprecated `/resume` command, replace with `/rehydrate`

## [2.3.4] - 2026-03-02

### Bug Fixes
- Array-of-objects upsert in deepMerge, harden gate check and review projection

## [2.3.3] - 2026-03-02

### Bug Fixes
- Align phase names with HSM definitions, add phase-name validation

## [2.3.2] - 2026-03-02

### Bug Fixes
- Sync plugin manifest versions to 2.3.1, add version:sync to rebuild
- Sync backend version counter with state._version on seed (#948)

## [2.3.1] - 2026-03-01

### Refactoring
- Namespace all skill references with `exarchos:` prefix

## [2.3.0] - 2026-03-01

### Bug Fixes
- Sequence corruption auto-repair, guard diagnostics, shepherd DX (#947)

### Refactoring
- Make plugin self-contained for marketplace install (#946)

## [2.2.2] - 2026-03-01

### Bug Fixes
- Expand tilde in WORKFLOW_STATE_DIR, remove stale artifacts
- Stale .seq cross-validation, manual evidence gate bypass, completed status alias (#939, #940, #941)

### Documentation
- README restructure, metadata refresh, and copy cleanup

## [2.2.1] - 2026-03-01

### Bug Fixes
- Audit remediation — bound arrays, extract skill body, add overhaul-plan-review (#938)

## [2.2.0] - 2026-03-01

### Features
- Event-driven skill architecture with CQRS readiness projections (#930)
- Add judge calibration pipeline and gold standard dataset
- Activate verification flywheel — remediation events and quality hints
- Add eval-backed feature audit prompt and regression dataset

### Bug Fixes
- Address review feedback and eval regression check (#932)
- Detect default branch dynamically in prepare-synthesis (#934)

### Refactoring
- Remove Graphite integration, adopt GitHub-native PR stacking (#933)
- Consolidate gate-telemetry integration, enforce D2, harden execFileSync

## [2.1.2] - 2026-02-28

### Bug Fixes
- Recognize deferred sections in plan coverage verification (#913) (#927)

## [2.1.1] - 2026-02-27

This was a large release spanning the v2.1.0 milestone, covering session provenance, phase playbooks, verification flywheel closure, and eval framework expansion.

### Features
- Add session provenance — event hardening, types, manifest, transcript parser, lifecycle (#896)
- Add session provenance query layer — projection, view integration (#903)
- Close verification flywheel loop — calibration, capture, signal wiring, integration (#914)
- Add phase playbook module with all workflow entries (#846)
- Add behavioral guidance section to context assembly (#856)
- Add behavioralGuidance field to SessionStartResult (#858)
- Add playbook virtual field to exarchos_workflow get (#860)
- Add `/rehydrate` command and deprecate `/resume` (#861)
- Add `/tag` command and document opt-in tracking philosophy
- Add validate-phase-coverage.sh meta-validation script (#852)
- Wire 4 validation scripts into skills (#845)
- Add compaction-behavioral eval dataset and update reliability suite (#849)
- Add cache hit/miss tracking and thrashing detection to ViewMaterializer (#917)
- Split Zod validation from event construction for hot-path optimization (#918)
- Enforce PR description template with CI validation and configurable overrides (#907) (#909)
- Add write-through .state.json backup and preserve files during migration (#806) (#906)
- Add LLM rubric assertion and dataset to brainstorming eval suite (#792)
- Add quality-aware dataset and llm-similarity assertion to delegation eval suite (#797)
- Add LLM rubric assertion and dataset to implementation-planning eval suite (#795)
- Add LLM rubric assertion and dataset to debug eval suite (#796)
- Add quality_correlation view joining CodeQuality and EvalResults by skill (#800)
- Remove stale @planned annotations and add shepherd event schemas (#781)

### Bug Fixes
- Add iteration limits, spec re-verification, and data handoff protocol to skills (#919)
- Extract gate event emission and add debug/refactor disambiguation (#920)
- Harden PR validation script and CI workflow (#911)
- Update SERVER_VERSION constant and test expectations to 1.1.0 (#912)
- Add max-length constraints to unbounded event payload fields (#916)
- Update pre-synthesis-check.sh for polish track and debug HSM phases (#851)
- Update reconcile-state.sh valid phases to match HSM (#850)
- Update refactor eval datasets to use correct HSM phase names (#848)
- Await async property test, validate stateFile paths, fix checkpoint loop break (#863)
- Populate _events for guard evaluation and skip team guard in subagent mode (#788)

### Refactoring
- Harden event store idempotency and sequence invariants (#822)
- Add HSM transitions for escalation, revision limits, and hotfix (#823)
- Add schema safety constraints and synthesize retry (#824)
- Clean up content layer documentation and scripts (#825)
- Add benchmark infrastructure and always-on CI gate (#826)

### Tests
- Add HSM-playbook coverage and content adequacy property tests (#847)
- Add discovery and parse tests for new eval suites (#785)

## [2.0.8] - 2026-02-23

### Bug Fixes
- Use INSERT OR IGNORE for event hydration to handle duplicate sequences

## [2.0.7] - 2026-02-23

### Features
- Complete eval framework Phase 3 (#773)
- Foundation cleanup and orphan event wiring (#774)
- Add eval suites for brainstorming, planning, refactor, and debug skills (#784)
- Add LLM rubric assertion and dataset to debug eval suite (#796)
- Add LLM rubric assertion and dataset to refactor eval suite (#794)
- Wire regression detector into code quality view + add quality-check CLI (#798)
- Add gate.executed event emission instructions to shepherd, synthesis, and delegation skills (#793)

### Bug Fixes
- Prevent property collision in captureTrace spread ordering
- Initialize explore field in state to prevent guard rejection (#775) (#779)
- Hydrate _events from event store before guard evaluation
- Bundle better-sqlite3 native binary + fix versionless state migration
- Update rebuild

### Refactoring
- Use typed TeamTaskAssignedData schema in CQRS view (#780)

### Tests
- Add E2E round-trip and crash recovery tests for storage layer
- Add lifecycle SQLite + hydration PBT tests
- Add storage E2E validation suite (#772)

### CI
- Switch all workflows to self-hosted runners
- Install gh CLI on self-hosted runners for review gate and project automation

---

## Legacy Changelog (pre-semver)

## 2026-02-09

### Removed Jules MCP Integration

Jules (Google's autonomous coding agent) integration has been removed. It was never used in production and is superseded by the Task tool subagent pattern.

**Removed:**
- `plugins/jules/` — entire MCP server and plugin directory
- `julesSessions` field from workflow state schema and initial state
- `julesSessionId` and `jules` assignee from JSON schema
- Jules permissions, labels, and auto-triage scope detection
- Jules references from delegation skill, delegate command, and documentation

## 2026-01-06

### Workflow Phase Restructuring

Added explicit integration phase and orchestrator constraints:

**New `/integrate` Phase:**
- Merges worktree branches in dependency order
- Runs combined test suite after each merge
- Reports pass/fail with specific failure details
- Auto-chains to `/review` on success, `/delegate --fixes` on failure

**Orchestrator Constraints:**
- Orchestrator no longer writes implementation code
- All fixes delegated to subagents (fixer prompt template)
- Worktree enforcement prevents accidental main project modifications

**Review Updates:**
- Reviews now assess integrated diff (not per-worktree fragments)
- Full picture of combined code quality

**Synthesis Simplification:**
- Merge/test logic moved to `/integrate`
- `/synthesize` now just creates PR from integration branch

**Updated flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
            ^           (auto)   (auto)      (auto)      (auto)     (auto)           ^
          HUMAN                                                                    HUMAN
                                   ^                        |
                                   +---- --fixes -----------+
```

**Files added:**
- `rules/orchestrator-constraints.md`
- `skills/integration/SKILL.md`
- `skills/integration/references/integrator-prompt.md`
- `skills/delegation/references/fixer-prompt.md`
- 14 test scripts

**Files modified:**
- `skills/delegation/SKILL.md` (worktree enforcement + fix mode)
- `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md` (integrated diff)
- `skills/synthesis/SKILL.md` (simplified)
- `docs/schemas/workflow-state.schema.json` (integration object)

---

## 2026-01-04

### PR Feedback Loop & Direct Commits

Added support for human interaction with PRs:

**PR Review Feedback:**
- New `--pr-fixes` flag for `/delegate`
- Fetches PR comments via `gh api`
- Creates fix tasks from review feedback
- Loops back to merge confirmation after fixes

**Direct Commits:**
- Users can commit directly to integration branch
- Workflow syncs (`git pull`) before merge confirmation
- Documented in synthesize command and skill

**Updated flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
                                            ^                                       |
                                            +----------- --pr-fixes ----------------+
```

---

### Streamlined Auto-Chain Flow

Reduced confirmation prompts in the workflow pipeline:

**New flow:**
```
/ideate -> [CONFIRM] -> /plan -> /delegate -> /integrate -> /review -> /synthesize -> [CONFIRM] -> merge
            ^           (auto)   (auto)      (auto)      (auto)     (auto)           |
            +------------ ON BLOCKED ------------------------------------------------+
                          ON FAIL -> /delegate --fixes (auto)
```

**Changes:**
- `/plan` -> `/delegate`: Now auto-invokes (no confirmation)
- `/delegate` -> `/review`: Now auto-invokes (no confirmation)
- `/review` -> `/synthesize`: Now auto-invokes on PASS (no confirmation)
- `/synthesize` -> merge: Added confirmation before merging PR
- `/review`: Now dispatches to subagents (preserves orchestrator context)

**Files modified:**
- `commands/plan.md`, `commands/delegate.md`, `commands/review.md`, `commands/synthesize.md`
- `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md`
- `skills/implementation-planning/SKILL.md`, `skills/delegation/SKILL.md`

---

### Initial Global Configuration

- **Skills (7)**: brainstorming, implementation-planning, git-worktrees, delegation, spec-review, quality-review, synthesis
- **Commands (6)**: ideate, plan, delegate, review, synthesize, tdd
- **Rules (4)**: tdd-typescript, tdd-csharp, coding-standards-csharp, coding-standards-typescript
- **Plugins (1)**: jules (symlinked from workflow/jules-plugin)
- **Settings**: Global permissions for WebSearch, Jules API, GitHub

### Update Policy

Before updating global config:
1. Test changes locally in a project first
2. Validate with `/review` quality checks
3. Document changes in this file
4. Project-level `.claude/` overrides take precedence
