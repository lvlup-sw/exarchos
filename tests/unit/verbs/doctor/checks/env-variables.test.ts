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

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../src',
);

/** Every `EXARCHOS_*` name the shipped source mentions. */
function scanExarchosNames(dir: string, found: Set<string> = new Set()): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanExarchosNames(abs, found);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
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
