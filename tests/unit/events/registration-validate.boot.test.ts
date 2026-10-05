// Proves that the registration weld gate runs on `initializeContext`, the production boot path.
// A seeded `capability` registration with an unresolvable provider must stop the boot.
//
// @oracle-sources: ../../../src/dispatch/core/context.ts, the shipped effect-provider registry the seeded id is deliberately absent from
//
// The boot sequence decides whether the process starts. The effect-provider registry decides which
// provider ids resolve. The tests assert that the two agree on the seeded id.
// The second oracle is a label, not the path of `providers.ts`. `context.ts` imports that module
// through `registration-validate.ts`. The derivation check walks static imports, so with two paths
// it reports one authority, although the boot sequence does not write the provider map.
//
// The gate is real, and the tests seed the annotation table that it reads. Without the
// `assertRegistrationWeldsAtStartup()` call in `initializeContext`, the first test fails.
// `createServer` in `index.ts` has no production caller, so a gate there never runs.
// The import from `registration-validate.js` is type-only, so it pins no module instance across
// the `vi.resetModules()` cycles.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import type { EventRegistration } from '../../../src/events/event-registration.js';
import type {
  WeldDiagnosticCode,
  WeldDiagnosticSeverity,
} from '../../../src/events/registration-validate.js';

const SEEDED_EVENT = 'seeded.boot-unresolvable-provider';
const SEEDED_PROVIDER = 'exarchos_provider_that_does_not_exist';

/**
 * A registration that the types accept: active, with a provider and a real reducer as its consumer.
 * Its only fault is a provider id that does not resolve, which the boot gate must find.
 */
const SEEDED_REGISTRATION: EventRegistration = {
  lifecycle: 'active',
  tier: 'capability',
  provider: SEEDED_PROVIDER,
  consumedBy: ['workflow-state@v1'],
};

