---
description: "Review failed tool calls in this session, diagnose root causes, and triage into code bug / docs issue / user error"
---

# Dogfood

Triage session failures for: "$ARGUMENTS"

## Skill Reference

Follow the dogfood skill: `@skills/dogfood/SKILL.md`

## Quick Start

1. **Debug trace first** — Use MCP self-service tools to build a ground-truth picture:
   - `exarchos_view pipeline` → identify active workflows
   - `exarchos_workflow describe(topology, playbook)` → get HSM + phase playbooks
   - `exarchos_event query` + `describe(emissionGuide)` → compare actual vs expected events
   - `exarchos_orchestrate describe(actions)` + `runbook(phase)` → verify schemas, gates, step ordering
   - `exarchos_view convergence, telemetry` → per-dimension pass rates, per-tool error rates
2. Scan this conversation for failed calls to the 5 Exarchos MCP tools (supplementary)
3. Cross-reference conversation errors with self-service evidence
4. Check playbook adherence and runbook conformance
5. Diagnose each failure using `references/root-cause-patterns.md`
6. Categorize: **code bug**, **documentation issue**, or **user error**
7. Present the report (include trace-only findings, playbook/runbook adherence)
8. Offer to file GitHub issues for bugs and doc issues

## Scope

If `$ARGUMENTS` is provided, focus analysis on that workflow or tool. Otherwise, review all Exarchos tool failures in the current session.
