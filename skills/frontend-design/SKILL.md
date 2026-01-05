# Frontend Design Skill

## Overview

Create distinctive, production-grade frontend interfaces that avoid generic AI aesthetics. This skill transforms Claude from generating "safe" designs into creating bold, memorable interfaces.

## Triggers

Activate this skill when:
- User requests frontend/UI work
- Working with: `.tsx`, `.jsx`, `.vue`, `.svelte`, `.html`, `.css`, `.scss`
- User mentions: dashboard, landing page, UI, interface, component, form, modal
- Design document specifies frontend implementation

## Core Directive

<frontend_aesthetics>
You tend to converge toward generic, "on distribution" outputs. In frontend design, this creates what users call the "AI slop" aesthetic. Avoid this: make creative, distinctive frontends that surprise and delight.

Before writing ANY frontend code, you MUST:
1. State your aesthetic direction (e.g., "brutalist", "neo-corporate", "warm minimal")
2. Declare your font choice and why
3. Describe your color strategy
4. Commit to these choices consistently
</frontend_aesthetics>

## Design Thinking Process

Before coding, understand context:

| Question | Purpose |
|----------|---------|
| What is this interface for? | Function drives form |
| Who is the audience? | Developer tool ≠ consumer app |
| What tone? | Playful, serious, technical, luxurious |
| What constraints? | Framework, browser support, performance |
| What makes this distinctive? | Not "what's safe" but "what's memorable" |

## Typography

<typography_requirements>
Typography instantly signals quality. Choose fonts that are beautiful, unique, and interesting.

### NEVER Use (Generic/Overused)
- Inter, Roboto, Open Sans, Lato
- Arial, Helvetica, system-ui defaults
- Space Grotesk (overused by AI)

### Impact Choices by Context

| Context | Recommended Fonts |
|---------|-------------------|
| Code/Developer | JetBrains Mono, Fira Code, Berkeley Mono |
| Editorial/Content | Playfair Display, Crimson Pro, Fraunces, Newsreader |
| Startup/Modern | Clash Display, Satoshi, Cabinet Grotesk, General Sans |
| Technical/Enterprise | IBM Plex family, Source Sans 3, Sohne |
| Distinctive/Bold | Bricolage Grotesque, Obviously, Instrument Serif |

### Pairing Principle
High contrast = interesting.
- Display + monospace
- Serif + geometric sans
- Variable font across extreme weights

### Weight & Size Extremes
Use extremes, not increments:
- Weights: 100/200 vs 800/900 (not 400 vs 600)
- Size jumps: 3x+ (not 1.5x)

### Execution
1. Pick ONE distinctive font
2. State your choice before coding
3. Load from Google Fonts or local
4. Use decisively throughout
</typography_requirements>

## Color & Theme

<color_requirements>
### Commit to Cohesion
- Define CSS variables for your palette
- Dominant color with sharp accents outperforms timid, evenly-distributed palettes
- Draw inspiration from IDE themes, cultural aesthetics, nature

### What to Avoid
- Purple gradients on white backgrounds (ultimate AI cliche)
- Safe corporate blue
- Timid, washed-out colors
- "Professional gray" everything

### What to Embrace
- Bold, intentional color choices
- Dark themes with vibrant accents
- Monochromatic with one accent color
- Unexpected palettes (terracotta + sage, electric blue + cream)

### CSS Variable Pattern
```css
:root {
  --color-bg: #0a0a0b;
  --color-surface: #141417;
  --color-text: #fafafa;
  --color-text-muted: #71717a;
  --color-accent: #22d3ee;
  --color-accent-muted: #22d3ee33;
}
```
</color_requirements>

## Motion & Animation

<motion_requirements>
### High-Impact Moments
One well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions.

### Priority Order
1. Page load orchestration (staggered reveals using `animation-delay`)
2. State transitions (loading -> loaded, collapsed -> expanded)
3. Hover states (subtle transforms, color shifts)
4. Scroll-triggered effects (intersection observer)

### Implementation
- CSS-only for HTML projects
- Motion library (Framer Motion) for React when available
- Use `animation-delay` for staggered effects:

