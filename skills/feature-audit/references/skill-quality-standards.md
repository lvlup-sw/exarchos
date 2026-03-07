# Skill Quality Standards

Audit criteria for skills created or modified during a feature, derived from Anthropic's *The Complete Guide to Building Skills for Claude* (authoritative reference).

When the feature under audit includes new or modified skills, evaluate them against these standards as part of D3 (Context Economy) and D5 (Workflow Determinism).

---

## 1. Fundamentals

### Progressive Disclosure (Three-Level System)

Skills must use a three-level information architecture to minimize token usage:

| Level | Location | Loaded When | Content |
|-------|----------|-------------|---------|
| L1: Frontmatter | YAML header | Always (system prompt) | Name, description, metadata — just enough for Claude to decide when to load |
| L2: SKILL.md body | Markdown after frontmatter | When skill is relevant to task | Core workflow instructions and guidance |
| L3: References | `references/` directory | On demand, when Claude navigates to them | Templates, detailed guides, checklists, examples, code blocks |

**Audit checks:**
- SKILL.md body contains only workflow steps, not templates or large code blocks
- Heavy content (tables, checklists, examples) lives in `references/` and is linked, not inlined
- References are discoverable from SKILL.md body via clear links like `See references/foo.md`

### Composability

Skills must work well alongside other simultaneously loaded skills.

**Audit checks:**
- No global state assumptions that conflict with other skills
- Trigger phrases don't overlap with other loaded skills
- Skill doesn't assume it's the only capability available

### Portability

Skills should work across Claude.ai, Claude Code, and API without modification.

**Audit checks:**
- No surface-specific instructions (e.g., "click the button in the sidebar")
- Dependencies (MCP servers, tools) are declared in metadata, not assumed

---

## 2. Planning & Design

### Use Case Definition

Every skill should serve 2-3 concrete, identifiable use cases.

**Audit checks:**
- Can articulate specific user scenarios the skill addresses
- Workflow steps map to real user outcomes, not abstract capabilities

### Skill Category Fit

Skills should align with one of three primary categories:

| Category | Purpose | Key Techniques |
|----------|---------|----------------|
| Document & Asset Creation | Consistent, high-quality output generation | Embedded style guides, templates, quality checklists |
| Workflow Automation | Multi-step processes with consistent methodology | Step-by-step gates, templates, built-in review, iterative refinement |
| MCP Enhancement | Workflow guidance on top of tool access | Multi-MCP coordination, embedded domain expertise, error handling |

### Problem-First vs Tool-First Framing

- **Problem-first:** User describes outcomes; skill orchestrates the right tool calls
- **Tool-first:** User has tool access; skill teaches optimal workflows and best practices

**Audit check:** Skill's framing is consistent — instructions either orchestrate toward outcomes or teach best practices, not a confused mix of both.

---

## 3. Technical Requirements

### File Structure

```
skill-name/              # kebab-case folder name
  SKILL.md                # Required — exact spelling, case-sensitive
  scripts/                # Optional — executable code
  references/             # Optional — documentation loaded on demand
  assets/                 # Optional — templates, fonts, icons
```

**Audit checks:**
- No README.md inside skill folder (all docs go in SKILL.md or references/)
- SKILL.md is exactly `SKILL.md` (not `skill.md`, `Skill.md`, `SKILL.MD`)
- Folder name is kebab-case (no spaces, underscores, or capitals)

### YAML Frontmatter

**Required fields:**

| Field | Rules |
|-------|-------|
| `name` | kebab-case, no spaces or capitals, should match folder name |
| `description` | Under 1,024 characters. Must include WHAT the skill does + WHEN to use it (trigger phrases). No XML angle brackets. Include specific tasks users might say. |

**Optional fields:**

| Field | Notes |
|-------|-------|
| `license` | MIT, Apache-2.0, etc. Use if making skill open source |
| `compatibility` | 1-500 chars. Environment requirements (intended product, system packages, network access) |
| `allowed-tools` | Restrict tool access (e.g., `Bash(python:*) Bash(npm:*) WebFetch`) |
| `metadata` | Custom key-value pairs. Suggested: `author`, `version`, `mcp-server`, `category`, `tags`, `documentation`, `support` |

**Forbidden in frontmatter:**
- XML angle brackets (`<` or `>`) — security restriction, frontmatter appears in system prompt
- Skills named with "claude" or "anthropic" prefix (reserved)

