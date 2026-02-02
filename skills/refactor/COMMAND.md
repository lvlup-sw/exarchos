# /refactor Command

## Purpose

Start a refactoring workflow for code improvements, cleanup, or restructuring.

## Usage

```
/refactor [target] [--polish] [--explore-only]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `target` | Optional. File, directory, or module to refactor. If omitted, will prompt. |

## Flags

| Flag | Description |
|------|-------------|
| `--polish` | Force polish track (direct implementation, no worktrees). Use for small, well-scoped refactors. |
| `--explore-only` | Run exploration phase only, output scope assessment without proceeding. |

## Examples

### Start refactor with exploration
```
/refactor src/services/auth
```

### Force small refactor mode
```
/refactor src/utils/helpers.ts --polish
```

### Just assess scope
```
/refactor src/api --explore-only
```

## Workflow Entry

The command triggers the refactor skill which:

1. **Explore phase**: Assesses scope (files, concerns, cross-module impact)
2. **Track selection**:
   - Polish (≤5 files, single concern) → direct implementation
   - Overhaul (>5 files or multiple concerns) → full workflow
3. **Brief capture**: Records problem, goals, approach in state
4. **Execution**: Track-specific implementation
5. **Validation**: Tests pass, goals met, docs updated

## State Initialization

When invoked, initializes refactor workflow state:

```bash
~/.claude/scripts/workflow-state.sh init --refactor <feature-id>
```

## See Also

- `/debug` - For bug fixes
- `/ideate` - For new features
- `/plan` - For implementation planning (used by overhaul track)
