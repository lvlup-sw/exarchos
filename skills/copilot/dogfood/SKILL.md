---
name: dogfood
description: "Review failed Exarchos MCP tool calls from the current session, diagnose root causes, and categorize into code bug, documentation issue, or user error. Use when the user says 'dogfood', 'review failures', 'what went wrong', 'triage errors', or runs /dogfood. Scopes exclusively to Exarchos tools (exarchos_workflow, exarchos_event, exarchos_orchestrate, exarchos_view, exarchos_sync). Do NOT use for debugging application code or non-Exarchos tool failures."
metadata:
  author: exarchos
  version: 2.0.0
  mcp-server: exarchos
  category: utility
---

# Dogfood Skill

## Overview

Retrospective analysis of Exarchos MCP tool usage. Uses the MCP server's own self-service capabilities as the primary diagnostic instrument — describe APIs, views, playbooks, and runbooks turned inward to diagnose failures.

Three distinct failure modes require different fixes — code changes, documentation updates, or skill instruction improvements. Mixing them wastes effort.

### Platform-Agnosticity

Per `docs/designs/2026-03-09-platform-agnosticity.md`: the MCP server is the self-sufficient, platform-agnostic core. The debug trace relies entirely on MCP tools — not conversation introspection — so it works for any MCP client. Conversation scanning is supplementary.

**Diagnostic self-service tools:** `describe(topology)` for HSM verification, `describe(playbook)` for adherence checks, `describe(eventTypes, emissionGuide)` for event schema/catalog comparison, `describe(actions)` for schema/gate metadata, `runbook(phase)` for step conformance, `pipeline`/`convergence`/`telemetry` views for health metrics.

## Triggers

Activate this skill when:
- User runs `/dogfood` or `/dogfood`
- User asks "what went wrong this session" or "review the failures"
- User wants to triage errors from a workflow run
- End of a workflow session to capture learnings

## Process

### Step 1: Debug Trace via MCP Self-Service

Query the MCP server's own self-service capabilities to build a ground-truth diagnostic picture. This is the primary investigation method — it uses the same tools any MCP client has access to.

#### 1a. Identify Active Workflows

Use `exarchos_view` with `action: "pipeline"` to get an aggregated view of active workflows with their phases and task counts.

If `$ARGUMENTS` specifies a workflow or feature ID, scope to that workflow. Otherwise, inspect all non-terminal workflows.

#### 1b. Inspect Workflow State and Topology

For each relevant workflow:

1. **Read state** — `exarchos_workflow get` to retrieve current phase, tasks, reviews, gate results.
2. **Read topology** — `exarchos_workflow describe(topology: "<workflowType>")` to get the HSM definition. Compare the agent's phase transition attempts against valid transitions. Invalid transition attempts = documentation issue (skill prescribed wrong path) or user error.
3. **Check guard prerequisites** — For `workflow.guard-failed` events, look up the guard in the topology to understand unmet preconditions.

#### 1c. Playbook Adherence Check

Use `exarchos_workflow describe(playbook: "<workflowType>")` to retrieve phase playbooks. For each phase executed, compare playbook's `tools`, `events`, `transitionCriteria`, `guardPrerequisites`, `humanCheckpoint`, and `compactGuidance` against what the agent actually did and what skill docs prescribe.

**Playbook violations are diagnostic gold:**
- Agent deviated and skill docs told it to → **documentation issue** (skill contradicts playbook)
- Agent deviated and skill docs agree with playbook → **user error**
- Playbook is wrong (prescribes invalid tools/events) → **code bug**

#### 1d. Event Log Analysis

Use `exarchos_event query(stream)` on the workflow's event stream. Look for:

- **Rejected events** — absent from log despite agent attempts (corroborate with conversation errors)
- **Missing events** — compare against playbook `events` field and `exarchos_event describe(emissionGuide: true)`. Missing model-emitted events = documentation gap or user error.
- **Sequence anomalies** — wrong order, duplicates, or timeline gaps
- **Schema mismatches** — use `describe(eventTypes: [...])` to get authoritative JSON Schema. Compare actual payloads against schema for semantically wrong fields.

#### 1e. Orchestrate Action and Gate Analysis

1. **Schema verification** — `exarchos_orchestrate describe(actions: [...])` for authoritative schemas. Compare agent's parameters against schema to detect stale skill docs or improvisation.
2. **Gate metadata** — Describe output includes `{ blocking, dimension, autoEmits }`. Check: did the agent treat blocking/non-blocking correctly? Did expected auto-emissions fire?
3. **Gate convergence** — `exarchos_view convergence` for per-dimension (D1-D5) pass rates. Low convergence suggests systemic gate issues.

#### 1f. Runbook Conformance Check

Use `exarchos_orchestrate runbook(phase)` to retrieve relevant runbooks. Check: step ordering, decision branch correctness (steps with `decide` fields), `onFail` directive adherence (`stop`/`continue`/`retry`), and `templateVars` completeness.

#### 1g. Telemetry Review

Use `exarchos_view telemetry` for per-tool performance. Flag: high error rates (systemic issues), high invocation counts (retry loops), and tools never invoked that the playbook prescribes.

### Step 2: Scan Session for Failed Tool Calls

Supplement the debug trace with client-side context — review conversation for failed Exarchos tool calls.

