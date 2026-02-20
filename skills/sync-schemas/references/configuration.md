# Schema Sync Configuration

Project-specific to **ares-elite-platform** monorepo.

## Monorepo Detection

```bash
MONOREPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

if [[ ! -f "$MONOREPO_ROOT/azure.yaml" ]] || [[ ! -d "$MONOREPO_ROOT/apps" ]]; then
  echo "ERROR: Not in ares-elite-platform monorepo"
  exit 1
fi
```

Handle worktrees: if `pwd` contains `.worktrees`, use the worktree root as monorepo root.

## API File Trigger Patterns

Schema sync is needed after modifying files matching these patterns:

| Pattern | Description |
|---------|-------------|
| `apps/aegis-api/src/**/*Endpoints.cs` | API endpoint definitions |
| `apps/aegis-api/src/**/Models/*.cs` | Request/response DTOs |
| `apps/aegis-api/src/**/Requests/*.cs` | Request models |
| `apps/aegis-api/src/**/Responses/*.cs` | Response models |
| `apps/aegis-api/src/**/Dtos/*.cs` | Data transfer objects |
| `apps/black-gate/src/**/*.ts` | Black Gate route definitions |

## Generated Files

| File | Purpose |
|------|---------|
| `apps/aegis-api/openapi.json` | OpenAPI specification |
| `shared/types/src/generated/aegis.ts` | TypeScript types |
| `shared/validation/src/generated/aegis.zod.ts` | Zod validation schemas |
| `shared/validation/src/generated/black-gate.zod.ts` | Black Gate Zod schemas |
| `shared/validation/src/generated/schemas/black-gate/` | Black Gate component schemas |
| `apps/ares-elite-web/src/api/generated/aegis.schemas.ts` | TypeScript schema types |

## Auto-Detection for Delegation

```bash
git diff --name-only HEAD~1 | grep -E "(Endpoints|Models|Requests|Responses|Dtos).*\.cs$"

if [[ $? -eq 0 ]]; then
  echo "API files modified - running schema sync..."
  npm run sync:schemas
fi
```

## Usage Examples

### After Backend Changes
```bash
# After editing PatientEndpoints.cs
/sync-schemas

# Verify and commit via Graphite
git add shared/ apps/ares-elite-web/src/api/generated/
gt create chore/schema-sync -m "chore: regenerate TypeScript types from OpenAPI"
gt submit --no-interactive --publish
```

**NEVER use `git commit` or `git push`** — always use `gt create` and `gt submit`.

### In Worktree
```bash
cd .worktrees/task-001
# ... make backend changes ...
/sync-schemas
```
