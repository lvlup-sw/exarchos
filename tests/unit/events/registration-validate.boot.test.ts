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
    expect(caught.verdict.observeCount).toBe(0);
    for (const diagnostic of caught.verdict.diagnostics) {
      expect(diagnostic.severity).toBe('blocking');
    }
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
    const observeEverything: Record<string, 'blocking' | 'observe'> = {};
    for (const code of Object.keys(DIAGNOSTIC_SEVERITY_POLICY)) observeEverything[code] = 'observe';

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
    const quiet: string[] = [];
    const clean = assertRegistrationWeldsAtStartup(
      EVENT_ANNOTATIONS,
      EFFECT_PROVIDERS,
      EFFECT_OWNERSHIP,
      WELD_RESOLUTION_POLICY,
      observeEverything,
      (message) => quiet.push(message),
    );
    expect(clean.ok).toBe(true);
    expect(quiet).toEqual([]);
    expect(clean.bootResolvedCount).toBeGreaterThan(0);
  });
});
