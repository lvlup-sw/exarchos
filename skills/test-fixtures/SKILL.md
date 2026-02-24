---
name: test-fixtures
description: "Fixture skill directories for validating the frontmatter validation script (validate-frontmatter.sh). Contains deliberately broken skills with various issues — missing name, no frontmatter, body too long, name mismatch, etc. Not directly invocable as a skill. Use as test inputs for validation script development. Do NOT modify fixture contents without updating corresponding test expectations."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: utility
---

# Test Fixtures

## Overview

Contains fixture skill directories used to test the frontmatter validation script (`validate-frontmatter.sh`). Each subdirectory is a mock skill with specific issues designed to exercise validation edge cases.

## Fixture Directories

- `valid-skill/` — Correctly structured skill (passes validation)
- `missing-name/` — Missing required `name` field
- `missing-description/` — Missing required `description` field
- `no-frontmatter/` — No YAML frontmatter block
- `name-mismatch/` — `name` field does not match directory name
- `body-too-long/` — Description exceeds 1,024 character limit
- `broken-reference/` — References a non-existent file
- `orphan-reference/` — Has unreferenced files in references directory
- `no-negative-trigger/` — Missing negative trigger pattern
- `xml-tags/` — Contains XML tags in content

## Usage

Run `bash skills/validate-frontmatter.sh skills/test-fixtures/<fixture>/SKILL.md` to test individual fixtures against the validator. See `validate-frontmatter.test.sh` for the full test suite.
