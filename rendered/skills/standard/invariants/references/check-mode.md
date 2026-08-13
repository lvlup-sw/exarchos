# `mode: check` — the advanced, declarative opt-in

`mode: audit` is the default for authoring (pure judgment, always portable). Use
`mode: check` only when the rule is **mechanically checkable** by a declarative
combinator tree — and only as an explicit author opt-in. There is **no
executable mode**: the enforcement DSL is `.strict()`, so any embedded `script`,
`exec`, or `code` field fails validation, and any unknown leaf `kind` is rejected
at write time (INV-4). The agent cannot emit an executable escape hatch even if
coaxed.

## The opt-in flow

1. **Author opts in.** Only switch to `check` when the author asks for a
   mechanical check and the rule maps cleanly to grep/structural/heuristic
   signals over named globs.
2. **Agent proposes the tree.** Draft a combinator tree from the rule. Express
   it as declarative leaves over **author-named globs** (never framework-inferred
   — INV-6).
3. **Validate live via the verb.** Call `invariants_add` with `dryRun: true`.
   The verb runs the entry through `InvariantEntryV3Schema` including the
   `.strict()` enforcement DSL. The agent never declares the tree valid on its
   own authority — the verb is the validator.
4. **Self-correct on error.** A rejected tree returns the INV-5b carrier shape
   (`validTargets` / `expectedShape` / `suggestedFix`). For an unknown leaf
   `kind`, the error states the valid kinds (`grep | structural | heuristic`)
   and reminds you the DSL is declarative-only. Fix and re-run the dry-run.
5. **Show + confirm, then commit.** Same gate as the default flow: show the
   rendered entry + diff, get explicit confirmation, then re-invoke with
   `dryRun: false`. Verify with `doctor` + `invariants_effective`.

## Leaf vocabulary

The same vocabulary the `prepare_review` quality catalog uses:

```yaml
{ kind: grep,       pattern: "<regex>", file-glob: "**/*.ts" }
{ kind: structural, pattern: "<regex>", file-glob: "**/*.ts", threshold: 3 }
{ kind: heuristic,  pattern: "<regex>", file-glob: "**/*.ts", threshold: 3 }
```

There is no `kind: shell`, `kind: exec`, or `kind: script`. Those are not
omissions — they are forbidden by construction.

## Combinators

| Form | Passes when |
|---|---|
| `all-of: [ ... ]` | every child passes |
| `any-of: [ ... ]` | at least one child passes |
| `not: <node>` | the child fails |
| `scope: { file-glob?, phase? }`, `node: <node>` | child evaluated with a narrowed file/phase scope |

A check that "fails" emits a finding; the gate folds findings into the review
verdict by the entry's resolved `severity`.

## Example: the audit-event rule as a `check`

The worked example's rule ("every handler emits an audit event before
returning") expressed mechanically — the handler glob must contain the audit
call and must not contain a bare early return:

```yaml
enforcement:
  mode: check
  check:
    all-of:
      - { kind: grep, pattern: "emitAuditEvent\\(", file-glob: "src/handlers/**/*.ts" }
      - not:
          { kind: grep, pattern: "return\\s+res\\b", file-glob: "src/handlers/**/*.ts" }
```

Propose this, validate it with `invariants_add` `dryRun: true`, show the
rendered entry + diff, confirm, then commit. If the author cannot reduce the
rule to grep/structural/heuristic signals, stay on `mode: audit` — judgment is
the portable default, not a fallback.

## Why declarative-only is non-negotiable

Keeping the DSL sandbox-free and declarative is what makes consumer
extensibility platform-agnostic (INV-4): an entry authored in one repo carries
no executable payload, runs nowhere, and means the same thing on any platform.
An audit prompt is judgment; a check tree is a pattern match. Neither is a
program. That is the guarantee the `.strict()` schema enforces at write time.
