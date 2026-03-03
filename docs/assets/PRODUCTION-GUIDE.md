# Visual Asset Production Guide

Visual assets referenced by the README. Create these before the general release.

## 1. Hero Demo GIF — `demo-rehydrate.gif`

**What to record:** A terminal session showing checkpoint → rehydrate flow.

**Script:**
1. Show an active workflow mid-feature (e.g., delegate phase, 3/5 tasks complete)
2. Run `/checkpoint` — show state being saved
3. Cut to a fresh session (clear terminal, new timestamp)
4. Run `/rehydrate` — show workflow state restored (phase, tasks, design doc path, next action)
5. Agent continues from where it left off

**Specs:**
- Width: 720px (retina: 1440px)
- Duration: 15-20 seconds
- Dark terminal theme (match GitHub dark mode)
- No typing delays > 50ms
- Format: GIF (for GitHub rendering) + MP4 (for potential video embed)

**Tools (pick one):**
- [vhs](https://github.com/charmbracelet/vhs) — scripted terminal recordings, reproducible
- [asciinema](https://asciinema.org) + [agg](https://github.com/asciinema/agg) — record then convert to GIF
- [Gifox](https://gifox.app) / [LICEcap](https://www.cockos.com/licecap/) — screen capture to GIF

**vhs script example:**
```tape
Set Theme "Dracula"
Set Width 1440
Set Height 800
Set FontSize 16

Type "/checkpoint"
Enter
Sleep 2s

# ... (expand with full scenario)
```

## 2. Architecture Diagram — `architecture.svg`

**What to create:** Clean SVG version of the ASCII architecture diagram in the README.

**Layout:**
```
Claude Code (Lead) box at top
    │
Exarchos MCP box in middle (with 4 labeled capabilities)
    │
Three Teammate boxes at bottom (with "worktree" labels)
```

**Style:**
- Dark background (#1a1a2e or similar)
- Monospace labels (JetBrains Mono, Fira Code, or similar)
- Muted accent colors — avoid bright primaries
- Clean connecting lines, no unnecessary decoration
- Width: 720px

**Tools:**
- [Excalidraw](https://excalidraw.com) — quick, hand-drawn feel
- [Figma](https://figma.com) — polished, exact
- [draw.io](https://draw.io) — export as SVG

## 3. Before/After Comparison — `before-after.png` (optional)

**What to create:** Side-by-side comparison of manual plan.md workflow vs. Exarchos workflow.

**Left side (Before — "Manual"):**
- Multiple terminal panes (tmux)
- Scattered markdown files
- Red indicators for: context lost, re-explaining, manual review
- Caption: "8 tmux panes. Constant oversight. Context dies mid-task."

**Right side (After — "Exarchos"):**
- Single clean terminal
- Structured workflow output
- Green indicators for: checkpoint/rehydrate, auto-continue, quality gates
- Caption: "2 checkpoints. Auto-continuation. State persists."

**Specs:**
- Width: 1200px (600px per side)
- Dark theme
- Minimal text — visual contrast should tell the story

**Priority:** Lower than demo GIF and architecture diagram. Create if time permits.

## 4. Workflow Diagram — `feature-workflow.svg` (optional)

**What to create:** Visual version of the feature workflow ASCII diagram.

**Priority:** Low — the ASCII version is clear enough and renders well on GitHub.

---

## Asset Checklist

- [ ] `demo-rehydrate.gif` — Hero demo recording
- [ ] `architecture.svg` — Clean architecture diagram
- [ ] `before-after.png` — Manual vs. Exarchos comparison (optional)
- [ ] `feature-workflow.svg` — Visual workflow diagram (optional)
