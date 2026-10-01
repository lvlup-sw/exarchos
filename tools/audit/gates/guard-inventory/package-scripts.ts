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
 * Appends the body of each `npm run <name>` in `command`, expanded transitively from
 * the script table. The result shows the `node` command that a step such as
 * `npm run skills:guard` reaches, which a name grep cannot see. The `seen` set stops cycles.
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
