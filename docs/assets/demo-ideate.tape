# Exarchos Demo — Feature Workflow
#
# Records a terminal GIF showing ideate → plan → delegate:
#   1. User kicks off /exarchos:ideate with a feature description
#   2. Agent asks a question, presents approaches, user picks one
#   3. Design saved, gate passes, auto-chains to /exarchos:plan
#   4. Plan generated with TDD tasks, user approves
#   5. Auto-chains to /exarchos:delegate — subagents dispatched to worktrees
#   6. Progress monitoring shows parallel execution
#
# Usage:
#   cd docs/assets
#   vhs demo-ideate.tape
#
# Output: demo-ideate.gif + demo-ideate.mp4

Output demo-ideate.gif
Output demo-ideate.mp4

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
# SCENE 1: User kicks off /exarchos:ideate
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1s

Type "/exarchos:ideate Add rate limiting to the API"
Sleep 500ms
Enter

Hide
Type "bash $DEMO/ideate-init.sh"
Enter
Show
Sleep 2s

# ═══════════════════════════════════════════════════════════════
# SCENE 2: Agent asks a clarifying question
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/ideate-question.sh"
Enter
Show
Sleep 3s

# ═══════════════════════════════════════════════════════════════
# SCENE 3: User answers
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1s

Type "External clients. We'll be multi-instance by Q2."
Sleep 300ms
Enter
Sleep 1.5s

# ═══════════════════════════════════════════════════════════════
# SCENE 4: Agent presents approaches
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/ideate-approaches.sh"
Enter
Show
Sleep 5s

# ═══════════════════════════════════════════════════════════════
# SCENE 5: User picks approach B
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1s

Type "Go with B."
Sleep 300ms
Enter
Sleep 1s

# ═══════════════════════════════════════════════════════════════
# SCENE 6: Design saved, gate passes, auto-chains to /exarchos:plan
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/ideate-saved.sh"
Enter
Show
Sleep 3s

# ═══════════════════════════════════════════════════════════════
# SCENE 7: Plan generated, awaiting approval
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/plan.sh"
Enter
Show
Sleep 4s

# ═══════════════════════════════════════════════════════════════
# SCENE 8: User approves the plan
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/prompt.sh"
Enter
Sleep 300ms
Show

Sleep 1s

Type "Looks good, approved."
Sleep 300ms
Enter
Sleep 1s

# ═══════════════════════════════════════════════════════════════
# SCENE 9: Delegation — subagents dispatched to worktrees
# ═══════════════════════════════════════════════════════════════

Hide
Type "bash $DEMO/delegate.sh"
Enter
Show
Sleep 8s

Sleep 2s
