# Axiom Plugin Integration

How the exarchos quality review integrates general backend quality checks — through MCP-served check catalogs (platform-agnostic) and optional companion plugins (platform-dependent). Axiom and impeccable are optional skill libraries that enhance depth when available.

## Architecture

Quality checks are layered across three tiers, each progressively more platform-dependent:

- **Tier 1** (MCP gates): Automated checks via `exarchos_orchestrate` actions. Platform-agnostic.
- **Tier 2** (MCP-served catalog): `prepare_review` returns structured check patterns that any LLM agent executes. Platform-agnostic.
- **Tier 3** (Companion skills): `axiom:audit` and `impeccable:critique` provide deeper qualitative analysis. Platform-dependent (Claude Code, Cursor).

```text
Any MCP client (Claude Code, Cursor, generic)
    │
    ├── Tier 1: MCP Gates (always, automated)
    │   ├── check_static_analysis (D2 gate)
    │   ├── check_security_scan (D1 gate)
    │   ├── check_context_economy (D3 gate — advisory)
    │   ├── check_workflow_determinism (D5 gate — advisory)
    │   └── Test Desiderata evaluation
    │
    ├── Tier 2: MCP-Served Check Catalog (always, agent-executed)
    │   ├── prepare_review → returns catalog as structured data
    │   │   ├── Grep patterns (error handling, type safety, test quality, ...)
    │   │   ├── Structural checks (nesting depth, function length, ...)
    │   │   └── Heuristic instructions (LLM-guided checks)
    │   ├── Agent executes checks against codebase
    │   └── Findings fed as pluginFindings to check_review_verdict
    │
    ├── Tier 3: Companion Plugin Skills (platform-dependent, optional)
    │   ├── axiom:audit — deeper qualitative backend analysis (7 dimensions)
    │   ├── impeccable:critique — design quality analysis
    │   └── Findings fed as additional pluginFindings to verdict
    │
    └── Verdict: check_review_verdict merges ALL findings → APPROVED | NEEDS_FIXES
```

## Dimension Ownership Split

The quality review draws from three independent sources. Each source owns distinct quality dimensions with no overlap:

| Concern | Owner | Rationale |
|---------|-------|-----------|
| DIM-1: Topology | Axiom plugin (optional) | General backend quality |
| DIM-2: Observability | Axiom plugin (optional) | General backend quality |
| DIM-3: Contracts | Axiom plugin (optional) | General backend quality |
| DIM-4: Test Fidelity | Axiom plugin (optional) | General backend quality |
| DIM-5: Hygiene | Axiom plugin (optional) | General backend quality |
| DIM-6: Architecture | Axiom plugin (optional) | General backend quality |
| DIM-7: Resilience | Axiom plugin (optional) | General backend quality |
| D1: Spec Fidelity & TDD | Exarchos (always runs) | Requires workflow state (design, plan, implementation traceability) |
| D2-domain: Event Sourcing / CQRS / HSM / Saga | Exarchos (always runs) | Domain-specific to event-sourced systems |
| D3: Context Economy | Exarchos (always runs) | Specific to AI-agent skill systems |
| D5: Workflow Determinism | Exarchos (always runs) | Specific to workflow orchestration |
| Design Quality (UI, accessibility, design system, responsive) | Impeccable plugin (optional) | Design-specific concerns |

**Key distinction:** Axiom's DIM-1 through DIM-7 are general backend quality dimensions. Exarchos's D1-D5 are workflow-specific dimensions that require access to workflow state. These are complementary, not overlapping.

## Detection and Invocation Protocol

Plugin detection and invocation is performed by the **orchestrator** (commands/review.md), not by the quality-review subagent. The subagent does not have Skill tool access and should not attempt plugin invocation.

### Step 1: Detect Plugin Availability (Orchestrator)

After the quality-review subagent returns its verdict, the orchestrator checks for companion plugins in its available skills list:

- `axiom:audit` — general backend quality (7 dimensions)
- `impeccable:critique` — design quality (UI, accessibility, design system, responsive)

### Step 2: Check Configuration Override (Orchestrator)

Read the project's `.exarchos.yml` for explicit plugin toggles:

```yaml
# .exarchos.yml — plugin overrides
plugins:
  axiom:
    enabled: true    # default when key is absent
  impeccable:
    enabled: true    # default when key is absent
```

A plugin is invoked only when BOTH conditions are met:
1. The skill is present in the available skills list (plugin is installed)
2. The config does not set `plugins.<name>.enabled: false`

If the `plugins` key or any sub-key is absent from `.exarchos.yml`, the default is `enabled: true`.

### Step 3: Invoke and Merge (Orchestrator)

**axiom:audit invocation:**
1. `Skill({ skill: "axiom:audit" })` with the diff content and list of changed files
2. axiom returns findings in Standard Finding Format (`severity`, `dimension`, `file`, `line`, `message`)
3. Map axiom findings to the unified list:
   - `dimension` (DIM-1 through DIM-7) becomes the category prefix (e.g., `axiom:DIM-1-topology`)
   - `severity` maps directly (HIGH, MEDIUM, LOW)
   - axiom HIGH findings are treated identically to exarchos-native HIGH findings

**impeccable:critique invocation:**
1. `Skill({ skill: "impeccable:critique" })` with the diff content
2. impeccable returns design quality findings (`severity`, `category`, `file`, `line`, `message`)
3. Map all impeccable findings under the `design-quality` category

**Merge:** Append all plugin findings to the subagent's findings list. The merged list informs verdict escalation.

### Step 4: Verdict Escalation (Orchestrator)

Compare plugin findings against the subagent's verdict:

- If the subagent returned **APPROVED** but plugins found HIGH-severity issues → escalate to **NEEDS_FIXES**
- If the subagent returned **NEEDS_FIXES** → preserve (plugins may add more findings but verdict is already failing)
- If no plugins ran → preserve subagent verdict as-is

## Graceful Degradation

When a plugin is not installed or is disabled, the orchestrator skips it and the review proceeds with exarchos-native checks only. The orchestrator logs a "Plugin Coverage" note in the review output:

- **Not installed:** Suggests the install command (`claude plugin install axiom@lvlup-sw` or `claude plugin marketplace add pbakaus/impeccable && claude plugin install impeccable@impeccable`)
- **Disabled via config:** Notes the config key to re-enable
- **Active:** Reports the number of dimensions checked and findings produced

The subagent's verdict is unaffected by plugin absence — it operates on exarchos-native findings. Plugins can only escalate (APPROVED → NEEDS_FIXES), never downgrade.

## Verdict Mapping

The verdict uses the merged findings from all sources. The logic is the same regardless of which plugins contributed:

| Merged Findings | Verdict |
|----------------|---------|
| No HIGH findings, acceptable MEDIUM/LOW | APPROVED |
| Any HIGH findings in blocking dimensions | NEEDS_FIXES |
| Critical architectural or security issues | BLOCKED |

axiom HIGH findings and exarchos-native HIGH findings carry equal weight — both trigger NEEDS_FIXES when present in blocking dimensions.
