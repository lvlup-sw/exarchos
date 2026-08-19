/**
 * Where every event is actually appended, measured from the source tree.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A `capability` registration names a `provider`, and a provider names an AREA
 * of the tree (`EFFECT_PROVIDERS` maps `exarchos_orchestrate → verbs/`). The
 * claim a provider makes is therefore checkable: the module that appends the
 * event should live inside that area.
 *
 * Nothing checked it. The provider comparison in `registration-validate.ts`
 * compares the declared provider against the DECLARING TOOL — declaration
 * against declaration — and never looks at the append site. So a provider
 * naming the wrong area is invisible to it, and worse, "repairing" a
 * disagreement by adopting the declaring tool buys agreement while asserting an
 * append site that does not exist. That is the comparison agreeing with itself
 * rather than with the tree, and it is the failure mode this census closes.
 *
 * ── Measured, not declared ──────────────────────────────────────────────────
 *
 * The population comes from PARSING the tree, not from a table somebody
 * maintains alongside it. A declared append-site table would drift the moment
 * an append moved, and would drift silently, because the only thing that could
 * detect the drift is the measurement it replaced.
 *
 * ── The scanner is a port, for a reason that is not stylistic ───────────────
 *
 * Resolving what `type:` MEANS is a question about bindings, and the only
 * instrument that cannot disagree with the compiler about bindings is the
 * compiler. But `typescript` is a devDependency, and a shipped `src/` module
 * importing it would make the compiler a runtime dependency of a tree whose
 * shipped artifact resolves only `dependencies` — which the effect ledger
 * enforces against itself. So the policy lives here and the parser is injected;
 * the implementation is `tools/test-helpers/evidence-emission-scanner.ts`.
 *
 * ── Unresolved is not "no" ──────────────────────────────────────────────────
 *
 * An append whose discriminant does not reduce to a string is reported, never
 * dropped. "The census could not read this" and "this module appends nothing"
 * are different answers, and collapsing them is how a scan under-reports while
 * looking complete — the exact defect the evidence scanner was once repaired
 * for.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { EvidenceEmissionScanner } from '../verbs/gates/gate-ownership-census.js';

/**
 * The append-site scanner port, under the name that describes what it does.
 *
 * Structurally identical to the evidence census's port and deliberately the
 * same type rather than a parallel one: two port types would mean two answers
 * to "what is an append site", and one implementation would eventually satisfy
 * only one of them.
 */
export type AppendSiteScanner = EvidenceEmissionScanner;

/** An append whose event type did not reduce to a string. */
export interface UnresolvedAppendSite {
  /** Source module, relative to the scan root, forward-slashed. */
  readonly module: string;
  /** 1-based line of the `.append(` call. */
  readonly line: number;
}

/** Every module that appends a given event, and every site that could not be read. */
export interface AppendSiteCensus {
  /** Event type → the modules that append it, sorted and de-duplicated. */
  readonly modulesByEvent: ReadonlyMap<string, readonly string[]>;
  /** Append sites whose discriminant is a runtime value. */
  readonly unresolved: readonly UnresolvedAppendSite[];
  /**
   * Every module the scan read, sorted. Carried in full, not merely counted,
   * because a consumer needs to distinguish "this module was scanned and does
   * not append" from "this module was never in scope" — collapsing those turns
   * an unanswered question into a refutation.
   */
  readonly scannedModules: readonly string[];
  /** Modules scanned — the DENOMINATOR, so a shrunken scan cannot read as a clean tree. */
  readonly scannedModuleCount: number;
}

/**
 * Every non-test TypeScript module under `root`, sorted.
 *
 * The suffix filter is a BUILD property, not a named subtree: a file the build
 * never emits cannot be a shipped append site.
 */
async function collectSources(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.bench.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}

/**
 * Scan `root` and group every resolved append site by the event it appends.
 *
 * Pure with respect to its inputs beyond the read: same tree and same scanner
 * produce the same census, and nothing here decides whether a site is a fault.
 */
export async function scanAppendSites(
  root: string,
  scan: AppendSiteScanner,
  knownConstants: ReadonlyMap<string, string>,
): Promise<AppendSiteCensus> {
  const files = await collectSources(root);
  const byEvent = new Map<string, Set<string>>();
  const unresolved: UnresolvedAppendSite[] = [];
  const scannedModules: string[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const module = relative(root, file).replaceAll('\\', '/');
    scannedModules.push(module);
    for (const site of scan(source, { fileName: module, knownConstants })) {
      if (site.discriminant === undefined) {
        unresolved.push({ module, line: site.line });
        continue;
      }
      const modules = byEvent.get(site.discriminant) ?? new Set<string>();
      modules.add(module);
      byEvent.set(site.discriminant, modules);
    }
  }

  const modulesByEvent = new Map<string, readonly string[]>();
  for (const [event, modules] of byEvent) {
    modulesByEvent.set(event, Object.freeze([...modules].sort()));
  }
  return Object.freeze({
    modulesByEvent,
    unresolved: Object.freeze(
      unresolved.sort((a, b) => a.module.localeCompare(b.module) || a.line - b.line),
    ),
    scannedModules: Object.freeze(scannedModules.sort()),
    scannedModuleCount: files.length,
  });
}
