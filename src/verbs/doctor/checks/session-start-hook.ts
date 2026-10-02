/**
 * Doctor check for the `SubagentStop` token-attribution binding in the agent-host settings.
 * It probes `SubagentStop`, not `SessionStart`, because `retired-hooks-present` removes
 * `SessionStart`. A probe for `SessionStart` makes the two checks install and remove it on
 * alternate runs. `installHook` writes all three bindings in one pass, and the next doctor run
 * removes the two retired bindings.
 *
 * - `SubagentStop` present: Pass.
 * - Home unresolved, settings unreadable or not JSON, or `SubagentStop` absent: Warning with a `fix`.
 *
 * The `name` must stay `'session-start-hook'`. `CHECK_CLASSIFICATION` maps that key to the
 * `hook` step kind, and a roster test pins it.
 */

import { join } from 'node:path';
import type { CheckFn } from './__shared__/make-stub-probes.js';
import type { CheckResult } from '../schema.js';

const BASE = { category: 'agent' as const, name: 'session-start-hook' };

const FIX_HINT =
  'run `exarchos onboard` (or `exarchos doctor --fix`) to install the ' +
  'SubagentStop token-attribution binding into ~/.claude/settings.json';

interface CommandHook {
  readonly command?: unknown;
}
interface HookGroup {
  readonly hooks?: unknown;
}

/** Scan a parsed settings object for an exarchos SubagentStop binding. */
function hasSubagentStopBinding(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== 'object' || hooks === null) return false;
  const subagentStop = (hooks as { SubagentStop?: unknown }).SubagentStop;
  if (!Array.isArray(subagentStop)) return false;
  for (const group of subagentStop as HookGroup[]) {
    const inner = group?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner as CommandHook[]) {
      if (typeof h?.command === 'string' && h.command.includes('exarchos subagent-stop')) {
        return true;
      }
    }
  }
  return false;
}

export const sessionStartHook: CheckFn = async (probes): Promise<CheckResult> => {
  const start = Date.now();
  const home = probes.env.HOME ?? probes.env.USERPROFILE;

  if (!home) {
    return {
      ...BASE,
      status: 'Warning',
      message: 'Cannot resolve agent-host home (HOME/USERPROFILE unset)',
      fix: FIX_HINT,
      durationMs: Date.now() - start,
    };
  }

  const settingsPath = join(home, '.claude', 'settings.json');

  let raw: string;
  try {
    raw = await probes.fs.readFile(settingsPath);
  } catch {
    return {
      ...BASE,
      status: 'Warning',
      message: `SubagentStop binding is not installed (${settingsPath} missing)`,
      fix: FIX_HINT,
      durationMs: Date.now() - start,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ...BASE,
      status: 'Warning',
      message: `Agent-host settings at ${settingsPath} is not valid JSON; cannot verify the SubagentStop binding`,
      fix: FIX_HINT,
      durationMs: Date.now() - start,
    };
  }

  if (hasSubagentStopBinding(parsed)) {
    return {
      ...BASE,
      status: 'Pass',
      message: 'SubagentStop binding is installed',
      durationMs: Date.now() - start,
    };
  }

  return {
    ...BASE,
    status: 'Warning',
    message: `SubagentStop binding not found in ${settingsPath}`,
    fix: FIX_HINT,
    durationMs: Date.now() - start,
  };
};
