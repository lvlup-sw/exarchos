// tools/audit/core/authority-live-proof.ts
//
// DR-6 / G5 — the LIVE half of the authority census (task 026).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
//
// Task 025 shipped the closure verdict (`architecture/authority-census.ts`) and
// stated its own limitation as DATA rather than prose: the evidence field records
// the `authority` and `binding` hops as resolving against `declared-row` — "a
// committed measurement, not independent evidence about the tree". The census
// therefore proves the TABLE is inconsistent. It does not prove the TREE is.
//
// Task 066 re-keyed that field to (hop, ROW), so the two rows this module
// measures now carry `live-measurement` while the other six stay `declared-row`.
// Their `oracle` entries name THIS module and its entrypoints; the co-located
// test resolves those names against the real exports and compares the declared
// subject paths against `GOVERNED_SOURCES` + `EVENT_CATALOG_SOURCES` below, so a
// source added here without reaching the evidence table fails CI.
//
// This module closes that gap for the two rows task 026 names, and it does so
// WITHOUT introducing an enforcement instrument:
//
//   • It has no policy, no violation vocabulary, no exit code and no CLI
//     entrypoint. It reports no findings and passes no judgement.
//   • It MEASURES the tree and emits boundary ROWS. The verdict is still
//     `runAuthorityCensus` — every finding kind, every closure rule and every
//     per-row `blocking` decision stays task 025's, unchanged.
//   • The only thing that changes is the EVIDENCE CLASS of the census's input:
//     rows read off the tree instead of rows read off task 024's table.
//
// `runAuthorityCensus(rows: readonly unknown[])` already takes `unknown` on
// purpose — "so a row the TYPE forbids can be fed in from a store, a fixture or
// a JSON round trip". A live measurement is exactly that case, and the census's
// own `evaluatedRows === rowCount` tooth is what proves a measured row narrowed
// through `isAuthorityTopologyRow` rather than being silently dropped. That
// runtime guard remains the single authority on the row shape; nothing here
// re-declares it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE DISCRIMINATING FACT, REUSED RATHER THAN REINVENTED
//
// Task 020 already isolated it for the CLI surface, and its reasoning transfers
// verbatim to the event catalog: a REPRESENTATION IS BOUND IFF ITS NAME IS
// COMPUTED FROM THE AUTHORITY, AND UNBOUND IFF THE NAME IS BAKED AS A LITERAL.
//
// The corollary task 020 paid for the hard way is the reason this module cannot
// be written against runtime values: `PHASE_EXPECTED_EVENTS['delegate']` and
// `PHASE_EXPECTED_EVENTS['review']` are both `readonly EventType[]` by the time
// a value exists — byte-identical in shape, one derived and one hand-written.
// Provenance is erased at evaluation, exactly as it is erased by the time a
// Commander tree exists. "The copies agree today" is what 024's `bound` arm
// explicitly refuses to accept as a binding, and comparing values could not tell
// the two apart even in principle. So: parse the source, classify the site.
//
// For the same reason this is the TypeScript parser and not a regex — the four
// prior defects enumerated in `cli-derivation-guard.ts`'s header (`as` counted
// in prose, `.command(` counted in a JSDoc block, DR-27's substring scanner)
// are the cost of measuring text instead of structure. Comments are blanked
// STRUCTURALLY here too: the parser classifies them as trivia, so they never
// become nodes this walk can see. The fail-closed parse itself is task 020's
// `parseOrThrow`, imported — not a second copy with its own recovery semantics.
//
// ─────────────────────────────────────────────────────────────────────────────
// PARTIAL BINDING IS NOT BINDING
//
// `PHASE_EXPECTED_EVENTS` is the trap this module exists to not fall into. Two
// of its six entries genuinely derive (`modelEmittedOnly(getRegisteredEventTypes
// (phase))`); the other four are hand-written literal arrays; and the loop that
// runs at module load validates only that each event it LISTS is registered and
// `model`-sourced. That loop can never see an event that should be listed and is
// not — it is the `authority-to-representation` direction one level down, and
// treating "a check exists" as a binding would repeat the defect the census
// exists to report.
//
// So {@link bindingFor} requires EVERY site to be derived. One literal site in a
// population of six makes the representation `unbound`, and the co-located test
// pins the 5-of-6 case specifically: deriving all but one entry must NOT close
// the row.
//
// ─────────────────────────────────────────────────────────────────────────────
// NON-EMPTY DENOMINATORS
//
// Every measurement below throws rather than returning an empty result. A proof
// that resolves zero subjects reports zero unbound representations and reads as
// a closed boundary — the `EMPTY_SEAM_DENOMINATOR` posture, and the failure mode
// that would make this whole task vacuous. A renamed constant, a moved file or a
// changed idiom must fail loudly, never quietly.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY `scripts/` AND NOT `src/architecture/`
//
// Same two objections that moved task 020's guard here, unchanged: this module
// reads files off disk (`effect-ledger` requires a declared owner for every
// filesystem effect in `src/**`) and imports `typescript`, a devDependency that
// would become a runtime dependency of the shipped binary. It also imports
// NOTHING from `src/` — not even a type — so its transitive module closure stays
// disjoint from `architecture/authority-topology.ts`, which is what lets the
// co-located test declare the two of them as genuinely independent DR-30 oracle
// sources: a committed human measurement of the tree, and an executable one.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {
  GOVERNED_SOURCES,
  REPO_ROOT,
  parseOrThrow,
  scanGovernedSources,
  type DerivationScan,
} from './cli-derivation-guard.js';
// The SHIPPED emission derivation and its two vocabularies, imported rather than restated so this
// analyser cannot drift from the rule it measures. `event-registration.ts` has zero runtime import
// edges (every import in it is `import type`), so this costs the script nothing.
import {
  EVENT_LIFECYCLES,
  EVENT_TIERS,
  resolveEmissionSource,
  type EventLifecycle,
  type EventTier,
} from '../../../src/events/event-registration.js';

const LABEL = 'authority-live-proof';

export { REPO_ROOT };

// ─── Measured sites ──────────────────────────────────────────────────────────

