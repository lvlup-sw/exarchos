#!/usr/bin/env bash
#
# install.sh - Set up Claude Code global configuration
#
# This script creates symlinks from ~/.claude/ to this repository,
# making skills, commands, rules, and plugins available globally.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
CLAUDE_HOME="${HOME}/.claude"

echo "Claude Config Installation"
echo "=========================="
echo ""
echo "Repo location: $REPO_ROOT"
echo "Claude home:   $CLAUDE_HOME"
echo ""

# Check for Jules API key
if [ -z "${JULES_API_KEY:-}" ]; then
    echo "WARNING: JULES_API_KEY is not set"
    echo ""
    echo "  The Jules plugin requires an API key to function."
    echo "  Get your key from: https://jules.google/settings"
    echo ""
    echo "  Add to your shell profile:"
    echo "    echo 'export JULES_API_KEY=\"your-key\"' >> ~/.zshrc"
    echo ""
    echo "  Continuing installation without Jules..."
    echo ""
else
    echo "Jules API key: [set]"
    echo ""
fi

# Ensure ~/.claude exists
mkdir -p "$CLAUDE_HOME"
mkdir -p "$CLAUDE_HOME/plugins"

# Function to create symlink, backing up existing if needed
link_dir() {
    local src="$1"
    local dest="$2"
    local name="$(basename "$dest")"

    if [ -L "$dest" ]; then
        echo "  [skip] $name (symlink exists)"
    elif [ -d "$dest" ]; then
        echo "  [backup] $name -> ${dest}.backup"
        mv "$dest" "${dest}.backup"
        ln -s "$src" "$dest"
        echo "  [link] $name"
    else
        ln -s "$src" "$dest"
        echo "  [link] $name"
    fi
}

link_file() {
    local src="$1"
    local dest="$2"
    local name="$(basename "$dest")"

    if [ -L "$dest" ]; then
        echo "  [skip] $name (symlink exists)"
    elif [ -f "$dest" ]; then
        echo "  [backup] $name -> ${dest}.backup"
        mv "$dest" "${dest}.backup"
        ln -s "$src" "$dest"
        echo "  [link] $name"
    else
        ln -s "$src" "$dest"
        echo "  [link] $name"
    fi
}

echo "Creating symlinks..."
echo ""

# Link directories
link_dir "$REPO_ROOT/skills" "$CLAUDE_HOME/skills"
link_dir "$REPO_ROOT/commands" "$CLAUDE_HOME/commands"
link_dir "$REPO_ROOT/rules" "$CLAUDE_HOME/rules"
link_dir "$REPO_ROOT/plugins/jules" "$CLAUDE_HOME/plugins/jules"

# Link files
link_file "$REPO_ROOT/settings.json" "$CLAUDE_HOME/settings.json"

echo ""
echo "Installing jules plugin dependencies..."
cd "$REPO_ROOT/plugins/jules/servers/jules-mcp"
npm install --silent
echo "  [done] npm install"
npm run build --silent
echo "  [done] npm run build"

echo ""
echo "Configuring Jules MCP server..."
# Add Jules MCP server to ~/.claude.json
if command -v jq &> /dev/null; then
    JULES_MCP_CONFIG='{
        "type": "stdio",
        "command": "node",
        "args": ["dist/index.js"],
        "cwd": "'"$CLAUDE_HOME"'/plugins/jules/servers/jules-mcp",
        "env": {
            "JULES_API_KEY": "${JULES_API_KEY}"
        }
    }'

    if [ -f "$HOME/.claude.json" ]; then
        # Update existing config
        jq --argjson jules "$JULES_MCP_CONFIG" '.mcpServers.jules = $jules' "$HOME/.claude.json" > /tmp/claude.json
        mv /tmp/claude.json "$HOME/.claude.json"
    else
        # Create new config
        echo "{\"mcpServers\": {\"jules\": $JULES_MCP_CONFIG}}" > "$HOME/.claude.json"
    fi
    echo "  [done] Added Jules MCP server to ~/.claude.json"
else
    echo "  [warn] jq not installed - manually add Jules MCP server with: claude mcp add jules"
fi

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Set JULES_API_KEY in your shell profile (~/.zshrc or ~/.bashrc)"
echo "  2. Restart Claude Code to load the MCP server"
echo "  3. For new projects, run: $REPO_ROOT/scripts/new-project.sh /path/to/project"
echo ""
