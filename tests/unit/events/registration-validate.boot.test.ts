// The BOOT half of task 012 (DR-2): the gate is wired into a path that actually executes in
// production, not only into a pure function a test can call.
//
// @oracle-sources: ../../../src/dispatch/core/context.ts, the shipped effect-provider registry the seeded id is deliberately absent from
//
// The two authorities. `dispatch/core/context.ts` owns the BOOT SEQUENCE — whether the process refuses to
// start — and knows nothing about which provider ids exist. The effect-provider registry owns which
// ids RESOLVE, and is what makes the seeded id bad; it was authored for P05-05's reachability
// closure, long before any event named a provider. The test asserts the two agree: the id the
// registry does not contain is the id the boot sequence refuses on.
//
// The second authority is a LABEL rather than the path `../contract/reachability/providers.ts`,
// because DR-30's derivation check is a static module-reachability walk and — precisely BECAUSE
// this task wired the gate — `dispatch/core/context.ts` now reaches `providers.ts` through
// `registration-validate.ts`. That is an import edge, not a derivation: the boot sequence does not
// author the provider map, and reporting them as one authority would be the over-approximation
// `suite-invariants/LIMITATIONS.md` names. Same call, same reason, as `event-annotations.test.ts`.
//
// The production entry point is `dispatch/core/context.ts::initializeContext`, whose sole production caller
// is `index.ts` `main()` (`... await initializeContext(stateDir, { backend, projectRoot })`) — the
// shared boot of BOTH facades: `exarchos mcp` and every stateful CLI verb route through it.
// `createServer()` in `index.ts` is a library/test factory with no production caller, so wiring the
// gate there would have shipped a check nothing runs — the R-11 shape this wave already recorded
// once for `resolveDispatchShape`.
//
// The seeding here is the SUBJECT, not the gate. `contract/bindings/startup-gate.test.ts` proves
// its wire by mocking the gate to throw, which shows the call exists but not that the check can
// find anything. This file instead injects one bad `capability` registration into the annotation
// table the gate reads and asserts the real, unmocked gate refuses to boot on it — so both halves
// (the wire AND the detection) are demonstrated on a live subject.
//
// Remove the `assertRegistrationWeldsAtStartup()` call from `initializeContext` and the first test
// goes green-when-it-should-be-red; the seeded catalog is otherwise perfectly bootable.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import type { EventRegistration } from '../../../src/events/event-registration.js';
// Type-only, so it does not pin a module instance the `vi.resetModules()` cycles below re-import.
import type {
  WeldDiagnosticCode,
  WeldDiagnosticSeverity,
} from '../../../src/events/registration-validate.js';

const SEEDED_EVENT = 'seeded.boot-unresolvable-provider';
const SEEDED_PROVIDER = 'exarchos_provider_that_does_not_exist';

