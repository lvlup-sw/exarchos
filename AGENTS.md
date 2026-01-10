# AGENTS.md

## Project Overview
lvlup-claude provides Claude Code customizations, skills, and configuration for the lvlup-sw organization. It contains workflow automation skills, hooks, and AI agent prompt templates.

## Tech Stack
- Language: TypeScript, Bash, Markdown
- Runtime: Node.js, Bun
- Tools: Claude Code CLI

## Code Organization
- `skills/` - Workflow automation skills (brainstorming, delegation, integration, etc.)
- `hooks/` - Git and Claude Code hooks
- `rules/` - Global rules and coding standards
- `scripts/` - Utility scripts for workflow management

## Security Considerations
- No secrets stored in repository
- Configuration templates use environment variables
- MCP server configurations may reference external services

## Known Tech Debt
- None acknowledged

## Scan Preferences
- Focus areas: Security vulnerabilities, code quality, outdated patterns
- Ignore patterns: `node_modules/`, `.git/`, `*.log`
- Severity threshold: Report Medium and above