/**
 * How one site names the thing it represents.
 *
 * Deliberately the same two-valued distinction as {@link CommandSiteKind} in
 * task 020: `literal` is a name baked into the representation's own source,
 * `derived` is a name computed by an expression that reads it from somewhere
 * else. There is no third "validated" value, because validation of the entries
 * present is not a binding over the population.
 */
export type SiteBinding = 'literal' | 'derived';

export interface MeasuredSite {
  /** Repo-relative, forward-slashed. */
  readonly file: string;
  /** 1-based line of the site. */
  readonly line: number;
  readonly kind: SiteBinding;
  /** The entry key or baked name; for a derived site, the deriving expression. */
  readonly subject: string;
  /** The site's source text, for the failure message. */
  readonly expression: string;
  /**
   * Offsets of {@link expression} within its own source.
   *
   * Carried so a SENSITIVITY CONTROL can rewrite the exact span the measurement
   * classified, in memory, rather than guessing at it with a regex. A control
   * that edited a different span than the one measured would prove nothing about
   * the measurement, and several of these spans are byte-identical to each other
   * (`review` and `overhaul-review` carry the same literal array), so text-based
   * substitution cannot address them individually at all.
   */
  readonly start: number;
  readonly end: number;
}

/**
 * Apply a counterfactual to the exact spans a measurement classified.
 *
 * Edits are applied back-to-front so earlier offsets stay valid. Sites from more
 * than one file are rejected: splicing offsets from file A into file B would
 * silently corrupt the source and produce a measurement of nothing real.
 */
export function spliceSites(
  source: string,
  sites: readonly MeasuredSite[],
  replacement: (site: MeasuredSite) => string,
): string {
  const files = new Set(sites.map((s) => s.file));
  if (files.size > 1) {
    throw new Error(
      `${LABEL}: spliceSites received sites from ${files.size} files ([${[...files].join(', ')}]); ` +
        'offsets are per-source and cannot be mixed.',
    );
  }
  for (const site of sites) {
    if (site.start < 0 || site.end <= site.start) {
      throw new Error(
        `${LABEL}: site ${site.file}:${site.line} (${site.subject}) carries no usable span ` +
          `[${site.start}, ${site.end}). Task 020's CLI scan reports line/column but not offsets, ` +
          'so its sites cannot be spliced — rewrite the source directly for that control.',
      );
    }
  }
  const ordered = [...sites].sort((a, b) => b.start - a.start);
  let out = source;
  for (const site of ordered) {
    out = out.slice(0, site.start) + replacement(site) + out.slice(site.end);
  }
  return out;
}

/** 024's `RepresentationBinding`, as produced by a measurement. */
export type MeasuredBinding =
  | { readonly kind: 'authoritative' }
  | { readonly kind: 'bound'; readonly boundTo: string; readonly how: string }
  | { readonly kind: 'unbound'; readonly why: string };

export interface MeasuredRepresentation {
  /** Must match the committed row's representation id, so the two are comparable. */
  readonly id: string;
  readonly binding: MeasuredBinding;
  /** Every site that evidences this representation. Never empty. */
  readonly sites: readonly MeasuredSite[];
}

export interface MeasuredBoundary {
  readonly boundary: string;
  /** Computed from the count of authoritative representations, never written. */
  readonly authority:
    | { readonly kind: 'single'; readonly authority: string }
    | { readonly kind: 'contested'; readonly candidates: readonly string[] };
  readonly representations: readonly MeasuredRepresentation[];
  /** Every site across every representation — the boundary's own denominator. */
  readonly siteCount: number;
  readonly measured: string;
}

/** Sites of one representation, split by class. */
export function literalSites(rep: MeasuredRepresentation): readonly MeasuredSite[] {
  return rep.sites.filter((s) => s.kind === 'literal');
}

export function derivedSites(rep: MeasuredRepresentation): readonly MeasuredSite[] {
  return rep.sites.filter((s) => s.kind === 'derived');
}

/**
 * The binding a measured population implies.
 *
 * `bound` requires EVERY site to be derived. This is the partial-binding tooth:
 * two derived entries out of six is not a binding over the six, and a census
 * that accepted it would be reporting the population it can see rather than the
 * population G5 asks about.
 */
export function bindingFor(
  sites: readonly MeasuredSite[],
  boundTo: string,
  how: string,
  why: string,
): MeasuredBinding {
  const literals = sites.filter((s) => s.kind === 'literal');
  if (literals.length === 0) return { kind: 'bound', boundTo, how };
  return {
    kind: 'unbound',
    why:
      `${why} Measured live: ${literals.length} of ${sites.length} site(s) bake the name as a ` +
      `literal (${literals.map((s) => `${s.file}:${s.line} ${s.subject}`).slice(0, 4).join('; ')}` +
      `${literals.length > 4 ? '; …' : ''}). A representation is bound only when EVERY site is ` +
      'computed from the authority — partial derivation is not a binding over the population.',
  };
}

function requireSites(sites: readonly MeasuredSite[], what: string): readonly MeasuredSite[] {
  if (sites.length === 0) {
    throw new Error(
      `${LABEL}: resolved ZERO sites for ${what}. A proof with an empty denominator reports no ` +
        'unbound representation and reads as a closed boundary, which is the instrument dying ' +
        'green. Refusing to report a measurement over nothing — the constant was renamed, the ' +
        'file moved, or the idiom changed.',
    );
  }
  return sites;
}

// ─── Generic source measurements ─────────────────────────────────────────────

function relative(file: string): string {
  return file.split(path.sep).join('/');
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
}

/** The property name of an object-literal member, quoted or not. */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

/**
 * Is this initializer a BAKED name, or one computed from somewhere else?
 *
 * A string literal, or an array whose every element is a string literal (or an
 * object literal of string literals), is baked. Anything else — a call, an
 * identifier, a property access, a spread — computes its value from another
 * expression, which is the only thing that can make a representation follow its
 * authority.
 */
export function classifyInitializer(node: ts.Expression): SiteBinding {
  if (ts.isStringLiteralLike(node)) return 'literal';
  if (ts.isArrayLiteralExpression(node)) {
    if (node.elements.length === 0) return 'literal';
    return node.elements.every((e) => classifyInitializer(e) === 'literal') ? 'literal' : 'derived';
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (p) =>
        ts.isPropertyAssignment(p) &&
        propertyName(p.name) !== undefined &&
        classifyInitializer(p.initializer) === 'literal',
    )
      ? 'literal'
      : 'derived';
  }
  return 'derived';
}

