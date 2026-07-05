/**
 * retired-hooks-present — are DR-7 retired lifecycle hooks still installed in the
 * agent-host settings (the uninstall-reachability check)?
 *
 * DR-7 makes the launcher the lifecycle authority, so the onboard-installed
 * SessionStart directive + SessionEnd observer are retired (SubagentStop is
 * retained for token attribution). A round-2 audit showed the existing
 * `session-start-hook` check PASSES for exactly the consumers who already have
 * the binding installed — so it never lands a reconcile step that could reach and
 * remove them. This check fills that gap: it is REMEDIABLE (Warning + `fix`)
 * exactly when provenance-matched retired hooks exist, so `diff` lands a
 * `retired-hooks-present` PlanStep (CHECK_CLASSIFICATION → `kind:'hook'`) that
 * `apply` routes to `removeRetiredHooks` — but only AFTER the on-ramp block write
 * (the reconciler's cross-step ordering keeps a consumer from ever transitioning
 * through hook-less + block-less).
 *
 * Provenance is command-marker only ({@link RETIRED_HOOK_MARKERS}) — the same
 * markers the installer writes, never an invented one. USER-authored hooks are
 * provably outside the set, so this check never flags them.
 *
 *   - retired hooks present               ⇒ Warning (+ `fix`) — remediable
 *   - clean settings / no retired hooks   ⇒ Pass
 *   - settings absent / home unresolvable ⇒ Pass (nothing installed to remove)
 *   - settings present but unparseable    ⇒ Skipped (cannot confirm retired hooks
 *                                           without reading the file; never a
 *                                           spurious removal step over a file we
 *                                           could not parse)
 *
 * CRITICAL: the `name` MUST equal {@link RETIRED_HOOKS_CHECK_NAME} — that string
 * is the key CHECK_CLASSIFICATION maps to the removal step AND the key
 * `installHook` dispatches to `removeRetiredHooks`; renaming it silently strands
 * the uninstall.
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
    // No resolvable home → no settings file to hold retired hooks → nothing to
    // remove. Pass (not a Warning): there is no remediation to land.
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
    // Absent (or unreadable) settings → the retired hooks are not installed →
    // nothing to remove. Pass, no step.
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
    // The host owns this file; without a parse we cannot confirm the retired
    // hooks are present, and triggering a removal step over an unparseable file
    // would be unsafe. Skip (with a reason) rather than Warn.
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
