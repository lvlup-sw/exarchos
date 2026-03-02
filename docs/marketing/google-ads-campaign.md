# Google Ads Campaign Strategy — PMF Validation

*Created: 2026-03-02*

## Campaign Objective

Validate product-market fit for Exarchos through paid search, measuring demand signals (CTR, CPC) and conversion intent (GitHub star, marketplace install). This is a **learning campaign**, not a scale campaign — budget is for data, not volume.

## Target CPA & Budget

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Monthly budget | $500-1,000 | PMF validation testing range |
| Daily budget | $15-30 | Enough for statistical significance at dev-tool CPCs |
| Target CPC | $2-5 | Developer/DevOps keywords typically $3-8 |
| Conversion goal | GitHub star or marketplace install page visit | Low-friction, measurable |
| Success signals | CTR >2%, CPC <$5, meaningful conversion rate | Indicates resonant messaging |

## Platform: Google Ads (Search Only)

**Why search only for validation:**
- High-intent traffic — people actively searching for solutions
- Clear signal — CTR measures message resonance against search intent
- Fastest path to PMF signal — no creative production needed (text ads only)
- Developer audience searches; they don't browse Meta/TikTok for dev tools

## Campaign Structure

```
Account: lvlup-sw
├── Campaign 1: GOOG_Search_HighIntent_ExarchosCore_2026Q1
│   ├── Ad Group 1: Claude Code Workflow Pain
│   ├── Ad Group 2: Agent Context Loss
│   └── Ad Group 3: AI Code Quality
├── Campaign 2: GOOG_Search_CategoryCapture_DevTooling_2026Q1
│   ├── Ad Group 1: Claude Code Plugins
│   ├── Ad Group 2: AI Coding Workflow
│   └── Ad Group 3: Agent Governance
└── Campaign 3: GOOG_Search_Brand_Exarchos_Ongoing
    └── Ad Group 1: Brand Terms
```

---

## Campaign 1: High-Intent Pain Keywords

**Budget allocation:** 50% of total ($250-500/mo)
**Bid strategy:** Manual CPC initially, switch to Maximize Conversions after 30+ conversions

### Ad Group 1: Claude Code Workflow Pain

**Keywords (phrase match):**
- "claude code context loss"
- "claude code loses context"
- "claude code workflow"
- "claude code session management"
- "claude code persistent state"
- "claude code agent workflow"

**Keywords (exact match):**
- [claude code context compaction]
- [claude code checkpoint resume]
- [claude code rehydrate]

### Ad Group 2: Agent Context Loss

**Keywords (phrase match):**
- "ai agent context loss"
- "ai coding agent workflow"
- "ai agent loses memory"
- "llm context window problem"
- "ai code review automation"

### Ad Group 3: AI Code Quality / Verification

**Keywords (phrase match):**
- "ai generated code quality"
- "ai code verification"
- "verify ai code"
- "ai code review tool"
- "llm code quality gates"

---

## Campaign 2: Category Capture

**Budget allocation:** 35% of total ($175-350/mo)
**Bid strategy:** Manual CPC

### Ad Group 1: Claude Code Plugins

**Keywords (phrase match):**
- "claude code plugins"
- "claude code extensions"
- "best claude code plugins"
- "claude code marketplace"
- "claude code mcp server"

### Ad Group 2: AI Coding Workflow / Structured Development

**Keywords (phrase match):**
- "ai sdlc workflow"
- "structured ai development"
- "ai pair programming workflow"
- "agentic development tools"
- "ai coding best practices"
- "spec driven development ai"
- "plan file ai coding"
- "claude code plan workflow"
- "ai development lifecycle"

### Ad Group 3: Agent Teams / Multi-Agent Coordination

**Keywords (phrase match):**
- "ai agent teams"
- "multi agent coding"
- "agent orchestration developer"
- "ai agent coordination"
- "parallel coding agents"
- "claude code parallel agents"
- "tmux coding agents"
- "multi agent workflow tool"
- "agent context drift"
- "coding agent orchestration overhead"

---

## Campaign 3: Brand

**Budget allocation:** 15% of total ($75-150/mo)
**Bid strategy:** Manual CPC, low bids

**Keywords:**
- [exarchos]
- [exarchos claude code]
- [lvlup-sw exarchos]
- "exarchos plugin"

---

## Negative Keywords (Universal)