/** Find `export const <name> … = { … }` and return the object literal. */
/** `Object.freeze(<expr>)` -> `<expr>`; anything else unchanged. */
function unwrapObjectFreeze(node: ts.Expression | undefined): ts.Expression | undefined {
  if (node === undefined || !ts.isCallExpression(node)) return node;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return node;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'Object') return node;
  if (callee.name.text !== 'freeze') return node;
  return node.arguments[0] ?? node;
}
function findExportedObjectLiteral(
  sourceFile: ts.SourceFile,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      // `Object.freeze({ … })` is unwrapped: the freeze call is a runtime immutability decision,
      // not a different declaration shape, and a measurement that silently found nothing because
      // the authority gained a `freeze` would be the exact proxy failure this module guards
      // against. Both forms are in the tree today (`EVENT_ANNOTATIONS` is frozen).
      const init = unwrapObjectFreeze(node.initializer);
      if (init !== undefined && ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Classify every entry of a named exported object literal.
 *
 * Pure over a source string — the sensitivity controls drive it with a
 * counterfactual edit applied in memory, so no test ever writes to the tree.
 */
export function measureObjectLiteralEntries(
  source: string,
  file: string,
  constName: string,
): readonly MeasuredSite[] {
  const sourceFile = parseOrThrow(source, file, LABEL);
  const literal = findExportedObjectLiteral(sourceFile, constName);
  if (literal === undefined) {
    return requireSites([], `\`${constName}\` in ${file} (no exported object literal by that name)`);
  }
  const sites: MeasuredSite[] = [];
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property.name);
    if (key === undefined) continue;
    sites.push({
      file,
      line: lineOf(sourceFile, property),
      kind: classifyInitializer(property.initializer),
      subject: key,
      expression: property.initializer.getText(sourceFile),
      start: property.initializer.getStart(sourceFile),
      end: property.initializer.getEnd(),
    });
  }
  return requireSites(sites, `\`${constName}\` in ${file}`);
}

/**
 * Keys of a named exported object literal whose value is an object declaring `lifecycle` and
 * `tier`, mapped to the emission source those two axes DERIVE.
 *
 * The replacement for reading a hand-written `source` column (task 011, DR-2): the column no
 * longer exists, and the fact it used to transcribe is the tier/lifecycle pair parsed here. The
 * composition is NOT re-implemented — `resolveEmissionSource` is imported from the shipped module
 * that owns it, so this analyser cannot drift from the derivation it is measuring.
 *
 * Same fail-closed denominator as before: zero entries throws rather than reporting an empty
 * catalog, and an entry missing either axis throws rather than being silently skipped.
 */
export function measureDerivedEmissionSources(
  source: string,
  file: string,
  constName: string,
): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const malformed: string[] = [];
  const sourceFile = parseOrThrow(source, file, LABEL);
  const literal = findExportedObjectLiteral(sourceFile, constName);
  if (literal !== undefined) {
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      const value = property.initializer;
      if (key === undefined) continue;
      if (!ts.isObjectLiteralExpression(value)) {
        malformed.push(key);
        continue;
      }
      const axis = (name: string): string | undefined => {
        for (const member of value.properties) {
          if (!ts.isPropertyAssignment(member)) continue;
          if (propertyName(member.name) !== name) continue;
          return ts.isStringLiteralLike(member.initializer) ? member.initializer.text : undefined;
        }
        return undefined;
      };
      const lifecycle = axis('lifecycle');
      const tier = axis('tier');
      if (lifecycle === undefined || tier === undefined) {
        malformed.push(key);
        continue;
      }
      if (!isEventLifecycle(lifecycle) || !isEventTier(tier)) {
        malformed.push(key);
        continue;
      }
      entries.set(key, resolveEmissionSource({ lifecycle, tier }));
    }
  }
  if (malformed.length > 0) {
    throw new Error(
      `${LABEL}: \`${constName}\` in ${file} has ${malformed.length} entr(y|ies) whose ` +
        '`lifecycle`/`tier` axes could not be read as the shipped vocabularies: ' +
        `${malformed.sort().join(', ')}. An unreadable annotation must fail the measurement, not ` +
        'drop out of the denominator.',
    );
  }
  if (entries.size === 0) {
    throw new Error(
      `${LABEL}: \`${constName}\` in ${file} yielded ZERO annotated entries. The event catalog ` +
        'authority cannot be empty; refusing to measure representations against a denominator of ' +
        'nothing.',
    );
  }
  return entries;
}
/** Keys of a named exported object literal whose value is a string literal. */
export function measureStringValuedEntries(
  source: string,
  file: string,
  constName: string,
): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const sourceFile = parseOrThrow(source, file, LABEL);
  const literal = findExportedObjectLiteral(sourceFile, constName);
  if (literal !== undefined) {
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      const value = property.initializer;
      if (key === undefined || !ts.isStringLiteralLike(value)) continue;
      entries.set(key, value.text);
    }
  }
  if (entries.size === 0) {
    throw new Error(
      `${LABEL}: \`${constName}\` in ${file} yielded ZERO string-valued entries. The event catalog ` +
        'authority cannot be empty; refusing to measure representations against a denominator of ' +
        'nothing.',
    );
  }
  return entries;
}

/**
 * Classify every `<propertyName>: …` assignment in a file, wherever it occurs.
 *
 * Used for `autoEmits`, which is a property of each action descriptor rather
 * than a top-level constant. `autoEmits: [{ event: 'gate.executed', … }]` is a
 * literal site; `autoEmits: emissionsFor(name)` would be a derived one.
 */
