import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── DR-5 / T8 (task 020): migration + docs sweep ─────────────────────────────
//
// `init`, `install-skills`, and `new-project` were consolidated into the single
// `onboard` (+ `--new`) / `doctor --fix` onboarding surface (design §7). The
// removed verbs survive for one release ONLY as error stubs that print
// `renamed → use 'exarchos onboard'`.
//
// This test is the regression shield over the LIVE, NORMATIVE doc + bootstrap
// surfaces: no live surface may instruct an operator to run a retired verb. The
// scan list is EXPLICIT and intentionally excludes the dated `docs/` record
// trees (designs/plans/research/rca/contexts/followups/proposals), which are
// historical and legitimately name the old verbs.
//
// A retired verb may appear on a live surface ONLY inside an explicit
// "renamed/removed" migration note — those lines are exempted below so the
// v2.10.2 rename note can name the old verbs while explaining the replacement.

// The repo root, four levels up from src/verbs/.
const REPO_ROOT = join(__dirname, '../../..');

// The retired onboarding verbs, matched as LIVE commands (an `exarchos <verb>`
// invocation or a bare verb token in a command position). `exarchos init` is
// matched with the `exarchos ` prefix so we don't flag the noun "init" in prose
// (e.g. "initial state"); `install-skills` / `new-project` are distinctive
// enough to match bare.
const STALE_VERB_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'install-skills', re: /\binstall-skills\b/ },
  { label: 'new-project', re: /\bnew-project\b/ },
  { label: 'exarchos init', re: /\bexarchos\s+init\b/ },
];

// A line is an explicit migration/rename/removal note (exempt) when it both
// flags the rename/removal AND points at the replacement verb. Requiring BOTH
// halves keeps the exemption from swallowing a stray live instruction that just
// happens to contain the word "removed".
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

// The EXPLICIT live-surface scan list. Files are read as flat text; each is
// scanned line-by-line so a migration note on one line cannot exempt a live
// instruction on another.
function liveSurfaceFiles(): readonly string[] {
  const files: string[] = [
    join(REPO_ROOT, 'README.md'),
    join(REPO_ROOT, 'tools', 'release', 'get-exarchos.sh'),
    join(REPO_ROOT, 'tools', 'release', 'get-exarchos.ps1'),
  ];

  // The published install guide used to live at documentation/guide/*.md. That
  // site was reduced to a build skeleton and its pages removed, so the install
  // instructions a user actually reads are the README and the two bootstrap
  // installers above — all three scanned unconditionally, so this sweep still
  // has a subject.

  // docs/guides/*.md — the operator/authoring guides (NOT the dated docs/
  // record trees, which are historical and excluded by construction).
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
        // A line inside an explicit rename/removal migration note may name the
        // old verbs while explaining the replacement.
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
