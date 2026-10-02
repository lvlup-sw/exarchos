/**
 * Tests for the `retired-hooks-present` doctor check. The check reads
 * `<home>/.claude/settings.json`. It gives `Warning` with a `fix` when a retired
 * lifecycle hook is present. A hook matches only by its command marker, so the
 * check never flags a user hook.
 */

import { describe, it, expect } from 'vitest';

import { retiredHooksPresent } from '../../../../../src/verbs/doctor/checks/retired-hooks-present.js';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import { CheckResultSchema } from '../../../../../src/verbs/doctor/schema.js';
import { RETIRED_HOOKS_CHECK_NAME } from '../../../../../src/verbs/onboard/hooks.js';
import type { DoctorProbes } from '../../../../../src/verbs/doctor/probes.js';

const HOME = '/fake/home';

/** A probes bundle whose settings.json read returns `raw` (a string). */
function probesWithSettings(raw: string, home: string | undefined = HOME): DoctorProbes {
  return makeStubProbes({
    env: home === undefined ? {} : { HOME: home },
    fs: {
      readFile: async () => raw,
      stat: async () => ({ isDirectory: () => true }),
      access: async () => undefined,
    },
  });
}

/** A probes bundle whose settings.json read fails (absent file). */
function probesWithNoSettings(home: string | undefined = HOME): DoctorProbes {
  return makeStubProbes({
    env: home === undefined ? {} : { HOME: home },
    fs: {
      readFile: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      stat: async () => ({ isDirectory: () => true }),
      access: async () => undefined,
    },
  });
}

function run(probes: DoctorProbes) {
  return retiredHooksPresent(probes, new AbortController().signal);
}

describe('retired-hooks-present check (DR-7)', () => {
  /** The SessionStart directive from onboard is a retired hook. The non-empty `fix` lands the removal step. */
  it('retiredHooksCheck_ProvenanceMatchedHooksPresent_Remediable', async () => {
    const settings = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [{ type: 'command', command: "exarchos session-start --directive 'x'" }],
          },
        ],
      },
    });

    const result = await run(probesWithSettings(settings));

    expect(result.name).toBe(RETIRED_HOOKS_CHECK_NAME);
    expect(result.status).toBe('Warning');
    expect(result.fix && result.fix.length).toBeGreaterThan(0);
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  /** The SessionEnd observer is also retired, because the launcher owns the session lifecycle. */
  it('retiredHooksCheck_SessionEndPresent_Remediable', async () => {
    const settings = JSON.stringify({
      hooks: {
        SessionEnd: [{ matcher: 'auto', hooks: [{ type: 'command', command: 'exarchos session-end' }] }],
      },
    });

    const result = await run(probesWithSettings(settings));

    expect(result.status).toBe('Warning');
    expect(result.fix && result.fix.length).toBeGreaterThan(0);
  });

  /** A user hook and the retained SubagentStop binding are not retired. A `Pass` result carries no `fix`. */
  it('retiredHooksCheck_CleanSettings_Pass', async () => {
    const settings = JSON.stringify({
      hooks: {
        SubagentStop: [{ matcher: '*', hooks: [{ type: 'command', command: 'exarchos subagent-stop' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-linter' }] }],
      },
    });

    const result = await run(probesWithSettings(settings));

    expect(result.name).toBe(RETIRED_HOOKS_CHECK_NAME);
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it('retiredHooksCheck_AbsentSettings_Pass', async () => {
    const result = await run(probesWithNoSettings());
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
  });

  it('retiredHooksCheck_HomeUnresolvable_Pass', async () => {
    const result = await run(probesWithSettings('{}', undefined));
    expect(result.status).toBe('Pass');
  });

  /** The check cannot confirm retired hooks in a file that does not parse. It skips with a reason and plans no removal step. */
  it('retiredHooksCheck_UnparseableSettings_SkippedNotRemovalStep', async () => {
    const result = await run(probesWithSettings('{ not json'));
    expect(result.status).toBe('Skipped');
    expect(result.reason && result.reason.length).toBeGreaterThan(0);
    expect(result.fix).toBeUndefined();
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });
});
