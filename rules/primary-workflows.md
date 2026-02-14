# Primary Workflows

This installation provides three SDLC workflows. When users ask to start work, guide them to the appropriate workflow.

## Workflow Commands

| Task | Command | When to Use |
|------|---------|-------------|
| **New feature or design** | `/ideate` | User wants to build something new, explore a problem, or design a solution |
| **Bug fix** | `/debug` | User reports a bug, regression, or unexpected behavior |
| **Code improvement** | `/refactor` | User wants to restructure, clean up, migrate, or reorganize existing code |

## Supporting Commands

These are phase commands used within workflows. Do not suggest them as starting points:

| Command | Role |
|---------|------|
| `/plan` | Create TDD implementation plan (auto-invoked after `/ideate`) |
| `/delegate` | Dispatch tasks to subagents (auto-invoked after plan approval) |
| `/review` | Two-stage quality review (auto-invoked after delegation) |
| `/synthesize` | Create pull request (auto-invoked after review) |
| `/resume` | Resume a workflow after session restart |
| `/checkpoint` | Save workflow state for later resumption |

## Guidance

- If a user describes work without specifying a command, suggest the matching primary workflow
- All workflows auto-continue between phases — human checkpoints only at plan approval and merge
- Use `/resume` to continue an interrupted workflow
