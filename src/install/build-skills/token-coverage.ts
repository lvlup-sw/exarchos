import { type RuntimeMap, RuntimeTokenKey } from '../runtimes/types.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Throw when a loaded runtime has no value for a token in `RuntimeTokenKey`.
 * The error lists every missing (runtime, token) pair, so authors can fix all
 * runtime YAML files in one pass. The sort by token and then by runtime keeps
 * the message the same for any YAML load order.
 */
export function assertRuntimeTokenCoverage(runtimes: RuntimeMap[]): void {
  const missing: Array<{ runtime: string; token: string }> = [];
  for (const rt of runtimes) {
    for (const token of RuntimeTokenKey) {
      if (!Object.prototype.hasOwnProperty.call(rt.placeholders, token)) {
        missing.push({ runtime: rt.name, token });
      }
    }
  }
  if (missing.length === 0) return;

  missing.sort((a, b) =>
    a.token === b.token ? a.runtime.localeCompare(b.runtime) : a.token.localeCompare(b.token),
  );

  const lines = missing.map(
    (m) =>
      `  - runtimes/${m.runtime}.yaml is missing required placeholder {{${m.token}}}`,
  );
  throw new Error(
    `[build:skills] runtime token coverage check failed:\n${lines.join('\n')}\n\n` +
      `Add the token to every content/harness/runtimes/*.yaml placeholders map. ` +
      `Required tokens (from RuntimeTokenKey in src/runtimes/types.ts): ` +
      `[${[...RuntimeTokenKey].join(', ')}].`,
  );
}

/**
 * Return the sorted, de-duplicated placeholder keys of all `runtimes`. The
 * placeholder lint uses this set, so a skill source can use a token that at
 * least one runtime can render.
 */
export function unionPlaceholderKeys(runtimes: RuntimeMap[]): string[] {
  const set = new Set<string>();
  for (const rt of runtimes) {
    for (const key of Object.keys(rt.placeholders)) set.add(key);
  }
  return [...set].sort();
}

/**
 * Return, sorted, every directory under `srcDir` that holds a `SKILL.md` file.
 * The walk skips `references/` directories and continues into nested skill
 * directories. A directory result lets callers find the adjacent `references/`
 * and `SKILL.<runtime>.md` override files.
 */
export function walkSkillSourceDirs(srcDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(srcDir)) return results;

  const stack: string[] = [srcDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    if (entries.includes('SKILL.md')) {
      results.push(current);
    }

    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory() && entry !== 'references') {
        stack.push(full);
      }
    }
  }
  return results.sort();
}
