// ─── Every direct construction of an evidence ContentAddressedStore ──────────
//
// A `ContentAddressedStore` reference carries a digest and no root. That means
// a producer and a reader that construct the store over two different roots
// are, from the reference's point of view, indistinguishable from a producer
// whose blob was never written at all — exactly the split the gate-evidence
// producers used to disagree on before this pass gave them one shared
// constructor (`evidenceArtifactStore`, in `src/workflow/admission/
// evidence-artifact.ts`).
//
// This walks a source tree for every line that spells `new
// ContentAddressedStore(` directly and reports each one, so a second
// construction introduced later — in a new producer, or a reader reached for
// convenience — is named rather than silently re-splitting the root.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface EvidenceStoreConstructionSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface EvidenceStoreConstructionCensus {
  readonly scannedModuleCount: number;
  readonly sites: readonly EvidenceStoreConstructionSite[];
  readonly unowned: readonly EvidenceStoreConstructionSite[];
}

const CONSTRUCTOR_PATTERN = /new\s+ContentAddressedStore\s*\(/;

/**
 * Blank out comments while preserving line numbers, so a mention of the
 * constructor inside a JSDoc block is never mistaken for a construction site.
 * Mirrors the stripper the artifact-directory-literal scan uses for the same
 * reason, so the two censuses agree about what counts as code.
 */
function stripComments(src: string): string {
  const blockless = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return blockless
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i === -1) return line;
      const before = line.slice(0, i);
      // Inside an unterminated string (a URL, a glob) — not a comment.
      if ((before.match(/['"`]/g) ?? []).length % 2 === 1) return line;
      if (before.endsWith(':') || before.endsWith('/')) return line;
      return before;
    })
    .join('\n');
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

/**
 * Every direct `ContentAddressedStore` construction under `sourceDir`,
 * `root`-relative and forward-slashed, plus the subset outside `owners`.
 *
 * A file path in `owners` is matched exactly against the reported `file`
 * field — the same `root`-relative, forward-slashed spelling this function
 * produces — so a caller states the allowlist the way the census reports
 * violations, with nothing to translate between the two.
 */
export function scanEvidenceStoreConstructions(
  root: string,
  options: { readonly sourceDir: string; readonly owners: readonly string[] },
): EvidenceStoreConstructionCensus {
  const modules: string[] = [];
  walk(options.sourceDir, modules);

  const owners = new Set(options.owners);
  const sites: EvidenceStoreConstructionSite[] = [];
  for (const modulePath of modules) {
    const raw = readFileSync(modulePath, 'utf8');
    const originalLines = raw.split('\n');
    const strippedLines = stripComments(raw).split('\n');
    const relFile = path.relative(root, modulePath).split(path.sep).join('/');
    strippedLines.forEach((strippedLine, index) => {
      if (CONSTRUCTOR_PATTERN.test(strippedLine)) {
        sites.push({
          file: relFile,
          line: index + 1,
          text: (originalLines[index] ?? '').trim(),
        });
      }
    });
  }

  const unowned = sites.filter((site) => !owners.has(site.file));
  return { scannedModuleCount: modules.length, sites, unowned };
}
