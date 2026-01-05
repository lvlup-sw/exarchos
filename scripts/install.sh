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
link_dir "$REPO_ROOT/scripts" "$CLAUDE_HOME/scripts"
# Note: Don't symlink plugins/jules - it causes ${CLAUDE_PLUGIN_ROOT} resolution issues
# The MCP server is configured directly in ~/.claude.json with an absolute path

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
# Add Jules MCP server to ~/.claude.json (user-scoped, works from any directory)
# Use the repo path directly since we don't symlink the plugin directory
MCP_SERVER_PATH="$REPO_ROOT/plugins/jules/servers/jules-mcp"
if command -v jq &> /dev/null; then
    # Build the config with proper escaping
    if [ -f "$HOME/.claude.json" ]; then
        # Update existing config - ensure mcpServers object exists
        jq '.mcpServers //= {} | .mcpServers.jules = {
            "type": "stdio",
            "command": "node",
            "args": ["'"$MCP_SERVER_PATH"'/dist/index.js"],
            "env": {
                "JULES_API_KEY": "${JULES_API_KEY}"
            }
        }' "$HOME/.claude.json" > /tmp/claude.json
        mv /tmp/claude.json "$HOME/.claude.json"
    else
        # Create new config
        echo '{
  "mcpServers": {
    "jules": {
      "type": "stdio",
      "command": "node",
      "args": ["'"$MCP_SERVER_PATH"'/dist/index.js"],
      "env": {
        "JULES_API_KEY": "${JULES_API_KEY}"
      }
    }
  }
}' > "$HOME/.claude.json"
    fi
    echo "  [done] Added Jules MCP server to ~/.claude.json"
else
    echo "  [warn] jq not installed - run: claude mcp add jules --scope user -- node $MCP_SERVER_PATH/dist/index.js"
fi

echo ""
echo "Installation complete!"
echo ""
echo "To use Jules:"
echo "  1. Set JULES_API_KEY: echo 'export JULES_API_KEY=\"your-key\"' >> ~/.zshrc"
echo "  2. Restart Claude Code"
echo "  3. Verify with: /mcp (should show 'jules: Connected')"
echo ""
echo "Alternative: Install via plugin marketplace:"
echo "  /plugin marketplace add lvlup-sw/lvlup-claude"
echo "  /plugin install jules@lvlup-claude"
echo ""