describe('DR-2 boot gate — initializeContext refuses to start on an unresolvable provider weld', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imo012-boot-gate-'));
  });

  afterEach(async () => {
    vi.doUnmock('../../../src/events/event-annotations.js');
    vi.resetModules();
    await rmrfAsync(tmpDir);
  });

  /**
   * The mock seeds the catalog, and the gate is real. `registration-validate.ts` reads
   * `EVENT_ANNOTATIONS` as a default parameter at call time, so the gate sees the seeded table.
   * The error names the event and the provider id. The state directory stays empty, so the
   * refusal comes before the event store exists.
   */
  it('InitializeContext_SeededUnresolvableProviderWeld_RefusesToBoot', async () => {
    vi.resetModules();
    vi.doMock('../../../src/events/event-annotations.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/events/event-annotations.js')>();
      return {
        ...actual,
        EVENT_ANNOTATIONS: Object.freeze({
          ...actual.EVENT_ANNOTATIONS,
          [SEEDED_EVENT]: SEEDED_REGISTRATION,
        }),
      };
    });

    const { initializeContext } = await import('../../../src/dispatch/core/context.js');
    const { RegistrationWeldError } = await import('../../../src/events/registration-validate.js');

    await expect(initializeContext(tmpDir)).rejects.toBeInstanceOf(RegistrationWeldError);
    await expect(initializeContext(tmpDir)).rejects.toThrow(SEEDED_EVENT);
    await expect(initializeContext(tmpDir)).rejects.toThrow(SEEDED_PROVIDER);

    await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
  });

  /**
   * The positive control: the same call succeeds with the real catalog.
   * Without it, a gate that always throws passes the test of the seeded catalog.
   */
  it('InitializeContext_LiveCatalog_BootsClean', async () => {
    vi.resetModules();
    vi.doUnmock('../../../src/events/event-annotations.js');

    const { initializeContext } = await import('../../../src/dispatch/core/context.js');
    const ctx = await initializeContext(tmpDir);
    expect(ctx.stateDir).toBe(tmpDir);
    expect(ctx.eventStore).toBeDefined();
    ctx.eventStore.close();
  });

  /**
   * On the real boot path, the gate refuses because a diagnostic is `blocking`, not because the
   * list is non-empty. `blockingCount` counts only the `blocking` diagnostics. The `observe`
   * diagnostics are in the same verdict and do not cause the throw.
   */
  it('StartupAssertion_BlockingSeverity_ThrowsOnAnyViolation', async () => {
    vi.resetModules();
    vi.doMock('../../../src/events/event-annotations.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/events/event-annotations.js')>();
      return {
        ...actual,
        EVENT_ANNOTATIONS: Object.freeze({
          ...actual.EVENT_ANNOTATIONS,
          [SEEDED_EVENT]: SEEDED_REGISTRATION,
        }),
      };
    });

    const { initializeContext } = await import('../../../src/dispatch/core/context.js');
    const { RegistrationWeldError } = await import('../../../src/events/registration-validate.js');

    let caught: unknown;
    try {
      await initializeContext(tmpDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistrationWeldError);
    if (!(caught instanceof RegistrationWeldError)) return;

    expect(caught.verdict.bootable).toBe(false);
    expect(caught.verdict.blockingCount).toBeGreaterThan(0);

    const blocking = caught.verdict.diagnostics.filter((d) => d.severity === 'blocking');
    const observed = caught.verdict.diagnostics.filter((d) => d.severity === 'observe');
    expect(caught.verdict.blockingCount).toBe(blocking.length);
    expect(caught.verdict.observeCount).toBe(observed.length);
    expect(blocking.length + observed.length).toBe(caught.verdict.diagnostics.length);
    expect(blocking.map((d) => d.eventType)).toContain(SEEDED_EVENT);
  });

  /**
   * `initializeContext` takes no severity table, so the test calls the gate directly with the
   * populations of the boot path. Only the severity table changes: each code is `observe`.
   * The gate then reports the seeded fault that stops the boot, and the call returns.
   * The table is a spread of the shipped table, so its type stays total over the diagnostic codes.
   *
   * The second call is the control. It uses the real catalog and one conforming emission edge for
   * each capability registration. It reports nothing, so the seeded fault causes the first report.
   */
  it('StartupAssertion_ObserveSeverity_ReportsWithoutThrowing', async () => {
    vi.resetModules();
    vi.doUnmock('../../../src/events/event-annotations.js');

    const { EVENT_ANNOTATIONS } = await import('../../../src/events/event-annotations.js');
    const { EFFECT_PROVIDERS } = await import('../../../src/contract/reachability/providers.js');
    const { EFFECT_OWNERSHIP } = await import('../../../src/architecture/effect-ledger.js');
    const {
      DIAGNOSTIC_SEVERITY_POLICY,
      WELD_RESOLUTION_POLICY,
      assertRegistrationWeldsAtStartup,
    } = await import('../../../src/events/registration-validate.js');

    const seeded = Object.freeze({ ...EVENT_ANNOTATIONS, [SEEDED_EVENT]: SEEDED_REGISTRATION });
    const observeEverything: Record<WeldDiagnosticCode, WeldDiagnosticSeverity> = {
      ...DIAGNOSTIC_SEVERITY_POLICY,
    };
    const isCode = (value: string): value is WeldDiagnosticCode =>
      Object.prototype.hasOwnProperty.call(DIAGNOSTIC_SEVERITY_POLICY, value);
    for (const code of Object.keys(observeEverything)) {
      if (isCode(code)) observeEverything[code] = 'observe';
    }

    const reported: string[] = [];
    const verdict = assertRegistrationWeldsAtStartup(
      seeded,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      observeEverything,
      (message) => reported.push(message),
    );

    expect(verdict.bootable).toBe(true);
    expect(verdict.blockingCount).toBe(0);
    expect(verdict.observeCount).toBeGreaterThan(0);
    expect(verdict.ok).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(SEEDED_EVENT);
    expect(reported[0]).toContain(SEEDED_PROVIDER);

    const conformingEmissions: { event: string; action: string; declaringTool: string }[] = [];
    for (const [event, registration] of Object.entries(EVENT_ANNOTATIONS)) {
      if (registration.tier !== 'capability') continue;
      conformingEmissions.push({
        event,
        action: `${event}-emitter`,
        declaringTool: registration.provider,
      });
    }
    expect(conformingEmissions.length).toBeGreaterThan(0);

    const quiet: string[] = [];
    const clean = assertRegistrationWeldsAtStartup(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      observeEverything,
      (message) => quiet.push(message),
      conformingEmissions,
    );
    expect(clean.ok).toBe(true);
    expect(quiet).toEqual([]);
    expect(clean.bootResolvedCount).toBeGreaterThan(0);
    expect(clean.comparedEmissionEdgeCount).toBeGreaterThan(0);
  });

  /**
   * A stale-cover fault stops the real boot path. The seed is an active `capability` weld with a
   * live provider, so its only fault is that no action declares the emission.
   * `InitializeContext_LiveCatalog_BootsClean` is the control: a conforming tree boots.
   * `blockingCount` is 1, so the stale-cover diagnostic alone causes the refusal. The code comes
   * from its exported constant, so the test holds no second copy of the literal.
   * The gate writes nothing to stderr, because a refusal throws and reports nothing.
   */
  it('EmissionTeeth_BlockingMode_HaltsBootOnAViolation', async () => {
    vi.resetModules();
    vi.doMock('../../../src/events/event-annotations.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/events/event-annotations.js')>();
      return {
        ...actual,
        EVENT_ANNOTATIONS: Object.freeze({
          ...actual.EVENT_ANNOTATIONS,
          'seeded.stale.cover': {
            lifecycle: 'active',
            tier: 'capability',
            provider: 'exarchos_workflow',
            consumedBy: ['workflow-state@v1'],
          } satisfies EventRegistration,
        }),
      };
    });

    const { initializeContext } = await import('../../../src/dispatch/core/context.js');
    const { STALE_CAPABILITY_COVER_CODE, RegistrationWeldError } = await import(
      '../../../src/events/registration-validate.js'
    );

    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(chunk.toString());
        return true;
      });

    try {
      let caught: unknown;
      try {
        const ctx = await initializeContext(tmpDir);
        ctx.eventStore.close();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RegistrationWeldError);
      if (!(caught instanceof RegistrationWeldError)) return;

      expect(caught.verdict.bootable).toBe(false);
      const blocking = caught.verdict.diagnostics.filter((d) => d.severity === 'blocking');
      expect(blocking.map((d) => d.code)).toContain(STALE_CAPABILITY_COVER_CODE);
      expect(blocking.map((d) => d.eventType)).toContain('seeded.stale.cover');

      expect(caught.verdict.blockingCount).toBe(1);

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(written.join('')).toBe('');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
