/**
 * The removed onboarding verbs `init`, `install-skills` and `new-project` must
 * not appear as live commands. The scan reads the README, the two bootstrap
 * installers, and the guides in `docs/guides`. The scan excludes the dated record trees under
 * `docs/`. A line that flags a rename and names the replacement verb is exempt.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The repo root, three levels up from `tests/unit/verbs`. */
const REPO_ROOT = join(__dirname, '../../..');

/**
 * The removed verbs as live commands. `exarchos init` needs the `exarchos`
 * prefix, so the noun "init" in prose does not match. The other two verbs are
 * distinct enough to match without a prefix.
 */
const STALE_VERB_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'install-skills', re: /\binstall-skills\b/ },
  { label: 'new-project', re: /\bnew-project\b/ },
  { label: 'exarchos init', re: /\bexarchos\s+init\b/ },
];

/**
 * A line is an exempt migration note when it flags a rename or removal and
 * also names the replacement verb. The second condition stops a live
 * instruction that contains the word "removed" from being exempt.
 */
function isMigrationNoteLine(line: string): boolean {
  const lower = line.toLowerCase();
  const flagsRename = /\b(renamed|removed|retired|consolidat|deprecat|replaced|no longer|former|legacy)\b/.test(
    lower,
  );
  const pointsAtReplacement = /exarchos\s+onboard|`onboard`|\bonboard\b.*\bverb\b|doctor\s+--fix/.test(
    lower,
  );
  return flagsRename && pointsAtReplacement;
}

/**
 * The explicit scan list: the README, the two bootstrap installers, and each
 * `.md` file in `docs/guides`. The test scans each file line by line, so a
 * migration note on one line cannot exempt a live instruction on another.
 */
function liveSurfaceFiles(): readonly string[] {
  const files: string[] = [
    join(REPO_ROOT, 'README.md'),
    join(REPO_ROOT, 'tools', 'release', 'get-exarchos.sh'),
    join(REPO_ROOT, 'tools', 'release', 'get-exarchos.ps1'),
  ];

  const docsGuidesDir = join(REPO_ROOT, 'docs', 'guides');
  if (existsSync(docsGuidesDir)) {
    for (const f of readdirSync(docsGuidesDir)) {
      if (f.endsWith('.md')) files.push(join(docsGuidesDir, f));
    }
  }

  return files;
}

describe('docs onboard sweep (DR-5 / T8, task 020)', () => {
  it('Docs_NoStaleOnboardingVerbReferences', () => {
    const offenders: string[] = [];

    for (const file of liveSurfaceFiles()) {
      expect(existsSync(file), `expected live-surface file to exist: ${file}`).toBe(true);
      const src = readFileSync(file, 'utf-8');
      const lines = src.split('\n');

      lines.forEach((line, idx) => {
        if (isMigrationNoteLine(line)) return;

        for (const { label, re } of STALE_VERB_PATTERNS) {
          if (re.test(line)) {
            const rel = file.slice(REPO_ROOT.length + 1);
            offenders.push(`${rel}:${idx + 1}: stale '${label}' → ${line.trim()}`);
          }
        }
      });
    }

    expect(
      offenders,
      `live doc/bootstrap surfaces must not reference retired onboarding verbs ` +
        `(install-skills / new-project / exarchos init) as live commands — use ` +
        `'exarchos onboard' / 'doctor --fix'. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
