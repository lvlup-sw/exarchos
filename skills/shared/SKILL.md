---
name: shared
description: "Shared prompt templates and resources used by other skills. Contains reusable prompt fragments for context reading, report formatting, and TDD requirements. Not directly invocable as a skill. Use when building or referencing cross-cutting prompt content that multiple skills depend on. Do NOT invoke directly — other skills reference these templates via relative paths."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: utility
---

# Shared Resources

## Overview

Contains shared prompt templates and reusable resources that other skills reference. This is not a directly invocable skill — it serves as a library of common prompt fragments.

## Contents

- `prompts/context-reading.md` — Shared context reading instructions
- `prompts/report-format.md` — Standard report formatting template
- `prompts/tdd-requirements.md` — TDD requirements prompt fragment

## Usage

Other skills reference these templates via relative paths in their own SKILL.md or reference files. Do not invoke this skill directly.
