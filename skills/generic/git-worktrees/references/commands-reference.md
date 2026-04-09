# Worktree Commands Reference

## Core Commands

| Action | Command |
|--------|---------|
| List worktrees | `git worktree list` |
| Add worktree | `git worktree add <path> <branch>` |
| Remove worktree | `git worktree remove <path>` |
| Prune stale refs | `git worktree prune` |
| Lock (prevent removal) | `git worktree lock <path>` |
| Unlock | `git worktree unlock <path>` |

## Environment Setup

Auto-detect project type and install dependencies in each worktree:

| Indicator | Setup Command |
|-----------|---------------|
| `package.json` | `npm install` or `pnpm install` |
| `Cargo.toml` | `cargo build` |
| `requirements.txt` | `pip install -r requirements.txt` |
| `*.csproj` | `dotnet restore` |
| `go.mod` | `go mod download` |

**Setup Script:**
```bash
cd .worktrees/task-name

# Node.js
if [ -f "package.json" ]; then
  npm install
fi

# .NET
if compgen -G "*.csproj" > /dev/null 2>&1; then
  dotnet restore
fi

# Rust
if [ -f "Cargo.toml" ]; then
  cargo build
fi
```

## Parallel Worktree Management

### Creating Multiple Worktrees

For parallel task groups from implementation plan:

```bash
# Group 1 tasks
git worktree add .worktrees/001-types feature/001-types
git worktree add .worktrees/002-tests feature/002-tests

# Group 2 tasks (parallel to Group 1)
git worktree add .worktrees/003-api feature/003-api
git worktree add .worktrees/004-handlers feature/004-handlers
```

### Tracking Active Worktrees

Maintain awareness of active worktrees:
```bash
git worktree list
```

Report format:
```markdown
## Active Worktrees

| Task | Branch | Status |
|------|--------|--------|
| 001-types | feature/001-types | In Progress |
| 002-tests | feature/002-tests | Complete |
| 003-api | feature/003-api | In Progress |
```
