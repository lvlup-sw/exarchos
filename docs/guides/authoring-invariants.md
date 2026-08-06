# Authoring invariants

Exarchos lets you define **architectural invariants** for your own codebase and
have them enforced on the SDLC workflow path — surfaced as constraints during
`/exarchos:ideate`, turned into acceptance criteria at planning, injected into
implementer prompts, and **audited at review by the `check_invariant_conformance`
gate**. This is the same machinery Exarchos applies to itself; you plug into it
by authoring a catalog file and listing it in `.exarchos.yml`.

> **Status:** the v3 schema, loader, projection, and gate ship as of
> [PR #1465](https://github.com/lvlup-sw/exarchos/pull/1465). The Exarchos-shipped
> `SDLC-*` consumer catalog (the default-on baseline) ships as of #1467 — see
> [§0](#0-the-shipped-sdlc-baseline-default-on). Authoring your own `user`-tier
> catalog is supported today; your entries merge on top of the SDLC baseline.

## Quickstart: the wizard

The fastest path is the **guided authoring wizard** — run `/exarchos:invariants`
(or invoke the `authoring-invariants` skill) and describe the rule in plain
prose. The wizard walks a 6-step interview (elicit → locate → weight → enforce →
number → commit) and turns your rule into a registered, enforced catalog entry
**without you hand-writing YAML**.

The wizard is agent-led but **every mutation goes through a deterministic,
schema-validated verb** — the agent supplies judgment and elicitation; the verbs
own validation, file writing, and `.exarchos.yml` wiring:

| Verb | CLI | What it does |
|---|---|---|
| `invariants_scaffold` | `exarchos invariants scaffold` | Create a starter catalog file for a tier; idempotently register it in `.exarchos.yml`. Never overwrites. |
| `invariants_add` | `exarchos invariants add` | Validate ONE entry against the v3 schema, then append it. `--dry-run` is the **default**: it returns the rendered entry + diff and writes nothing. |
| `exarchos doctor` | `exarchos doctor` | The validator — the `invariants-catalog` check resolves and reports malformed files / reserved-namespace ids. |
| `invariants_effective` | `exarchos view invariants_effective` | The merged, projected catalog the gate will enforce. |

The commit step is always **dry-run → show the rendered entry + diff → explicit
confirmation → write → `doctor` → show the `invariants_effective` delta**. The
enforcement DSL is `.strict()` and declarative-only, so the wizard cannot emit
an executable check (no `script` / `exec` / `code`) — see
[§3](#3-the-enforcement-block--check-vs-audit). Default authoring is
`mode: audit` (judgment); `mode: check` (a declarative combinator tree) is an
advanced opt-in.

You can drive the verbs directly without the wizard if you prefer — they are
plain CLI/MCP actions. The hand-authoring reference below
([§2](#2-author-an-entry)–[§3](#3-the-enforcement-block--check-vs-audit)) remains
the **manual/advanced** path for editing catalogs by hand or understanding the
exact field shapes the verbs produce.

- Wizard skill: `authoring-invariants` (entered via `/exarchos:invariants`).
- Design: [`docs/designs/archive/2026-05-25-invariants-authoring-wizard.md`](../designs/archive/2026-05-25-invariants-authoring-wizard.md).
- Plan: [`docs/plans/archive/2026-05-25-invariants-authoring-wizard.md`](../plans/archive/2026-05-25-invariants-authoring-wizard.md).

## 0. The shipped SDLC baseline (default-on)

Exarchos ships a small **consumer-facing** catalog that is **on by default** —
you do not register or enable it. These `SDLC-*` invariants govern *how you run
your SDLC through Exarchos* (workflow conduct), not your application's
architecture. They are workload-neutral: the same set applies to a React app, a
Go CLI, or a Python service. All ship as `mode: audit` (the review subagent
judges them; none is a mechanical diff check) with `integrity-class: sdlc`, so
you can **tune any of them down to advisory but never silently disable** one
(§4).

| id | governs | default severity |
|---|---|---|
| `SDLC-1` phase-observability | long-running ops are queryable; state reconstructible from disk | advisory |
| `SDLC-2` tdd-discipline | test-before-impl where the workflow declares it (feature, oneshot); defers to the `check_tdd_compliance` gate | blocking (oneshot ⇒ advisory) |
| `SDLC-3` review-gate-honesty | the verdict reflects the findings; no advisory-laundering of a HIGH | blocking |
| `SDLC-4` branch-pr-discipline | PR body has Summary/Changes/Test Plan; bottom-up stacked merge; no admin-merge bypass | blocking |
| `SDLC-5` recovery-posture | pause/resume from on-disk state; native-primitive-first recovery, no destructive overwrite | advisory |

They bite at **review** on code-bearing workflows (`feature`, `debug`,
`refactor`, `oneshot`); a `discovery` (docs-only) workflow is exempt. The three
audiences are distinct: **dev** (`INV-*`, Exarchos's own runtime substrate,
internal and not surfaced to consumers) → **sdlc** (`SDLC-*`, this baseline) →
**user** (your own `U-*` entries, §2).

> **As a consumer, you always author into the `user` tier (`U-*`).** The `dev`
> tier (`INV-*`) is *exarchos's own reserved substrate namespace* — not "for your
> project's developers". Its `INV-1..6` ship inside the tool and merge into every
> `invariants_effective` projection, so authoring into `dev` from your repo
> silently collides your `INV-N` with exarchos's own (and `doctor` won't catch it
> — it only flags `INV-*` in a *user* catalog). The authoring verbs reject
> `tier: dev` outside the exarchos repo (heuristic: `package.json` name ≠
> `@lvlup-sw/exarchos`) with a `RESERVED_TIER` error that redirects you to
> `user`; a genuine exarchos fork overrides with `allowReservedTier: true`.

## Manual authoring (advanced)

The rest of this guide is the **manual/advanced** path — registering catalogs
and hand-writing entries directly. Most authors should use the wizard above
(`/exarchos:invariants`), which produces these exact shapes for you. Read on if
you are editing a catalog by hand, scripting bulk authoring, or want to
understand the field shapes the verbs emit.

## 1. Register a catalog

```yaml
# .exarchos.yml
invariants:
  catalogs:
    - .exarchos/invariants.yml      # explicit — a file on disk is NOT auto-loaded
  enforcement:
    review: blocking                # invariant findings gate the review verdict
```

Listing is explicit by design (no auto-detection). Multiple files may be listed; they merge in order.

`exarchos onboard` seeds a `.exarchos.yml` with this `invariants:` block already
present **as comments** (a stubbed `catalogs:` example), so the opt-in is
discoverable without changing behavior — uncomment the keys you want. After
editing, validate your catalog wiring with `exarchos doctor` (the
`invariants-catalog` check parses every configured catalog and flags malformed
files or reserved-namespace ids) and inspect the resolved result with
`invariants_effective` ([§5](#5-inspect-the-effective-catalog)).

## 2. Author an entry

A catalog file is YAML frontmatter with an `invariants:` list. Each entry mirrors
the shipped catalog (`.exarchos/invariants.md`) and adds the v3 fields.
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
    SDLC-3: { severity: advisory }   # downgrade review-gate-honesty to advisory
    SDLC-4: { enabled: false }       # REFUSED — sdlc floor is advisory, so this clamps to advisory + emits a warning, not a silent disable
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

You can surface these same authoring mistakes *before* a review run with
`exarchos doctor` — the `invariants-catalog` check resolves your configured
catalogs and reports a Warning that names the offending file or reserved id.

## See also

- **Wizard:** `/exarchos:invariants` (the `authoring-invariants` skill) — the
  guided on-ramp; see [Quickstart](#quickstart-the-wizard).
- [`.exarchos.yml` invariants block](exarchos-yml-invariants.md) — config reference.
- `exarchos onboard` — seeds the commented `invariants:` onboarding stanza into a
  new `.exarchos.yml` (see [§1](#1-register-a-catalog)).
- `exarchos doctor` → `invariants-catalog` check — validates configured catalogs.
- `invariants_effective` view — inspect the merged, projected catalog ([§5](#5-inspect-the-effective-catalog)).
- Design: [`docs/designs/archive/2026-05-23-invariants-projection-and-extensibility.md`](../designs/archive/2026-05-23-invariants-projection-and-extensibility.md).
- Shipped catalog (worked examples of entries): [`.exarchos/invariants.md`](../../.exarchos/invariants.md).
