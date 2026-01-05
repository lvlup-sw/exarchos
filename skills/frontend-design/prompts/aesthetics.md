# Frontend Aesthetics Requirements

You are implementing frontend code. Follow these requirements to avoid generic AI output.

## Before Coding

1. State your aesthetic direction (e.g., "brutalist", "neo-corporate", "warm minimal")
2. Declare your font choice (see banned/recommended lists below)
3. Define your color palette with CSS variables
4. Describe your animation strategy

## Typography

### NEVER Use
- Inter, Roboto, Open Sans, Lato, Arial, Helvetica
- system-ui defaults
- Space Grotesk (overused by AI)

### Recommended by Context

| Context | Fonts |
|---------|-------|
| Developer | JetBrains Mono, Fira Code, Berkeley Mono |
| Editorial | Playfair Display, Crimson Pro, Fraunces |
| Modern | Clash Display, Satoshi, Cabinet Grotesk |
| Technical | IBM Plex, Source Sans 3 |

### Principles
- High contrast pairings (display + monospace, serif + geometric sans)
- Extreme weights (100/200 vs 800/900, not 400 vs 600)
- Size jumps of 3x+, not incremental

## Color

- Commit to a cohesive palette with CSS variables
- Dominant color + sharp accents (not evenly distributed)
- Draw from IDE themes, cultural aesthetics, nature

### Avoid
- Purple gradients on white (AI cliche)
- Safe corporate blue
- Timid, washed-out colors
- #f5f5f5 gray backgrounds

### CSS Pattern
```css
:root {
  --color-bg: #0a0a0b;
  --color-surface: #141417;
  --color-text: #fafafa;
  --color-text-muted: #71717a;
  --color-accent: #22d3ee;
}
```

## Motion

### Priority
1. Page load orchestration (staggered reveals)
2. State transitions
3. Hover states
4. Scroll-triggered effects

### Implementation
```css
.item { animation: fadeSlideIn 0.5s ease-out forwards; opacity: 0; }
.item:nth-child(1) { animation-delay: 0.1s; }
.item:nth-child(2) { animation-delay: 0.2s; }
```

### Avoid
- Animation without purpose
- Jarring transitions
- Inconsistent easing

## Layout

- Embrace asymmetry over perfect symmetry
- Create depth with overlap/shadows
- Use generous whitespace
- Break predictable grids intentionally

### Avoid
- Centering everything
- Equal spacing everywhere
- Flat, same-plane layouts

## Backgrounds

- Layer gradients for richness
- Add subtle patterns or textures
- Create atmosphere, not flatness

### Example
```css
.background {
  background:
    radial-gradient(ellipse at top, #1a1a2e 0%, transparent 50%),
    linear-gradient(180deg, #0f0f0f 0%, #1a1a1a 100%);
}
```

### Avoid
- Pure white (#ffffff)
- Pure black (#000000)
- Solid flat colors

## Verify Before Submitting

- [ ] No generic fonts (Inter, Roboto, Arial)
- [ ] No purple gradient on white
- [ ] Not symmetrically centered everything
- [ ] Background has depth/texture
- [ ] Animations serve purpose
- [ ] Result is distinctive, not "AI slop"
