export interface VerifyResult {
  passed: boolean;
  diff?: string;
}

function normalize(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
}

export function verify(actual: string, expected: string): VerifyResult {
  const actualLines = normalize(actual);
  const expectedLines = normalize(expected);

  const diffs: string[] = [];

  const maxLen = Math.max(actualLines.length, expectedLines.length);
  for (let i = 0; i < maxLen; i++) {
    const a = i < actualLines.length ? actualLines[i] : undefined;
    const e = i < expectedLines.length ? expectedLines[i] : undefined;

    if (a !== e) {
      diffs.push(
        `line ${i + 1}: expected "${e ?? '(missing)'}", got "${a ?? '(missing)'}"`
      );
    }
  }

  if (diffs.length === 0) {
    return { passed: true };
  }

  return {
    passed: false,
    diff: diffs.join('\n'),
  };
}
