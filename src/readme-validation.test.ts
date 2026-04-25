import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, '..', 'README.md');

/**
 * Slice the `## Install` section out of the README so context-window
 * checks operate on the install prose only. Matching the same `httpsUrl`
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
  it('Readme_InstallSection_MentionsHttpsFallback', () => {
    const installSection = readInstallSection(readFileSync(README_PATH, 'utf8'));
    const httpsUrl = 'https://github.com/lvlup-sw/.github.git';

    // The HTTPS fallback URL must appear in the Install section.
    expect(installSection).toContain(httpsUrl);

    // The context must clarify this is the HTTPS/SSH fallback by mentioning
    // either "HTTPS" or "SSH" within 500 characters of the URL — but the
    // URL itself contains "https://" which would match a naive /HTTPS/i.
    // Slice the URL out of the window so the regex catches genuine
    // explanatory prose, not the URL protocol.
    const urlIndex = installSection.indexOf(httpsUrl);
    const windowStart = Math.max(0, urlIndex - 500);
    const windowEnd = Math.min(installSection.length, urlIndex + httpsUrl.length + 500);
    const leftContext = installSection.slice(windowStart, urlIndex);
    const rightContext = installSection.slice(urlIndex + httpsUrl.length, windowEnd);
    const contextWithoutUrl = leftContext + rightContext;

    const mentionsFallbackContext =
      /\bHTTPS\b/i.test(contextWithoutUrl) || /\bSSH\b/i.test(contextWithoutUrl);

    expect(
      mentionsFallbackContext,
      'Expected "HTTPS" or "SSH" within 500 chars of the HTTPS URL inside the Install section',
    ).toBe(true);
  });
});
