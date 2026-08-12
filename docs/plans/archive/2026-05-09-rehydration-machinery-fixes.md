# Rehydration-Machinery-Refactor: Review Fix Plan

**Source review**: 2026-05-09 review of `feature/rehydration-machinery-refactor` (origin tip `cc83d4e4`)
**Verdict**: NEEDS_FIXES (3 HIGH, 4 MEDIUM, 5 LOW)
**Branch**: continue on `feature/rehydration-machinery-refactor`

## Context

The 33-task refactor landed cleanly across P1–P6, but reviewers found four orphan references to the deleted `cli-commands/session-start.ts` and `pre-compact.ts` files that escaped P5 + P6 cleanup. One is a release-time blocker. The rest are documentation drift + a small parity polish.

Invariants (INV-1, INV-2, phasePlaybook null contract) all pass — no spec rework required.

## Tasks

### F-01 [HIGH — release-blocker]: Repair `scripts/sync-versions.sh` + test

**Problem**: `scripts/sync-versions.sh:95,148` references `servers/exarchos-mcp/src/cli-commands/session-start.ts` and the constant pattern `^const SESSION_START_BINARY_VERSION = `. The script's `patch_quoted_after` (line 129) explicitly fails when the target file is missing → next `npm run sync-versions` invocation will exit non-zero, breaking the release workflow.

**Files**:
- `scripts/sync-versions.sh` — drop the SESSION_START_BINARY_VERSION sink; remove its row from `ts_sites()` (around L95, L148)
- `scripts/sync-versions.test.sh:30,77,146,164,175,210` — drop fixtures and expectations referencing the dead path

**Acceptance**:
- `bash scripts/sync-versions.sh --check` exits 0 against current repo state
- `bash scripts/sync-versions.test.sh` passes (or its equivalent test runner)
- No remaining `grep -rn "session-start" scripts/sync-versions*` matches

**Test discipline**: TDD — first add a failing test asserting `sync-versions.sh --check` exits 0; confirm RED; then make GREEN.

### F-02 [MEDIUM]: Bump `minBinaryVersion` to 2.10.0 in plugin manifest

**Problem**: `.claude-plugin/plugin.json:44` declares `metadata.compat.minBinaryVersion: "2.9.0"`, but the v2.10 plugin emits `phasePlaybook`-aware envelopes that depend on v2.10 binary's composition logic. Running v2.9 binary against v2.10 plugin would silently miss playbook composition.

**Files**:
- `.claude-plugin/plugin.json` — bump `metadata.compat.minBinaryVersion` from `"2.9.0"` to `"2.10.0"`

**Acceptance**:
- `npm run build:plugin` (or equivalent validation) passes
- `grep "minBinaryVersion" .claude-plugin/plugin.json` shows `"2.10.0"`

### F-03 [MEDIUM]: Scrub `plugin-compat.ts` JSDoc references to deleted `handleSessionStart`

**Problem**: `servers/exarchos-mcp/src/lib/plugin-compat.ts:5,24,174,187,190` — module header and JSDoc still describe `handleSessionStart()` as a call site. The function is gone (only `version --check-plugin-root` remains). Misleading documentation but no runtime bug.

**Files**:
- `servers/exarchos-mcp/src/lib/plugin-compat.ts` — remove handleSessionStart references from module header (L5), JSDoc (L24, L174, L187, L190); ensure remaining doc accurately describes the surviving `version --check-plugin-root` call site only

**Acceptance**:
- `grep -n "handleSessionStart" servers/exarchos-mcp/src/lib/plugin-compat.ts` returns no matches
- `npm run typecheck` passes

### F-04 [LOW — combined cleanup]: Scrub remaining orphan comments + allowlist entries

**Problem**: Several files carry orphan comments referencing the deleted hook chain. None affect behavior.

**Files** (all comment/allowlist edits, no logic changes):
- `scripts/check-event-store-composition-root.mjs:51` and `scripts/check-event-store-composition-root.test.ts:13` — drop `cli-commands/pre-compact.ts` from EventStore composition-root ALLOWLIST
- `scripts/validate-no-legacy.test.sh:307` — update comment listing "live handlers" to remove `pre-compact, session-start`
- `servers/exarchos-mcp/src/index.ts:232` — drop orphan comment
- `servers/exarchos-mcp/src/adapters/cli.ts:522` — drop orphan comment
- `servers/exarchos-mcp/src/adapters/hooks.ts:44` — drop orphan comment
- `servers/exarchos-mcp/src/workflow/terminal-phases.ts` — drop orphan reference (line TBD via grep)
- `servers/exarchos-mcp/src/workflow/human-checkpoint-phases.ts` — drop orphan reference (line TBD via grep)
- `servers/exarchos-mcp/src/session/types.ts:1` — drop orphan comment
- `servers/exarchos-mcp/src/verbs/design-completeness*.ts:32,302` — drop orphan comments

**Acceptance**:
- `grep -rn "session-start\|pre-compact" servers/exarchos-mcp/src/ scripts/ --include="*.ts" --include="*.mjs" --include="*.sh"` shows only intentional historical references (CHANGELOG, fix-plan docs); no orphan code/comment hits
- `npm run typecheck` passes

### F-05 [LOW — observability polish, optional]: Add `workflowLogger.warn` to session-machinery interceptor catch

**Problem**: `servers/exarchos-mcp/src/dispatch/core/interceptors/session-machinery.ts:169` swallows interceptor errors silently. Documented as observability-only by design, but unlike sibling swallow paths in `handleRehydrate` and `buildDegradedResponse`, this catch emits no log signal at all — T-12 interceptor regressions would be invisible to oncall.

**Files**:
- `servers/exarchos-mcp/src/dispatch/core/interceptors/session-machinery.ts:169` — add `workflowLogger.warn({ err, ctx: ... }, 'session-machinery interceptor swallowed error')` inside the catch

**Acceptance**:
- `npm run typecheck` passes
- Existing tests still green
- Manual: trigger an interceptor failure path in a unit test (or add one) and assert the warn was emitted

## Out of scope (defer)

- TQ-1 documented `describe.skip` in `reducer.test.ts:542` for decisions fold — leave as-is until first `decision.*` event type is registered. No follow-up needed beyond the inline comment.
- CH-2 `TODO(T-01-refactor)` in `schema.ts:37` for `SerializedPhasePlaybookSchema` unification — track as design item, not blocking.

## Sequencing

F-01 is the only release-blocker. F-02 is one-line and trivially mergeable. F-03/F-04/F-05 are low-conflict cleanup. All five can be dispatched in parallel against `feature/rehydration-machinery-refactor`.

## Done criteria

- All five fix tasks merged into `feature/rehydration-machinery-refactor`
- `npm run typecheck && npm run test:run && npm run skills:guard` all green
- `bash scripts/sync-versions.sh --check` exits 0
- Re-run review reaches PASS verdict (no remaining HIGHs)
