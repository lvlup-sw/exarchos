// ─── P07-04 — cross-runtime + packaged parity of the admission decision ──────
//
// The admission decision path is a pure, deterministic fold. This suite proves
// that determinism CROSSES the runtime boundary: the same corpus digest is
// produced by Node (this vitest process) and by Bun (`bun run` on the standalone
// CLI, which is also the runtime the packaged binary is built with — P05-02).
//
// Honest scope note (packaged): the shipped `exarchos` binary exposes no CLI
// surface for the internal admission decision, so a *binary-invoked* admission
// digest is not feasible here. Bun is the packaged runtime (the binary is a
// `bun build --compile` artifact), so running the digest under Bun exercises the
// same module resolution + stdlib the packaged binary uses — the closest
// faithful packaged-parity proof available without a bespoke admission CLI
// surface. See the final report for the follow-up.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { admissionScenarioCorpus } from './__fixtures__/admission-scenario-corpus.js';
import { corpusDigest } from './__fixtures__/admission-decision-path.js';

const CLI_PATH = fileURLToPath(
  new URL('./__fixtures__/corpus-digest-cli.ts', import.meta.url),
);

const IS_WIN = process.platform === 'win32';

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a REAL bun executable (never a `.cmd`/`.ps1` shim — Node ≥ 20 refuses
 * to `execFile` those without `shell:true`, and we want a hermetic no-shell
 * spawn). On Linux CI `bun` is a real PATH executable; on this Windows dev box
 * PATH only holds the npm-global `bun.cmd` shim, whose real binary lives at
 * `<shim-dir>/node_modules/bun/bin/bun.exe` (per the shim body).
 */
function resolveBunExecutable(): string | null {
  const pathDirs = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0);
  const realName = IS_WIN ? 'bun.exe' : 'bun';

  for (const dir of pathDirs) {
    const direct = join(dir, realName);
    if (isFile(direct)) return direct;
  }
  if (IS_WIN) {
    for (const dir of pathDirs) {
      if (isFile(join(dir, 'bun.cmd'))) {
        const derived = join(dir, 'node_modules', 'bun', 'bin', 'bun.exe');
        if (isFile(derived)) return derived;
      }
    }
  }
  // Last resort: trust PATH resolution via a bare invocation (Linux).
  try {
    execFileSync(realName, ['--version'], { stdio: 'ignore' });
    return realName;
  } catch {
    return null;
  }
}

const BUN_EXECUTABLE = resolveBunExecutable();

function runBunDigest(bun: string): string {
  const stdout = execFileSync(bun, ['run', CLI_PATH], {
    encoding: 'utf8',
    // Keep it hermetic and fast; the CLI does pure in-memory work.
    timeout: 60_000,
  });
  const match = /DIGEST=([a-f0-9]{64})/.exec(stdout);
  if (match === null || match[1] === undefined) {
    throw new Error(`bun digest CLI produced no DIGEST line: ${stdout}`);
  }
  return match[1];
}

describe('admission decision cross-runtime parity (exit-proof d, cross-runtime leg)', () => {
  it('CorpusDigest_IsStable_AndContentAddressed_UnderNode', () => {
    const a = corpusDigest(admissionScenarioCorpus);
    const b = corpusDigest(admissionScenarioCorpus);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toBe(a);
  });

  it.skipIf(BUN_EXECUTABLE === null)(
    'CorpusDigest_MatchesAcrossNodeAndBun',
    () => {
      const nodeDigest = corpusDigest(admissionScenarioCorpus);
      // BUN_EXECUTABLE is non-null in this branch (skipIf guards it).
      const bunDigest = runBunDigest(BUN_EXECUTABLE as string);
      expect(bunDigest).toBe(nodeDigest);
    },
  );
});
