# Exarchos Hero Demo — Checkpoint + Rehydrate
#
# Records a terminal GIF showing:
#   1. Mid-feature workflow with /checkpoint saving state
#   2. Fresh session with /rehydrate restoring full awareness
#
# Usage:
#   brew install charmbracelet/tap/vhs   # or: go install github.com/charmbracelet/vhs@latest
#   cd docs/assets
#   vhs demo-rehydrate.tape
#
# Output: demo-rehydrate.gif + demo-rehydrate.mp4

Output demo-rehydrate.gif
Output demo-rehydrate.mp4

# ── Terminal config ──────────────────────────────────────────
Set Shell bash
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 1440
Set Height 900
Set Padding 20
Set Framerate 30
Set PlaybackSpeed 1.0
Set TypingSpeed 40ms
Set CursorBlink false

Set Theme {
  "name": "Exarchos",
  "black": "#0a0a14",
  "red": "#ef4444",
  "green": "#10B981",
  "yellow": "#f59e0b",
  "blue": "#60a5fa",
  "magenta": "#a78bfa",
  "cyan": "#22d3ee",
  "white": "#e5e7eb",
  "brightBlack": "#6b7280",
  "brightRed": "#ef4444",
  "brightGreen": "#10B981",
  "brightYellow": "#f59e0b",
  "brightBlue": "#60a5fa",
  "brightMagenta": "#a78bfa",
  "brightCyan": "#22d3ee",
  "brightWhite": "#f0f0f0",
  "background": "#0a0a14",
  "foreground": "#e5e7eb",
  "selection": "#1e293b",
  "cursor": "#22d3ee"
}

# ── Prepare simulated output scripts (hidden from recording) ─
Hide

Type "mkdir -p /tmp/exarchos-demo"
Enter
Sleep 300ms

# Script: simulated Claude Code prompt
Type@0ms `cat > /tmp/exarchos-demo/prompt.sh << 'SCRIPT'
#!/bin/bash
printf "\033[1;36m╭─\033[0m \033[1mClaude Code\033[0m \033[2m(exarchos)\033[0m\n"
printf "\033[1;36m╰─\033[0m "
SCRIPT`
Enter
Sleep 200ms
Type "chmod +x /tmp/exarchos-demo/prompt.sh"
Enter
Sleep 200ms

# Script: checkpoint output
Type@0ms `cat > /tmp/exarchos-demo/checkpoint.sh << 'SCRIPT'
#!/bin/bash
sleep 0.3
printf "\n"
printf "\033[1;32m✓\033[0m \033[1mCheckpoint saved\033[0m\n"
printf "\n"
printf "  \033[1mFeature:\033[0m  user-authentication\n"
printf "  \033[1mPhase:\033[0m    delegate\n"
printf "  \033[1mTasks:\033[0m    3/5 complete\n"
printf "  \033[1mDesign:\033[0m   docs/designs/2026-03-01-user-auth.md\n"
printf "  \033[1mPlan:\033[0m     docs/plans/2026-03-01-user-auth.md\n"
printf "\n"
printf "  \033[2mResume with /rehydrate or start a new session —\033[0m\n"
printf "  \033[2mSessionStart hook auto-discovers active workflows.\033[0m\n"
printf "\n"
SCRIPT`
Enter
Sleep 200ms
Type "chmod +x /tmp/exarchos-demo/checkpoint.sh"
Enter
Sleep 200ms

# Script: rehydrate output
Type@0ms `cat > /tmp/exarchos-demo/rehydrate.sh << 'SCRIPT'
#!/bin/bash
sleep 0.4
printf "\n"
printf "\033[1;36m⟳\033[0m \033[1mWorkflow rehydrated:\033[0m user-authentication\n"
printf "\n"
printf "  \033[1mPhase:\033[0m    delegate  \033[1mType:\033[0m feature\n"
printf "  \033[1mDesign:\033[0m   docs/designs/2026-03-01-user-auth.md\n"
printf "  \033[1mPlan:\033[0m     docs/plans/2026-03-01-user-auth.md\n"
printf "\n"
printf "  \033[1mTask progress:\033[0m\n"
printf "  \033[32m✓\033[0m task-001  Auth types + interfaces        \033[32mcomplete\033[0m\n"
printf "  \033[32m✓\033[0m task-002  JWT token generation           \033[32mcomplete\033[0m\n"
printf "  \033[32m✓\033[0m task-003  Token validation middleware    \033[32mcomplete\033[0m\n"
printf "  \033[33m◉\033[0m task-004  Error handling + edge cases    \033[33mpending\033[0m\n"
printf "  \033[33m◉\033[0m task-005  Integration tests              \033[33mpending\033[0m\n"
printf "\n"
printf "  \033[1mNext action:\033[0m Dispatch remaining tasks (4-5)\n"
printf "  \033[2mRestored in ~2.1k tokens\033[0m\n"
printf "\n"
SCRIPT`
Enter
Sleep 200ms
Type "chmod +x /tmp/exarchos-demo/rehydrate.sh"
Enter
Sleep 200ms

# Script: next action after rehydrate
Type@0ms `cat > /tmp/exarchos-demo/continue.sh << 'SCRIPT'
#!/bin/bash
sleep 0.5
printf "\n"
printf "  Spawning subagents for remaining tasks...\n"
sleep 0.3
printf "\n"
printf "  \033[34m→\033[0m Subagent A  \033[2mtask-004 · worktree: feat/error-handling\033[0m\n"
sleep 0.2
printf "  \033[34m→\033[0m Subagent B  \033[2mtask-005 · worktree: feat/integration-tests\033[0m\n"
printf "\n"
printf "  \033[2mMonitoring progress...\033[0m\n"
SCRIPT`
Enter
Sleep 200ms
Type "chmod +x /tmp/exarchos-demo/continue.sh"
Enter
Sleep 200ms

Type "clear"
Enter
Sleep 300ms

Show

# ═══════════════════════════════════════════════════════════════
# SCENE 1: Mid-feature — checkpoint
# ═══════════════════════════════════════════════════════════════

# Show the prompt
Hide
Type "bash /tmp/exarchos-demo/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1s

# User types /checkpoint
Type "/checkpoint"
Sleep 500ms
Enter

# Show checkpoint output
Hide
Type "bash /tmp/exarchos-demo/checkpoint.sh"
Enter
Show
Sleep 3s

# ═══════════════════════════════════════════════════════════════
# SCENE 2: Fresh session — rehydrate
# ═══════════════════════════════════════════════════════════════

# Clear screen to simulate new session
Hide
Type "clear"
Enter
Sleep 300ms

# Show a fresh prompt with timestamp
Type@0ms `printf "\033[2m── new session ──────────────────────────────────────\033[0m\n\n"`
Enter
Sleep 200ms
Type "bash /tmp/exarchos-demo/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1.5s

# User types /rehydrate
Type "/rehydrate"
Sleep 500ms
Enter

# Show rehydrate output
Hide
Type "bash /tmp/exarchos-demo/rehydrate.sh"
Enter
Show
Sleep 4s

# ═══════════════════════════════════════════════════════════════
# SCENE 3: Agent continues where it left off
# ═══════════════════════════════════════════════════════════════

# Show the prompt again
Hide
Type "bash /tmp/exarchos-demo/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1s

# Agent auto-continues
Hide
Type "bash /tmp/exarchos-demo/continue.sh"
Enter
Show
Sleep 3s

# Hold on final frame
Sleep 2s
