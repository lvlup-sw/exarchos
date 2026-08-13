// ─── Flatten-emit for authored, non-templated artifact kinds ─────────────────
//
// Skills are authored per capability domain and rendered per runtime. Commands
// and rules are authored the same way but carry no placeholders and no
// per-runtime variance, so their "render" is a copy — what they need from this
// build is only the flattening.
//
// That flattening is not cosmetic. A harness resolves a command by its bare
// name from one directory, and `plugin.json` declares a single flat path for
// the kind. Grouping the sources by capability would break both if the group
// reached the output, so the emitted name depends on the artifact's kind and
// its own filename, never on the domain that authored it.
//
// The emitted trees are generated artifacts: deterministic, never hand-edited,
// and stale-swept on every run so a deleted source cannot leave a live file
// behind.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** An authored artifact kind that is emitted by copy rather than by render. */
export interface AuthoredKind {
  /** Directory name holding this kind inside a domain, e.g. `commands`. */
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
 * Emit every authored non-skill artifact from `contentDir` into its flat
 * shipped root under `outRoot`.
 *
 * Fails closed when two domains author the same flat name: the output has one
 * slot for that name, so emitting both is a last-writer-wins overwrite that
 * silently drops one source. Both source paths are named in the error, because
 * knowing only the winner does not tell you what was lost.
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

    // No authored source for this kind anywhere means this tree is not ours to
    // manage — a caller whose content root simply does not carry the kind must
    // not have its existing output swept to empty. "The build knows nothing
    // about this kind" and "this kind is empty" are different claims, and only
    // the second would justify deleting anything. That the real repository does
    // carry sources is asserted separately, where it can fail loudly.
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
