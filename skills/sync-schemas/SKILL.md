---
name: sync-schemas
description: "Synchronize TypeScript types from backend OpenAPI specifications. Monorepo-specific to ares-elite-platform. Use when the user says \"sync schemas\", \"update types from API\", or runs /sync-schemas. Generates TypeScript interfaces from OpenAPI spec files and validates type compatibility. Do NOT use for manual type definitions or non-OpenAPI schemas."
metadata:
  author: exarchos
  version: 1.0.0
  category: utility
---

# Schema Sync Skill

## Project Requirement

This skill only works in the **ares-elite-platform** monorepo.
Detection: check for `azure.yaml` and `apps/` directory at repo root.
If not found: report "This skill requires the ares-elite-platform monorepo" and stop.

## Overview

Synchronize TypeScript types and Zod schemas from backend OpenAPI specifications. This skill can be invoked manually via `/sync-schemas` or automatically after delegation tasks that modify API files.

## Triggers

Activate this skill when:
- User runs `/sync-schemas` command
- Subagent completes task that modified API files (auto-chain from delegation)
- CI schema-check job fails and user wants to regenerate

## Monorepo Detection

Detect monorepo root and verify `azure.yaml` + `apps/` exist. Handle worktrees. See `references/configuration.md` for detection script and API file trigger patterns.

## Process

### Step 1: Detect Working Directory

Find monorepo root via `git rev-parse --show-toplevel`. Handle `.worktrees` paths. See `references/configuration.md`.

### Step 2: Run Schema Sync

```bash
npm run sync:schemas
```

This command:
1. **Builds Aegis API** - Generates `apps/aegis-api/openapi.json`
2. **Runs Orval** - Generates TypeScript types and Zod schemas for both Aegis and Black Gate
3. **Rebuilds shared packages** - Compiles the generated code

### Step 3: Verify TypeScript

```bash
npm run typecheck
```

### Step 4: Report Results

Report what was regenerated:

```markdown
## Schema Sync Complete

**OpenAPI Spec:** apps/aegis-api/openapi.json
**TypeScript Types:** shared/types/src/generated/aegis.ts
**Zod Schemas:** shared/validation/src/generated/aegis.zod.ts
**Black Gate Zod:** shared/validation/src/generated/black-gate.zod.ts
**Black Gate Component Schemas:** shared/validation/src/generated/schemas/black-gate/
**Frontend Types:** apps/ares-elite-web/src/api/generated/aegis.schemas.ts

Typecheck: PASS
```

## Auto-Detection for Delegation

After delegation tasks that modify API files, auto-detect and run sync. See `references/configuration.md` for detection script, trigger patterns, and generated file mapping.

## Failure Recovery

### Build Failure
```bash
# Check for C# compilation errors
cd apps/aegis-api && dotnet build src/Aegis.sln
```

### Orval Failure
```bash
# Verify OpenAPI spec exists and is valid
cat apps/aegis-api/openapi.json | jq . > /dev/null
```

### TypeScript Errors
TypeScript errors after sync usually indicate breaking API changes. Review the generated types and update consumers accordingly.

## CI Integration

The `schema-check` CI job verifies schemas are in sync:
- Regenerates schemas from scratch
- Compares against committed files
- Fails if any drift detected

If CI fails on schema-check, run `/sync-schemas` locally and commit the results.

## Usage Examples

See `references/configuration.md` for manual, post-backend-change, and worktree usage examples.

## Completion Criteria

- [ ] OpenAPI spec generated successfully
- [ ] TypeScript types generated
- [ ] Zod schemas generated
- [ ] Black Gate Zod schemas generated
- [ ] Typecheck passes
- [ ] No uncommitted generated files (if committing)
