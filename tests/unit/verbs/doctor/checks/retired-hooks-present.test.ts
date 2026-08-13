/**
 * Tests for the `retired-hooks-present` doctor check (Task 017, DR-7).
 *
 * The check reads `<home>/.claude/settings.json` and is REMEDIABLE (Warning +
 * `fix`) exactly when a provenance-matched retired lifecycle hook (SessionStart
 * directive / SessionEnd observer) is present — the finding that lands the
 * removal PlanStep. Clean settings (or only USER hooks / the retained SubagentStop
 * binding) ⇒ Pass. Provenance is command-marker only, so a user-authored hook is
 * never flagged.
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
  it('retiredHooksCheck_ProvenanceMatchedHooksPresent_Remediable', async () => {
    // Settings carrying the onboard-installed SessionStart directive — a retired
    // hook by command-marker provenance.
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

    // Remediable: Warning + a non-empty fix (this is what lands the removal step).
    expect(result.name).toBe(RETIRED_HOOKS_CHECK_NAME);
    expect(result.status).toBe('Warning');
    expect(result.fix && result.fix.length).toBeGreaterThan(0);
    // Contract-valid CheckResult.
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it('retiredHooksCheck_SessionEndPresent_Remediable', async () => {
    // The SessionEnd observer is also retired (launcher owns lifecycle).
    const settings = JSON.stringify({
      hooks: {
        SessionEnd: [{ matcher: 'auto', hooks: [{ type: 'command', command: 'exarchos session-end' }] }],
      },
    });

    const result = await run(probesWithSettings(settings));

    expect(result.status).toBe('Warning');
    expect(result.fix && result.fix.length).toBeGreaterThan(0);
  });

  it('retiredHooksCheck_CleanSettings_Pass', async () => {
    // Only a USER hook + the RETAINED SubagentStop binding — neither is retired.
    const settings = JSON.stringify({
      hooks: {
        SubagentStop: [{ matcher: '*', hooks: [{ type: 'command', command: 'exarchos subagent-stop' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-linter' }] }],
      },
    });

    const result = await run(probesWithSettings(settings));

    expect(result.name).toBe(RETIRED_HOOKS_CHECK_NAME);
    expect(result.status).toBe('Pass');
    // Pass carries no fix (remediation affordance only on non-green states).
    expect(result.fix).toBeUndefined();
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it('retiredHooksCheck_AbsentSettings_Pass', async () => {
    // No settings.json → nothing installed to remove → Pass, no step.
    const result = await run(probesWithNoSettings());
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
  });

  it('retiredHooksCheck_HomeUnresolvable_Pass', async () => {
    // No HOME/USERPROFILE → cannot locate settings → Pass (no remediation).
    const result = await run(probesWithSettings('{}', undefined));
    expect(result.status).toBe('Pass');
  });

  it('retiredHooksCheck_UnparseableSettings_SkippedNotRemovalStep', async () => {
    // A present-but-unparseable file cannot be confirmed to hold retired hooks;
    // Skip (with a reason) rather than Warn — never a spurious removal step.
    const result = await run(probesWithSettings('{ not json'));
    expect(result.status).toBe('Skipped');
    expect(result.reason && result.reason.length).toBeGreaterThan(0);
    expect(result.fix).toBeUndefined();
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });
});
