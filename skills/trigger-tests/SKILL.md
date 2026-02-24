---
name: trigger-tests
description: "Test runner and fixtures for skill trigger matching validation. Contains a JSONL fixture file with trigger patterns and expected match results, plus a bash runner script. Not directly invocable as a skill. Use when developing or verifying changes to the skill trigger matching logic. Do NOT use for production trigger resolution."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: utility
---

# Trigger Tests

## Overview

Validates that skill trigger matching works correctly by running a suite of test cases defined in a JSONL fixture file against the trigger resolution logic.

## Contents

- `fixtures.jsonl` — Test cases with trigger patterns and expected match results
- `run-trigger-tests.sh` — Bash test runner that executes fixtures and reports results

## Usage

```bash
bash skills/trigger-tests/run-trigger-tests.sh
```

This runs all trigger matching test cases and reports pass/fail results. Use after modifying skill trigger patterns or the trigger matching algorithm.