export function measurePropertyAssignments(
  source: string,
  file: string,
  property: string,
): readonly MeasuredSite[] {
  const sourceFile = parseOrThrow(source, file, LABEL);
  const sites: MeasuredSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === property) {
      sites.push({
        file,
        line: lineOf(sourceFile, node),
        kind: classifyInitializer(node.initializer),
        subject: property,
        expression: node.initializer.getText(sourceFile),
        start: node.initializer.getStart(sourceFile),
        end: node.initializer.getEnd(),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return requireSites(sites, `\`${property}:\` assignments in ${file}`);
}

// ─── Markdown (the representation with no expressions at all) ────────────────

/** A dotted token that could be an event type. */
const EVENT_TOKEN = /[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+/g;

export interface SkillDoc {
  /** Repo-relative, forward-slashed. */
  readonly file: string;
  readonly text: string;
}

/**
 * Every model-emitted event name written in skill prose.
 *
 * Classified `literal` unconditionally, and that is a STRUCTURAL fact rather
 * than a measurement outcome: Markdown carries no expressions, so a name written
 * in prose cannot be computed from anything. A `.md` file has no import edge to
 * the event registry either, so no derivation can exist even in principle. What
 * the scan establishes is that the representation EXISTS.
 *
 * The non-empty tooth is on the CORPUS, not on the result, and the distinction
 * matters: an empty corpus is a broken scan (the authored skills tree moved) and
 * must fail closed, whereas a non-empty corpus in which no document names an
 * event is the honest report that this representation is not present. The
 * counterfactual control depends on being able to tell those two apart.
 */
export function measureProseEventMentions(
  docs: readonly SkillDoc[],
  modelEvents: ReadonlySet<string>,
): readonly MeasuredSite[] {
  if (docs.length === 0) {
    throw new Error(
      `${LABEL}: the skill-prose corpus is EMPTY. Zero documents scanned means zero event names ` +
        'found, which would silently delete a representation from the boundary rather than ' +
        'report it unbound. Fail closed.',
    );
  }
  if (modelEvents.size === 0) {
    throw new Error(
      `${LABEL}: the model-emitted event set is EMPTY, so no prose mention could ever match. ` +
        'A scan whose needle list is empty finds nothing and proves nothing.',
    );
  }
  const sites: MeasuredSite[] = [];
  for (const doc of docs) {
    const lines = doc.text.split('\n');
    const seen = new Set<string>();
    let offset = 0;
    lines.forEach((text, index) => {
      EVENT_TOKEN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = EVENT_TOKEN.exec(text)) !== null) {
        const token = match[0];
        if (!modelEvents.has(token) || seen.has(token)) continue;
        seen.add(token);
        sites.push({
          file: doc.file,
          line: index + 1,
          kind: 'literal',
          subject: token,
          expression: text.trim().slice(0, 120),
          start: offset + match.index,
          end: offset + match.index + token.length,
        });
      }
      offset += text.length + 1;
    });
  }
  return sites;
}

// ─── Reading the tree ────────────────────────────────────────────────────────

/** Every source the event-catalog measurement reads, repo-relative. */
export const EVENT_CATALOG_SOURCES: {
  readonly authority: string;
  readonly annotations: string;
  readonly autoEmits: string;
  readonly phaseExpectedEvents: string;
  readonly proseRoot: string;
} = Object.freeze({
  authority: 'src/events/schemas.ts',
  // Where the per-event emission facts are DECLARED since task 011 (DR-2). `schemas.ts` still
  // exports `EVENT_EMISSION_REGISTRY` — it is still the authority binding, and the row's
  // representation id is unchanged — but its value is now
  // `deriveEmissionRegistry(EventTypes, ANNOTATED_EVENTS.registrationOf)`, so parsing that file for
  // string-valued entries measures a literal that no longer exists and reports zero.
  //
  // This is the measure-the-proxy failure mode in its purest form, and it fired exactly as it
  // should: the empty-denominator guard threw rather than reporting a clean catalog of nothing.
  // The fix is to measure the structural fact — the tier/lifecycle pair each event declares —
  // and to derive the source through the SHIPPED derivation rather than restating it here.
  annotations: 'src/events/event-annotations.ts',
  // The action descriptors, which is where `autoEmits` rows live. A DIRECTORY,
  // not a file: the declarations are split into a module per action family, so
  // any single path would measure a fraction of the representation.
  autoEmits: 'src/registry/actions',
  phaseExpectedEvents: 'src/verbs/gates/check-event-emissions.ts',
  // The AUTHORED skills tree. `skills/<runtime>/` is generated from it, so
  // measuring both would count one representation several times.
  proseRoot: 'content',
});

export interface EventCatalogSources {
  readonly authority: string;
  readonly annotations: string;
  readonly autoEmits: string;
  readonly phaseExpectedEvents: string;
  readonly docs: readonly SkillDoc[];
}

/** Every `.ts` under `dir`, concatenated in a stable order. */
function readTypeScriptTree(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) return readTypeScriptTree(abs);
      return entry.isFile() && entry.name.endsWith('.ts') ? readFileSync(abs, 'utf8') : '';
    })
    .join('\n');
}

/**
 * Read a representation's source. A representation may be one file or a
 * DIRECTORY of them: `autoEmits` rows are declared on action descriptors, and
 * those are split across a module per action family. Naming the directory
 * keeps the measurement over the whole representation, where naming one file
 * would silently shrink the denominator every time a family is split out —
 * the empty-denominator guard catches the total loss, but not a partial one.
 */
function readOrThrow(repoRoot: string, rel: string): string {
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) {
    throw new Error(
      `${LABEL}: source "${rel}" does not exist at ${abs}. An event-catalog representation was ` +
        'moved or renamed; refusing to report a measurement over a file that is not there.',
    );
  }
  return statSync(abs).isDirectory() ? readTypeScriptTree(abs) : readFileSync(abs, 'utf8');
}

function walkMarkdown(dir: string, repoRoot: string, out: SkillDoc[]): SkillDoc[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(abs, repoRoot, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ file: relative(path.relative(repoRoot, abs)), text: readFileSync(abs, 'utf8') });
    }
  }
  return out;
}

