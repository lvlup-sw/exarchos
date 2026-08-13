import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, '../../README.md');

/**
 * Slice the `## Install` section out of the README so context-window
 * checks operate on the install prose only. Matching an install token
 * elsewhere in the doc (a "Related projects" link, an example, etc.)
 * would let the test pass for the wrong reason. Throws if the heading is
 * absent so a future README reorg can't silently turn this into a
 * vacuous pass.
 */
function readInstallSection(content: string): string {
  const installRe = /(^|\n)##\s+Install(\b|\s)/i;
  const installMatch = installRe.exec(content);
  if (!installMatch) {
    throw new Error('README.md is missing a "## Install" heading');
  }
  const start = installMatch.index + (installMatch[1] === '\n' ? 1 : 0);
  const after = content.slice(start + 1); // skip past the matched newline-or-start
  const nextHeading = /\n##\s+/.exec(after);
  return nextHeading
    ? content.slice(start, start + 1 + nextHeading.index)
    : content.slice(start);
}

describe('README validation', () => {
  it('Readme_InstallSection_DocumentsPrimaryInstaller', () => {
    const installSection = readInstallSection(readFileSync(README_PATH, 'utf8'));

    // The Install section must document the canonical one-line installer for
    // the standalone CLI. Sliced to the Install section (readInstallSection
    // throws if the heading is gone) so an install token elsewhere in the
    // README can't satisfy this for the wrong reason, and a reorg that drops
    // the install command can't silently turn this into a vacuous pass.
    expect(installSection).toContain('get-exarchos.sh');
  });
});
