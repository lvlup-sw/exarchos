import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, findActionInRegistry } from '../../src/registry.js';

// ─── Task 011 (DR-2/DR-5): `onboard` action registration ──────────────────────
//
// `onboard` is registered as a NEW ACTION on the `exarchos_orchestrate`
// composite tool (INV-5d — NOT a fifth visible tool). Its flag surface
// (`--new`/`--runtime`/`--vcs`/`--dry-run`/`--force`/`--no-hooks`/`--format`)
// auto-emits from the Zod schema via `addFlagsFromSchema` in the CLI adapter —
// there is no hand-written flag table to drift (INV-5a / governing INV-2 — the
// flag surface is DERIVED from the registered contract schema rather than
// hand-coordinated with the MCP wire).
//
// SWAP (design line 322: "init action → onboard action"): task 011 REMOVED the
// legacy `init` action and registered `onboard` in its place. Removing the init
// action is what cleared the #1127 flattener collision in buildRegistrationSchema
// between init's `runtime: string` and onboard's `runtime: string[]` (a single
// flattened JSON-Schema slot can't be both). The `init` CLI verb is a DR-5
// rename stub (`renamed → use 'exarchos onboard'`, non-zero exit); the init
// handler + `init.executed` event were fully removed in DR-5 (task 018), with
// `onboard` reproducing init's outputs via the GENERATE writers. The
// `Registry_InitAction_RemovedBySwap` assertion below fails loud if the init
// action ever reappears.

describe('Registry_OnboardAction', () => {
  it('Registry_OnboardAction_SchemaConstrainedFlags', () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'onboard');
    expect(
      action,
      'onboard action must be registered on exarchos_orchestrate',
    ).toBeDefined();

    // ─── Schema mirrors HandleOnboardArgs (DR-2 flag surface) ────────────────
    // `surface` is NOT a user flag — the adapter injects it. The schema the CLI
    // auto-emits flags from must therefore NOT carry a `surface` field.
    const schema = action!.schema;

    // A full valid payload parses (all flags optional).
    const full = schema.safeParse({
      new: 'my-service',
      runtime: ['claude-code', 'codex'],
      vcs: 'github',
      dryRun: true,
      force: false,
      noHooks: true,
      format: 'json',
    });
    expect(full.success).toBe(true);

    // An empty payload parses — every flag is optional.
    expect(schema.safeParse({}).success).toBe(true);

    // ─── The schema REJECTS bad input ────────────────────────────────────────
    // `format` is a closed enum: anything outside table|json is rejected.
    expect(schema.safeParse({ format: 'xml' }).success).toBe(false);

    // `runtime` is an array of strings — a bare string (non-array) is rejected
    // at the schema layer (the CLI coerces csv/json into an array before parse).
    expect(schema.safeParse({ runtime: 'claude-code' }).success).toBe(false);

    // `dryRun` is a boolean — a string is rejected at the schema layer.
    expect(schema.safeParse({ dryRun: 'yes' }).success).toBe(false);

    // ─── `surface` is adapter-injected, not a user flag ──────────────────────
    // The registered schema must NOT declare `surface` (the adapter supplies it
    // out-of-band). Zod strips unknown keys by default, so a `surface` key in
    // the input is silently dropped rather than validated — proving it is not a
    // declared field that would auto-emit a `--surface` CLI flag.
    const shapeKeys = Object.keys(
      (schema as unknown as { shape: Record<string, unknown> }).shape,
    );
    expect(shapeKeys).not.toContain('surface');
    // Sanity: the seven documented user flags ARE present.
    expect(shapeKeys.sort()).toEqual(
      ['dryRun', 'force', 'format', 'new', 'noHooks', 'runtime', 'vcs'].sort(),
    );
  });

  it('Registry_OnboardAction_NoFifthVisibleTool_INV5d', () => {
    // INV-5d: adding the `onboard` ACTION must NOT grow the visible composite
    // tool surface. The four visible tools (workflow/event/orchestrate/view)
    // plus the one hidden sync tool are unchanged.
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBe(4);
    expect(visibleTools.map((t) => t.name).sort()).toEqual(
      [
        'exarchos_event',
        'exarchos_orchestrate',
        'exarchos_view',
        'exarchos_workflow',
      ].sort(),
    );
  });

  it('Registry_OnboardAction_LocalMutationAnnotation', () => {
    // onboard writes config + skills and emits onboard.requested/onboard.executed,
    // so it is LOCAL_MUTATION (not read-only). The annotation must match the
    // actual write surface — readOnly:true would let a readonly-capability client
    // trigger event-store writes and bypass the audit boundary.
    const action = findActionInRegistry('exarchos_orchestrate', 'onboard');
    expect(action!.annotations).toBeDefined();
    expect(action!.annotations.safety).toBe('local-mutation');
    expect(action!.annotations.readOnly).toBe(false);
    expect(action!.annotations.destructive).toBe(false);
    expect(action!.annotations.openWorld).toBe(false);
    expect(action!.outputSchema).toBeDefined();
  });

  it('Registry_InitAction_RemovedBySwap', () => {
    // DR-2/DR-5 swap (design line 322: "init action → onboard action"). The
    // `init` ACTION was removed (task 011) — `onboard` supersedes it. This also
    // cleared the #1127 flattener collision between init's `runtime: string` and
    // onboard's `runtime: string[]` in buildRegistrationSchema. The `init` CLI
    // verb is a DR-5 rename stub; the init handler + `init.executed` event were
    // fully removed in DR-5 (task 018).
    const init = findActionInRegistry('exarchos_orchestrate', 'init');
    expect(
      init,
      'init action must be removed by the onboard swap — it is no longer registered on exarchos_orchestrate',
    ).toBeUndefined();
  });
});
