---
outline: deep
---

# Project Configuration

Exarchos ships with opinionated defaults. When you need to adjust behavior for a specific project, drop a `.exarchos.yml` file in your repository root. Only specify what you want to change. Everything else keeps its default value.

## Before you start

- Exarchos installed and running (see [Installation](/guide/installation))
- A project repository where you want to customize behavior

## Creating the config file

Create `.exarchos.yml` (or `.exarchos.yaml`) at your project root:

```yaml
# .exarchos.yml
# All sections are optional. Only specify what you want to change.

review:
  dimensions:
    D3: warning         # Context economy — advisory instead of blocking

vcs:
  provider: github      # github | gitlab | azure-devops

tools:
  auto-merge: false     # Disable auto-merge after CI passes
```

That's it. The file is validated on load. Invalid sections fall back to defaults with a warning in the logs. A typo in one section won't break the rest of your config.

## What you can configure

### Review criteria

Control which quality gates block your workflow and which ones just advise.

Exarchos checks five quality dimensions during review (see [Convergence Gates](/reference/convergence-gates)). You can adjust severity at the dimension level, the gate level, or both.

**Dimension-level control:**

```yaml
review:
  dimensions:
    D1: blocking        # Security and compliance (default)
    D2: blocking        # Static quality (default)
    D3: warning         # Context economy — downgrade to advisory
    D4: blocking        # Operational resilience (default)
    D5: disabled        # Workflow determinism — skip entirely
```

Three severity levels are available:
- `blocking` (default) stops the workflow if the check fails
- `warning` runs the check and reports findings, but lets the workflow continue
- `disabled` skips the check entirely

**Gate-level overrides:**

Individual gates override their parent dimension. This lets you keep a dimension strict while relaxing a specific check:

```yaml
review:
  gates:
    tdd-compliance:
      blocking: false           # Advisory only, even though D1 is blocking
      params:
        coverage-threshold: 80  # Custom parameter
    error-handling-audit:
      enabled: false            # Skip this gate entirely
    security-scan:
      enabled: true
      blocking: true            # Always block on security findings
```

**Review routing:**

Control how PRs are routed to reviewers based on risk score:

```yaml
review:
  routing:
    coderabbit-threshold: 0.6   # Score >= 0.6 routes to CodeRabbit (default: 0.4)
    risk-weights:               # Customize how risk is scored (must sum to 1.0)
      security-path: 0.30
      api-surface: 0.20
      diff-complexity: 0.15
      new-files: 0.10
      infra-config: 0.15
      cross-module: 0.10
```

### VCS provider

Select which version control platform Exarchos uses for PR creation, CI checks, merging, and review status:

```yaml
vcs:
  provider: github              # github | gitlab | azure-devops
  settings:
    auto-merge-strategy: squash # squash | merge | rebase
```

GitHub is the default and fully implemented. GitLab and Azure DevOps support is tracked in [Issue #1024](https://github.com/lvlup-sw/exarchos/issues/1024).

### Workflow behavior

Adjust the workflow process itself:

```yaml
workflow:
  skip-phases:
    - plan-review               # Skip the plan-review checkpoint
  max-fix-cycles: 2             # Reduce fix cycle limit (default: 3, range: 1-10)
  phases:
    plan-review:
      human-checkpoint: true    # Require human approval (default)
    synthesize:
      human-checkpoint: false   # Auto-merge without asking
```

Phase skipping reroutes the workflow's state machine. When you skip a phase, its incoming transitions point directly to the next phase. Guards from the skipped phase transfer to the rerouted transition, so safety checks still apply.

You cannot skip initial phases (like `ideate`) or final phases (like `completed`).

### Tool settings

Configure how Exarchos creates commits, PRs, and manages branches:

```yaml
tools:
  default-branch: main          # PR base branch (default: auto-detect from git)
  commit-style: conventional    # conventional | freeform
  pr-template: .github/pull_request_template.md
  auto-merge: true              # Enable auto-merge after CI (default: true)
  pr-strategy: github-native    # github-native | single
```

The `github-native` PR strategy uses `--base` targeting for stacked PRs. The `single` strategy creates one PR per feature without stacking.

### Event hooks

Run shell commands when workflow events occur. Hooks are fire-and-forget: they run in the background and never block the workflow.

```yaml
hooks:
  on:
    workflow.transition:
      - command: 'echo "Phase: $EXARCHOS_PHASE" | slack-notify'
        timeout: 10000          # Kill after 10 seconds (default: 30000)
    gate.executed:
      - command: './scripts/report-gate-result.sh'
    synthesis.complete:
      - command: 'curl -X POST "$JIRA_WEBHOOK" -d @-'
```

Each hook command receives the event data as JSON on stdin. Four environment variables are set automatically:

| Variable | Value |
|----------|-------|
| `EXARCHOS_FEATURE_ID` | Current workflow feature ID |
| `EXARCHOS_PHASE` | Current workflow phase |
| `EXARCHOS_EVENT_TYPE` | Event type that triggered the hook |
| `EXARCHOS_WORKFLOW_TYPE` | Workflow type (feature, debug, refactor) |

A failing notification script will not break your workflow. Errors are logged, but hooks never block the event pipeline.

Set `EXARCHOS_SKIP_HOOKS=true` to disable all hooks (useful during testing).

## How config is loaded

Exarchos finds your config through this precedence chain:

1. `$EXARCHOS_PROJECT_ROOT` environment variable (if set)
2. Walk up from the working directory looking for `.exarchos.yml` or `.exarchos.yaml`
3. Git repository root
4. Current working directory

The config is loaded once at MCP server startup. Changes require restarting the server (or restarting Claude Code).

## Inspecting effective config

To see the resolved config with source annotations showing which values are defaults and which come from your `.exarchos.yml`:

```ts
exarchos_workflow({ action: "describe", config: true })
```

Each value is annotated with its source:

```json
{
  "review": {
    "dimensions": {
      "D1": { "value": "blocking", "source": "default" },
      "D3": { "value": "warning", "source": ".exarchos.yml" }
    }
  }
}
```

## Relationship to exarchos.config.ts

There are two config files, and they do different things:

| File | Format | Purpose |
|------|--------|---------|
| `.exarchos.yml` | YAML | Override built-in defaults (review, VCS, workflow, tools, hooks) |
| `exarchos.config.ts` | TypeScript | Define new workflow types, custom events, views, and tools |

Both can coexist in the same project. YAML overrides are applied first, then TypeScript extensions are registered on top. Custom workflows defined in TypeScript inherit the project's YAML settings.

Most teams only need `.exarchos.yml`. The TypeScript config is for teams building custom workflow types or integrating domain-specific quality gates.

## Next steps

- [Convergence Gates](/reference/convergence-gates) for details on each quality dimension (D1-D5)
- [Review Process](/guide/review-process) for how two-stage review works
- [Configuration Reference](/reference/configuration) for plugin settings, hooks, and environment variables
