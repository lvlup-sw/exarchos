# Design: Context Reload Command

## Problem Statement

Running long SDLC workflows exhausts the Claude Code context window. When context fills up, users must manually `/compact` or `/clear` and then `/resume` — a multi-step, friction-heavy process. The existing PreCompact hook saves checkpoints and the SessionStart hook restores them, but these mechanisms are reactive (triggered by Claude Code's auto-compaction) and the recovery produces minimal context that often leaves Claude disoriented.

We have a full event-sourcing infrastructure (state files, JSONL event store, CQRS views) that knows everything about the workflow. We should leverage it to make context management invisible: auto-compact fires, a rich context is reconstructed, and the workflow continues seamlessly.

## Chosen Approach

**Context Assembly Engine + Invisible Auto-Reload** (Options 3 + 2 from brainstorming)

Three coordinated components:

1. **Context Assembly Engine** — New `assemble-context` CLI command that composes existing CQRS views, queries the event store via its API, and reads git state to produce a phase-aware context document. This is the core primitive.

2. **Enhanced Hooks** — Widen PreCompact and SessionStart hook matchers. PreCompact saves enriched checkpoints with pre-computed context; SessionStart reads pre-computed context and injects it into the new session.

3. **`/reload` Command** — User-initiated context refresh. Emits a checkpoint event, instructs user to type `/clear`. SessionStart handles the rest.

### Auto-Compact Configuration

The installer sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90` statically in `~/.claude/settings.json` via the `env` field during installation. This enables Claude Code's built-in context measurement as the "context low" signal. When context hits 90%, PreCompact fires, saves checkpoint, and returns `continue: false` — cleanly halting the session with a message to `/clear`.

> **Note:** Claude Code hooks cannot dynamically set environment variables on the parent process. The auto-compact threshold must be configured statically during installation.

## Technical Design

### Component 1: Context Assembly Engine

New CLI command `assemble-context` that produces structured Markdown for context reconstruction by composing existing CQRS views and event store queries.

**Input:** `featureId` (required), `trigger` (optional: `reload` | `compact` | `clear` | `startup`)

**Output:** Structured context document (hard cap: 8,000 characters / ~2,000 tokens) with these sections:

```markdown
## Workflow: {featureId}
**Type:** {workflowType} | **Phase:** {phase} | **Next:** {nextAction}

## Task Progress
| # | Task | Status | Branch |
|---|------|--------|--------|
| 1 | Setup types | complete | feat/001-types |
| 2 | Add validation | in_progress | feat/002-validation |
(+3 more pending)

## Active Context
- **Design:** docs/designs/2026-02-18-feature.md — Feature authentication system
- **Plan:** docs/plans/2026-02-18-feature.md — 5 tasks, TDD-based
- **Working branch:** feat/context-reload
- **Worktrees:** .worktrees/wt-002-validation (active)

## Recent Events (last 5)
- 14:30 workflow.transition delegate → review
- 14:25 task.completed 001-types
- 14:10 task.assigned 002-validation

## Git State
- Branch: feat/context-reload (3 ahead of main)
- Recent: abc1234 feat: add type definitions
- Working tree: clean

## Next Action
{nextAction directive with specific instructions for the current phase}
```

**Data sources (via existing APIs — no raw JSONL reads):**
- `handleViewWorkflowStatus()` → phase, task counts, workflow metadata
- `handleViewTasks()` → task details with status and branch info
- `EventStore.query(featureId, { limit: 10 })` → recent events via query API
- `execFile('git', ...)` → current branch, recent commits, working tree status (async, with timeout)
- `fs.readFile` → first line of design/plan docs (title only)
- `computeNextAction()` → phase-to-action mapping + guard evaluation

**Implementation location:** `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/assemble-context.ts`

**CQRS compliance:** The assembly engine is a read-only consumer of materialized views. It imports view handlers directly from `views/tools.ts` (same pattern as `session-start.ts` using `telemetryProjection`). No raw JSONL parsing — all event access through `EventStore.query()`.

**Token budget enforcement:** Hard cap of 8,000 characters. Truncation strategy:
- Task table: show first 10 rows, append `(+N more pending/in_progress)` for overflow
- Events: show last 5 (not 10) — lean summaries only, no `data` field contents
- Artifact summaries: first line (title) + path only
- Git: branch + 3 most recent commit subjects + working tree status
- If total exceeds cap after all sections, drop sections in order: events → git → artifacts

**Async I/O:** All external operations use async APIs:
- `execFile` (promisified) for git — NOT `execSync`
- `Promise.all()` for parallel git queries (branch, log, status)
- Individual 5-second timeouts per git call with graceful degradation

**Git fault tolerance:** All git operations wrapped in try/catch. If git is unavailable (not a repo, SSH session, bare repo), the Git State section is omitted entirely. This path is tested explicitly.

**Phase-aware context tuning:**

| Phase | Extra Context |
|-------|--------------|
| `ideate` | Design decisions, open questions |
| `plan`, `plan-review` | Task breakdown, dependency graph |
| `delegate` | Worktree locations, teammate status, task assignments |
| `review` | Review findings, fix cycles, affected files |
| `synthesize` | PR URL, merge order, stack status |
| No workflow | Git state only (no views to query) |

**Event formatting:** Events are formatted as one-line summaries: `{HH:MM} {type} {key-detail}`. Raw `data` fields are never included. Key detail is extracted from event type:
- `workflow.transition` → `{from} → {to}`
- `task.completed` → `{taskId}`
- `task.assigned` → `{taskId} to {agentId}`
- Other → type only, no payload

### Component 2: Enhanced Checkpoint (PreCompact)

**Changes to `pre-compact.ts`:**

1. After saving checkpoint JSON, call `handleAssembleContext` to generate context markdown
2. Write the result as `{featureId}.context.md` alongside the checkpoint
3. The checkpoint JSON gains a new field: `contextFile: string` pointing to the `.context.md` file
4. **Trigger-aware behavior:** Check `trigger` field from stdin to differentiate auto vs manual compaction

**Changes to `hooks.json`:**

```diff
  "PreCompact": [
    {
-     "matcher": "auto",
+     "matcher": "",
      "hooks": [
        {
          "type": "command",
          "command": "node \"{{CLI_PATH}}\" pre-compact",
          "timeout": 30,
          "statusMessage": "Saving workflow checkpoint..."
        }
      ]
    }
  ],
```

Removing the matcher means PreCompact fires on ALL compaction events — both `auto` and `manual`.

**Trigger-aware return values:**

On **auto-compaction** (context exhaustion):
```json
{
  "continue": false,
  "stopReason": "Context checkpoint saved. Type /clear to reload with fresh context."
}
```
Returns `continue: false` to stop Claude cleanly before context overflows.

On **manual `/compact`** (user-initiated soft compaction):
```json
{
  "continue": true
}
```
Returns `continue: true` to allow the compaction to proceed normally. The checkpoint + context.md are still written (so SessionStart can use them if the user later `/clear`s), but the session is not interrupted.

> **Rationale:** A user typing `/compact` wants a soft compaction within the current session. Stopping them with `continue: false` would be unexpected. Auto-compaction signals context exhaustion where a hard stop is appropriate.

### Component 3: Enhanced SessionStart

**Changes to `session-start.ts`:**

1. **Wider matcher:** Match `startup|resume|compact|clear` (adds `compact` and `clear`)
2. **Context injection from pre-computed file:** When a checkpoint with `contextFile` exists, read the `.context.md` file and include its contents in the `contextDocument` response field
3. **No inline assembly:** SessionStart does NOT call `handleAssembleContext` directly — it only reads pre-computed context.md files written by PreCompact. This keeps SessionStart within its 10-second timeout.
4. **Cleanup:** Delete `.context.md` files alongside checkpoint cleanup (at-most-once: delete before adding to results)

**Changes to `hooks.json`:**

```diff
  "SessionStart": [
    {
-     "matcher": "startup|resume",
+     "matcher": "startup|resume|compact|clear",
      "hooks": [
        {
          "type": "command",
          "command": "node \"{{CLI_PATH}}\" session-start",
          "timeout": 10,
          "statusMessage": "Checking for active workflows..."
        }
      ]
    }
  ],
```

**Enhanced response shape:**

```typescript
interface SessionStartResult extends CommandResult {
  readonly workflows?: ReadonlyArray<WorkflowInfo>;
  readonly orphanedTeams?: ReadonlyArray<string>;
  readonly telemetryHints?: ReadonlyArray<string>;
  readonly contextDocument?: string;  // NEW: pre-computed assembled context markdown
}
```

The `contextDocument` field contains the pre-computed context from the assembly engine (written by PreCompact). Claude sees this immediately on session start and can continue the workflow without re-reading files.

> **Removed:** `envOverrides` field. Claude Code hooks cannot dynamically set environment variables on the parent process. The auto-compact threshold is set statically during installation instead.

**Fallback behavior (no checkpoint, just state file):** When no checkpoint exists but an active state file is discovered, SessionStart returns the current minimal behavior (featureId, phase, summary, nextAction). It does NOT attempt inline context assembly — the 10-second timeout is too tight. The user can type `/reload` → `/clear` to get the full assembled context.

### Component 4: `/reload` Command

**Location:** `commands/reload.md`

**Content:**

```markdown
Reload context from event-sourced workflow state.

## Instructions

1. Check for active workflows using `exarchos_workflow` get
2. If active workflow exists:
   a. Call `exarchos_event append` with type `workflow.checkpoint` and reason `user-reload`
   b. Display current phase, task progress, and next action
   c. Output: "Context checkpointed. Type `/clear` to reload with fresh context."
3. If no active workflow:
   a. Output: "No active workflow. Type `/clear` for a fresh start."

The `/clear` command will trigger SessionStart, which automatically reconstructs
your full working context from the event store and state files.
```

This is a thin Markdown command — the heavy lifting happens in the hooks. The command's job is to (1) emit a checkpoint event for audit and (2) instruct the user on the single next step.

### Component 5: Installer — Auto-Compact Configuration

**Changes to installer (`src/operations/settings.ts`):**

Add `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90` to the `env` field in generated settings. This sets the auto-compact threshold statically at install time.

```typescript
// In generateSettings():
env: {
  ...existingEnv,
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90',
}
```

This is the only mechanism to set environment variables on the Claude Code process from within Exarchos. It takes effect on next session start after installation/reinstallation.

### Auto-Compact Flow

```
Context hits 90% (threshold set by installer)
  → Claude Code triggers auto-compact
  → PreCompact hook fires (matcher: all, trigger: auto)
    → Saves checkpoint JSON + context.md (via assembly engine)
    → Returns { continue: false, stopReason: "Type /clear to reload" }
  → Claude stops
  → User types /clear
  → SessionStart hook fires (matcher: includes 'clear')
    → Reads checkpoint + context.md
    → Returns enriched contextDocument
    → Deletes checkpoint + context.md files
  → Claude sees full context, continues workflow
```

### Manual Compact Flow (User Types `/compact`)

```
User types /compact
  → PreCompact hook fires (trigger: manual)
    → Saves checkpoint JSON + context.md
    → Returns { continue: true }  ← allows compaction to proceed
  → Compaction completes normally
  → SessionStart hook fires (matcher: includes 'compact')
    → Reads checkpoint + context.md (if present)
    → Returns enriched contextDocument
    → Deletes checkpoint + context.md files
  → Claude sees full context within compacted session
```

### Manual Reload Flow (User-Initiated)

```
User types /reload
  → Command emits checkpoint event
  → Command outputs: "Type /clear to reload with fresh context."
  → User types /clear
  → Same SessionStart flow as auto-compact
```

## Integration Points

### Existing Systems Modified

| Component | Change |
|-----------|--------|
| `hooks.json` | PreCompact matcher: `""` (all). SessionStart matcher: `startup\|resume\|compact\|clear` |
| `pre-compact.ts` | Generate + save context.md alongside checkpoint. Trigger-aware continue/stop |
| `session-start.ts` | Read pre-computed context.md, include contextDocument in response |
| `cli.ts` | Register new `assemble-context` command handler |
| `settings.ts` | Add `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90` to env in generated settings |

### New Files

| File | Purpose |
|------|---------|
| `cli-commands/assemble-context.ts` | Context assembly engine (composes CQRS views + EventStore queries) |
| `commands/reload.md` | `/reload` command definition |

### No Changes Required

- Event store schemas (existing event types suffice)
- Workflow state machine (no new phases or transitions)
- Guard system (untouched)
- Quality gates (untouched)
- MCP tools (`exarchos_workflow`, `exarchos_event`, etc. — untouched)
- View projections (consumed as-is, not modified)

## Testing Strategy

### Unit Tests

1. **`assemble-context.test.ts`** — Test context assembly for each workflow phase:
   - Feature workflow in delegate phase → includes worktree info, task assignments
   - Debug workflow in investigate phase → includes triage results, RCA
   - No active workflow → produces git-state-only context
   - Missing event store → graceful degradation (state-only context)
   - Missing artifact files → graceful degradation (skips summaries)
   - Git unavailable → graceful degradation (skips git section)
   - Token budget enforcement → output ≤ 8,000 characters
   - Task table truncation → >10 tasks shows overflow count
   - Event formatting → one-line summaries, no data payloads

2. **`pre-compact.test.ts`** (extend existing) — Test context.md generation:
   - Active workflow → checkpoint + context.md written
   - No active workflow → no context.md written
   - Context.md path stored in checkpoint JSON
   - Auto trigger → returns `continue: false`
   - Manual trigger → returns `continue: true`

3. **`session-start.test.ts`** (extend existing) — Test enhanced recovery:
   - Checkpoint with contextFile → contextDocument included in response
   - Checkpoint without contextFile → falls back to current behavior
   - Context.md referenced but missing on disk → graceful degradation
   - Context.md deleted after successful read (at-most-once)
   - `clear` and `compact` matchers trigger correctly

4. **`settings.test.ts`** (extend existing) — Test auto-compact env var:
   - Generated settings include `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90` in `env`

### Integration Tests

1. **Full reload cycle:** Init workflow → advance to delegate → save checkpoint → clear → verify SessionStart produces rich context
2. **No-workflow reload:** No active workflow → `/reload` → `/clear` → verify minimal response
3. **Multi-workflow:** Two active workflows → verify both get context documents
4. **Manual compact preservation:** Manual compact → verify checkpoint written but session continues

## Resolved Design Decisions

1. **Token budget:** Hard cap at 8,000 characters (~2,000 tokens). Truncation in priority order: events → git → artifacts → task table overflow.

2. **Artifact summarization:** First line (title) + file path. No multi-line summaries.

3. **Event depth:** Last 5 events (reduced from 10 to stay within budget). One-line summaries only.

4. **Auto-compact threshold:** 90%, set statically during installation via `settings.json` env field.
