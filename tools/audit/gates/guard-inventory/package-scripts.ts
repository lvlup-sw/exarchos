import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageScripts {
  /** Repo-relative directory the package lives in (`''` for the root package). */
  readonly dir: string;
  readonly scripts: Readonly<Record<string, string>>;
}

export function readPackageScripts(repoRoot: string, dir: string): PackageScripts {
  const file = join(repoRoot, dir, 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const scripts =
    parsed !== null && typeof parsed === 'object' && 'scripts' in parsed
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;
  const table: Record<string, string> = {};
  if (scripts !== null && typeof scripts === 'object') {
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body === 'string') table[name] = body;
    }
  }
  return { dir, scripts: table };
}

/**
 * Expand `npm run <name>` (and `npm run <name> --`) transitively against a
 * package's script table, so a step that runs `npm run skills:guard` is seen to
 * execute `node tools/audit/gates/lint-test-first-drift.mjs` — the class-2 `unreachable-npm`
 * trap a name-grep cannot see. Cycles terminate via the `seen` set.
 */
export function expandNpmScripts(command: string, pkg: PackageScripts, seen = new Set<string>()): string {
  let out = command;
  const re = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const name = m[1];
    if (name !== undefined) names.push(name);
  }
  for (const name of names) {
    if (seen.has(name)) continue;
    const body = pkg.scripts[name];
    if (body === undefined) continue;
    seen.add(name);
    out += `\n${expandNpmScripts(body, pkg, seen)}`;
  }
  return out;
}

// ─── Shell-wrapper indirection (task 070) ────────────────────────────────────

/**
 * Interpreters that take the program they run as a path ARGUMENT rather than in
 * command position, so `bash x.sh` / `node x.mjs` / `tsx x.ts` all execute `x`.
 *
 * A hand-written set, and the only one in this module — justified by which way it
 * fails. An interpreter MISSING here makes a real invocation read as unreachable,
 * i.e. the inventory reports a wiring hole that is not there. The opposite error
 * (silently blessing an execution that never happens) is the one that would let a
 * dead guard pass, and no omission here can cause it.
 */
