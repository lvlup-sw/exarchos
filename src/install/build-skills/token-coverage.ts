import { type RuntimeMap, RuntimeTokenKey } from '../runtimes/types.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

  // Sort by (token, runtime) so the message is reproducible regardless
  // of YAML load order — most useful when the same token is missing on
  // multiple runtimes.
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
 * Collect every placeholder identifier defined by any loaded runtime
 * map into a sorted, de-duplicated list. The `buildAllSkills` lint
 * preflight uses this as its vocabulary so a skill source is allowed
 * to reference any token that at least one runtime knows how to
 * render. Sorted for determinism in diagnostic messages.
 */
export function unionPlaceholderKeys(runtimes: RuntimeMap[]): string[] {
  const set = new Set<string>();
  for (const rt of runtimes) {
    for (const key of Object.keys(rt.placeholders)) set.add(key);
  }
  return [...set].sort();
}

/**
 * Walk `srcDir` recursively and return the absolute path of every
 * directory that contains a `SKILL.md` file. We return directories (not
 * the `SKILL.md` files themselves) so downstream code can locate the
 * adjacent `references/` and `SKILL.<runtime>.md` override files.
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

    // If this directory contains a SKILL.md, record it.
    if (entries.includes('SKILL.md')) {
      results.push(current);
    }

    // Recurse into subdirectories regardless — skill trees may nest.
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

// -----------------------------------------------------------------------------
// Task 008: CLI entry (`npm run build:skills`)
// -----------------------------------------------------------------------------

/**
 * Re-export of the shared `MainDeps` shape so existing callers that
 * imported it from this module continue to work. The canonical
 * definition lives in `cli-helpers.ts`.
 */
