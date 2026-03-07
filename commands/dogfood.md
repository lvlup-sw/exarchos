---
description: "Review failed tool calls in this session, diagnose root causes, and triage into code bug / docs issue / user error"
---

# Dogfood

Triage session failures for: "$ARGUMENTS"

## Skill Reference

Follow the dogfood skill: `@skills/dogfood/SKILL.md`

## Quick Start

1. Scan this conversation for failed calls to the 5 Exarchos MCP tools only (workflow, event, orchestrate, view, sync)
2. Diagnose each failure using `references/root-cause-patterns.md`
3. Categorize: **code bug**, **documentation issue**, or **user error**
4. Present the report
5. Offer to file GitHub issues for bugs and doc issues

## Scope

If `$ARGUMENTS` is provided, focus analysis on that workflow or tool. Otherwise, review all Exarchos tool failures in the current session.
