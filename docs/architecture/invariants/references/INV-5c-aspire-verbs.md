# INV-5c: Aspire-Inspired Control-Plane Verbs

Exarchos's CLI design borrows deliberately from Aspire. Per CLAUDE.md "Design Philosophy": *"New feature designs must follow agent-first CLI patterns (Aspire-inspired), not config-file-centric or human-first designs."* The substantive contribution is a *control-plane verb* model: agents query state, don't drive scripts.

## Acceptance questions

1. Does the new verb follow the **queryable, dry-run-capable, JSON-explicit** Aspire-style first, before considering positional-args / exit-codes / stdout-stream Unix-style?
2. Are process-lifecycle observations (`ps`, `describe`, `wait`, `export`) modeled as observation verbs, not control verbs that mutate hidden state?
3. Is `describe` exposed as a first-class verb, not an afterthought? Every composite tool exposes a `describe` action.
4. Do long-running operations expose a status verb (`wait`, `tasks/get`) so an agent can poll without re-issuing the work?

## Repo-grounded checks

- Process Lifecycle Verbs (v2.10.0 milestone): `ps`, `describe`, `wait`, `export`. These are the most concrete Aspire borrow currently shipping.
- Every composite tool (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) supports `action: "describe"` returning typed schemas + emission catalogs + topology. New composite actions must add a `describe` entry — see [INV-5d](INV-5d-action-discriminator.md).
- Verbs default to `--format json` (machine-first) with optional human renderers (`--format table`, `--format text`).
- Dry-run mode (`--dry-run`) is the default for any verb that mutates persistent state, with explicit opt-in via `--apply` or equivalent.
- Long-running operations expose a status verb. Pre-#1273: bespoke poll mechanisms. Post-#1273: MCP Tasks (`tasks/get` / `tasks/result` / `tasks/cancel`).

## What "Aspire-style" means in practice

| Aspire-style (do) | Unix-style (avoid as default) |
|---|---|
| `exarchos workflow describe --feature-id foo --format json` | `exarchos foo \| less` |
| `exarchos workflow set foo --phase plan --dry-run` | `echo plan > .exarchos/foo.phase` |
| `exarchos ps --format json` | `pgrep exarchos \| xargs ps` |
| `exarchos wait --feature-id foo --timeout 30s` | `while ! check; do sleep 1; done` |
| `exarchos export --feature-id foo --format json` | `cat .exarchos/foo/*.json` |

Aspire-style verbs are **agents observing a system**; Unix-style verbs are **shells driving a system**. Exarchos defaults to the former because the primary consumer is an agent, not a human at a terminal.

## External grounding

- CLAUDE.md "Design Philosophy" section — explicit Aspire-inspiration constraint on new designs.
- v2.10.0 milestone (Process Lifecycle Verbs: ps/describe/wait/export) — the most concrete Aspire borrow currently shipping.
- Aspire CLI documentation — the reference for queryable, JSON-first, dry-run-capable control-plane verbs.

## Severity guide

- **HIGH:** new verb that mutates persistent state without `--dry-run` as the default; verb that emits human-formatted output (banners, color codes) into the agent-facing JSON path; missing `describe` action on a new composite tool.
- **MEDIUM:** verb defaults to text output instead of JSON; long-running op without a status verb; verb uses positional args where named args would be clearer for agents.
- **LOW:** verb names that read awkwardly to a human but parse fine for an agent (acceptable; agent-first means agent legibility, not human poetry).

## Worked example

**Violation (HIGH):** New mutate-style verb without dry-run:

```ts
// cli-commands/cleanup.ts — DON'T
export async function runCleanup(args: { featureId: string }) {
  await fs.promises.rm(`.exarchos/workflow-state/${args.featureId}`, { recursive: true });
  console.log(`Cleaned up ${args.featureId}`);
}
```

No dry-run preview, no JSON output, side effects are the only signal.

**Fix:** Aspire-style — query first, mutate second:

```ts
// cli-commands/cleanup.ts — DO
export async function runCleanup(
  args: { featureId: string; apply?: boolean },
): Promise<ToolResult> {
  const wouldDelete = await previewCleanup(args.featureId);
  if (!args.apply) {
    return wrap({
      success: true,
      data: { wouldDelete, applied: false },
      meta: { dryRun: true },
    });
  }
  await applyCleanup(wouldDelete);
  return wrap({
    success: true,
    data: { wouldDelete, applied: true },
  });
}
```

Default is dry-run (`--apply` opts in to mutation). Output is JSON. Both paths return a `ToolResult` an agent can reason over.

## See also

- [INV-5b](INV-5b-output-contract.md) — Aspire-style verbs feed the same envelope; the two invariants compose.
- [INV-5d](INV-5d-action-discriminator.md) — `describe` as a first-class action across composite tools.
- [deterministic-checks.md](deterministic-checks.md) — no INV-5c deterministic checks (reasoning-driven).
