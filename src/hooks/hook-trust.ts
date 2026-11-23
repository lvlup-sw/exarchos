/**
 * Binds the project hooks of `.exarchos.yml` to a trust record that the user keeps outside the repository.
 * A repository can write its own config, so the config alone does not authorize a hook to run.
 * The trust record lives in the state directory and maps a project root to one hooks digest.
 * The digest covers the real project root and the parsed argument list of each hook.
 * Startup binds the parsed hooks one time, and the runner acts only on that bound object.
 * A changed hook gives a different digest, and the hooks stay off until the user trusts the new set.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { safeCommand } from '../config/exarchos-config-schema.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { tokenizeCommand } from '../config/tokenize-command.js';

/** The file in the state directory that holds the trust records for project hooks. */
export const HOOK_TRUST_FILENAME = 'trusted-hooks.json';

/** One hook after the binding: the program, its arguments and the time limit. */
export interface BoundHook {
  readonly argv: readonly [string, ...string[]];
  readonly timeout: number;
}

/**
 * The hooks that the user trusts for one project. Production code gets this object only from {@link bindProjectHooks}.
 * The runner starts each hook with `projectRoot` as the working directory.
 */
export interface BoundProjectHooks {
  readonly projectRoot: string;
  readonly on: Readonly<Record<string, readonly BoundHook[]>>;
}

/**
 * The result of one binding.
 * - `none`: the config has no hook.
 * - `trusted`: the trust record matches the digest of the configured hooks.
 * - `untrusted`: no trust record matches. `digest` is the value that a record must hold to trust this set.
 * - `invalid`: a hook command fails the safe-command allowlist, so no hook of the project runs.
 */
export type HookTrustBinding =
  | { readonly kind: 'none'; readonly hooks: BoundProjectHooks }
  | { readonly kind: 'trusted'; readonly hooks: BoundProjectHooks }
  | {
    readonly kind: 'untrusted';
    readonly hooks: BoundProjectHooks;
    readonly projectRoot: string;
    readonly digest: string;
    readonly trustFile: string;
  }
  | {
    readonly kind: 'invalid';
    readonly hooks: BoundProjectHooks;
    readonly projectRoot: string;
    readonly event: string;
    readonly command: string;
    readonly reason: string;
  };

export interface BindProjectHooksInput {
  readonly stateDir: string;
  readonly projectRoot: string;
  readonly hooks: ResolvedProjectConfig['hooks'];
}

/**
 * Parses the configured hooks, computes their digest, and compares the digest with the trust record.
 * Only a `trusted` result carries hooks. Every other result carries an empty hook table.
 */
export function bindProjectHooks(input: BindProjectHooksInput): HookTrustBinding {
  const projectRoot = realProjectRoot(input.projectRoot);
  const events = Object.keys(input.hooks.on)
    .filter((event) => (input.hooks.on[event]?.length ?? 0) > 0)
    .sort();
  const empty = freezeBound(projectRoot, {});
  if (events.length === 0) return { kind: 'none', hooks: empty };

  const on: Record<string, BoundHook[]> = {};
  for (const event of events) {
    const bound: BoundHook[] = [];
    for (const action of input.hooks.on[event] ?? []) {
      const parsed = parseHookCommand(action.command);
      if (typeof parsed === 'string') {
        return { kind: 'invalid', hooks: empty, projectRoot, event, command: action.command, reason: parsed };
      }
      bound.push({ argv: parsed, timeout: action.timeout });
    }
    on[event] = bound;
  }

  const digest = hooksDigest(projectRoot, events, on);
  const trustFile = join(input.stateDir, HOOK_TRUST_FILENAME);
  if (readTrustedDigest(trustFile, projectRoot) !== digest) {
    return { kind: 'untrusted', hooks: empty, projectRoot, digest, trustFile };
  }
  return { kind: 'trusted', hooks: freezeBound(projectRoot, on) };
}

/** The real path of the project root, or the resolved path when the root does not exist. */
function realProjectRoot(projectRoot: string): string {
  try {
    return realpathSync(projectRoot);
  } catch {
    return resolve(projectRoot);
  }
}

/** The argument list of one hook command, or the reason that the command is refused. */
function parseHookCommand(command: string): readonly [string, ...string[]] | string {
  const checked = safeCommand.safeParse(command);
  if (!checked.success) return checked.error.issues[0]?.message ?? 'invalid command';
  let tokens: readonly string[];
  try {
    tokens = tokenizeCommand(checked.data);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const [program, ...args] = tokens;
  if (program === undefined || program.length === 0) return 'must name a program';
  return [program, ...args];
}

/** The SHA-256 digest of the project root and the bound hooks, in a fixed key order. */
function hooksDigest(
  projectRoot: string,
  events: readonly string[],
  on: Readonly<Record<string, readonly BoundHook[]>>,
): string {
  const canonical = JSON.stringify({
    projectRoot,
    on: events.map((event) => [
      event,
      (on[event] ?? []).map((hook) => ({ argv: hook.argv, timeout: hook.timeout })),
    ]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The trusted digest for `projectRoot` in the trust file, or undefined.
 * A missing, unreadable or malformed file trusts nothing.
 */
function readTrustedDigest(trustFile: string, projectRoot: string): string | undefined {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(trustFile, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(document)) return undefined;
  const projects = document.projects;
  if (!isRecord(projects) || !Object.hasOwn(projects, projectRoot)) return undefined;
  const entry = projects[projectRoot];
  if (!isRecord(entry)) return undefined;
  return typeof entry.hooksDigest === 'string' ? entry.hooksDigest : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A frozen copy of the hook table, so a later change to the source objects has no effect. */
function freezeBound(
  projectRoot: string,
  on: Readonly<Record<string, readonly BoundHook[]>>,
): BoundProjectHooks {
  const table: Record<string, readonly BoundHook[]> = {};
  for (const [event, hooks] of Object.entries(on)) {
    table[event] = Object.freeze(hooks.map((hook) => {
      const [program, ...args] = hook.argv;
      return Object.freeze({ argv: Object.freeze<[string, ...string[]]>([program, ...args]), timeout: hook.timeout });
    }));
  }
  return Object.freeze({ projectRoot, on: Object.freeze(table) });
}
