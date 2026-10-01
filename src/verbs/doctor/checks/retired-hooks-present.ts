/**
 * retired-hooks-present: reports retired Exarchos lifecycle hooks that are
 * still installed in the agent-host settings. The launcher owns the session
 * lifecycle, so the SessionStart directive and the SessionEnd observer are
 * retired. SubagentStop stays for token attribution.
 *
 * A `Warning` with `fix` makes `diff` plan a removal step. `apply` routes that
 * step to `removeRetiredHooks` after the on-ramp block write. A hook matches
 * only when its command carries one of the {@link RETIRED_HOOK_MARKERS}.
 * Missing or unreadable settings, or no home directory, give `Pass`. Settings
 * that do not parse give `Skipped`, because a removal step over an unparsed
 * file is not safe.
 *
 * The `name` must equal {@link RETIRED_HOOKS_CHECK_NAME}. The reconciler and
 * `installHook` use that key to route the removal.
 */

import { join } from 'node:path';
import type { CheckFn } from './__shared__/make-stub-probes.js';
import type { CheckResult } from '../schema.js';
import {
  RETIRED_HOOKS_CHECK_NAME,
  SESSION_START_SETTINGS_PATH,
  settingsHasRetiredHooks,
} from '../../onboard/hooks.js';

const BASE = { category: 'agent' as const, name: RETIRED_HOOKS_CHECK_NAME };

const FIX_HINT =
  'run `exarchos onboard` (or `exarchos doctor --fix`) to remove the retired ' +
  'Exarchos lifecycle hooks (SessionStart directive + SessionEnd) from ' +
  '~/.claude/settings.json — the launcher now owns session lifecycle (DR-7)';

export const retiredHooksPresent: CheckFn = async (probes): Promise<CheckResult> => {
  const start = Date.now();
  const home = probes.env.HOME ?? probes.env.USERPROFILE;

  if (!home) {
    return {
      ...BASE,
      status: 'Pass',
      message: 'No agent-host home resolved (HOME/USERPROFILE unset); no retired hooks to remove',
      durationMs: Date.now() - start,
    };
  }

  const settingsPath = join(home, SESSION_START_SETTINGS_PATH);

  let raw: string;
  try {
    raw = await probes.fs.readFile(settingsPath);
  } catch {
    return {
      ...BASE,
      status: 'Pass',
      message: `No retired lifecycle hooks installed (${settingsPath} absent)`,
      durationMs: Date.now() - start,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ...BASE,
      status: 'Skipped',
      reason: `Agent-host settings at ${settingsPath} is not valid JSON`,
      message: `Cannot verify retired lifecycle hooks: ${settingsPath} is not valid JSON`,
      durationMs: Date.now() - start,
    };
  }

  if (settingsHasRetiredHooks(parsed)) {
    return {
      ...BASE,
      status: 'Warning',
      message: `Retired Exarchos lifecycle hooks are still installed in ${settingsPath}`,
      fix: FIX_HINT,
      durationMs: Date.now() - start,
    };
  }

  return {
    ...BASE,
    status: 'Pass',
    message: 'No retired Exarchos lifecycle hooks installed',
    durationMs: Date.now() - start,
  };
};