/** Read every event-catalog source off disk. The only IO in the measurement. */
export function readEventCatalogSources(repoRoot: string = REPO_ROOT): EventCatalogSources {
  const proseDir = path.join(repoRoot, EVENT_CATALOG_SOURCES.proseRoot);
  if (!existsSync(proseDir) || !statSync(proseDir).isDirectory()) {
    throw new Error(
      `${LABEL}: skill source root "${EVENT_CATALOG_SOURCES.proseRoot}" is not a directory at ` +
        `${proseDir}. The prose representation cannot be measured, and reporting zero prose ` +
        'sites would silently remove a representation from the boundary.',
    );
  }
  const docs = walkMarkdown(proseDir, repoRoot, []).sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  if (docs.length === 0) {
    throw new Error(`${LABEL}: found ZERO Markdown files under ${EVENT_CATALOG_SOURCES.proseRoot}`);
  }
  return {
    authority: readOrThrow(repoRoot, EVENT_CATALOG_SOURCES.authority),
    annotations: readOrThrow(repoRoot, EVENT_CATALOG_SOURCES.annotations),
    autoEmits: readOrThrow(repoRoot, EVENT_CATALOG_SOURCES.autoEmits),
    phaseExpectedEvents: readOrThrow(repoRoot, EVENT_CATALOG_SOURCES.phaseExpectedEvents),
    docs,
  };
}

// ─── The event-catalog boundary, measured ────────────────────────────────────

/** The representation ids task 024's committed row uses. Matched exactly. */
export const EVENT_CATALOG_REPRESENTATION_IDS: {
  readonly authority: string;
  readonly autoEmits: string;
  readonly phaseExpectedEvents: string;
  readonly prose: string;
} = Object.freeze({
  authority: 'EVENT_EMISSION_REGISTRY (`events/schemas.ts`)',
  autoEmits: 'the registry `autoEmits` rows',
  phaseExpectedEvents: 'PHASE_EXPECTED_EVENTS (`verbs/gates/check-event-emissions.ts`)',
  prose: 'skill prose naming events to emit',
});

export interface EventCatalogMeasurement extends MeasuredBoundary {
  /** event type → emission source, parsed from the authority's own declaration. */
  readonly registeredEvents: ReadonlyMap<string, string>;
  /** The subset the prose representation is measured against. */
  readonly modelEvents: ReadonlySet<string>;
}

/**
 * Measure the event-catalog boundary from source.
 *
 * The authority is `EVENT_EMISSION_REGISTRY`, read from its own declaration
 * rather than imported: importing it would drag zod and the whole event-store
 * module graph into a build-tooling script, and — more to the point — the
 * runtime value cannot answer the question being asked. A parsed key set is
 * a static under-approximation (`registerEventType` can add custom types at
 * runtime), which is stated here rather than smoothed over; the co-located test
 * cross-checks it against the live imported registry.
 */
export function measureEventCatalog(sources: EventCatalogSources): EventCatalogMeasurement {
  const registeredEvents = measureDerivedEmissionSources(
    sources.annotations,
    EVENT_CATALOG_SOURCES.annotations,
    'EVENT_ANNOTATIONS',
  );
  const modelEvents = new Set<string>();
  for (const [event, source] of registeredEvents) if (source === 'model') modelEvents.add(event);
  if (modelEvents.size === 0) {
    throw new Error(
      `${LABEL}: the authority registers ${registeredEvents.size} event(s) but NONE with source ` +
        '`model`. The prose representation is measured against the model-emitted subset, and an ' +
        'empty subset would make it vanish rather than be found unbound.',
    );
  }

  const autoEmitSites = measurePropertyAssignments(
    sources.autoEmits,
    EVENT_CATALOG_SOURCES.autoEmits,
    'autoEmits',
  );
  const phaseSites = measureObjectLiteralEntries(
    sources.phaseExpectedEvents,
    EVENT_CATALOG_SOURCES.phaseExpectedEvents,
    'PHASE_EXPECTED_EVENTS',
  );
  const proseSites = measureProseEventMentions(sources.docs, modelEvents);

  const representations: MeasuredRepresentation[] = [
    {
      id: EVENT_CATALOG_REPRESENTATION_IDS.authority,
      binding: { kind: 'authoritative' },
      sites: [
        {
          // The BINDING is still exported from `schemas.ts` (hence the unchanged representation
          // id); the per-event facts behind it are declared in the annotations module, which is
          // what was measured.
          file: EVENT_CATALOG_SOURCES.annotations,
          line: 1,
          kind: 'derived',
          subject: 'EVENT_EMISSION_REGISTRY',
          expression: `${registeredEvents.size} declared event types (tier+lifecycle, source derived)`,
          start: -1,
          end: -1,
        },
      ],
    },
    {
      id: EVENT_CATALOG_REPRESENTATION_IDS.autoEmits,
      binding: bindingFor(
        autoEmitSites,
        'EVENT_EMISSION_REGISTRY',
        'every `autoEmits` list is computed from the emission registry',
        'declared alongside the emission registry rather than projected from it — an action whose ' +
          '`autoEmits` drifts from what it actually emits is invisible to any shipped check.',
      ),
      sites: autoEmitSites,
    },
    {
      id: EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents,
      binding: bindingFor(
        phaseSites,
        'EVENT_EMISSION_REGISTRY',
        'every phase entry is computed via `modelEmittedOnly(getRegisteredEventTypes(phase))`',
        'the module-load loop VALIDATES that each event the table lists is registered and ' +
          '`model`-sourced, but it can never see an event that should be listed and is not.',
      ),
      sites: phaseSites,
    },
    {
      id: EVENT_CATALOG_REPRESENTATION_IDS.prose,
      binding: {
        kind: 'unbound',
        why:
          'Markdown; nothing regenerates it from the registry and nothing fails when it drifts. ' +
          `Measured live: ${proseSites.length} model-emitted event name(s) written in prose across ` +
          `${new Set(proseSites.map((s) => s.file)).size} document(s) under ` +
          `\`${EVENT_CATALOG_SOURCES.proseRoot}\`. Markdown carries no expressions, so no site here ` +
          'can be computed from the authority even in principle.',
      },
      sites: proseSites,
    },
  ];

  const present = representations.filter((r) => r.sites.length > 0);
  const siteCount = present.reduce((total, r) => total + r.sites.length, 0);
  const unbound = present.filter((r) => r.binding.kind === 'unbound');

  return {
    boundary: 'event-catalog',
    authority: { kind: 'single', authority: 'EVENT_EMISSION_REGISTRY' },
    representations: present,
    registeredEvents,
    modelEvents,
    siteCount,
    measured:
      `Measured LIVE from source by \`scripts/authority-live-proof.ts\`: the authority declares ` +
      `${registeredEvents.size} event types (${modelEvents.size} \`model\`-sourced). ` +
      `${unbound.length} of ${present.length - 1} non-authoritative representations are unbound. ` +
      `\`autoEmits\`: ${autoEmitSites.filter((s) => s.kind === 'literal').length}/` +
      `${autoEmitSites.length} sites baked. \`PHASE_EXPECTED_EVENTS\`: ` +
      `${phaseSites.filter((s) => s.kind === 'literal').length}/${phaseSites.length} entries baked ` +
      `(the rest derive) — PARTIALLY bound, which is not bound. Skill prose: ${proseSites.length} ` +
      'event names in Markdown, which has no expressions to derive them with.',
  };
}