### Description Quality

The description is the most important field — it determines whether Claude loads the skill.

**Structure:** `[What it does] + [When to use it] + [Key capabilities]`

**Good description audit criteria:**
- Specific and actionable (not "Helps with projects")
- Includes trigger phrases users would actually say
- Mentions relevant file types if applicable
- Includes negative triggers ("Do NOT use for X") to prevent over-triggering
- Under 1,024 characters

---

## 4. Writing Effective Instructions

### Be Specific and Actionable

```
# Good
Run `python scripts/validate.py --input {filename}` to check data format.
If validation fails, common issues include:
- Missing required fields (add them to the CSV)
- Invalid date formats (use YYYY-MM-DD)

# Bad
Validate the data before proceeding.
```

**Audit checks:**
- Instructions use specific commands with actual tool/script names
- Error cases include concrete resolution steps
- No vague directives like "make sure" or "validate properly"

### Instructions Structure

- Put critical instructions at the top
- Use `## Important` or `## Critical` headers for key rules
- Use bullet points and numbered lists (not prose paragraphs)
- Repeat key points if needed for emphasis

### Avoid Ambiguous Language

```
# Bad
Make sure to validate things properly

# Good
CRITICAL: Before calling create_project, verify:
- Project name is non-empty
- At least one team member assigned
- Start date is not in the past
```

### Deterministic over Prose Validation

For critical validations, bundle scripts that perform checks programmatically rather than relying on language instructions. Code is deterministic; language interpretation isn't.

**Audit check:** Checkable conditions use scripts with exit codes, not prose instructions that depend on LLM interpretation.

### Combat Model Laziness

Add explicit encouragement for thoroughness:

```
## Performance Notes
- Take your time to do this thoroughly
- Quality is more important than speed
- Do not skip validation steps
```

Note: Adding this to user prompts is more effective than in SKILL.md.

### Reference Bundled Resources Clearly

```
Before running queries, consult `references/api-patterns.md` for:
- Rate limiting guidance
- Pagination patterns
- Error codes and handling
```

---

## 5. Testing & Iteration

### Three Testing Areas

| Area | Goal | Method |
|------|------|--------|
| Trigger testing | Skill loads at the right times | Run 10-20 test queries, track auto-load vs manual invocation |
| Functional testing | Correct outputs produced | Valid outputs, API calls succeed, error handling works, edge cases covered |
| Performance comparison | Skill improves over baseline | Compare tool calls, token consumption, failed API calls, user corrections with vs without skill |

### Quantitative Metrics

- Skill triggers on 90% of relevant queries
- Completes workflow in X tool calls (compare with/without skill)
- 0 failed API calls per workflow

### Qualitative Metrics

- Users don't need to prompt Claude about next steps
- Workflows complete without user correction
- Consistent results across sessions
- New users can accomplish tasks on first try with minimal guidance

### Iteration Signals

