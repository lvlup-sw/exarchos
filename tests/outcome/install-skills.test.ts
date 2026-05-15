// ─── T-015 — install-skills outcome (RED-by-design) ──────────────────────
//
// Encodes the #1355 regression: copilot/codex/cursor/opencode/generic
// runtimes' `install-skills` produces only `design-invariants` instead of
// the full bundle of skills. Claude alone produces the full bundle.
//
// Each per-runtime case is wrapped in `it.failing()` so vitest reports it
// as an expected failure. The fix in PR2 (wave1-fixes) will atomically
// remove the `.failing` annotation per runtime as each one regains parity
// with claude's behavior.
//
// This test invokes the real CLI binary (the bun-compiled platform binary
// at `dist/bin/exarchos-<platform>-<arch>`) under a tmp HOME so the
// install lands in an isolated location. No mocks at the test boundary.

import { describe, it, expect } from 'vitest';
import { withTmpHome } from './_helpers/tmp-home.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const RUNTIMES = [
  'claude',
  'copilot',
  'codex',
  'cursor',
  'opencode',
  'generic',
] as const;

// Per-runtime install paths under `<home>` — derived from
// `runtimes/<runtime>.yaml`'s `skillsInstallPath` field (the CLI's
// canonical install target). Hardcoding the resolution here (instead of
// importing the runtime maps) keeps the test free of source-tree
// internals: we assert what an operator would observe on disk.
const INSTALL_PATH_UNDER_HOME: Record<(typeof RUNTIMES)[number], string> = {
  claude: '.claude/skills',
  copilot: '.copilot/skills',
  codex: '.agents/skills',
  cursor: '.cursor/skills',
  opencode: '.config/opencode/skills',
  generic: '.agents/skills',
};

// Locate the platform binary produced by `npm run build`. The CLI is
// shipped as a bun-compiled native executable; the per-platform name
// follows the `exarchos-<os>-<arch>[.exe]` convention from
// `scripts/build-binary.ts`.
function platformBinaryName(): string {
  const platform = os.platform();
  const arch = os.arch();
  const ext = platform === 'win32' ? '.exe' : '';
  const osPart =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'win32'
        ? 'windows'
        : 'linux';
  const archPart = arch === 'arm64' ? 'arm64' : 'x64';
  return `exarchos-${osPart}-${archPart}${ext}`;
}

const CLI_BINARY = path.join(REPO_ROOT, 'dist', 'bin', platformBinaryName());

describe('install-skills outcome (#1355)', () => {
  for (const runtime of RUNTIMES) {
    // RED-by-design: removed in PR2 (wave1-fixes) as each runtime is fixed.
    // `it.fails` (vitest >=2) marks a test as an expected failure — the
    // test PASSES when its assertions throw and FAILS if they unexpectedly
    // pass. Reviewer grep target: `it.fails`.
    it(
      `InstallSkills_${runtime}_FullManifestInstalled`,
      async () => {
        // Source-of-truth: every skill directory under `skills/<runtime>/`
        // that has a SKILL.md file. The operator-visible contract is that
        // running `install-skills --agent <runtime>` materializes the
        // same set under the runtime's home install path.
        const sourceDir = path.resolve(REPO_ROOT, 'skills', runtime);
        const manifestExpected = fs
          .readdirSync(sourceDir)
          .filter((d) =>
            fs.existsSync(path.join(sourceDir, d, 'SKILL.md')),
          );

        await withTmpHome(async (home) => {
          // Run the real CLI. On failure (#1355 manifests as the upstream
          // `skills add` exiting non-zero or writing an incomplete bundle),
          // execFileSync throws; we catch so the on-disk assertion below
          // is the canonical signal — the test is `it.failing`, so the
          // assertion failing is the expected outcome.
          try {
            execFileSync(
              CLI_BINARY,
              ['install-skills', '--agent', runtime],
              {
                env: {
                  ...process.env,
                  HOME: home,
                  // Avoid clobbering each other when run in parallel and
                  // suppress prompts even if the binary detects a TTY
                  // through some unexpected channel.
                  NON_INTERACTIVE: '1',
                  CI: 'true',
                  FORCE_COLOR: '0',
                },
                stdio: 'pipe',
                timeout: 60_000,
              },
            );
          } catch {
            // Swallow — the assertion below is the operator-visible signal.
          }

          const installRoot = path.join(
            home,
            INSTALL_PATH_UNDER_HOME[runtime],
          );

          // If the install path doesn't exist at all, the install
          // produced no on-disk side effects — surface as an empty list
          // so the `arrayContaining` assertion fails with a clear diff.
          const installed = fs.existsSync(installRoot)
            ? fs
                .readdirSync(installRoot)
                .filter((d) =>
                  fs.existsSync(path.join(installRoot, d, 'SKILL.md')),
                )
            : [];

          expect(installed).toEqual(
            expect.arrayContaining(manifestExpected),
          );
        });
      },
    );
  }
});