// ─── The effect-event boundary, measured ─────────────────────────────────────

/** Every source the effect-event measurement reads, repo-relative. */
export const EFFECT_EVENT_SOURCES: {
  readonly carrier: string;
  readonly vcsLedger: string;
  readonly promotion: string;
} = Object.freeze({
  // The carrier itself: where `EffectPlan.emits` is declared and where the commit
  // gate that makes it authoritative is thrown from.
  carrier: 'src/dispatch/core/effect-carrier.ts',
  // The two owners that declare emissions on a plan. They are named individually
  // rather than scanned for, because a directory scan would report a shrinking
  // denominator as a clean measurement the moment an owner moved — and there are
  // two, so the population is small enough to name and large enough to disagree.
  vcsLedger: 'src/vcs/mutation-owner.ts',
  promotion: 'src/install/atomic-promotion.ts',
});

/** The representation ids the committed row uses. Matched exactly. */
export const EFFECT_EVENT_REPRESENTATION_IDS: {
  readonly plan: string;
  readonly vcsLedger: string;
  readonly promotion: string;
} = Object.freeze({
  plan: 'EffectPlan `emits` (`dispatch/core/effect-carrier.ts`)',
  vcsLedger: 'the VCS ledger append site (`vcs/mutation-owner.ts`)',
  promotion: 'the promotion record sink (`install/atomic-promotion.ts`)',
});

/**
 * The authority id the committed row uses, and the `boundTo` a bound
 * representation must name to resolve.
 */
export const EFFECT_PLAN_AUTHORITY = 'EffectPlan.emits';

export interface EffectEventSources {
  readonly carrier: string;
  readonly vcsLedger: string;
  readonly promotion: string;
}

/** Read every effect-event source off disk. The only IO in the measurement. */
export function readEffectEventSources(repoRoot: string = REPO_ROOT): EffectEventSources {
  return {
    carrier: readOrThrow(repoRoot, EFFECT_EVENT_SOURCES.carrier),
    vcsLedger: readOrThrow(repoRoot, EFFECT_EVENT_SOURCES.vcsLedger),
    promotion: readOrThrow(repoRoot, EFFECT_EVENT_SOURCES.promotion),
  };
}

/**
 * The identifier a plan-declared emission is handed to a sink under.
 *
 * A sink derives the fact it records IFF it reads the emission it was handed.
 * The property is named rather than inferred: `emission.when` selects the
 * CONDITION and `emission.event` selects the IDENTITY, and only the second makes
 * the recorded fact follow the plan. A sink that reads `when` alone still bakes
 * the name of whatever it records.
 */
const EMISSION_IDENTITY_PROPERTY = 'event';

/** The factory every declaring owner builds its sink with. */
const EMISSION_SINK_FACTORY = 'emissionRecorder';

/** Does this sink body name `<param>.event`, or destructure `event` off the param? */
function sinkReadsEmissionIdentity(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
): { readonly derived: boolean; readonly subject: string } {
  const param = fn.parameters[0];
  if (param === undefined) {
    return { derived: false, subject: 'sink takes no emission parameter' };
  }
  // `({ event }) => …` — the identity is bound straight out of the parameter.
  if (ts.isObjectBindingPattern(param.name)) {
    const binds = param.name.elements.some((el) =>
      el.propertyName === undefined
        ? ts.isIdentifier(el.name) && el.name.text === EMISSION_IDENTITY_PROPERTY
        : propertyName(el.propertyName) === EMISSION_IDENTITY_PROPERTY,
    );
    return binds
      ? { derived: true, subject: `{ ${EMISSION_IDENTITY_PROPERTY} } destructured from the emission` }
      : { derived: false, subject: 'sink destructures the emission without binding its identity' };
  }
  if (!ts.isIdentifier(param.name)) {
    return { derived: false, subject: 'sink parameter is not a name this walk can follow' };
  }
  const paramName = param.name.text;
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === paramName &&
      node.name.text === EMISSION_IDENTITY_PROPERTY
    ) {
      found = node.getText(sourceFile);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return found === undefined
    ? {
        derived: false,
        subject: `sink binds \`${paramName}\` but never reads \`${paramName}.${EMISSION_IDENTITY_PROPERTY}\``,
      }
    : { derived: true, subject: found };
}

/**
 * Every emission sink an owner builds, classified by whether the fact it
 * records is NAMED BY THE PLAN.
 *
 * This is the module's one discriminating fact — a name is bound iff it is
 * computed from the authority — applied to the append direction: a
 * sink that appends `emission.event` records a name COMPUTED from the plan and
 * follows it; a sink that ignores the emission bakes whatever it records, and no
 * change to the plan can move it. The two are byte-identical in their effect on
 * the commit gate — both mint a receipt — so the gate cannot tell them apart and
 * this measurement is the only thing that can.
 *
 * Classified from the SINK rather than from the append call, deliberately. An
 * owner may append through a private helper (the VCS owner does), so following
 * the store call would measure the helper's parameter and report `derived` for
 * any owner that happened to route through one.
 */
