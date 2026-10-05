import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, '../../../README.md');

/**
 * Return the `## Install` section of the README, so the checks read the install
 * prose only. An install token in a different section must not make the test pass.
 * The function throws when the heading is absent, so a README reorganization
 * cannot turn the test into a vacuous pass.
 */
function readInstallSection(content: string): string {
  const installRe = /(^|\n)##\s+Install(\b|\s)/i;
  const installMatch = installRe.exec(content);
  if (!installMatch) {
    throw new Error('README.md is missing a "## Install" heading');
  }
  const start = installMatch.index + (installMatch[1] === '\n' ? 1 : 0);
  const after = content.slice(start + 1);
  const nextHeading = /\n##\s+/.exec(after);
  return nextHeading
    ? content.slice(start, start + 1 + nextHeading.index)
    : content.slice(start);
}

describe('README validation', () => {
  /** The Install section must document `get-exarchos.sh`, the one-line installer for the standalone CLI. */
  it('Readme_InstallSection_DocumentsPrimaryInstaller', () => {
    const installSection = readInstallSection(readFileSync(README_PATH, 'utf8'));

    expect(installSection).toContain('get-exarchos.sh');
  });
});