```css
.item { animation: fadeSlideIn 0.5s ease-out forwards; opacity: 0; }
.item:nth-child(1) { animation-delay: 0.1s; }
.item:nth-child(2) { animation-delay: 0.2s; }
.item:nth-child(3) { animation-delay: 0.3s; }
```

### What to Avoid
- Animation for animation's sake
- Jarring, fast transitions
- Inconsistent easing curves
- Blocking animations on critical paths
</motion_requirements>

## Spatial Composition

<layout_requirements>
### Break the Grid (Intentionally)
- Asymmetry over perfect symmetry
- Overlap elements for depth
- Diagonal flow, not just horizontal/vertical
- Generous whitespace (more than feels comfortable)

### Unexpected Layouts
- Off-center hero content
- Overlapping cards/images
- Text that breaks boundaries
- Layered depth with shadows/blur

### What to Avoid
- Perfectly centered everything
- Equal spacing everywhere
- Predictable 12-column grids without variation
- Flat, same-plane layouts
</layout_requirements>

## Backgrounds & Atmosphere

<background_requirements>
### Create Depth, Not Flatness
Backgrounds create atmosphere. Never default to solid white or plain dark.

### Techniques
- **Layered gradients:** Multiple gradient layers for richness
- **Subtle patterns:** Dot grids, noise textures, geometric shapes
- **Contextual effects:** Glows, blurs that match the aesthetic
- **Mesh gradients:** Complex, organic color blends

### Example: Rich Dark Background
```css
.background {
  background:
    radial-gradient(ellipse at top, #1a1a2e 0%, transparent 50%),
    radial-gradient(ellipse at bottom right, #16213e 0%, transparent 50%),
    linear-gradient(180deg, #0f0f0f 0%, #1a1a1a 100%);
}
```

### What to Avoid
- Pure white (#ffffff) backgrounds
- Pure black (#000000) backgrounds
- Solid, flat colors
- Generic gray (#f5f5f5) backgrounds
</background_requirements>

## Anti-Patterns Checklist

Before submitting ANY frontend code, verify you have NOT:

| Anti-Pattern | Check |
|--------------|-------|
| Used Inter, Roboto, or Arial | |
| Used purple gradient on white | |
| Centered everything symmetrically | |
| Used solid white/gray background | |
| Added animations without purpose | |
| Used safe corporate blue | |
| Created a predictable grid layout | |
| Made it look like every other AI output | |

## Execution Standard

Match code complexity to aesthetic vision:
- **Maximalist designs:** Elaborate code, extensive animations, rich interactions
- **Minimalist designs:** Precision in spacing, typography, subtle refinements

Both require equal attention to detail--minimalism is not an excuse for laziness.

## Example Aesthetic Directions

| Direction | Characteristics |
|-----------|-----------------|
| Brutalist | Raw, exposed structure, harsh contrasts, unconventional layouts |
| Neo-Corporate | Clean but warm, subtle gradients, refined typography |
| Cyberpunk | Dark backgrounds, neon accents, tech textures, glitch effects |
| Warm Minimal | Cream/beige tones, serif typography, generous spacing |
| Editorial | Magazine-like, bold headlines, asymmetric layouts |
| Retro-Futurism | Vintage sci-fi palettes, chrome effects, grid patterns |

## Integration with Workflow

### During Ideate
When brainstorming frontend features, explicitly discuss aesthetic direction as part of the design.

### During Plan
Implementation plans for frontend work should specify:
- Chosen aesthetic direction
- Font selections
- Color palette (CSS variables)
- Animation strategy

### During Delegate
Pass the aesthetics prompt (`skills/frontend-design/prompts/aesthetics.md`) to implementers.

## Completion Criteria

- [ ] Aesthetic direction explicitly stated before coding
- [ ] Font choice is distinctive (not on "never use" list)
- [ ] Color palette defined with CSS variables
- [ ] No anti-patterns present
- [ ] Motion serves purpose, not decoration
- [ ] Layout has intentional asymmetry or depth
- [ ] Background creates atmosphere
- [ ] Result is memorable, not generic
