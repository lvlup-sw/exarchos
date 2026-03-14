# Axiom Plugin Integration

How the exarchos quality review phase delegates general backend quality checks to the axiom plugin while retaining domain-specific checks. Axiom is an optional companion plugin — quality review runs with or without it.

## Architecture

```text
/exarchos:review (quality-review stage)
    │
    ├── Tier 1: Exarchos-native checks (always runs)
    │   ├── check_static_analysis (D2 gate)
    │   ├── check_security_scan (D1 gate)
    │   ├── check_context_economy (D3 gate — advisory)
    │   ├── check_workflow_determinism (D5 gate — advisory)
    │   └── Test Desiderata evaluation
    │
    ├── Tier 2: Plugin-enhanced checks (conditional)
    │   ├── Detect axiom:audit skill availability
    │   ├── Check .exarchos.yml plugins.axiom.enabled (default: true)
    │   ├── If available + enabled → invoke axiom:audit
    │   │   └── Returns: findings[] in Standard Finding Format
    │   ├── Detect impeccable:critique skill availability
    │   ├── Check .exarchos.yml plugins.impeccable.enabled (default: true)
    │   └── If available + enabled → invoke impeccable:critique
    │       └── Returns: design quality findings[]
    │
    ├── Merge findings (exarchos-native + axiom + impeccable)
    │
    ├── Tier 3: Verdict computation (always runs)
    │   ├── check_convergence (D1-D5 aggregate status)
    │   ├── check_review_verdict (merged finding counts + dimension results)
    │   ├── APPROVED: no HIGH findings in blocking dimensions
    │   ├── NEEDS_FIXES: any HIGH or MEDIUM_count > threshold
    │   └── BLOCKED: critical architectural or security issues
    │
    ├── Emit workflow events (gate.executed — automatic)
    └── Transition phase
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

### Step 1: Detect Plugin Availability

Check for the companion plugin skills in the available skills list:

- `axiom:audit` — general backend quality (7 dimensions)
- `impeccable:critique` — design quality (UI, accessibility, design system, responsive)

### Step 2: Check Configuration Override

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

### Step 3: Invoke and Merge

**axiom:audit invocation:**
1. Pass the diff content and the list of changed files
2. axiom returns findings in Standard Finding Format (`severity`, `dimension`, `file`, `line`, `message`)
3. Map axiom findings to the unified list:
   - `dimension` (DIM-1 through DIM-7) becomes the category prefix (e.g., `axiom:DIM-1-topology`)
   - `severity` maps directly (HIGH, MEDIUM, LOW)
   - axiom HIGH findings are treated identically to exarchos-native HIGH findings

**impeccable:critique invocation:**
1. Pass the diff content
2. impeccable returns design quality findings (`severity`, `category`, `file`, `line`, `message`)
3. Map all impeccable findings under the `design-quality` category

**Merge:** Append all plugin findings to the exarchos-native findings list. The merged list is the input to `check_review_verdict`.

## Graceful Degradation

When a plugin is not installed or is disabled, the quality review proceeds without it. The review report includes a "Plugin Coverage" section that communicates the status of each optional plugin:

- **Not installed:** Suggests the install command (`claude plugin add lvlup-sw/axiom` or `claude plugin add lvlup-sw/impeccable`)
- **Disabled via config:** Notes the config key to re-enable
- **Active:** Reports the number of dimensions checked and findings produced

The verdict computation is unaffected by plugin absence — it operates on whatever findings are present in the merged list.

## Verdict Mapping

The verdict uses the merged findings from all sources. The logic is the same regardless of which plugins contributed:

| Merged Findings | Verdict |
|----------------|---------|
| No HIGH findings, acceptable MEDIUM/LOW | APPROVED |
| Any HIGH findings in blocking dimensions | NEEDS_FIXES |
| Critical architectural or security issues | BLOCKED |

axiom HIGH findings and exarchos-native HIGH findings carry equal weight — both trigger NEEDS_FIXES when present in blocking dimensions.
