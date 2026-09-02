import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves authored content by name rather than by path.
 *
 * Sources are grouped by capability domain, so a skill's location is
 * `content/<domain>/skills/<name>/`. A caller that joins its own path has to
 * know the domain, which makes every such call site a thing that breaks when a
 * skill is regrouped. These helpers search the domains instead, so regrouping
 * is invisible to anything that only knows a skill's name.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Absolute path of the authored content root. */
export const CONTENT_ROOT = join(REPO_ROOT, 'content');

function subdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
}

/** Domain directories present under `content/`, sorted. */
export function contentDomains(): string[] {
  return subdirectories(CONTENT_ROOT).sort();
}

/**
 * Directory of the named skill, or `undefined` when no domain declares it.
 * Prefer {@link skillDir} where absence is a failure rather than a branch.
 */
export function findSkillDir(name: string): string | undefined {
  for (const domain of contentDomains()) {
    const candidate = join(CONTENT_ROOT, domain, 'skills', name);
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
  }
  return undefined;
}

/**
 * Directory of the named skill. Throws naming every domain searched, so a
 * miss reads as "this skill is not authored" rather than as a missing file at
 * a path the caller guessed.
 */
export function skillDir(name: string): string {
  const found = findSkillDir(name);
  if (!found) {
    throw new Error(
      `no skill '${name}' under any domain of ${CONTENT_ROOT} (searched: ${contentDomains().join(', ')})`,
    );
  }
  return found;
}

/** Path of the named skill's `SKILL.md`. */
export function skillPath(name: string): string {
  return join(skillDir(name), 'SKILL.md');
}

/** Path of a file beneath the named skill's `references/`. */
export function skillReference(name: string, ...segments: string[]): string {
  return join(skillDir(name), 'references', ...segments);
}

/** Every authored skill name, sorted. */
export function allSkillNames(): string[] {
  return contentDomains()
    .flatMap((domain) => subdirectories(join(CONTENT_ROOT, domain, 'skills')))
    .filter((name) => findSkillDir(name) !== undefined)
    .sort();
}
