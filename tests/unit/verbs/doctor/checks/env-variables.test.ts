// @oracle-sources: ../../../../../src/verbs/doctor/checks/env-variables.ts, shipped-src-corpus
//
// The drift guard below derives its expectation from the shipped `src/` tree —
// every `EXARCHOS_*` name the source mentions — and checks it against the
// hand-maintained `KNOWN` set in the check itself. Both authorities are named
// here because the assertion is a comparison BETWEEN them: the tree supplies
// the population, the check supplies the claim, and the test exists to stop the
// two drifting apart.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVariables } from '../../../../../src/verbs/doctor/checks/env-variables.js';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';

/**
 * The names the check itself recognizes, read out of its source.
 *
 * Deliberately NOT a copy of the list: a second hand-maintained copy would be
 * the very defect this file guards against.
 */
const CHECK_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../src/verbs/doctor/checks/env-variables.ts',
);

const KNOWN_NAMES: readonly string[] = [
  ...new Set(
    (fs.readFileSync(CHECK_SOURCE, 'utf8').match(/'(EXARCHOS_[A-Z0-9_]+)'/g) ?? []).map((s) =>
      s.replaceAll("'", ''),
    ),
  ),
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/**
 * The two directions deliberately scan different trees.
 *
 * Forward ("every name the source mentions must be recognized") reads `src/`
 * alone, because that is what the shipped product actually consults. Widening
 * it would drag in this file's own negative fixture (`EXARCHOS_FOO`) and demand
 * that a name invented to be unknown be added to the list.
 *
 * Reverse ("every recognized name must still be mentioned") reads the whole
 * repository, because a knob that only a test still exercises is not yet dead
 * and removing it from the list would make `doctor` warn about it. The wider
 * scope makes the reverse claim weaker and safer: it fires only for a name
 * nothing anywhere refers to.
 */
const REVERSE_SCAN_ROOTS = ['src', 'tests', 'tools'].map((d) => path.join(REPO_ROOT, d));

/**
 * Every `EXARCHOS_*` name the shipped source mentions, EXCLUDING the check's
 * own module.
 *
 * The exclusion is load-bearing, not tidiness. The check declares its
 * recognized names as string literals, so a scan that reads that file finds
 * every one of them and the reverse direction becomes a tautology: the list
 * would prove itself current by quoting itself. Seeding a name the rest of the
 * tree never mentions is what exposed it — with the file in scope, the guard
 * stayed green.
 */
function scanExarchosNames(
  dir: string,
  found: Set<string> = new Set(),
  exclude: string = CHECK_SOURCE,
): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanExarchosNames(abs, found, exclude);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && path.resolve(abs) !== exclude) {
      for (const m of fs.readFileSync(abs, 'utf8').matchAll(/EXARCHOS_[A-Z0-9_]+/g)) {
        found.add(m[0]);
      }
    }
  }
  return found;
}

const signal = new AbortController().signal;

describe('env-variables', () => {
  it('EnvVariables_AllExarchosEnvValid_ReturnsPass', async () => {
    const probes = makeStubProbes({
      env: {
        EXARCHOS_LOG_LEVEL: 'debug',
        EXARCHOS_PLUGIN_ROOT: '/opt/exarchos',
        PATH: '/usr/bin', // unrelated, ignored
      },
    });

    const result = await envVariables(probes, signal);

    expect(result.category).toBe('env');
    expect(result.name).toBe('variables');
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
  });

  // ─── the list is hand-maintained, so prove it against the tree ───────────
  //
  // Seventeen supported variables had drifted out of `KNOWN`, so `doctor`
  // reported correct configuration as an unknown variable and advised removing
  // it. A hand-maintained mirror of a fact the source already carries goes
  // stale silently; this is the tooth that makes it go red instead.
  it('EnvVariables_EveryNameTheSourceMentions_IsRecognized', async () => {
    const names = [...scanExarchosNames(SRC_ROOT)].sort();

    // Denominator: a scan that finds nothing would satisfy the loop below
    // without checking anything.
    expect(names.length).toBeGreaterThan(20);

    // Feed every name at once — one Warning names every unrecognized member.
    const env: Record<string, string> = {};
    for (const n of names) env[n] = 'x';
    const result = await envVariables(makeStubProbes({ env }), signal);

    expect(
      result.status,
      `doctor calls these supported variables unknown: ${result.message}`,
    ).toBe('Pass');
  });

  // The other direction. A one-way check lets the list keep names the source
  // dropped, so a deleted variable stays "supported" forever and the list grows
  // monotonically into fiction. Both directions together pin it to the tree.
  it('EnvVariables_EveryRecognizedName_IsStillMentionedBySource', async () => {
    const names = new Set<string>();
    for (const root of REVERSE_SCAN_ROOTS) scanExarchosNames(root, names);
    expect(names.size).toBeGreaterThan(20);

    // A name is recognized when the check does NOT warn about it on its own.
    const stale: string[] = [];
    for (const known of KNOWN_NAMES) {
      if (names.has(known)) continue;
      const r = await envVariables(makeStubProbes({ env: { [known]: 'x' } }), signal);
      if (r.status === 'Pass') stale.push(known);
    }

    expect(
      stale,
      'these names are recognized by doctor but nothing in the repository mentions them',
    ).toEqual([]);
  });

  it('EnvVariables_UnknownExarchosEnvVar_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      env: {
        EXARCHOS_LOG_LEVEL: 'info',
        EXARCHOS_FOO: 'bar',
      },
    });

    const result = await envVariables(probes, signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('EXARCHOS_FOO');
    expect(result.fix).toBe(
      'Remove unknown variable or check documentation for supported EXARCHOS_* vars',
    );
  });
});
