# Authoring invariants

Exarchos lets you define **architectural invariants** for your own codebase and
have them enforced on the SDLC workflow path — surfaced as constraints during
`/exarchos:ideate`, turned into acceptance criteria at planning, injected into
implementer prompts, and **audited at review by the `check_invariant_conformance`
gate**. This is the same machinery Exarchos applies to itself; you plug into it
by authoring a catalog file and listing it in `.exarchos.yml`.

> **Status:** the v3 schema, loader, projection, and gate ship as of
> [PR #1465](https://github.com/lvlup-sw/exarchos/pull/1465). Authoring your own
> `user`-tier catalog is supported today. The Exarchos-shipped `SDLC-*` consumer
> catalog (default-on baseline invariants) is a separate forthcoming deliverable
> — until it lands, the sdlc layer is empty and only your `user` catalog and any
> enabled dev catalog contribute.

## 1. Register a catalog

```yaml
# .exarchos.yml
invariants:
  catalogs:
    - .exarchos/invariants.yml      # explicit — a file on disk is NOT auto-loaded
  enforcement:
    review: blocking                # invariant findings gate the review verdict
```

Listing is explicit by design (no auto-detection, matching the `devCatalog`
precedent). Multiple files may be listed; they merge in order.

## 2. Author an entry

A catalog file is YAML frontmatter with an `invariants:` list. Each entry mirrors
the shipped catalog (`docs/architecture/invariants.md`) and adds the v3 fields.
Field keys are **kebab-case** (they are YAML frontmatter).

```yaml
---
schema-version: 3
invariants:
  - id: U-1                         # user ids: reserved namespaces INV-* / SDLC-* are rejected
    dimension: audit-completeness
    axis: substrate
    cost-of-load: always-load
    integrity-class: user           # substrate | sdlc | authoring | user
    applies-to:
      - src/handlers/**
    summary: >
      Every request handler must emit an audit event before returning.
    phase-affinity: [review]        # absent ⇒ all phases
    workflow-affinity: [feature]    # absent ⇒ all workflow types
    severity:
      default: blocking             # blocking | advisory
      by-workflow:
        oneshot: advisory           # downgrade for cheap workflows
    enforcement:
      mode: check                   # see §3
      check:
        all-of:
          - { kind: grep, pattern: "emitAuditEvent\\(", file-glob: "src/handlers/**/*.ts" }
          - not:
              { kind: grep, pattern: "return\\s+res\\b", file-glob: "src/handlers/**/*.ts" }
---
```

### Field reference (v3 additions)

| Field | Type | Meaning |
|---|---|---|
| `phase-affinity` | `enum[]` of `ideate\|plan\|delegate\|review\|synthesize` | Phases where the invariant is active. Absent ⇒ all phases. |
| `workflow-affinity` | `enum[]` of `feature\|debug\|refactor\|discover\|oneshot` | Workflow types where it bites. Absent ⇒ all. `discover` excludes code-axis invariants automatically. |
| `state-affinity` | `string[]` | Optional topology transition ids the invariant guards (soft reference). |
| `severity` | `{ default, by-workflow?, by-phase? }` | Context-keyed severity (`blocking`/`advisory`). |
| `integrity-class` | enum | Override authority — see [the gating guide](exarchos-yml-invariants.md#override-authority--integrity-class-floors). |
| `enforcement` | object | How the invariant is checked — `mode: check` or `mode: audit` (§3). |

## 3. The `enforcement` block — `check` vs `audit`

### `mode: check` — mechanizable, sandbox-free

A **combinator tree** over declarative leaf checks. **No executable code** is ever
accepted — the schema is `.strict()`, so an embedded `script`/`exec`/`code` field
fails validation, and an unknown `kind` fails at load. This keeps consumer
extensibility platform-agnostic and safe (INV-4).

**Leaves** (the same vocabulary the `prepare_review` quality catalog uses):

```yaml
{ kind: grep,       pattern: "<regex>", file-glob: "**/*.ts" }
{ kind: structural, pattern: "<regex>", file-glob: "**/*.ts", threshold: 3 }
{ kind: heuristic,  pattern: "<regex>", file-glob: "**/*.ts", threshold: 3 }
```

**Combinators:**

| Form | Passes when |
|---|---|
| `all-of: [ ... ]` | every child passes |
| `any-of: [ ... ]` | at least one child passes |
| `not: <node>` | the child fails |
| `scope: { file-glob?, phase? }`, `node: <node>` | child evaluated with a narrowed file/phase scope |

A check that "fails" emits a finding; the gate folds findings into the review
verdict by the entry's resolved `severity`.

### `mode: audit` — judgment, run by a generic prompt

For invariants that aren't mechanically checkable (e.g. "is this design's
isolation unrepresentable-by-construction?"), use an `audit-prompt`. At review,
the gate compiles all applicable audit prompts into one block for the review
subagent; its answers re-enter as findings.

```yaml
enforcement:
  mode: audit
  audit-prompt: >
    Does this diff let a task-isolated agent write outside its worktree?
    The handler must make this unrepresentable by construction.
```

## 4. Tuning shipped invariants

Use `overrides` to adjust an invariant Exarchos ships, within its
`integrity-class` floor:

```yaml
invariants:
  overrides:
    SDLC-3: { severity: advisory }   # downgrade
    SDLC-7: { enabled: false }       # clamps to advisory if the floor forbids disable (you'll get a warning)
```

You can add new ids (in your own namespace) freely; you can tune `sdlc`/`authoring`
invariants down to advisory; you cannot disable a `substrate` invariant (it is never
in your resolved catalog to begin with). See the
[override-authority table](exarchos-yml-invariants.md#override-authority--integrity-class-floors).

## 5. Inspect the effective catalog

The merged, projected catalog (dev + sdlc + your user layers, after overrides)
is queryable so you can see exactly what the gate will enforce:

- **MCP:** `exarchos_view` → `invariants_effective`.
- **CLI:** the same view with `--json` (byte-identical payload — facade parity).
- **Later:** the same payload will be exposed as an MCP Resource
  (`exarchos://invariants/...`) once Resources land (tracked in
  [#1286](https://github.com/lvlup-sw/exarchos/issues/1286)).

## 6. Failure behavior

Authoring mistakes fail safe and loud:

- A **malformed catalog file** (bad YAML, unknown check kind, reserved-namespace
  id) does **not** abort the gate — Exarchos evaluates the valid shipped layers
  and reports the load failure as an **advisory finding** naming the file. The
  signal is surfaced, never silently swallowed.
- A **single check leaf that throws** (e.g. an invalid regex) becomes a `LOW`
  finding naming the invariant id, not a gate crash.

## See also

- [`.exarchos.yml` invariants block](exarchos-yml-invariants.md) — config reference.
- Design: [`docs/designs/2026-05-23-invariants-projection-and-extensibility.md`](../designs/2026-05-23-invariants-projection-and-extensibility.md).
- Shipped catalog (worked examples of entries): [`docs/architecture/invariants.md`](../architecture/invariants.md).