export function measureEmissionSinks(source: string, file: string): readonly MeasuredSite[] {
  const sourceFile = parseOrThrow(source, file, LABEL);
  const sites: MeasuredSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === EMISSION_SINK_FACTORY
    ) {
      const arg = node.arguments[0];
      const fn =
        arg !== undefined && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
          ? arg
          : undefined;
      const verdict =
        fn === undefined
          ? { derived: false, subject: 'sink is not a function literal this walk can read' }
          : sinkReadsEmissionIdentity(fn, sourceFile);
      sites.push({
        file,
        line: lineOf(sourceFile, node),
        kind: verdict.derived ? 'derived' : 'literal',
        subject: verdict.subject,
        expression: node.getText(sourceFile).slice(0, 200),
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return requireSites(sites, `\`${EMISSION_SINK_FACTORY}(\` sinks in ${file}`);
}

/**
 * The commit gate, measured rather than assumed.
 *
 * `EffectPlan.emits` is only an AUTHORITY because a plan that declares one
 * cannot produce a committed value without a receipt for it — that is what
 * `UnrecordedEmissionError` enforces, and without it the field would be a
 * comment. Deleting the gate must therefore take the authority claim with it,
 * so its presence is a fail-closed precondition of the measurement rather than a
 * sentence in the row's prose.
 */
function requireCommitGate(source: string, file: string): number {
  const sourceFile = parseOrThrow(source, file, LABEL);
  let throws = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isThrowStatement(node) &&
      node.expression !== undefined &&
      ts.isNewExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'UnrecordedEmissionError'
    ) {
      throws += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (throws === 0) {
    throw new Error(
      `${LABEL}: found ZERO \`throw new UnrecordedEmissionError\` sites in ${file}. The commit ` +
        'gate is what makes a plan\'s declared emission authoritative over the record; with it ' +
        'gone the field is a comment, and reporting the boundary as authoritative anyway would ' +
        'be the census certifying a binding that no longer exists.',
    );
  }
  return throws;
}

/**
 * Measure the effect-event boundary from source.
 *
 * The boundary asks whether the effect that was PLANNED and the event that
 * RECORDS it agree. Two independent facts answer it, and they are measured
 * separately because they can fail separately:
 *
 *   • the plan's `emits` set is authoritative over WHETHER a record happens —
 *     `runEffect` refuses the effect up front without a sink and reaches its
 *     return only on one receipt per declared emission. That is total over every
 *     declaring owner and has no escape, which is why {@link requireCommitGate}
 *     is a precondition rather than a representation;
 *   • whether the record's IDENTITY follows the plan is per-owner, and it is
 *     where the two owners part company.
 *
 * The type on `EffectEmission.event` is deliberately NOT offered as evidence of
 * either. It guarantees a plan cannot name an unregistered event, which is a
 * property of the catalog and cannot fail here — a check whose subject is
 * enforced by a type is not a check, and counting it would close the row on a
 * tautology.
 */
export function measureEffectEvent(sources: EffectEventSources): MeasuredBoundary {
  const gates = requireCommitGate(sources.carrier, EFFECT_EVENT_SOURCES.carrier);

  const planSites = [
    ...measurePropertyAssignments(sources.vcsLedger, EFFECT_EVENT_SOURCES.vcsLedger, 'emits'),
    ...measurePropertyAssignments(sources.promotion, EFFECT_EVENT_SOURCES.promotion, 'emits'),
  ];
  const vcsSinks = measureEmissionSinks(sources.vcsLedger, EFFECT_EVENT_SOURCES.vcsLedger);
  const promotionSinks = measureEmissionSinks(sources.promotion, EFFECT_EVENT_SOURCES.promotion);

  const representations: MeasuredRepresentation[] = [
    {
      id: EFFECT_EVENT_REPRESENTATION_IDS.plan,
      binding: { kind: 'authoritative' },
      sites: planSites,
    },
    {
      id: EFFECT_EVENT_REPRESENTATION_IDS.vcsLedger,
      binding: bindingFor(
        vcsSinks,
        EFFECT_PLAN_AUTHORITY,
        'the ledger append is handed the plan\'s emission and names the event it appends from it, so a change to the plan moves the record',
        'the sink records a fact whose name the plan does not supply, so the ledger cannot follow a change to the plan.',
      ),
      sites: vcsSinks,
    },
    {
      id: EFFECT_EVENT_REPRESENTATION_IDS.promotion,
      binding: bindingFor(
        promotionSinks,
        EFFECT_PLAN_AUTHORITY,
        'the promotion sink names what it records from the emission it was handed',
        'the promoter owns the payload and the CALLER owns the destination, so the plan\'s declared ' +
          'emission reaches no append this census can see. The commit gate still holds — the ' +
          'promotion is refused without a sink — but the gate proves a record was taken, not that ' +
          'the record is the one the plan named.',
      ),
      sites: promotionSinks,
    },
  ];

  const siteCount = representations.reduce((total, r) => total + r.sites.length, 0);
  const subjects = representations.filter((r) => r.binding.kind !== 'authoritative');
  const unbound = subjects.filter((r) => r.binding.kind === 'unbound');

  return {
    boundary: 'effect-event',
    authority: { kind: 'single', authority: EFFECT_PLAN_AUTHORITY },
    representations,
    siteCount,
    measured:
      `Measured LIVE from source by \`${EFFECT_EVENT_SOURCES.carrier}\` and its two declaring ` +
      `owners: ${planSites.length} plan(s) declare \`emits\`, and the carrier throws ` +
      `\`UnrecordedEmissionError\` at ${gates} site(s), so a declared emission is a precondition ` +
      `of the effect committing rather than a hope. ${unbound.length} of ${subjects.length} ` +
      'non-authoritative representations are unbound: the VCS ledger appends `emission.event` and ' +
      'therefore follows the plan, while the promotion sink discards the emission and hands a ' +
      'typed payload to a caller-supplied destination. The boundary is no longer authority-less — ' +
      'it is single-authority and PARTIALLY bound, which is not bound.',
  };
}

// ─── The CLI-surface boundary, measured ──────────────────────────────────────

/** The registry-side authority id task 024's committed row uses. */
export const CLI_REGISTRY_AUTHORITY = 'registry';
/** The literal-side authority id task 024's committed row uses. */
export const CLI_LITERAL_AUTHORITY = 'adapters/cli/cli.ts hand-written `.command()` literals';

/**
 * Build the CLI-surface row from task 020's live scan.
 *
 * The second authority is not asserted: it EXISTS iff the guard finds at least
 * one baked `.command('…')` name in the live composition root, and the authority
 * arm is computed from the count of authoritative representations exactly as
 * `sdkAuthority()` computes the sdk-generation row's. Retire the last literal
 * and this row reports `single` on its own — nobody has to remember to edit it.
 */
export function measureCliSurface(scan: DerivationScan): MeasuredBoundary {
  if (scan.sites.length === 0) {
    throw new Error(
      `${LABEL}: the CLI scan resolved ZERO \`.command(\` sites. A composition root that registers ` +
        'no commands is a broken scan, not a boundary with one authority.',
    );
  }
  if (scan.indeterminate.length > 0) {
    throw new Error(
      `${LABEL}: ${scan.indeterminate.length} \`.command(\` site(s) could not be classified. ` +
        'Failing closed rather than counting an unclassifiable site as derived.',
    );
  }

  // Task 020's scan reports line/column, not offsets, and it is reused here
  // UNCHANGED rather than widened for this task's convenience. The unusable
  // span is recorded honestly (-1) so {@link spliceSites} refuses these sites
  // outright instead of splicing at a plausible-looking wrong position.
  const toSite = (kind: SiteBinding) => (site: DerivationScan['sites'][number]): MeasuredSite => ({
    file: site.file,
    line: site.line,
    kind,
    subject: site.name.length > 0 ? site.name : site.expression,
    expression: site.expression,
    start: -1,
    end: -1,
  });

  const representations: MeasuredRepresentation[] = [
    {
      id: 'registry action descriptor (TOOL_REGISTRY)',
      binding: { kind: 'authoritative' },
      sites: [
        {
          file: GOVERNED_SOURCES[0] ?? EVENT_CATALOG_SOURCES.autoEmits,
          line: 1,
          kind: 'derived',
          subject: 'TOOL_REGISTRY',
          expression: 'the registry action descriptors the derivation helpers read',
          start: -1,
          end: -1,
        },
      ],
    },
  ];

  if (scan.derived.length > 0) {
    representations.push({
      id: 'the registry-derived command tree',
      binding: {
        kind: 'bound',
        boundTo: CLI_REGISTRY_AUTHORITY,
        how:
          `measured live: ${scan.derived.length} \`.command(\` site(s) take their name from a ` +
          `computed expression (${[...new Set(scan.derived.map((s) => s.expression))].sort().join(', ')}), ` +
          'so a registry change moves them',
      },
      sites: scan.derived.map(toSite('derived')),
    });
  }

  if (scan.literals.length > 0) {
    representations.push({
      // Formatted to reproduce the committed row's id EXACTLY, count included —
      // so a drift in the live count changes the census tuple rather than
      // hiding inside a number nothing compares.
      id: `the ${scan.literals.length} hand-written \`.command('…')\` literals in \`adapters/cli/cli.ts\``,
      binding: { kind: 'authoritative' },
      sites: scan.literals.map(toSite('literal')),
    });
  }

  // The authority arm, COMPUTED from the count of authoritative representations
  // rather than written down — the `sdkAuthority()` idiom. There is no branch
  // here that can report `single` while two authoritative representations are
  // present; `checkTopologyTotality`'s AUTHORITY_REPRESENTATION_DISAGREEMENT
  // tooth would reject the row if there were.
  const authoritativeCount = representations.filter(
    (r) => r.binding.kind === 'authoritative',
  ).length;
  if (authoritativeCount === 0) {
    throw new Error(`${LABEL}: the CLI measurement produced no authoritative representation.`);
  }
  const authority: MeasuredBoundary['authority'] =
    authoritativeCount === 1
      ? { kind: 'single', authority: CLI_REGISTRY_AUTHORITY }
      : { kind: 'contested', candidates: [CLI_REGISTRY_AUTHORITY, CLI_LITERAL_AUTHORITY] };

  return {
    boundary: 'cli-surface',
    authority,
    representations,
    siteCount: representations.reduce((total, r) => total + r.sites.length, 0),
    measured:
      `Measured LIVE from \`adapters/cli/cli.ts\` by task 020's \`cli-derivation-guard\`: ` +
      `${scan.sites.length} \`.command(\` site(s) — ${scan.derived.length} derived from a registry ` +
      `declaration, ${scan.literals.length} with the name BAKED as a string literal. The baked ` +
      'names are a second authoritative representation: nothing derives them from the registry, ' +
      'and the registry does not derive them.',
  };
}

/** Measure the CLI surface against the live composition root on disk. */
export function measureCliSurfaceLive(repoRoot: string = REPO_ROOT): MeasuredBoundary {
  return measureCliSurface(scanGovernedSources(repoRoot));
}

// ─── Substituting a measured row into the committed topology ─────────────────

/**
 * Carried from the committed row, deliberately: `enforceFrom` is a SCHEDULE
 * claim and `provenance` is a claim about how the row is maintained. Neither is
 * a fact about the tree, so task 026 must not restate them — it measures the
 * authority and the representations and leaves the rest to task 024.
 */
export interface CarriedRowFields {
  readonly enforceFrom: unknown;
  readonly provenance: unknown;
}

/** A measured boundary, shaped as a topology row for {@link runAuthorityCensus}. */
export function measuredRow(
  boundary: MeasuredBoundary,
  carried: CarriedRowFields,
): {
  readonly boundary: string;
  readonly authority: MeasuredBoundary['authority'];
  readonly representations: readonly { readonly id: string; readonly binding: MeasuredBinding }[];
  readonly enforceFrom: unknown;
  readonly provenance: unknown;
  readonly measured: string;
} {
  return {
    boundary: boundary.boundary,
    authority: boundary.authority,
    representations: boundary.representations.map((r) => ({ id: r.id, binding: r.binding })),
    enforceFrom: carried.enforceFrom,
    provenance: carried.provenance,
    measured: boundary.measured,
  };
}

const isEventLifecycle = (value: string): value is EventLifecycle =>
  EVENT_LIFECYCLES.some((lifecycle) => lifecycle === value);

const isEventTier = (value: string): value is EventTier =>
  EVENT_TIERS.some((tier) => tier === value);