Apply across all campaigns:

```
free course, tutorial, learn, salary, job, hiring, careers, interview,
openai, gpt, copilot, cursor, windsurf, chatgpt, gemini,
enterprise pricing, consulting, agency, freelance,
reddit, youtube, podcast, book, certification
```

---

## Ad Creative

### Responsive Search Ads (RSAs)

Each ad group gets one RSA with 15 headlines and 4 descriptions. Google tests combinations.

#### Headlines (30 chars max) — Master List

**Pain-focused (pin-eligible for position 1):**
1. `Agents Forget. Exarchos Won't` (30) — *rehydrate*
2. `Context Dies? Workflow Lives` (28) — *rehydrate*
3. `Checkpoint. Rehydrate. Ship.` (29) — *rehydrate*
4. `Stop Losing Agent Context` (25) — *pain*
5. `Your Plan.md, Systematized` (25) — *structured workflows*

**Benefit-focused:**
6. `Durable Agent Workflows` (23) — *durability*
7. `Verified AI-Written Code` (24) — *verification*
8. `SDLC Structure for Claude` (25) — *category*
9. `Design → Plan → Ship` (19) — *structured workflows*
10. `90% Less Token Overhead` (23) — *token efficiency*

**Proof/specificity:**
11. `5 Quality Gates Per Phase` (25) — *verification*
12. `2 Checkpoints. Full Audit.` (27) — *structured workflows*
13. `Free Open Source Plugin` (22) — *CTA*
14. `Parallel Agent Teams` (20) — *teams*

**Cognitive load / orchestration:**
15. `Stop Landing Planes All Day` (28) — *orchestration overhead*

**CTA-focused:**
16. `Install Free From Marketplace` (30) — *CTA*

#### Descriptions (90 chars max) — Master List

**Rehydrate + artifacts emphasis:**
1. `Checkpoint mid-task, walk away, rehydrate later. Workflow resumes with full context intact.` (90)
2. `Workflows survive context compaction. Design docs, plans, and PR links persist across sessions.` (94 — trim to:) `Workflows survive context loss. Design docs, plans, and PRs persist across sessions.` (83)

**Token efficiency emphasis:**
3. `Field-projected state queries use 90% fewer tokens. Your context budget goes to code, not overhead.` (99 — trim to:) `State queries use 90% fewer tokens. Your context budget goes to code, not workflow overhead.` (89)

**Structured workflows emphasis:**
4. `Your plan.md workflow, systematized. Design, plan, implement, review, ship — with persistence.` (92 — trim to:) `Your plan.md workflow, systematized. Design, plan, review, ship — with state that persists.` (88)
5. `Design, plan, delegate to agent teams, review, ship. Quality verified at every phase.` (83)

**Core value:**
6. `Free plugin adds phase-gated SDLC workflows and 5-dimension quality gates to Claude Code.` (89)
7. `Audit trail traces every agent decision from design requirement to merged code.` (77)

**Social proof / differentiation:**
8. `Most plugins suggest good behavior. Exarchos verifies it. Five quality dimensions, every phase.` (94 — trim to:) `Most plugins suggest good behavior. Exarchos verifies it. 5 quality gates per phase.` (82)
9. `Parallel agent teams in isolated git worktrees. Orchestrator coordinates, teammates execute.` (92 — trim to:) `Parallel agent teams in isolated worktrees. Orchestrator coordinates, teammates execute.` (86)

**Orchestration overhead / cognitive load:**
10. `2 checkpoints, not 8 tmux panes. Agents work in worktrees. You approve design and merge.` (87)
11. `300+ specs later, you'll wish it persisted. Event-sourced state survives every session.` (85)

#### Recommended RSA Configuration per Ad Group

**Ad Group: Claude Code Workflow Pain**
- Pin headline 1 or 2 to position 1 (pain hook)
- Pin headline 15 to position 3 (CTA)
- Use descriptions 1, 2, 4, 6

**Ad Group: Agent Context Loss**
- Pin headline 3 or 4 to position 1 (pain hook)
- Use descriptions 1, 3, 5, 7

**Ad Group: AI Coding Workflow / Structured Development**
- Pin headline 5 or 9 to position 1 (structured workflow hook)
- Use descriptions 4, 5, 6, 8

