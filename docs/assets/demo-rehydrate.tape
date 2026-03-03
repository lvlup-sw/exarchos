# Exarchos Hero Demo — Checkpoint + Rehydrate
#
# Records a terminal GIF showing:
#   1. Mid-feature workflow with /exarchos:checkpoint saving state
#   2. Fresh session with /exarchos:rehydrate restoring full awareness
#   3. Agent continues exactly where it left off
#
# Usage:
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

# ── Set script path ──────────────────────────────────────────
Env DEMO "docs/assets/demo-scripts"

# ═══════════════════════════════════════════════════════════════
# SCENE 1: Mid-feature — checkpoint
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1s

Type "/exarchos:checkpoint"
Sleep 500ms
Enter

Hide
Type "bash $DEMO/checkpoint.sh"
Enter
Show
Sleep 3s

# ═══════════════════════════════════════════════════════════════
# SCENE 2: Fresh session — rehydrate
# ═══════════════════════════════════════════════════════════════

Hide
Type "clear"
Enter
Sleep 300ms
Type "bash $DEMO/new-session.sh"
Enter
Sleep 200ms
Type "bash $DEMO/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1.5s

Type "/exarchos:rehydrate"
Sleep 500ms
Enter

Hide
Type "bash $DEMO/rehydrate.sh"
Enter
Show
Sleep 4s

# ═══════════════════════════════════════════════════════════════
# SCENE 3: Agent continues where it left off
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1s

Hide
Type "bash $DEMO/continue.sh"
Enter
Show
Sleep 3s

Sleep 2s
