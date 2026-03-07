---
name: dogfood
description: "Review failed Exarchos MCP tool calls from the current session, diagnose root causes, and categorize into code bug, documentation issue, or user error. Use when the user says 'dogfood', 'review failures', 'what went wrong', 'triage errors', or runs /dogfood. Scopes exclusively to Exarchos tools (exarchos_workflow, exarchos_event, exarchos_orchestrate, exarchos_view, exarchos_sync). Do NOT use for debugging application code or non-Exarchos tool failures."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: utility
---

# Dogfood Skill

## Overview

Retrospective analysis of failed Exarchos MCP tool calls in the current session. Scans conversation history exclusively for failures from the five Exarchos tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, `exarchos_sync`), diagnoses the root cause of each, and categorizes findings into actionable buckets for filing issues or fixing docs.

This skill exists because dogfooding reveals three distinct failure modes that require different fixes — code changes, documentation updates, or skill instruction improvements. Mixing them together wastes effort.

## Triggers

Activate this skill when:
- User runs `/dogfood` or `/exarchos:dogfood`
- User asks "what went wrong this session" or "review the failures"
- User wants to triage errors from a workflow run
- End of a workflow session to capture learnings

## Process

### Step 1: Scan Session for Failed Tool Calls

Review the current conversation for all tool calls to the five Exarchos MCP tools that returned errors. **Only** include failures from these tools — ignore failures from GitHub, Serena, Context7, or any other MCP server.

**Target tools (exhaustive list):**
- `mcp__plugin_exarchos_exarchos__exarchos_workflow`
- `mcp__plugin_exarchos_exarchos__exarchos_event`
- `mcp__plugin_exarchos_exarchos__exarchos_orchestrate`
- `mcp__plugin_exarchos_exarchos__exarchos_view`
- `mcp__plugin_exarchos_exarchos__exarchos_sync`

**Error signals to look for:**
- Tool responses containing `error`, `INVALID_INPUT`, `VALIDATION_ERROR`, `BATCH_APPEND_FAILED`
- Zod validation failures (`invalid_type`, `invalid_enum_value`, `too_small`, `unrecognized_keys`)
- `ENOENT` or path resolution failures from `exarchos_orchestrate` script execution
- `CLAIM_FAILED`, `SEQUENCE_CONFLICT`, or CAS retry exhaustion
- Any Exarchos tool call that was retried with different parameters (indicates the first attempt failed)
- Exarchos tool calls that succeeded after retry (friction even if resolved)

### Step 2: Diagnose Each Failure

For each failed tool call, determine:

1. **What was attempted** — The action, parameters, and intent
2. **What went wrong** — The exact error message and validation path
3. **Why it went wrong** — Root cause analysis (see `references/root-cause-patterns.md`)
4. **What would have prevented it** — The fix category

### Step 3: Categorize into Buckets

Assign each failure to exactly one root cause bucket:

#### Bucket 1: Code Bug
The MCP server, event store, or workflow engine has a defect.

**Signals:**
- Schema rejects valid input (e.g., `null` for optional field, `"completed"` vs `"complete"`)
- CAS/sequence failures with no concurrent writers
- Gate enforcement blocks valid workflows (e.g., TDD gate on docs-only tasks)
- Tool succeeds on retry with identical parameters (race condition)

**Action:** File a bug issue with reproduction steps, expected vs actual behavior, and suggested fix.

#### Bucket 2: Documentation Issue
Skill docs, references, or examples are wrong, incomplete, or out of sync with the code.

**Signals:**
- Agent used payload/schema from skill docs that doesn't match actual Zod schema
- Agent referenced a script path from docs that doesn't exist at that location
- Agent guessed event type names because valid types aren't documented in the skill
- Agent followed documented workflow steps that skip required tool calls
- Multiple retries with different field names (trial-and-error discovery)

**Action:** File a docs issue identifying the specific file:line, the discrepancy, and the correct information from the source code.

#### Bucket 3: User Error
The agent (or human) misused the tool in a way the docs correctly describe.

**Signals:**
- Parameter value doesn't match documented format (and docs are correct)
- Tool called out of sequence (e.g., quality review before spec review)
- Missing required context that the skill instructions say to provide
- Agent ignored explicit skill instructions (e.g., didn't read state file first)

**Action:** Note for skill improvement — if user errors are frequent, the skill instructions may need to be clearer, or guardrails should be added.

### Step 4: Generate Report

Produce the report using the template from `references/report-template.md`. Include:
- Summary counts per bucket
- Each failure with full diagnosis
- Actionable next steps (draft issue bodies for bugs/docs issues)

### Step 5: Offer to File Issues

For findings in the **Code Bug** and **Documentation Issue** buckets, offer to create GitHub issues:

```bash
gh issue create --title "<type>: <summary>" --body "<issue body>" --label "bug"
```

Only file issues with user confirmation — present the draft first.

## Required Output Format

```json
{
  "session_summary": {
    "total_tool_calls": 0,
    "failed_tool_calls": 0,
    "failure_rate": "0%"
  },
  "buckets": {
    "code_bug": [],
    "documentation_issue": [],
    "user_error": []
  },
  "findings": [
    {
      "id": 1,
      "bucket": "code_bug | documentation_issue | user_error",
      "tool": "exarchos_workflow",
      "action": "set",
      "error": "INVALID_INPUT: ...",
      "root_cause": "Schema rejects null branch on pending tasks",
      "severity": "HIGH | MEDIUM | LOW",
      "suggested_fix": "Accept nullable branch in TaskSchema",
      "issue_draft": {
        "title": "bug: workflow task schema rejects null branch",
        "labels": ["bug"],
        "body": "..."
      }
    }
  ]
}
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Blame the user when docs are wrong | If the agent followed skill docs and failed, it's a doc issue |
| File duplicate issues | Check existing open/closed issues before drafting |
| Categorize retries as separate failures | Group retry sequences as a single finding |
| Ignore successful-after-retry calls | These reveal friction even though they eventually worked |
| Include non-Exarchos failures | Scope strictly to the 5 Exarchos tools — other MCP failures are out of scope |