**Ad Group: Agent Teams / Multi-Agent Coordination**
- Pin headline 14 or 15 to position 1 (orchestration hook)
- Use descriptions 9, 10, 5, 8

**Ad Group: Claude Code Plugins**
- Pin headline 8 to position 1 (category match)
- Use descriptions 5, 6, 9, 10

---

## Ad Extensions

### Sitelinks (4-6)
| Link Text | URL | Description 1 | Description 2 |
|-----------|-----|---------------|---------------|
| How It Works | /README.md#how-it-works | See the architecture | MCP server + event sourcing |
| Feature Workflow | /README.md#feature-workflow | Design to ship lifecycle | Auto-continues between checkpoints |
| Agent Teams | /README.md#how-it-works | Parallel agents in worktrees | Orchestrator + teammates |
| Free Installation | /README.md#installation | One command install | From Claude Code marketplace |

### Callouts
- Free & Open Source
- Apache-2.0 License
- 5 Quality Dimensions
- Checkpoint & Resume
- Token-Efficient Design
- Full Audit Trail

### Structured Snippets
- **Features:** Durable State, Convergence Gates, Agent Teams, Audit Trail, Rehydrate
- **Types:** Feature Workflow, Debug Workflow, Refactor Workflow

---

## Landing Page Strategy

**For PMF validation, use the GitHub README as the landing page.**

Rationale:
- Developers trust GitHub over marketing sites
- README already has product overview, architecture diagram, installation instructions
- Conversion action (star / clone / install command) is native to the platform
- Zero landing page build cost — faster to market

**URL:** `https://github.com/lvlup-sw/exarchos`

**UTM structure:**
```
?utm_source=google&utm_medium=cpc&utm_campaign={campaign_name}&utm_content={ad_group}&utm_term={keyword}
```

**Tracking:**
- GitHub doesn't support conversion pixels — track "clicks to GitHub" as proxy conversion
- Measure: CTR (message resonance), CPC (market efficiency), click-to-star rate (conversion intent)
- Use Google Ads conversion tracking on the final URL click

---

## Measurement Framework

### Week 1-2: Message Validation
| Metric | Target | Signal |
|--------|--------|--------|
| CTR | >2% | Headline resonates with search intent |
| CPC | <$5 | Competitive but sustainable |
| Impressions | 500+/week | Sufficient keyword volume |
| Quality Score | >6 | Ad relevance + landing page quality |

### Week 3-4: Angle Validation
| Analysis | Action |
|----------|--------|
| Best-performing headlines | Double down on winning angle |
| Best-performing ad groups | Shift budget toward high-intent keywords |
| CPC by keyword theme | Identify most efficient acquisition channels |
| CTR by messaging angle (pain vs. benefit vs. proof) | Refine positioning |

### Monthly Review
- Blended CPC and total spend
- Top 5 converting keywords
- Headline combination performance (Google's RSA reporting)
- Impression share (are we budget-limited or rank-limited?)
- Click-to-GitHub-star conversion rate (manual tracking)

---

## PMF Validation Decision Framework

After 4-6 weeks of data:

| Signal | Interpretation | Next Step |
|--------|---------------|-----------|
| CTR >3%, CPC <$4 | Strong message-market fit | Scale budget, build dedicated landing page |
| CTR 2-3%, CPC $4-6 | Moderate fit, needs refinement | Test new angles, refine keywords |
| CTR <2%, CPC >$6 | Weak fit or wrong channel | Reassess positioning, try content marketing instead |
| High CTR but no stars/installs | Message resonates but product doesn't convert | Landing page problem — improve README or build LP |
| Low impressions (<100/week) | Insufficient search volume | Expand to broader keywords or adjacent categories |

---

## Pre-Launch Checklist

- [ ] Google Ads account created and verified
- [ ] Billing information added
- [ ] Conversion tracking set up (click-through to GitHub as conversion)
- [ ] UTM parameters tested and working
- [ ] Negative keyword lists applied
- [ ] All RSAs created with 15 headlines + 4 descriptions each
- [ ] Ad extensions configured (sitelinks, callouts, structured snippets)
- [ ] Location targeting set (US, UK, CA, AU, DE — English-speaking dev markets)
- [ ] Language targeting: English
- [ ] Budget set to daily cap
- [ ] Campaign start date confirmed
- [ ] README reviewed for conversion readiness (clear install instructions, compelling above-the-fold)
