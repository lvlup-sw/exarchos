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
- `run-trigger-tests.sh` — Bash test runner that executes trigger fixtures and reports results
- `fixtures/pressure-tests.jsonl` — Adversarial pressure test fixtures that validate discipline skills hold firm under pressure
- `run-pressure-tests.sh` — Runner that validates pressure test fixtures reference valid skills with discipline content
- `pressure-tests.test.sh` — Structural validation tests for pressure test fixture format and coverage

## Usage

```bash
# Run trigger matching tests
bash skills/trigger-tests/run-trigger-tests.sh

# Run pressure test validation
bash skills/trigger-tests/run-pressure-tests.sh

# Run pressure test structural tests
bash skills/trigger-tests/pressure-tests.test.sh
```

The trigger tests validate skill trigger matching. The pressure tests validate that discipline skills (implementation-planning, spec-review, quality-review) resist adversarial prompts that attempt to bypass required processes.
