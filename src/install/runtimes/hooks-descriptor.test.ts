import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadAllRuntimes } from './load.js';

// #1485: assert every runtime's hooks descriptor matches design §4.3. The data
// is also drift-guarded (runtimes:guard) and exercised via the renderer
// integration test; these assertions lock the per-runtime capability values.
const RUNTIMES_DIR = resolve(__dirname, '../../../runtimes');

const EXPECTED: Record<string, { profile: string; canInjectContext: boolean; start: string | null; end: string | null }> = {
  claude: { profile: 'claude-json', canInjectContext: true, start: 'SessionStart', end: 'SessionEnd' },
  codex: { profile: 'claude-json', canInjectContext: true, start: 'SessionStart', end: 'Stop' },
  opencode: { profile: 'opencode-plugin', canInjectContext: false, start: 'session.created', end: 'session.idle' },
  cursor: { profile: 'cursor-json', canInjectContext: true, start: 'sessionStart', end: 'sessionEnd' },
  copilot: { profile: 'copilot-json', canInjectContext: false, start: 'sessionStart', end: 'sessionEnd' },
  generic: { profile: 'none', canInjectContext: false, start: null, end: null },
};

describe('runtime hooks descriptors (#1485 T2)', () => {
  const runtimes = loadAllRuntimes(RUNTIMES_DIR);

  for (const [name, exp] of Object.entries(EXPECTED)) {
    it(`${name}Runtime_HooksDescriptor_MatchesSpec`, () => {
      const rt = runtimes.find((r) => r.name === name);
      expect(rt, `runtime ${name} not loaded`).toBeDefined();
      expect(rt!.capabilities.hooks?.profile).toBe(exp.profile);
      expect(rt!.capabilities.hooks?.canInjectContext).toBe(exp.canInjectContext);
      expect(rt!.capabilities.hooks?.sessionStartEvent).toBe(exp.start);
      expect(rt!.capabilities.hooks?.sessionEndEvent).toBe(exp.end);
    });
  }
});
