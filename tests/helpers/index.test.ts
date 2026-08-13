import { describe, it, expect } from 'vitest';

describe('fixtures barrel', () => {
  it('Barrel_ImportsAllPublicApi_AndNothingMore', async () => {
    const mod = await import('./index.js');
    const actual = Object.keys(mod).sort();
    const expected = [
      'withHermeticEnv',
      'spawnMcpClient',
      'runCli',
      'normalize',
      'expectNoLeakedProcesses',
    ].sort();
    expect(actual).toEqual(expected);
  });
});
