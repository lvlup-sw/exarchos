// ─── Test report carrier — the result side of the toolchain SoT ─────────────
//
// The runner COMMAND resolves from the toolchain registry; before this seam its
// RESULT CARRIER did not, so the integration-suite gate appended vitest's
// `--reporter=json` to every resolved command (`cargo test --reporter=json`)
// and parsed vitest JSON only.
//
// Three properties are load-bearing here:
//   - resolution is TOTAL over the registry (measured against the live array,
//     never a hand-listed id set — a hand-list passes by shrinking with it);
//   - an id outside the registry lands on the `unknown` arm, so the gate can
//     report indeterminate instead of guessing;
//   - the reporter flag rides on the descriptor, so no consumer can hand one
//     runner another runner's flag.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

import {
  BUILTIN_TOOLCHAINS,
  resolveTestReportFormat,
} from '../../../src/config/toolchains.js';

describe('resolveTestReportFormat (per-runner result carrier)', () => {
  it('EveryBuiltinToolchain_HasAReportFormat', () => {
    const ids = BUILTIN_TOOLCHAINS.map((t) => t.id);

    // Denominator first: the loop below proves nothing if the registry is
    // empty, and it must not silently shrink under the guard either.
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(new Set(ids).size).toBe(ids.length);

    const unresolved = ids.filter((id) => resolveTestReportFormat(id).kind === 'unknown');
    expect(unresolved).toEqual([]);
  });

  it('UnknownToolchain_ResolvesUnknownArm', () => {
    // Anti-vacuity: this asserts something only while `zig` really is outside
    // the registry.
    const id = 'zig';
    expect(BUILTIN_TOOLCHAINS.some((t) => t.id === id)).toBe(false);

    const format = resolveTestReportFormat(id);
    expect(format.kind).toBe('unknown');
    if (format.kind === 'unknown') {
      // The reason names the id, so an indeterminate verdict is actionable.
      expect(format.reason).toContain(id);
    }
  });

  it('Descriptor_CarriesItsOwnReporterFlag', () => {
    const ids = BUILTIN_TOOLCHAINS.map((t) => t.id);
    expect(ids.length).toBeGreaterThanOrEqual(12);

    // Which ids carry a reporter flag is the whole claim, so it is pinned as a
    // SET. Sampling the complement — naming `rust` and `python` and trusting
    // the rest — is what lets a wrong flag reappear on `go` or `dotnet` without
    // anything going red.
    const vitestIds = ids.filter((id) => resolveTestReportFormat(id).kind === 'vitest-json');
    // Both directions, so neither a new id silently acquiring the flag nor
    // `node` silently losing it can pass — the set claim, unweakened. Written
    // as two checks rather than one sorted comparison because the sorted form
    // reads as a parity between two derived populations, and the right-hand
    // side here is a literal: `BUILTIN_TOOLCHAINS` and `resolveTestReportFormat`
    // are the same authority, so there is no second one to take a parity
    // against. This form also NAMES the offending id instead of printing two
    // lists that differ.
    expect(
      vitestIds.filter((id) => id !== 'node'),
      'an id acquired the vitest-json report format',
    ).toEqual([]);
    expect(vitestIds, 'node lost the vitest-json report format').toContain('node');

    for (const id of vitestIds) {
      const arm = resolveTestReportFormat(id);
      if (arm.kind === 'vitest-json') {
        // The consumer reads the flag off the descriptor rather than spelling it.
        expect(arm.reporterFlag).toBe('--reporter=json');
      }
    }

    // Every remaining id — the denominator is the live registry minus the
    // vitest set, never a literal list — carries the exit code and nothing to
    // append. This is the measured defect: `cargo test --reporter=json`.
    const exitCodeIds = ids.filter((id) => !vitestIds.includes(id));
    expect(exitCodeIds.length).toBe(ids.length - vitestIds.length);
    for (const id of exitCodeIds) {
      expect(resolveTestReportFormat(id)).toEqual({ kind: 'exit-code-only' });
    }
  });

  it('MissingEntry_IsACompileError', () => {
    // The compile-time half of this claim is NOT here, and cannot be: the tests
    // tsconfig excludes `unit/**`, so a `@ts-expect-error` in this file would be
    // checked by no compiler. It lives in the subject module as the exported
    // `_Toolchains_CarrierRows_CoverExactlyTheRegistry` proof alias, which
    // `npm run typecheck` does read.
    //
    // This is its runtime twin: what the compile device buys is that a registry
    // entry with no carrier row can never reach a consumer as a silent
    // `unknown`. Measured over the live registry, against a control proving the
    // `unknown` arm is reachable at all — otherwise the first half would hold
    // just as well if the arm were unreachable by construction.
    const silentlyUnknown = BUILTIN_TOOLCHAINS.filter(
      (t) => resolveTestReportFormat(t.id).kind === 'unknown',
    ).map((t) => t.id);
    expect(silentlyUnknown).toEqual([]);

    const offRegistry = 'toolchain-the-registry-does-not-carry';
    expect(BUILTIN_TOOLCHAINS.some((t) => t.id === offRegistry)).toBe(false);
    expect(resolveTestReportFormat(offRegistry).kind).toBe('unknown');
  });
});