**Undertriggering** (skill doesn't load when it should):
- Add more detail and nuance to description
- Include keywords for technical terms

**Overtriggering** (skill loads for irrelevant queries):
- Add negative triggers ("Do NOT use for X")
- Be more specific in description
- Clarify scope

**Instructions not followed:**
- Instructions too verbose — keep concise, use bullets, move detail to references
- Instructions buried — put critical ones at the top with `## Important` headers
- Ambiguous language — replace vague directives with specific commands

---

## 6. Distribution & Positioning

### Distribution Model

- **Individual:** Download skill folder, zip it, upload via Claude.ai Settings > Capabilities > Skills, or place in Claude Code skills directory
- **Organization:** Admins deploy skills workspace-wide (automatic updates, centralized management)
- **API:** Use `/v1/skills` endpoint, add via `container.skills` parameter in Messages API. Works with Claude Agent SDK for custom agents.

### When to Use API vs Claude.ai

| Use Case | Best Surface |
|----------|-------------|
| End users interacting directly, manual testing, ad-hoc workflows | Claude.ai / Claude Code |
| Programmatic use, production deployments, automated pipelines, agent systems | API |

### Positioning (Outcomes over Features)

```
# Good — focuses on outcomes
"The ProjectHub skill enables teams to set up complete project workspaces
in seconds — including pages, databases, and templates — instead of
spending 30 minutes on manual setup."

# Bad — describes implementation
"The ProjectHub skill is a folder containing YAML frontmatter and
Markdown instructions that calls our MCP server tools."
```

**Audit check:** Skill documentation and descriptions focus on what users accomplish, not how the skill is built.

### skill-creator Tool

Built into Claude.ai and available for Claude Code. Use "Help me build a skill using skill-creator" to:
- Generate skills from natural language descriptions
- Produce properly formatted SKILL.md with frontmatter
- Suggest trigger phrases and structure
- Review existing skills and suggest improvements

**Audit check:** For new skills, verify that trigger phrases and description quality meet the bar that skill-creator would produce.

---

## 7. Patterns (from early adopters)

### Pattern 1: Sequential Workflow Orchestration

**Use when:** Multi-step processes in specific order.

**Key techniques:**
- Explicit step ordering with numbered steps
- Dependencies between steps clearly stated
- Validation at each stage before proceeding
- Rollback instructions for failures

### Pattern 2: Multi-MCP Coordination

**Use when:** Workflows span multiple services.

**Key techniques:**
- Clear phase separation (one MCP per phase)
- Data passing between MCPs explicitly documented
- Validation before moving to next phase
- Centralized error handling

### Pattern 3: Iterative Refinement

**Use when:** Output quality improves with iteration.

**Key techniques:**
- Explicit quality criteria (what "done" looks like)
- Validation scripts (not prose assessment)
- Know when to stop iterating (max iterations, quality threshold)
- Iterative improvement loop clearly structured

### Pattern 4: Context-Aware Tool Selection

**Use when:** Same outcome, different tools depending on context.

**Key techniques:**
- Clear decision criteria (if X then use tool A, else tool B)
- Fallback options documented
- Transparency about choices (explain to user why a tool was chosen)

### Pattern 5: Domain-Specific Intelligence

**Use when:** Skill adds specialized knowledge beyond tool access.

**Key techniques:**
- Domain expertise embedded in logic (compliance rules, best practices)
- Compliance checks before action
- Comprehensive documentation/audit trail
- Clear governance model

---

## 8. Troubleshooting Checklist

Use this when auditing a skill that has known issues:

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Skill won't upload | SKILL.md not exact spelling, or missing `---` delimiters | Rename to exactly `SKILL.md`, fix YAML frontmatter |
| Skill doesn't trigger | Description too vague, missing trigger phrases | Add specific user phrases, mention file types |
| Skill triggers too often | Description too broad, missing negative triggers | Add "Do NOT use for X", narrow scope |
| Instructions not followed | Too verbose, buried, or ambiguous | Concise bullets, critical items first, specific commands |
| MCP calls fail | Wrong tool names, auth issues, server disconnected | Verify tool names are case-sensitive correct, check connection |
| Slow or degraded responses | SKILL.md too large, too many skills loaded | Move content to references/, keep SKILL.md under 5,000 words, consider selective enablement |

### Large Context Issues

When skill content is too large or too many skills are enabled:

1. **Optimize SKILL.md size**
   - Move detailed docs to `references/`
   - Link to references instead of inlining
   - Keep SKILL.md under 5,000 words (Exarchos convention: under 1,600 words)

2. **Reduce enabled skills**
   - Evaluate if you have more than 20-50 skills enabled simultaneously
   - Recommend selective enablement — only enable skills relevant to current work
   - Consider skill "packs" for related capabilities (enable/disable as a group)

---

## 9. Quality Checklist (Reference A from guide)

### Before Development
- [ ] 2-3 concrete use cases identified
- [ ] Tools identified (built-in or MCP)
- [ ] Planned folder structure

### During Development
- [ ] Folder named in kebab-case
- [ ] SKILL.md file exists (exact spelling)
- [ ] YAML frontmatter has `---` delimiters
- [ ] `name` field: kebab-case, no spaces, no capitals
- [ ] `description` includes WHAT and WHEN
- [ ] No XML tags anywhere in frontmatter
- [ ] Instructions are clear and actionable
- [ ] Error handling included
- [ ] Examples provided
- [ ] References clearly linked

### Before Upload/Distribution
- [ ] Tested triggering on obvious tasks
- [ ] Tested triggering on paraphrased requests
- [ ] Verified doesn't trigger on unrelated topics
- [ ] Functional tests pass
- [ ] Tool integration works (if applicable)

### After Upload
- [ ] Test in real conversations
- [ ] Monitor for under/over-triggering
- [ ] Iterate on description and instructions
- [ ] Update version in metadata
