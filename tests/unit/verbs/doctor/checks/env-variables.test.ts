// @oracle-sources: ../../../../../src/verbs/doctor/checks/env-variables.ts, shipped-src-corpus
//
// The drift guard compares two authorities. The shipped `src/` tree supplies every
// `EXARCHOS_*` name. The hand-maintained `KNOWN` set in the check supplies the claim.
// The test stops the two from drifting apart.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVariables } from '../../../../../src/verbs/doctor/checks/env-variables.js';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';

/**
 * The check source. The test reads the recognized names from this file.
 * A second hand-maintained copy of the list is the defect that this file guards against.
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
 * The two directions scan different trees.
 *
 * Forward reads `src/` only, because only that tree ships.
 * A wider scan finds the negative fixture `EXARCHOS_FOO` and demands that the list recognize it.
 *
 * Reverse reads `src`, `tests` and `tools`. A name that only a test uses is not dead.
 * The reverse check fails only for a name that no scanned file mentions.
 */
const REVERSE_SCAN_ROOTS = ['src', 'tests', 'tools'].map((d) => path.join(REPO_ROOT, d));

/**
 * Collects every `EXARCHOS_*` name in the `.ts` files under `dir`, except the `exclude` file.
 * The default exclusion is the check module. It declares its names as string literals,
 * so a scan of it makes the reverse direction pass for every name.
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
        PATH: '/usr/bin',
      },
    });

    const result = await envVariables(probes, signal);

    expect(result.category).toBe('env');
    expect(result.name).toBe('variables');
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
  });

  /**
   * `KNOWN` is hand-maintained, so this test proves it against the tree.
   * The check for more than 20 names stops an empty scan from passing.
   * The test sets every name at once, so that one Warning names every unrecognized name.
   */
  it('EnvVariables_EveryNameTheSourceMentions_IsRecognized', async () => {
    const names = [...scanExarchosNames(SRC_ROOT)].sort();

    expect(names.length).toBeGreaterThan(20);

    const env: Record<string, string> = {};
    for (const n of names) env[n] = 'x';
    const result = await envVariables(makeStubProbes({ env }), signal);

    expect(
      result.status,
      `doctor calls these supported variables unknown: ${result.message}`,
    ).toBe('Pass');
  });

  /**
   * The reverse direction stops the list from keeping a name that the source dropped.
   * A name counts as recognized when the check gives Pass for that name alone.
   */
  it('EnvVariables_EveryRecognizedName_IsStillMentionedBySource', async () => {
    const names = new Set<string>();
    for (const root of REVERSE_SCAN_ROOTS) scanExarchosNames(root, names);
    expect(names.size).toBeGreaterThan(20);

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
