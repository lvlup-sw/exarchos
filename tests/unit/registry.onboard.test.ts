/**
 * Registration of the `onboard` action on `exarchos_orchestrate`.
 * The CLI derives the flags of `onboard` from its Zod schema through `addFlagsFromSchema`, so no hand-written flag table exists.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, findActionInRegistry } from '../../src/registry.js';

describe('Registry_OnboardAction', () => {
  /**
   * The schema declares seven flags, and each one is optional. `format` is a closed enum of `table` and `json`.
   * `runtime` must be an array at the schema layer, because the CLI coerces CSV or JSON to an array before the parse.
   * The schema must not declare `surface`. The adapter injects it, and a declared field becomes a `--surface` flag.
   */
  it('Registry_OnboardAction_SchemaConstrainedFlags', () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'onboard');
    expect(
      action,
      'onboard action must be registered on exarchos_orchestrate',
    ).toBeDefined();

    const schema = action!.schema;

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

    expect(schema.safeParse({}).success).toBe(true);

    expect(schema.safeParse({ format: 'xml' }).success).toBe(false);

    expect(schema.safeParse({ runtime: 'claude-code' }).success).toBe(false);

    expect(schema.safeParse({ dryRun: 'yes' }).success).toBe(false);

    const shapeKeys = Object.keys(
      (schema as unknown as { shape: Record<string, unknown> }).shape,
    );
    expect(shapeKeys).not.toContain('surface');
    expect(shapeKeys.sort()).toEqual(
      ['dryRun', 'force', 'format', 'new', 'noHooks', 'runtime', 'vcs'].sort(),
    );
  });

  /** `onboard` is an action, so the registry must still hold exactly four visible tools. */
  it('Registry_OnboardAction_NoFifthVisibleTool_INV5d', () => {
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

  /**
   * `onboard` writes config and skills, and it appends `onboard.requested` and `onboard.executed`.
   * Thus its annotation must be `local-mutation`. With `readOnly: true`, a read-only client can start those writes.
   */
  it('Registry_OnboardAction_LocalMutationAnnotation', () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'onboard');
    expect(action!.annotations).toBeDefined();
    expect(action!.annotations.safety).toBe('local-mutation');
    expect(action!.annotations.readOnly).toBe(false);
    expect(action!.annotations.destructive).toBe(false);
    expect(action!.annotations.openWorld).toBe(false);
    expect(action!.outputSchema).toBeDefined();
  });

  /**
   * `onboard` takes the place of an `init` action, so `exarchos_orchestrate` must register no `init` action.
   * An `init` action with `runtime: string` collides with the `runtime: string[]` of `onboard` in `buildRegistrationSchema`.
   * The `init` CLI verb is only a stub that points to `exarchos onboard`.
   */
  it('Registry_InitAction_RemovedBySwap', () => {
    const init = findActionInRegistry('exarchos_orchestrate', 'init');
    expect(
      init,
      'init action must be removed by the onboard swap — it is no longer registered on exarchos_orchestrate',
    ).toBeUndefined();
  });
});
