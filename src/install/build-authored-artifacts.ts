/**
 * Flat copy-emit for the authored artifact kinds that have no placeholders.
 * Commands and rules come from capability domains, like skills, but have no per-runtime variance.
 * A harness finds a command by its bare name in one directory, and `plugin.json` declares one flat path per kind.
 * Thus the output name comes from the kind and the filename, not from the domain.
 * Each run removes stale output files, so a deleted source leaves no live file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** An authored artifact kind that is emitted by copy rather than by render. */
export interface AuthoredKind {
  /** The directory of this kind inside a domain, for example `commands`. */
  readonly source: string;
  /** Flat output directory relative to the repository root. */
  readonly out: string;
}

export const AUTHORED_KINDS: readonly AuthoredKind[] = [
  { source: 'commands', out: 'commands' },
  { source: 'rules', out: 'rules' },
];

export interface AuthoredArtifactReport {
  /** Files written, per artifact kind. */
  readonly written: Record<string, number>;
  /** Absolute paths of every file produced. */
  readonly writtenPaths: string[];
}

function directoriesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
}

/**
 * Copy each authored non-skill artifact from `contentDir` into its flat output directory under `outRoot`.
 * It throws when two domains author the same flat name, and the error names both source paths.
 * When no domain has a source for a kind, the existing output of that kind stays, because the build does not manage it.
 */
export function emitAuthoredArtifacts(opts: {
  contentDir: string;
  outRoot: string;
  kinds?: readonly AuthoredKind[];
}): AuthoredArtifactReport {
  const kinds = opts.kinds ?? AUTHORED_KINDS;
  const written: Record<string, number> = {};
  const writtenPaths: string[] = [];

  for (const kind of kinds) {
    const claimedBy = new Map<string, string>();
    const emitted: Array<{ name: string; body: string }> = [];

    for (const domain of directoriesIn(opts.contentDir).sort()) {
      const kindDir = join(opts.contentDir, domain, kind.source);
      if (!existsSync(kindDir)) continue;

      for (const entry of readdirSync(kindDir).sort()) {
        if (!entry.endsWith('.md')) continue;
        const sourcePath = join(kindDir, entry);
        if (statSync(sourcePath).isDirectory()) continue;

        const name = basename(entry);
        const previous = claimedBy.get(name);
        if (previous !== undefined) {
          throw new Error(
            `emitAuthoredArtifacts: two domains emit ${kind.out}/${name} — ` +
              `${previous} and ${sourcePath}. Flat output has one slot per name; ` +
              `rename one source.`,
          );
        }
        claimedBy.set(name, sourcePath);
        emitted.push({ name, body: readFileSync(sourcePath, 'utf8') });
      }
    }

    if (emitted.length === 0) {
      written[kind.out] = 0;
      continue;
    }

    const outDir = join(opts.outRoot, kind.out);
    mkdirSync(outDir, { recursive: true });

    const keep = new Set(emitted.map((e) => e.name));
    for (const existing of readdirSync(outDir)) {
      if (existing.endsWith('.md') && !keep.has(existing)) {
        rmSync(join(outDir, existing));
      }
    }

    for (const { name, body } of emitted) {
      const target = join(outDir, name);
      writeFileSync(target, body);
      writtenPaths.push(target);
    }
    written[kind.out] = emitted.length;
  }

  return { written, writtenPaths };
}
