#!/usr/bin/env bash
#
# new-project.sh - Initialize a new project with Claude Code configuration
#
# Usage: new-project.sh [project-path] [options]
#
# Options:
#   --typescript    Set up for TypeScript project
#   --csharp        Set up for C# project
#   --minimal       Only create CLAUDE.md, no local overrides
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Defaults
PROJECT_PATH="${1:-.}"
LANG=""
MINIMAL=false

# Parse arguments
shift || true
while [[ $# -gt 0 ]]; do
    case $1 in
        --typescript) LANG="typescript"; shift ;;
        --csharp) LANG="csharp"; shift ;;
        --minimal) MINIMAL=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Resolve project path
PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd || echo "$PROJECT_PATH")"

if [ ! -d "$PROJECT_PATH" ]; then
    echo "Creating project directory: $PROJECT_PATH"
    mkdir -p "$PROJECT_PATH"
fi

echo "Setting up Claude Code for: $PROJECT_PATH"
echo ""

# Create CLAUDE.md from template
if [ -f "$PROJECT_PATH/CLAUDE.md" ]; then
    echo "[skip] CLAUDE.md already exists"
else
    cp "$REPO_ROOT/CLAUDE.md.template" "$PROJECT_PATH/CLAUDE.md"
    echo "[created] CLAUDE.md"

    # Customize based on language
    if [ "$LANG" = "typescript" ]; then
        sed -i 's/npm run test:run/npm run test/g' "$PROJECT_PATH/CLAUDE.md"
        sed -i 's/npm run test:coverage/npm run test -- --coverage/g' "$PROJECT_PATH/CLAUDE.md"
    elif [ "$LANG" = "csharp" ]; then
        sed -i 's/npm run test:run/dotnet test/g' "$PROJECT_PATH/CLAUDE.md"
        sed -i 's/npm run test:coverage/dotnet test --collect:"XPlat Code Coverage"/g' "$PROJECT_PATH/CLAUDE.md"
        sed -i 's/npm run typecheck/dotnet build/g' "$PROJECT_PATH/CLAUDE.md"
    fi
fi

# Create .claude directory for local overrides (unless minimal)
if [ "$MINIMAL" = false ]; then
    mkdir -p "$PROJECT_PATH/.claude"

    # Create local settings.json if it doesn't exist
    if [ ! -f "$PROJECT_PATH/.claude/settings.json" ]; then
        cat > "$PROJECT_PATH/.claude/settings.json" << 'EOF'
{
  "permissions": {
    "allow": []
  }
}
EOF
        echo "[created] .claude/settings.json (local overrides)"
    else
        echo "[skip] .claude/settings.json already exists"
    fi

    # Add .claude/settings.local.json to .gitignore if git repo
    if [ -d "$PROJECT_PATH/.git" ]; then
        if ! grep -q "settings.local.json" "$PROJECT_PATH/.gitignore" 2>/dev/null; then
            echo ".claude/settings.local.json" >> "$PROJECT_PATH/.gitignore"
            echo "[updated] .gitignore (added settings.local.json)"
        fi
    fi
fi

echo ""
echo "Setup complete!"
echo ""
echo "Available commands (via global config):"
echo "  /ideate     - Collaborative design exploration"
echo "  /plan       - TDD implementation planning"
echo "  /delegate   - Dispatch to Jules or subagents"
echo "  /review     - Two-stage code review"
echo "  /synthesize - Merge and create PR"
echo ""
echo "Next steps:"
echo "  1. Edit $PROJECT_PATH/CLAUDE.md with project-specific details"
echo "  2. Add project-specific rules to $PROJECT_PATH/.claude/rules/ if needed"
echo ""
