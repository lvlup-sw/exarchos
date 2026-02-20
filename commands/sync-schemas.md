---
description: Synchronize TypeScript types from backend OpenAPI specs
---

# Sync Schemas

Regenerate TypeScript types and Zod schemas from backend OpenAPI specifications.

## Skill Reference

Follow the schema sync skill: `@skills/sync-schemas/SKILL.md`

## Quick Process

### Step 1: Detect Monorepo Root

```bash
MONOREPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

# Handle worktree case
if [[ "$(pwd)" == *".worktrees"* ]]; then
  MONOREPO_ROOT=$(pwd)
fi

cd "$MONOREPO_ROOT"
```

### Step 2: Run Sync

```bash
npm run sync:schemas
```

### Step 3: Verify

```bash
npm run typecheck
```

### Step 4: Report

```markdown
## Schema Sync Complete

Generated files:
- `apps/aegis-api/openapi.json`
- `shared/types/src/generated/aegis.ts`
- `shared/validation/src/generated/aegis.zod.ts`
- `apps/ares-elite-web/src/api/generated/aegis.schemas.ts`

Typecheck: PASS
```

## When to Use

Run this command after modifying:
- `*Endpoints.cs` - API endpoint definitions
- `**/Models/*.cs` - Request/response DTOs
- `**/Dtos/*.cs` - Data transfer objects

## Auto-Invocation

This command is auto-invoked by `/exarchos:delegate` when subagents modify API files. You typically only need to run it manually when:
- CI schema-check fails
- Making quick backend changes outside the workflow
- Verifying types after pulling changes

## Failure Recovery

| Issue | Solution |
|-------|----------|
| Build failure | Check C# compilation errors in Aegis.API |
| Orval failure | Verify `apps/aegis-api/openapi.json` is valid JSON |
| TypeScript errors | Breaking API change - update consumers |
