import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, '..', 'README.md');

describe('README validation', () => {
  it('Readme_InstallSection_MentionsHttpsFallback', () => {
    const content = readFileSync(README_PATH, 'utf8');
    const httpsUrl = 'https://github.com/lvlup-sw/.github.git';

    // The HTTPS fallback URL must appear in the README.
    expect(content).toContain(httpsUrl);

    // The context must clarify this is the HTTPS/SSH fallback by mentioning
    // either "HTTPS" or "SSH" within 500 characters of the URL — but the
    // URL itself contains "https://" which would match a naive /HTTPS/i.
    // Slice the URL out of the window so the regex catches genuine
    // explanatory prose, not the URL protocol.
    const urlIndex = content.indexOf(httpsUrl);
    const windowStart = Math.max(0, urlIndex - 500);
    const windowEnd = Math.min(content.length, urlIndex + httpsUrl.length + 500);
    const leftContext = content.slice(windowStart, urlIndex);
    const rightContext = content.slice(urlIndex + httpsUrl.length, windowEnd);
    const contextWithoutUrl = leftContext + rightContext;

    const mentionsFallbackContext =
      /\bHTTPS\b/i.test(contextWithoutUrl) || /\bSSH\b/i.test(contextWithoutUrl);

    expect(
      mentionsFallbackContext,
      'Expected "HTTPS" or "SSH" within 500 chars of the HTTPS URL to signal fallback context',
    ).toBe(true);
  });
});
