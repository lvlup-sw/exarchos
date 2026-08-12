/**
 * session-start-hook — the default-on binding-install trigger (DR-8, #1485;
 * repurposed under DR-7). Historically this probed for the SessionStart
 * binding and re-added it whenever absent. DR-7 retires the onboard-installed
 * SessionStart directive (and SessionEnd observer) — the launcher is now the
 * lifecycle authority — while `SubagentStop` (the token-attribution seam, see
 * `subagent.tokens_used`) is explicitly RETAINED. Re-triggering an install on
 * SessionStart's absence would fight `retired-hooks-present`'s removal every
 * other doctor run (an infinite install↔remove toggle — the DR-8 idempotency
 * regression this fix closes), so this check now probes `SubagentStop`
 * instead: the one binding of `installBindings`'s three-binding bundle this
 * PR still wants installed and kept installed.
 *
 * `installHook` (`verbs/onboard/hooks.ts`) writes all three bindings in
 * one idempotent pass when triggered, so a fresh consumer still gets
 * SessionStart+SessionEnd once on first onboard — `retired-hooks-present`
 * removes them on the very next doctor pass and this check never asks for them
 * again once SubagentStop exists, so the system converges instead of
 * oscillating.
 *
 *   - SubagentStop present         ⇒ Pass
 *   - settings/home unresolvable,
 *     or SubagentStop absent       ⇒ Warning + `fix` (routes to `installHook`
 *                                     via `CHECK_CLASSIFICATION`'s `kind:'hook'`)
 *
 * CRITICAL: the `name` MUST stay exactly `'session-start-hook'` — that string
 * is pinned in `doctor-roster.characterization.test.ts` and is the key
 * `CHECK_CLASSIFICATION` maps to the `hook` PlanStep kind; changing it silently
 * drops the default-on binding-install trigger.
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
