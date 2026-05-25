# Worked example — authoring one `U-*` entry end-to-end

This walks the 6-step interview for a single consumer-authored (`tier: user`)
invariant, from a rule in the author's head to a verified catalog entry. The
agent drives the verbs; it never writes catalog YAML by hand.

## The rule

> "Every HTTP request handler must emit an audit event before it returns a
> response — we got burned by a handler that silently returned without
> recording the request."

## Step 1 — Elicit → `summary`

The agent distills the rule and probes the failure it prevents:

> Agent: "What goes wrong if a handler returns without emitting the event?"
> Author: "We lose the audit trail for that request — it's invisible to
> compliance."

Distilled `summary`:

> Every request handler emits an audit event before returning a response.

## Step 2 — Locate

The agent asks the author to name the paths and the phase where the rule bites.

- `dimension`: `audit-completeness`
- `applies-to`: `src/handlers/**` (the author named this glob — not inferred)
- `phase-affinity`: `[review]` (it is a code-shape rule, audited at review)
- `workflow-affinity`: omitted ⇒ all workflow types

## Step 3 — Weight

- `severity.default`: `blocking` (a missing audit event is a compliance gap)
- `severity.by-workflow`: `{ oneshot: advisory }` (downgrade for cheap throwaway work)
- `integrity-class`: `user` (consumer-authored)

## Step 4 — Enforce (DEFAULT `mode: audit`)

The author has no mechanical signal in mind, so the agent stays on the default
`mode: audit` and drafts the prompt from the elicited rule:

```yaml
enforcement:
  mode: audit
  audit-prompt: >-
    Does this diff let a request handler in src/handlers/** return a response
    before emitting an audit event? Cite the offending file + line.
```

(If the author later wants a mechanical grep check, the agent would switch to
`mode: check` — see `check-mode.md` — and validate the combinator tree via a
dry-run before showing it.)

## Step 5 — Number

The agent does **not** pick an id. It calls the verb and lets it allocate the
next free id in the `user` namespace. The catalog already has `U-1` and `U-2`,
so the verb assigns `U-3`.

## Step 6 — Commit (dry-run → confirm → write → verify)

### 6a. Dry-run preview (writes nothing)

```ts
exarchos_orchestrate({
  action: "invariants_add",
  tier: "user",
  catalog: "docs/architecture/my-invariants.md",
  entry: {
    dimension: "audit-completeness",
    "applies-to": ["src/handlers/**"],
    "phase-affinity": ["review"],
    summary: "Every request handler emits an audit event before returning a response.",
    severity: { default: "blocking", "by-workflow": { oneshot: "advisory" } },
    "integrity-class": "user",
    enforcement: {
      mode: "audit",
      "audit-prompt": "Does this diff let a request handler in src/handlers/** return a response before emitting an audit event? Cite the offending file + line."
    }
  }
})
```

The verb returns `committed: false`, the auto-assigned `id: "U-3"`, the rendered
YAML entry, and a `+`-prefixed append diff.

### 6b. Show + confirm

The agent shows the rendered entry and the diff, then asks explicitly:

> "This will add `U-3` (audit-completeness, blocking, audit-mode) to
> `docs/architecture/my-invariants.md`. Commit it?"

It does **not** proceed until the author confirms.

### 6c. Commit (only after confirmation)

Re-invoke the identical call with `dryRun: false`. The verb appends the entry,
wires the catalog into `.exarchos.yml` if it was not already registered, and
emits `invariant.authored` (plus `catalog.registered` if this was the catalog's
first registration). The result carries `committed: true` and
`next_actions: ["doctor", "view invariants_effective"]`.

### 6d. Verify

- Run `doctor` → the `invariants-catalog` check parses the catalog and confirms
  no malformed entries or reserved-namespace ids.
- Run `view invariants_effective` → `U-3` now appears in the merged, projected
  catalog with its resolved severity, confirming exactly what the gate will
  enforce.

The rule is now a registered, enforced invariant — authored entirely through
the verbs, with no hand-written YAML.
