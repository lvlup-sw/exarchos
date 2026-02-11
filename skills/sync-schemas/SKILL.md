# Schema Sync Skill

## Overview

Synchronize TypeScript types and Zod schemas from backend OpenAPI specifications. This skill can be invoked manually via `/sync-schemas` or automatically after delegation tasks that modify API files.

## Triggers

Activate this skill when:
- User runs `/sync-schemas` command
- Subagent completes task that modified API files (auto-chain from delegation)
- CI schema-check job fails and user wants to regenerate

## Monorepo Detection

This skill works in the **ares-elite-platform** monorepo. Before running, detect the monorepo root:

```bash
# Find monorepo root (contains azure.yaml and apps/ directory)
MONOREPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

# Verify it's the right monorepo
if [[ ! -f "$MONOREPO_ROOT/azure.yaml" ]] || [[ ! -d "$MONOREPO_ROOT/apps" ]]; then
  echo "ERROR: Not in ares-elite-platform monorepo"
  exit 1
fi
```

## API File Patterns

Schema sync is needed after modifying these API files:

| Pattern | Description |
|---------|-------------|
| `apps/aegis-api/src/**/*Endpoints.cs` | API endpoint definitions |
| `apps/aegis-api/src/**/Models/*.cs` | Request/response DTOs |
| `apps/aegis-api/src/**/Requests/*.cs` | Request models |
| `apps/aegis-api/src/**/Responses/*.cs` | Response models |
| `apps/aegis-api/src/**/Dtos/*.cs` | Data transfer objects |
| `apps/black-gate/src/**/*.ts` | Black Gate route definitions |

## Process

### Step 1: Detect Working Directory

```bash
# Get current directory and monorepo root
CURRENT_DIR=$(pwd)
MONOREPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

# Handle worktree case
if [[ "$CURRENT_DIR" == *".worktrees"* ]]; then
  # In a worktree - find the actual monorepo root
  WORKTREE_ROOT=$(pwd)
  # Worktrees are clones, so monorepo root is the worktree root
  MONOREPO_ROOT="$WORKTREE_ROOT"
fi

echo "Monorepo root: $MONOREPO_ROOT"
cd "$MONOREPO_ROOT"
```

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

When delegation completes a task, check if schema sync is needed:

```bash
# Check if any API files were modified in the task
git diff --name-only HEAD~1 | grep -E "(Endpoints|Models|Requests|Responses|Dtos).*\.cs$"

# If matches found, schema sync is needed
if [[ $? -eq 0 ]]; then
  echo "API files modified - running schema sync..."
  npm run sync:schemas
fi
```

## Generated Files

| File | Purpose |
|------|---------|
| `apps/aegis-api/openapi.json` | OpenAPI specification |
| `shared/types/src/generated/aegis.ts` | TypeScript types |
| `shared/validation/src/generated/aegis.zod.ts` | Zod validation schemas |
| `shared/validation/src/generated/black-gate.zod.ts` | Black Gate Zod validation schemas |
| `shared/validation/src/generated/schemas/black-gate/` | Black Gate component schemas |
| `apps/ares-elite-web/src/api/generated/aegis.schemas.ts` | TypeScript schema types |

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

### Manual Invocation
```
/sync-schemas
```

### After Backend Changes
```bash
# After editing PatientEndpoints.cs
/sync-schemas

# Verify and commit via Graphite
git add shared/ apps/ares-elite-web/src/api/generated/
gt create chore/schema-sync -m "chore: regenerate TypeScript types from OpenAPI"
gt submit --no-interactive
```

**NEVER use `git commit` or `git push`** — always use `gt create` and `gt submit`.

### In Worktree
```bash
cd .worktrees/task-001
# ... make backend changes ...
/sync-schemas
```

## Completion Criteria

- [ ] OpenAPI spec generated successfully
- [ ] TypeScript types generated
- [ ] Zod schemas generated
- [ ] Black Gate Zod schemas generated
- [ ] Typecheck passes
- [ ] No uncommitted generated files (if committing)