**Note:** Platform-dependent step (requires conversation history). Skip on platforms without introspection; the debug trace is self-sufficient.

**Target tools:** `exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, `exarchos_sync`

**Error signals:** `INVALID_INPUT`, `VALIDATION_ERROR`, `BATCH_APPEND_FAILED`, Zod failures (`invalid_type`, `invalid_enum_value`, `unrecognized_keys`), `ENOENT`, `CLAIM_FAILED`, `SEQUENCE_CONFLICT`, CAS exhaustion, retry sequences, successful-after-retry calls.

### Step 3: Diagnose Each Failure

Merge debug trace and conversation scan findings. For each failure document:

1. **What was attempted** — action, parameters, intent
2. **What went wrong** — error message and validation path
3. **Server-side evidence** — event log, state, describe output, views
4. **Authoritative reference** — the self-service query providing ground truth (playbook, topology, schema, runbook)
5. **Root cause** — per `references/root-cause-patterns.md`
6. **Fix category** — code, docs, or user behavior

Flag discrepancies only visible via server-side inspection as **trace-only findings**.

### Step 4: Categorize into Buckets

Assign each failure to exactly one root cause bucket:

#### Bucket 1: Code Bug
The MCP server, event store, or workflow engine has a defect.

**Signals:** Schema rejects valid input (confirmed via `describe`), CAS failures with no concurrent writers, gate over-enforcement, identical-parameter retry succeeds (race condition), state corruption, topology/engine mismatch, auto-emission failure.

**Action:** File bug issue with reproduction steps, expected vs actual, and suggested fix.

#### Bucket 2: Documentation Issue
Skill docs are wrong, incomplete, or out of sync with the MCP server's self-service output.

**Signals:** Skill payload doesn't match `describe` schema, skill/playbook divergence, skill documents nonexistent topology paths, missing event types (compare emission guide), retry-based field discovery, runbook/skill contradictions, compactGuidance drift.

**Action:** File docs issue with file:line, the discrepancy, and correct information from `describe` output.

#### Bucket 3: User Error
The agent misused a tool in a way both docs and `describe` output correctly describe.

**Signals:** Format mismatch (confirmed by `describe` + docs agreement), invalid sequence (topology confirms), missing context both skill and playbook prescribe, runbook deviation without justification.

**Action:** Note for skill improvement if errors are frequent.

### Step 5: Generate Report

Produce the report using the template from `references/report-template.md`. Include:
- Summary counts per bucket
- Debug trace summary (workflows inspected, events reviewed, describe queries issued, views consulted)
- Each failure with full diagnosis (including authoritative self-service references)
- Trace-only findings section (issues only visible via server-side inspection)
- Playbook/runbook adherence summary
- Actionable next steps (draft issue bodies for bugs/docs issues)

### Step 6: Offer to File Issues

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
    "failure_rate": "0%",
    "debug_trace": {
      "workflows_inspected": 0,
      "events_reviewed": 0,
      "describe_queries": 0,
      "views_consulted": [],
      "trace_only_findings": 0
    }
  },
  "playbook_adherence": {
    "phases_checked": 0,
    "violations": [
      {
        "phase": "delegate",
        "field": "events",
        "expected": "team.spawned, team.task.assigned",
        "actual": "none emitted",
        "bucket": "documentation_issue"
      }
    ]
  },
  "runbook_conformance": {
    "runbooks_checked": 0,
    "deviations": []
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
      "trace_evidence": "describe(actions: ['set']) shows branch as required string; event log confirms no task.updated event",
      "authoritative_ref": "exarchos_workflow describe(actions: ['set']) → TaskSchema",
      "severity": "HIGH | MEDIUM | LOW",
      "suggested_fix": "Accept nullable branch in TaskSchema",
      "issue_draft": {
        "title": "bug: workflow task schema rejects null branch",
        "labels": ["bug"],
        "body": "..."
      }
    }
  ],
  "trace_only_findings": [
    {
      "id": "T1",
      "description": "State drift: agent assumed phase was 'delegate' but server shows 'plan'",
      "evidence": "exarchos_workflow get shows phase=plan; topology confirms plan→delegate requires planReviewComplete guard",
      "authoritative_ref": "exarchos_workflow describe(topology: 'feature') → guards",
      "bucket": "documentation_issue",
      "suggested_fix": "Skill should instruct agent to verify phase via get before proceeding"
    }
  ]
}
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip the debug trace and only scan conversation | Always query MCP self-service tools first — conversation scan is supplementary |
| Guess what the schema expects | Use `describe` to get authoritative schemas — they are the source of truth |
| Assess playbook adherence from memory | Query `describe(playbook)` to get the actual prescribed tools, events, and criteria |
| Assume the topology without checking | Query `describe(topology)` to get valid transitions, guards, and effects |
| Blame the user when skill docs contradict the playbook | If skill docs diverge from playbook/describe output, it's a documentation issue |
| File duplicate issues | Check existing open/closed issues before drafting |
| Categorize retries as separate failures | Group retry sequences as a single finding |
| Ignore successful-after-retry calls | These reveal friction even though they eventually worked |
| Include non-Exarchos failures | Scope strictly to the 5 Exarchos tools — other MCP failures are out of scope |
| Report conversation-only findings without trace corroboration | Cross-reference every finding with server-side state when possible |
