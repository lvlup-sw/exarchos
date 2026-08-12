# Deterministic Checks

Mechanical grep / structural patterns that the skill can run against the diff or working tree to surface candidate findings. These are starting points for human or agent reasoning, not verdicts. A pattern match is a *signal*, not a conclusion — confirm by reading context.

Coverage limited to invariants where mechanical detection adds value: INV-1, INV-2, INV-4, INV-5d, INV-6. The remaining invariants (INV-3, INV-5a, INV-5b, INV-5c) are reasoning-driven; their checks live in the corresponding reference files.

## INV-1: Event-Sourcing Integrity

### Check 1.1: In-memory side-database in projections

A projection reducer that holds a module-level mutable `Map`, `Set`, or stateful instance is a candidate stores-as-projections violation. Reducers are pure folds; persistent state belongs in the snapshot store.

```bash
# Module-global mutable collections under projections/
rg -n '^(const|let)\s+\w+\s*[:=]\s*new\s+(Map|Set|WeakMap)' \
   servers/exarchos-mcp/src/projections/

# InMemoryTaskStore references (the SDK anti-pattern called out in
# milestone-16 §2.1)
rg -n 'InMemoryTaskStore' servers/exarchos-mcp/src/
```

### Check 1.2: State mutation inside reducer apply

`apply` must return new state, never mutate. Direct property assignment to the `state` argument is the most obvious smell.

```bash
# Mutation patterns in any apply function
rg -n 'state\.\w+\s*=' servers/exarchos-mcp/src/projections/
rg -n 'state\.\w+\.push\(' servers/exarchos-mcp/src/projections/
rg -n 'delete\s+state\.' servers/exarchos-mcp/src/projections/
```

### Check 1.3: Missing event registration

Append calls reference event types that must exist in `event-store/schemas.ts`. A missing registration fails at runtime with `"Unknown event type"` (confirmed during the 2026-05-07 discovery workflow).

```bash
# Find all event.type literals in append calls; cross-reference with
# the registered EventType union in schemas.ts.
rg -n "type:\s*['\"]([a-z_.]+)['\"]" --only-matching --replace '$1' \
   servers/exarchos-mcp/src/ \
   | sort -u
```

### Check 1.4: Reducer non-determinism

Reducers must be deterministic. Reads of clock, random, or env inside `apply` are violations.

```bash
# Inside projections/, look for non-deterministic calls in or near apply()
rg -n 'Date\.now\(\)|Math\.random\(\)|process\.env|new Date\(\)' \
   servers/exarchos-mcp/src/projections/
```

## INV-2: Facade Equivalence

### Check 2.1: Adapter-local mutable state

Either CLI or MCP adapter holding a `Map` / `Set` / cached field that survives across calls is a candidate facade-equivalence violation. State should live in dispatch core or a projection — never in an adapter.

```bash
# Module-global mutable state under adapters/
rg -n '^(const|let)\s+\w+\s*[:=]\s*new\s+(Map|Set|WeakMap)' \
   servers/exarchos-mcp/src/adapters/
rg -n '^(const|let)\s+\w+\s*[:=]\s*\[\]' \
   servers/exarchos-mcp/src/adapters/
```

### Check 2.2: Side effects in adapters

Adapters carry zero behavior beyond format conversion. `console.log`, file writes, or event emissions inside `adapters/cli.ts` or `adapters/mcp.ts` are candidates.

```bash
# Side-effect calls in adapters
rg -n 'console\.(log|warn|error)|fs\.(write|append)|emit\(' \
   servers/exarchos-mcp/src/adapters/
```

### Check 2.3: Verbs bypassing dispatch core

Every verb routes through `dispatch/core/dispatch.ts`. New handlers in adapters that don't go through dispatch are violations.

```bash
# Look for handler functions in adapters/ that don't call dispatch()
# (manual review — this is a starting point, not an automated check)
rg -n 'export (async )?function handle[A-Z]' \
   servers/exarchos-mcp/src/adapters/
```

## INV-4: Platform-Agnosticity

### Check 4.1: Hardcoded Claude-specific syntax in source

Source under `skills-src/` should use `{{TOKEN}}` placeholders, not Claude-flavored literals.

```bash
# Skill-chain calls in source (should be {{CHAIN}})
rg -n 'Skill\(\{\s*skill:\s*["\047]exarchos:' skills-src/

# Task-tool calls in source (should be {{TASK_TOOL}} or {{SPAWN_AGENT_CALL}})
rg -nw 'TaskCreate|TaskUpdate|TaskGet|TaskList' skills-src/

# MCP-tool prefix in source (should be {{MCP_PREFIX}})
rg -n 'mcp__plugin_exarchos_exarchos__' skills-src/
```

### Check 4.2: Direct edits to generated skills

Source-of-truth lives in `skills-src/`. Direct edits to `skills/<runtime>/**` will fail `skills:guard` CI.

```bash
# Last-modified comparison: any skills/ file newer than its skills-src/
# counterpart is suspicious. Run from repo root:
find skills -name '*.md' -newer skills-src -type f 2>/dev/null
```

### Check 4.3: Reference files with frontmatter

Reference files (`skills-src/<skill>/references/*.md`) MUST NOT have YAML frontmatter per the CLAUDE.md "Reference-file frontmatter" rule.

