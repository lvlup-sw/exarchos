/**
 * session-start-hook — is the #1485 SessionStart cross-harness binding hook
 * installed in the agent-host settings (DR-8)?
 *
 * Reads `<home>/.claude/settings.json` and inspects `hooks.SessionStart[]` for a
 * `command` hook whose command references `exarchos session-start` (the stable
 * binding marker the installer writes — see `orchestrate/onboard/hooks.ts`).
 *
 *   - present + parseable        ⇒ Pass
 *   - settings absent / no entry ⇒ Warning (the binding is the default-on
 *                                  posture; its absence degrades orientation but
 *                                  does NOT break workflow correctness — the
 *                                  `exarchos_*` MCP tools still function. A
 *                                  remediable drift, not a hard Fail and not a
 *                                  silent Skip.)
 *   - settings present but unparseable / shape-corrupt ⇒ Warning (the host owns
 *                                  the file; we advise repair without claiming a
 *                                  hard Fail on a file we cannot fully read)
 *
 * Both non-green branches carry a `fix` so the DR-4 `diff` turns this check into
 * a `session-start-hook` PlanStep (CHECK_CLASSIFICATION → `kind:'hook'`), which
 * `apply` routes to the real installer. CRITICAL: the `name` MUST be exactly
 * `'session-start-hook'` — that string is the key the classification table maps
 * to the hook step; renaming it silently drops the default-on binding step.
 */

import { join } from 'node:path';
import type { CheckFn } from './__shared__/make-stub-probes.js';
import type { CheckResult } from '../schema.js';

const BASE = { category: 'agent' as const, name: 'session-start-hook' };

const FIX_HINT =
  'run `exarchos onboard` (or `exarchos doctor --fix`) to install the #1485 ' +
  'SessionStart binding into ~/.claude/settings.json';

interface CommandHook {
  readonly command?: unknown;
}
interface HookGroup {
  readonly hooks?: unknown;
}

/** Scan a parsed settings object for an exarchos SessionStart binding. */
function hasExarchosBinding(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== 'object' || hooks === null) return false;
  const sessionStart = (hooks as { SessionStart?: unknown }).SessionStart;
  if (!Array.isArray(sessionStart)) return false;
  for (const group of sessionStart as HookGroup[]) {
    const inner = group?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner as CommandHook[]) {
      if (typeof h?.command === 'string' && h.command.includes('exarchos session-start')) {
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
    // No resolvable home → cannot locate the settings file. Advise rather than
    // hard-fail (the environment, not the binding, is the unknown here).
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
    // No settings.json (or unreadable) → the binding is not installed. Warning,
    // not Fail: the absent soft-binding degrades orientation but the MCP tools
    // still work. Carries a `fix` so the diff lands a remediable hook step.
    return {
      ...BASE,
      status: 'Warning',
      message: `SessionStart binding (#1485) is not installed (${settingsPath} missing)`,
      fix: FIX_HINT,
      durationMs: Date.now() - start,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The host owns this file; a parse failure is a repairable advisory.
    return {
      ...BASE,
      status: 'Warning',
      message: `Agent-host settings at ${settingsPath} is not valid JSON; cannot verify the SessionStart binding`,
      fix: FIX_HINT,
      durationMs: Date.now() - start,
    };
  }

  if (hasExarchosBinding(parsed)) {
    return {
      ...BASE,
      status: 'Pass',
      message: 'SessionStart binding (#1485) is installed',
      durationMs: Date.now() - start,
    };
  }

  return {
    ...BASE,
    status: 'Warning',
    message: `SessionStart binding (#1485) not found in ${settingsPath}`,
    fix: FIX_HINT,
    durationMs: Date.now() - start,
  };
};