/**
 * Structurally valid in every respect the TYPE can see — active, welded to a provider, consumed by
 * a real reducer. The one thing wrong with it is reference integrity, which is exactly the class
 * DR-2 assigns to boot rather than to `tsc`.
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

  it('InitializeContext_SeededUnresolvableProviderWeld_RefusesToBoot', async () => {
    vi.resetModules();
    // Seed the CATALOG, not the gate. `registration-validate.ts` reads `EVENT_ANNOTATIONS` as a
    // call-time default parameter, so the injected entry is the table the production gate sees.
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
    // The failure names the offending registration and the id that did not resolve, so the boot
    // log is actionable rather than "startup failed".
    await expect(initializeContext(tmpDir)).rejects.toThrow(SEEDED_EVENT);
    await expect(initializeContext(tmpDir)).rejects.toThrow(SEEDED_PROVIDER);

    // It fails BEFORE the event store exists: nothing was written into the state dir, so the
    // refusal is a startup gate and not a first-append surprise.
    await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
  });

  it('InitializeContext_LiveCatalog_BootsClean', async () => {
    // The positive control, and the reason the test above is evidence of anything: with the real
    // catalog the very same call succeeds. Without this, a gate that threw unconditionally would
    // pass the kill probe.
    vi.resetModules();
    vi.doUnmock('../../../src/events/event-annotations.js');

    const { initializeContext } = await import('../../../src/dispatch/core/context.js');
    const ctx = await initializeContext(tmpDir);
    expect(ctx.stateDir).toBe(tmpDir);
    expect(ctx.eventStore).toBeDefined();
    ctx.eventStore.close();
  });

  it('StartupAssertion_BlockingSeverity_ThrowsOnAnyViolation', async () => {
    // THE REFUSAL IS SEVERITY-DRIVEN, asserted on the real boot path rather than on a pure call.
    // The gate no longer refuses because "the diagnostic list is non-empty" — it refuses because a
    // diagnostic is stamped `blocking`, and the verdict riding the thrown error is where that shows.
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

    // Not bootable, and every fault that made it so is blocking — the boot decision follows the
    // stamp. A verdict that refused with zero blocking diagnostics would be the axis being ignored.
    expect(caught.verdict.bootable).toBe(false);
    expect(caught.verdict.blockingCount).toBeGreaterThan(0);

    // The refusal is the BLOCKING half's alone. The live tree also carries observe-severity
    // emission-coupling findings, and this is where that separation is worth asserting rather than
    // assuming: `blockingCount` counts only stamped-blocking diagnostics, and the observations
    // ride the same verdict without contributing to the decision that threw.
    const blocking = caught.verdict.diagnostics.filter((d) => d.severity === 'blocking');
    const observed = caught.verdict.diagnostics.filter((d) => d.severity === 'observe');
    expect(caught.verdict.blockingCount).toBe(blocking.length);
    expect(caught.verdict.observeCount).toBe(observed.length);
    expect(blocking.length + observed.length).toBe(caught.verdict.diagnostics.length);
    expect(blocking.map((d) => d.eventType)).toContain(SEEDED_EVENT);
  });

  it('StartupAssertion_ObserveSeverity_ReportsWithoutThrowing', async () => {
    // THE OTHER ARM, over the very catalog the boot path just refused. The severity table the
    // production gate reads is all-blocking by construction in this change, so an observe-severity
    // finding cannot be produced through `initializeContext` itself yet — arming a real one is a
    // later, deliberate flip. What IS shown here is the property that flip depends on: hold the
    // populations fixed at the ones the boot path uses, move ONLY the severity table, and the same
    // input that refused startup above is reported and survived instead.
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
    // Spread the shipped table and overwrite in place, so the result stays TOTAL over the
    // diagnostic axis by type — a fresh `Record<string, …>` is not the parameter type the gate
    // takes, and would let a code the loop missed fall back to whatever the lookup produced.
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

    // Returned rather than thrown, and the finding is still the one the boot path refused on.
    expect(verdict.bootable).toBe(true);
    expect(verdict.blockingCount).toBe(0);
    expect(verdict.observeCount).toBeGreaterThan(0);
    expect(verdict.ok).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(SEEDED_EVENT);
    expect(reported[0]).toContain(SEEDED_PROVIDER);

    // ...and the boot path with the UNSEEDED catalog reports nothing at all under the same
    // all-observe table, so the report above is caused by the fault and not by every call.
    //
    // The emission population is substituted for one that agrees with the annotation table
    // everywhere, because the SHIPPED registry does not: the live tree carries real disagreements
    // between an event's declared provider and the tool whose action declares the emission, and
    // those are reported at observe severity on every boot. Holding that one population conforming
    // is what leaves a genuinely quiet tree to assert silence over — the disagreements themselves
    // are measured in `registration-validate.test.ts`, not swept up here.
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

  it('EmissionTeeth_BlockingMode_HaltsBootOnAViolation', async () => {
    // THE TEETH, on the real boot path. Stale cover and the provider comparison shipped at
    // `observe` for as long as the shipped tree reported findings against them — a check that
    // refuses startup for a defect nobody has fixed makes the tree unbootable for every entry
    // point at once. Both break sets are now closed and both diagnostics are `blocking`, and this
    // is the assertion that says the flip has consequences.
    //
    // SEEDED, and it has to be: a conforming tree produces no violation, so the only way to show
    // that a violation halts boot is to introduce one. `EmissionTeeth_ConformingTree_BootsClean`
    // (`InitializeContext_LiveCatalog_BootsClean` above) is the other half — without it this test
    // would pass equally well against a gate that refused every tree.
    //
    // The seed is a `capability` weld naming a LIVE provider, so reference integrity resolves and
    // the pre-existing blocking codes have nothing to say; the ONLY thing wrong with it is that no
    // action declares the emission. That isolates the refusal to the newly-flipped diagnostic.
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
      // BOOT IS REFUSED. Not "a diagnostic was printed somewhere" — the process does not start.
      let caught: unknown;
      try {
        const ctx = await initializeContext(tmpDir);
        ctx.eventStore.close();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RegistrationWeldError);
      if (!(caught instanceof RegistrationWeldError)) return;

      // ...and it is refused BY THE FLIPPED DIAGNOSTIC, stamped blocking, naming the seeded weld.
      // The code comes from its own exported constant so a rename reddens here instead of leaving
      // this quietly matching a stale label.
      expect(caught.verdict.bootable).toBe(false);
      const blocking = caught.verdict.diagnostics.filter((d) => d.severity === 'blocking');
      expect(blocking.map((d) => d.code)).toContain(STALE_CAPABILITY_COVER_CODE);
      expect(blocking.map((d) => d.eventType)).toContain('seeded.stale.cover');

      // The seed is the ONLY fault: reference integrity still resolves, so this is attributable to
      // the emission check and not to a tree that was broken some other way.
      expect(caught.verdict.blockingCount).toBe(1);

      // Nothing was written to stderr, because nothing SURVIVED to be reported. An observe-only
      // report and a refusal are different outcomes, and conflating them is how a blocking gate
      // gets mistaken for a noisy one.
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(written.join('')).toBe('');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