```bash
# Frontmatter on reference files
for f in skills-src/*/references/*.md; do
  if head -1 "$f" 2>/dev/null | grep -q '^---$'; then
    echo "$f has frontmatter"
  fi
done
```

### Check 4.4: New token used but not declared in all runtimes

The build's `assertRuntimeTokenCoverage` pre-flight catches this, but flagging at design time saves a CI cycle.

```bash
# Tokens referenced in skills-src/ source
rg -no '\{\{([A-Z_]+)\}\}' --replace '$1' skills-src/ \
   | sort -u

# Cross-reference: every emitted token must appear in every runtimes/*.yaml
# under the placeholders: key.
for token in $(rg -no '\{\{([A-Z_]+)\}\}' --replace '$1' skills-src/ | sort -u); do
  for yaml in runtimes/*.yaml; do
    if ! grep -q "^[[:space:]]\+$token:" "$yaml" 2>/dev/null; then
      echo "MISSING: $token in $yaml"
    fi
  done
done
```

## INV-5d: Action Discriminator

### Check 5d.1: New top-level tools

Exarchos exposes 4 visible composite tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) plus `exarchos_sync` (hidden). Any new `server.tool(...)` or `server.registerTool(...)` call adds a fifth visible tool — this is a candidate INV-5d violation unless it has explicit design justification.

```bash
# Top-level tool registrations
rg -n 'server\.(tool|registerTool)\s*\(' servers/exarchos-mcp/src/
```

### Check 5d.2: Permissive action schemas

Action parameters should be discriminated unions, not `Record<string, unknown>`.

```bash
# Permissive Record types in tool input schemas
rg -n 'z\.record\(z\.unknown\(\)\)' \
   servers/exarchos-mcp/src/registry.ts \
   servers/exarchos-mcp/src/**/tools.ts

# Tools using `additionalProperties: true` which allows arbitrary fields
rg -n 'additionalProperties:\s*true' servers/exarchos-mcp/src/
```

### Check 5d.3: Missing describe action

Every composite tool must support `action: "describe"`. New tools without it skip the discoverability mechanism.

```bash
# Composite-tool action enums; verify "describe" is in each
rg -n 'action:\s*z\.enum\(\[' servers/exarchos-mcp/src/ \
   | rg -v 'describe'
```

### Check 5d.4: Tool-level annotation on a divergent composite

Per-action annotations live on `CompositeAction` post-#1268. A tool-level `destructiveHint` / `readOnlyHint` on a composite where actions diverge in destructiveness is a violation (e.g., `exarchos_event` has both `append` and `query`).

```bash
# Tool-level annotations that should be per-action
rg -n 'destructiveHint|readOnlyHint|idempotentHint|openWorldHint' \
   servers/exarchos-mcp/src/registry.ts
```

## INV-6: Workflow-Agnosticism

### Check 6.1: Workflow-typed literals in skill bodies

A skill body containing workflow-typed literals (`feature/`, `featureId`, `merge-pending`, `delegate`, `synthesize`, `review`, `gathering`) WITHOUT a `metadata.workflow-type:` frontmatter declaration is a candidate INV-6 violation. Skills under `skills-src/_shared/**` are exempt by convention. Formalized in `scripts/lint-inv6.mjs`.

```bash
# Raw literals in skill bodies (excluding _shared/)
rg -n 'feature/|featureId|merge-pending|delegate|synthesize|review|gathering' \
   skills-src/ \
   --glob '!skills-src/_shared/**' \
   --glob '*.md'

# Triage: which matching SKILL.md files lack workflow-type: in frontmatter?
for f in $(rg -l 'feature/|featureId|merge-pending|delegate|synthesize|review|gathering' \
              skills-src/ \
              --glob '!skills-src/_shared/**' \
              --glob 'SKILL.md'); do
  if ! head -20 "$f" | grep -q '^  workflow-type:'; then
    echo "CANDIDATE: $f references workflow literals without workflow-type declaration"
  fi
done
```

### Check 6.2: Advisory lint integration

The advisory lint `scripts/lint-inv6.mjs` runs as part of `npm run skills:guard` (currently advisory — `(npm run lint:inv6 || true)`). Promotion to blocking is tracked separately.

```bash
# Direct invocation surfaces JSON findings:
node scripts/lint-inv6.mjs
```

## Running the full sweep

The deterministic checks above are run by the `check_invariant_conformance`
gate (`servers/exarchos-mcp/src/verbs/gates/check-invariant-conformance.ts`),
whose audit prompt is generated from this catalog
(`servers/exarchos-mcp/src/architecture/audit-prompt.ts`). The gate emits
findings as a structured `ToolResult` (verdict + findings array with severity +
invariant ID + file + line + description + required_fix + axiom_overlap). The
`design-invariants` skill that previously wrapped these greps was retired in
T-23; the grep blocks above remain the authoritative deterministic checks the
gate's reasoning is grounded in.

## Tracking

When the v2.10/v2.11 spec-alignment children land, update this file:

- After [#1266](https://github.com/lvlup-sw/exarchos/issues/1266): add a check for missing `outputSchema` registration on new actions.
- After [#1268](https://github.com/lvlup-sw/exarchos/issues/1268): add a check for missing per-action annotations in the `CompositeAction` table.
- After [#1273](https://github.com/lvlup-sw/exarchos/issues/1273): add a check for new long-running ops still using NDJSON instead of Tasks.
