// The live half of the authority census. It measures boundary rows from the
// source tree for `runAuthorityCensus`, which keeps the verdict. It has no
// policy, no exit code and no CLI entrypoint.
//
// A representation is bound when its name is computed from the authority, and
// unbound when the name is a baked literal. Runtime values erase this
// difference, so the module parses source with the TypeScript parser and
// classifies each site. A representation is bound only when each site is
// derived. A measurement throws when its denominator is empty, because an empty
// measurement reads as a closed boundary.
//
// It lives in `tools/audit/` because it reads files and imports `typescript`, a
// devDependency. It imports the shipped emission derivation, not a copy.
// `event-registration.ts` holds only type imports, so this adds no runtime edge.

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
import {
  EVENT_LIFECYCLES,
  EVENT_TIERS,
  resolveEmissionSource,
  type EventLifecycle,
  type EventTier,
} from '../../../src/events/event-registration.js';

const LABEL = 'authority-live-proof';

export { REPO_ROOT };

/**
 * How a site holds its value. `literal` bakes the name. `derived` computes it
 * through a projection of the authority. `opaque` computes it through something
 * else, such as a conditional or an unrelated helper. Only `derived` binds.
 */
export type SiteBinding = 'literal' | 'derived' | 'opaque';

export interface MeasuredSite {
  /** Repo-relative, forward-slashed. */
  readonly file: string;
  /** 1-based line of the site. */
  readonly line: number;
  readonly kind: SiteBinding;
  /** The entry key or the baked name. For a derived site, the deriving expression. */
  readonly subject: string;
  /** The site's source text, for the failure message. */
  readonly expression: string;
  /**
   * Offsets of {@link expression} within its own source. A sensitivity control
   * rewrites this exact span in memory. Several spans are byte-identical, so a
   * text substitution cannot address each one.
   */
  readonly start: number;
  readonly end: number;
}

/**
 * Applies a counterfactual to the exact spans that a measurement classified.
 * Edits go back to front, so earlier offsets stay valid. Sites from more than one
 * file are rejected, because offsets are per source.
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

/** The `RepresentationBinding` shape, as a measurement produces it. */
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
 * The binding that a measured population implies. `bound` requires each site to
 * be derived. Two derived entries out of six are not a binding over the six.
 */
export function bindingFor(
  sites: readonly MeasuredSite[],
  boundTo: string,
  how: string,
  why: string,
): MeasuredBinding {
  const unbound = sites.filter((s) => s.kind !== 'derived');
  if (unbound.length === 0) return { kind: 'bound', boundTo, how };
  const literals = unbound.filter((s) => s.kind === 'literal').length;
  const opaque = unbound.length - literals;
  return {
    kind: 'unbound',
    why:
      `${why} Measured live: ${unbound.length} of ${sites.length} site(s) are not computed from ` +
      `the authority — ${literals} bake the name as a literal, ${opaque} compute it through ` +
      'something the measurement does not recognise as a projection of the authority ' +
      `(${unbound.map((s) => `${s.file}:${s.line} ${s.subject} [${s.kind}]`).slice(0, 4).join('; ')}` +
      `${unbound.length > 4 ? '; …' : ''}). A representation is bound only when EVERY site is ` +
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
 * Tells whether an initializer bakes a name or computes it. A string literal, or
 * an array or object literal of string literals, is baked. Any other expression
 * computes its value, and only a computed value can follow its authority.
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

/**
 * Reads a `derived` initializer again against the shapes that reach an
 * authority. It gets the initializer with parent pointers set, so it can walk up
 * to the scope that declares a receiver. It also gets the measured subject.
 */
export type DerivedSiteBinder = (initializer: ts.Expression, subject: string) => SiteBinding;

function bindDerived(
  initializer: ts.Expression,
  subject: string,
  bind: DerivedSiteBinder | undefined,
): SiteBinding {
  const kind = classifyInitializer(initializer);
  return kind === 'derived' && bind !== undefined ? bind(initializer, subject) : kind;
}

/** `Object.freeze(<expr>)` -> `<expr>`. Any other node stays unchanged. */
function unwrapObjectFreeze(node: ts.Expression | undefined): ts.Expression | undefined {
  if (node === undefined || !ts.isCallExpression(node)) return node;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return node;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'Object') return node;
  if (callee.name.text !== 'freeze') return node;
  return node.arguments[0] ?? node;
}
/**
 * Finds the variable declaration `<name>` and returns its object literal. An
 * `Object.freeze({ … })` wrapper is unwrapped, because freezing is a runtime
 * choice and not a different declaration shape.
 */
function findExportedObjectLiteral(
  sourceFile: ts.SourceFile,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
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
 * Each declared event row in a source file: an object literal with a `type` and
 * a `when` property. Each row is one site, classified by how its `type` is
 * written. Zero rows throws. An object whose `when` is not a string literal is a
 * copy of a row, such as `when: row.when`, and does not count.
 */
export function measureDeclaredEventRows(source: string, file: string): readonly MeasuredSite[] {
  const sourceFile = parseOrThrow(source, file, LABEL);
  const sites: MeasuredSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const assignments = node.properties.filter((p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p),
      );
      const type = assignments.find((p) => propertyName(p.name) === 'type');
      const when = assignments.find((p) => propertyName(p.name) === 'when');
      if (type !== undefined && when !== undefined && ts.isStringLiteralLike(when.initializer)) {
        const init = type.initializer;
        sites.push({
          file,
          line: lineOf(sourceFile, type),
          kind: classifyInitializer(init),
          subject: ts.isStringLiteralLike(init) ? init.text : init.getText(sourceFile),
          expression: init.getText(sourceFile),
          start: init.getStart(sourceFile),
          end: init.getEnd(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return requireSites(sites, `declared event rows (\`type\` + \`when\`) in ${file}`);
}

/**
 * One site for each named constant: how its whole initializer is written. A call
 * is a derivation, and an object or array literal is a baked table. A missing
 * name throws, because the constant was renamed or moved.
 */
export function measureExportedInitializers(
  source: string,
  file: string,
  names: readonly string[],
  bind?: DerivedSiteBinder,
): readonly MeasuredSite[] {
  const sourceFile = parseOrThrow(source, file, LABEL, true);
  const sites: MeasuredSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) {
      const init = unwrapObjectFreeze(node.initializer);
      if (init !== undefined) {
        sites.push({
          file,
          line: lineOf(sourceFile, node),
          kind: bindDerived(init, node.name.text, bind),
          subject: node.name.text,
          expression: init.getText(sourceFile),
          start: init.getStart(sourceFile),
          end: init.getEnd(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  const missing = names.filter((name) => !sites.some((site) => site.subject === name));
  if (missing.length > 0) {
    throw new Error(
      `${LABEL}: ${file} exports no constant named ${missing.join(', ')}. The table was renamed ` +
        'or moved; refusing to report a measurement over a name that is not there.',
    );
  }
  return sites;
}

/**
 * Maps each key of a named object literal to the emission source that its
 * `lifecycle` and `tier` derive. It imports `resolveEmissionSource` from the
 * shipped module, so it cannot drift from the derivation it measures. Zero
 * entries throw, and an entry with an unreadable axis throws.
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
 * Classifies each `<propertyName>: …` assignment in a file. This form is for a
 * representation that a property carries, not a top-level constant.
 * `p: [{ … }]` is a literal site, and `p: computedFrom(x)` is a derived one.
 */
export function measurePropertyAssignments(
  source: string,
  file: string,
  property: string,
  bind?: DerivedSiteBinder,
): readonly MeasuredSite[] {
  const sourceFile = parseOrThrow(source, file, LABEL, true);
  const sites: MeasuredSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === property) {
      sites.push({
        file,
        line: lineOf(sourceFile, node),
        kind: bindDerived(node.initializer, property, bind),
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

/**
 * Each `ActionEmission` row declared on an action contract.
 *
 * The population is the row, not the `emissions:` assignment. Assignments reach
 * rows through `declared({ … })`, a spread of a named constant, a bare
 * reference, or `none('…')`. An anchor on the row measures each shape without
 * resolving it. A row is an object literal with both `event` and `condition`.
 * `event:` alone also matches postcondition rows and request schemas.
 */
export function measureActionEmissions(source: string, file: string): readonly MeasuredSite[] {
  const sourceFile = parseOrThrow(source, file, LABEL);
  const sites: MeasuredSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const event = emissionRowEvent(node);
      if (event !== undefined) {
        sites.push({
          file,
          line: lineOf(sourceFile, event),
          kind: classifyInitializer(event.initializer),
          subject: ts.isStringLiteralLike(event.initializer)
            ? event.initializer.text
            : event.initializer.getText(sourceFile),
          expression: event.initializer.getText(sourceFile),
          start: event.initializer.getStart(sourceFile),
          end: event.initializer.getEnd(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return requireSites(sites, '`ActionEmission` rows (an object pairing `event` with `condition`) ' + `in ${file}`);
}

/**
 * The `event:` member of an object literal that is an `ActionEmission` row, or
 * `undefined` when the literal is anything else.
 */
function emissionRowEvent(node: ts.ObjectLiteralExpression): ts.PropertyAssignment | undefined {
  let event: ts.PropertyAssignment | undefined;
  let hasCondition = false;
  for (const member of node.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const name = propertyName(member.name);
    if (name === 'event') event = member;
    else if (name === 'condition') hasCondition = true;
  }
  return hasCondition ? event : undefined;
}

/** A dotted token that can be an event type. */
const EVENT_TOKEN = /[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+/g;

export interface SkillDoc {
  /** Repo-relative, forward-slashed. */
  readonly file: string;
  readonly text: string;
}

/**
 * Each model-emitted event name in skill prose. Each site is `literal`, because
 * Markdown has no expressions and no import edge to the event registry.
 *
 * The non-empty check is on the corpus, not on the result. An empty corpus is a
 * broken scan and throws. A corpus in which no document names an event is a true
 * report that the representation is absent.
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

/** Every source the event-catalog measurement reads, repo-relative. */
export const EVENT_CATALOG_SOURCES: {
  readonly authority: string;
  readonly annotations: string;
  readonly emissions: string;
  readonly phaseExpectedEvents: string;
  readonly proseRoot: string;
} = Object.freeze({
  authority: 'src/events/schemas.ts',
  /**
   * The per-event emission facts. `schemas.ts` derives `EVENT_EMISSION_REGISTRY`
   * from them, so the measurement reads the tier and lifecycle pair of each event.
   */
  annotations: 'src/events/event-annotations.ts',
  /**
   * A directory of action descriptors, one module for each action family. The
   * measurement reads each emission row, not the property that carries it.
   */
  emissions: 'src/registry/actions',
  phaseExpectedEvents: 'src/workflow/topology/phase-events.ts',
  /**
   * The authored skills tree. The rendered trees come from it, so a scan of both
   * counts one representation more than once.
   */
  proseRoot: 'content',
});

export interface EventCatalogSources {
  readonly authority: string;
  readonly annotations: string;
  readonly emissions: string;
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
 * Reads the source of a representation: one file, or each `.ts` file of a
 * directory. A directory keeps the whole representation in the measurement when
 * a family splits into a new module.
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
    emissions: readOrThrow(repoRoot, EVENT_CATALOG_SOURCES.emissions),
    phaseExpectedEvents: readOrThrow(repoRoot, EVENT_CATALOG_SOURCES.phaseExpectedEvents),
    docs,
  };
}

/** The representation ids of the committed row. They must match exactly. */
export const EVENT_CATALOG_REPRESENTATION_IDS: {
  readonly authority: string;
  readonly emissions: string;
  readonly phaseExpectedEvents: string;
  readonly prose: string;
} = Object.freeze({
  authority: 'EVENT_EMISSION_REGISTRY (`events/schemas.ts`)',
  emissions: 'the registry emission rows',
  phaseExpectedEvents: 'the PHASE_EVENT_CONTRACTS rows (`workflow/topology/phase-events.ts`)',
  prose: 'skill prose naming events to emit',
});

export interface EventCatalogMeasurement extends MeasuredBoundary {
  /** event type → emission source, parsed from the authority's own declaration. */
  readonly registeredEvents: ReadonlyMap<string, string>;
  /** The subset the prose representation is measured against. */
  readonly modelEvents: ReadonlySet<string>;
}

/**
 * Measures the event-catalog boundary from source. The authority is measured
 * from the annotations it derives from, not imported. An import pulls zod and
 * the event-store graph into a build script, and a runtime value cannot show
 * provenance. The parsed key set omits types that `registerEventType` adds at
 * runtime. The co-located test compares it with the live registry.
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

  const emissionSites = measureActionEmissions(
    sources.emissions,
    EVENT_CATALOG_SOURCES.emissions,
  );
  const phaseSites = measureDeclaredEventRows(
    sources.phaseExpectedEvents,
    EVENT_CATALOG_SOURCES.phaseExpectedEvents,
  );
  const proseSites = measureProseEventMentions(sources.docs, modelEvents);

  const representations: MeasuredRepresentation[] = [
    {
      id: EVENT_CATALOG_REPRESENTATION_IDS.authority,
      binding: { kind: 'authoritative' },
      sites: [
        {
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
      id: EVENT_CATALOG_REPRESENTATION_IDS.emissions,
      binding: bindingFor(
        emissionSites,
        'EVENT_EMISSION_REGISTRY',
        'every emission row is computed from the emission registry',
        'declared alongside the emission registry rather than projected from it — an action whose ' +
          'emission row drifts from what it actually emits is invisible to any shipped check.',
      ),
      sites: emissionSites,
    },
    {
      id: EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents,
      binding: bindingFor(
        phaseSites,
        'EVENT_EMISSION_REGISTRY',
        'every contract row names its event through an expression computed from the registry',
        'the contract DECLARES which phase expects which event — a workflow fact the registry ' +
          'does not hold — so each row is validated against the registry at load (registered, ' +
          '`model`-sourced for an expectation, `auto`-sourced for a disclosure), never computed ' +
          'from it. The gate table and the playbooks are computed from the contract; that binding ' +
          'is the `phase-events` boundary, measured separately.',
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
      `emission rows: ${emissionSites.filter((s) => s.kind === 'literal').length}/` +
      `${emissionSites.length} sites baked. \`PHASE_EVENT_CONTRACTS\`: ` +
      `${phaseSites.filter((s) => s.kind === 'literal').length}/${phaseSites.length} rows name ` +
      `their event as a literal — declared and validated at load, not computed. Skill prose: ${proseSites.length} ` +
      'event names in Markdown, which has no expressions to derive them with.',
  };
}

/** Every source the phase-events measurement reads, repo-relative. */
export const PHASE_EVENTS_SOURCES: {
  readonly contract: string;
  readonly gate: string;
  readonly playbooks: string;
  readonly prose: readonly string[];
} = Object.freeze({
  contract: 'src/workflow/topology/phase-events.ts',
  gate: 'src/verbs/gates/check-event-emissions.ts',
  playbooks: 'src/workflow/playbooks.ts',
  prose: Object.freeze([
    'content/synthesis/skills/synthesize/SKILL.md',
    'content/delivery/skills/delegate/SKILL.md',
  ]),
});

export interface PhaseEventsSources {
  readonly contract: string;
  readonly gate: string;
  readonly playbooks: string;
  readonly docs: readonly SkillDoc[];
}

/** The representation ids the committed `phase-events` row uses. Matched exactly. */
export const PHASE_EVENTS_REPRESENTATION_IDS: {
  readonly authority: string;
  readonly gate: string;
  readonly playbooks: string;
  readonly prose: string;
} = Object.freeze({
  authority: 'PHASE_EVENT_CONTRACTS (`workflow/topology/phase-events.ts`)',
  gate: 'the gate tables `PHASE_EXPECTED_EVENTS` and `EVENT_DESCRIPTIONS` (`verbs/gates/check-event-emissions.ts`)',
  playbooks: 'the playbook `events` and `autoEmittedEvents` rows (`workflow/playbooks.ts`)',
  prose: 'the skill passages that say what the gate checks',
});

/** The module every consumer must import the contract's projections from. */
export const CONTRACT_MODULE_SUFFIX = 'topology/phase-events.js';

/** The contract table. A gate projection takes only this argument. */
export const CONTRACT_TABLE = 'PHASE_EVENT_CONTRACTS';

/** Each gate table and the one contract projection that can compute it. */
export const GATE_TABLE_PROJECTIONS: Readonly<Record<string, string>> = Object.freeze({
  PHASE_EXPECTED_EVENTS: 'expectedEventsByPhase',
  EVENT_DESCRIPTIONS: 'hintDescriptions',
});

/** The two gate tables that must be computed from the contract. */
export const GATE_TABLES: readonly string[] = Object.freeze(Object.keys(GATE_TABLE_PROJECTIONS));

/**
 * Each playbook property and the one contract projection that can compute it.
 * `events` instructs the model, and `autoEmittedEvents` discloses what the
 * runtime emits. A row that calls the projection of the other property swaps
 * model-owned and runtime-owned meaning, so it is not bound.
 */
export const PLAYBOOK_PROPERTY_PROJECTIONS: Readonly<Record<string, string>> = Object.freeze({
  events: 'phaseEventInstructions',
  autoEmittedEvents: 'phaseRuntimeEmissions',
});

/** The playbook properties the contract must compute. */
export const PLAYBOOK_PROPERTIES: readonly string[] = Object.freeze(
  Object.keys(PLAYBOOK_PROPERTY_PROJECTIONS),
);

/** The contract projections that a playbook row can call, across all properties. */
export const PLAYBOOK_PROJECTIONS: readonly string[] = Object.freeze(
  Object.values(PLAYBOOK_PROPERTY_PROJECTIONS),
);

/** The names `file` imports, by name, from a module whose specifier ends with `moduleSuffix`. */
export function namedImportsFrom(source: string, file: string, moduleSuffix: string): ReadonlySet<string> {
  const sourceFile = parseOrThrow(source, file, LABEL);
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.endsWith(moduleSuffix)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/** The type of the measured playbook population. The serializer copies rows off a value of this type. */
export const PLAYBOOK_TYPE = 'PhasePlaybook';

/** A copy of a measured row: `<receiver>.<property>` with `<receiver>` declared as `receiverType`. */
export interface RowCopyShape {
  readonly property: string;
  readonly receiverType: string;
}

/** What a derived site must look like to count as computed from the authority. */
export interface ProjectionShape {
  /** Callees that are projections of the authority, as imported by the file under measurement. */
  readonly projections: ReadonlySet<string>;
  /** When set, the projection call's one argument must be exactly this name. */
  readonly argument?: string;
  /**
   * When set, `<receiver>.<property>`, or `<receiver>.<property>.map(clone)`, is
   * a copy of a row in the population. The receiver must be declared in an
   * enclosing scope with the population type. Otherwise the same property is a
   * second table.
   */
  readonly copies?: RowCopyShape;
}

/**
 * Reads a `derived` initializer again against the shapes that reach the
 * authority. The whole initializer must be exactly one call of an imported
 * projection, or exactly one copy of a measured row. A conditional, an unrelated
 * helper, or a wrapped call is `opaque`, which `bindingFor` counts as unbound. A
 * playbook projection takes the phase as a name or a string, never an expression
 * that can carry an event.
 */
export function bindThroughProjection(initializer: ts.Expression, shape: ProjectionShape): SiteBinding {
  const node = unwrapParentheses(initializer);
  if (shape.copies !== undefined && copiesMeasuredRow(node, shape.copies)) return 'derived';
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return 'opaque';
  if (!shape.projections.has(node.expression.text) || node.arguments.length !== 1) return 'opaque';
  const [argument] = node.arguments;
  if (argument === undefined) return 'opaque';
  if (shape.argument !== undefined) {
    return ts.isIdentifier(argument) && argument.text === shape.argument ? 'derived' : 'opaque';
  }
  return ts.isIdentifier(argument) || ts.isStringLiteralLike(argument) ? 'derived' : 'opaque';
}

function unwrapParentheses(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** `<receiver>.<property>` or `<receiver>.<property>.map(<clone>)`, with `<receiver>` declared as the population's type. */
function copiesMeasuredRow(node: ts.Expression, copies: RowCopyShape): boolean {
  let read: ts.Expression = node;
  if (
    ts.isCallExpression(read) &&
    ts.isPropertyAccessExpression(read.expression) &&
    read.expression.name.text === 'map'
  ) {
    const [clone] = read.arguments;
    if (read.arguments.length !== 1 || clone === undefined || !clonesRowsUnchanged(clone)) return false;
    read = read.expression.expression;
  }
  if (!ts.isPropertyAccessExpression(read) || read.name.text !== copies.property) return false;
  if (!ts.isIdentifier(read.expression)) return false;
  return declaredTypeOf(read.expression) === copies.receiverType;
}

/**
 * Whether a `.map()` callback returns each row with its event facts unchanged. A
 * callback that can set `type` or `when` is a second author of the facts. Only a
 * one-parameter arrow or function expression is accepted. It must return an
 * object literal of spreads: of the parameter, or of a guarded object literal
 * that copies the same-named property of the parameter. A named callback
 * resolves to its declaration first.
 */
function clonesRowsUnchanged(callback: ts.Expression): boolean {
  const declared = unwrapParentheses(callback);
  const fn = ts.isIdentifier(declared) ? declaredValueOf(declared) : declared;
  if (fn === undefined) return false;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const [parameter] = fn.parameters;
  if (fn.parameters.length !== 1 || parameter === undefined || !ts.isIdentifier(parameter.name)) {
    return false;
  }
  const row = parameter.name.text;
  const returned = returnedExpression(fn.body);
  if (returned === undefined || !ts.isObjectLiteralExpression(returned)) return false;
  return returned.properties.every(
    (property) => ts.isSpreadAssignment(property) && spreadKeepsRow(property.expression, row),
  );
}

/** The single expression a body evaluates to — `=> expr`, or a block whose only statement returns one. */
function returnedExpression(body: ts.ConciseBody): ts.Expression | undefined {
  if (!ts.isBlock(body)) return unwrapParentheses(body);
  const [statement] = body.statements;
  if (body.statements.length !== 1 || statement === undefined || !ts.isReturnStatement(statement)) {
    return undefined;
  }
  return statement.expression === undefined ? undefined : unwrapParentheses(statement.expression);
}

/** `...row`, or `...(<guard> && { k: <reads row.k> })` — a spread that adds nothing of its own. */
function spreadKeepsRow(expression: ts.Expression, row: string): boolean {
  const node = unwrapParentheses(expression);
  if (ts.isIdentifier(node)) return node.text === row;
  const guarded = ts.isBinaryExpression(node)
    ? unwrapParentheses(node.right)
    : ts.isConditionalExpression(node)
      ? unwrapParentheses(node.whenTrue)
      : undefined;
  if (guarded === undefined || !ts.isObjectLiteralExpression(guarded)) return false;
  return guarded.properties.every(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      readsRowProperty(property.initializer, row, property.name.text),
  );
}

/** `row.k` or `[...row.k]` under the key `k`: the same field, copied, never renamed or replaced. */
function readsRowProperty(initializer: ts.Expression, row: string, key: string): boolean {
  const node = unwrapParentheses(initializer);
  if (ts.isArrayLiteralExpression(node)) {
    const [element] = node.elements;
    return (
      node.elements.length === 1 &&
      element !== undefined &&
      ts.isSpreadElement(element) &&
      readsRowProperty(element.expression, row, key)
    );
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === row &&
    node.name.text === key
  );
}

/** The initializer of the nearest enclosing declaration of `identifier`, if it has one. */
function declaredValueOf(identifier: ts.Identifier): ts.Expression | undefined {
  requireParentPointers(identifier, 'declaredValueOf');
  for (let scope: ts.Node | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find(
        (d) => ts.isIdentifier(d.name) && d.name.text === identifier.text,
      );
      if (declaration !== undefined) {
        return declaration.initializer === undefined
          ? undefined
          : unwrapParentheses(declaration.initializer);
      }
    }
  }
  return undefined;
}

/** Reading a scope off a parentless tree answers "nothing declares it" for every question. */
function requireParentPointers(node: ts.Node, caller: string): void {
  if (node.parent === undefined) {
    throw new Error(
      `${LABEL}: ${caller} needs a source parsed with parent pointers; the measurer that ` +
        'produced this site parsed without them, so no declaration could ever resolve.',
    );
  }
}

/**
 * The annotated type name on the nearest enclosing declaration of
 * `identifier`: a parameter of an enclosing function, or a variable declared
 * in an enclosing block. Undefined when no enclosing scope declares it, or
 * declares it without a type reference — either way, not the population's
 * type. Needs a parse with parent pointers, and refuses one without them
 * rather than reading "no enclosing scope" off a tree that has no parents.
 */
function declaredTypeOf(identifier: ts.Identifier): string | undefined {
  requireParentPointers(identifier, 'declaredTypeOf');
  for (let scope: ts.Node | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find(
        (p) => ts.isIdentifier(p.name) && p.name.text === identifier.text,
      );
      if (parameter !== undefined) return typeNameOf(parameter.type);
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const declaration = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === identifier.text,
        );
        if (declaration !== undefined) return typeNameOf(declaration.type);
      }
    }
  }
  return undefined;
}

function typeNameOf(type: ts.TypeNode | undefined): string | undefined {
  return type !== undefined && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
    ? type.typeName.text
    : undefined;
}

/**
 * Measures the phase-events boundary from source. `PHASE_EVENT_CONTRACTS`
 * declares the events that each phase expects and that the runtime emits. The
 * gate tables and the playbook rows must be computed from the contract, through
 * a projection that the file imports from the contract module. The gate
 * projection must take the contract table itself. A test compares the skill
 * prose with the contract.
 */
export function measurePhaseEvents(sources: PhaseEventsSources): MeasuredBoundary {
  const contractRows = measureDeclaredEventRows(sources.contract, PHASE_EVENTS_SOURCES.contract);
  const contractEvents = new Set(
    contractRows.filter((site) => site.kind === 'literal').map((site) => site.subject),
  );
  if (contractEvents.size === 0) {
    throw new Error(
      `${LABEL}: the phase event contract declares ${contractRows.length} row(s) but NONE names ` +
        'its event as a literal. The prose representation is measured against the declared ' +
        'names, and an empty set would make it vanish rather than be found unbound.',
    );
  }
  const gateImports = namedImportsFrom(sources.gate, PHASE_EVENTS_SOURCES.gate, CONTRACT_MODULE_SUFFIX);
  const gateSites = measureExportedInitializers(
    sources.gate,
    PHASE_EVENTS_SOURCES.gate,
    GATE_TABLES,
    (initializer, table) =>
      bindThroughProjection(initializer, {
        projections: new Set(
          [GATE_TABLE_PROJECTIONS[table]].filter(
            (name): name is string => name !== undefined && gateImports.has(name),
          ),
        ),
        argument: gateImports.has(CONTRACT_TABLE) ? CONTRACT_TABLE : `${CONTRACT_TABLE} (not imported)`,
      }),
  );
  const playbookImports = namedImportsFrom(
    sources.playbooks,
    PHASE_EVENTS_SOURCES.playbooks,
    CONTRACT_MODULE_SUFFIX,
  );
  const playbookSites = PLAYBOOK_PROPERTIES.flatMap((property) =>
    measurePropertyAssignments(sources.playbooks, PHASE_EVENTS_SOURCES.playbooks, property, (initializer) =>
      bindThroughProjection(initializer, {
        projections: new Set(
          [PLAYBOOK_PROPERTY_PROJECTIONS[property]].filter(
            (name): name is string => name !== undefined && playbookImports.has(name),
          ),
        ),
        copies: { property, receiverType: PLAYBOOK_TYPE },
      }),
    ),
  );
  const proseSites = measureProseEventMentions(sources.docs, contractEvents);
  const representations: MeasuredRepresentation[] = [
    {
      id: PHASE_EVENTS_REPRESENTATION_IDS.authority,
      binding: { kind: 'authoritative' },
      sites: contractRows,
    },
    {
      id: PHASE_EVENTS_REPRESENTATION_IDS.gate,
      binding: bindingFor(
        gateSites,
        PHASE_EVENTS_REPRESENTATION_IDS.authority,
        'both tables are computed from the contract at load — `expectedEventsByPhase` and ' +
          '`hintDescriptions`, each imported from the contract module and applied to the ' +
          'contract table — and the gate module holds no phase or event literal of its own',
        'a gate table written as a literal is a second copy of the phase → event facts, which is ' +
          'the drift the contract exists to end.',
      ),
      sites: gateSites,
    },
    {
      id: PHASE_EVENTS_REPRESENTATION_IDS.playbooks,
      binding: bindingFor(
        playbookSites,
        PHASE_EVENTS_REPRESENTATION_IDS.authority,
        'every playbook row is `phaseEventInstructions(phase)` or `phaseRuntimeEmissions(phase)`, ' +
          'imported from the contract module (or the serializer copying such a row off a `PhasePlaybook`); the per-phase ' +
          'arrays and the delegate metadata maps are gone',
        'a playbook row written as a literal instructs the model from a copy the gate does not ' +
          'check — four phases instructed runtime-owned events that way before the contract.',
      ),
      sites: playbookSites,
    },
    {
      id: PHASE_EVENTS_REPRESENTATION_IDS.prose,
      binding: {
        kind: 'unbound',
        why:
          'Markdown; the checked-by line and the delegate table are compared to the contract by ' +
          '`tests/architecture/skill-prose-gate-row-agreement.test.ts`, so drift fails, but nothing ' +
          'computes them — the renderer may not import `workflow/`. Measured live: ' +
          `${proseSites.length} contract event name(s) written in prose across ` +
          `${new Set(proseSites.map((s) => s.file)).size} document(s).`,
      },
      sites: proseSites,
    },
  ];
  const present = representations.filter((r) => r.sites.length > 0);
  return {
    boundary: 'phase-events',
    authority: { kind: 'single', authority: PHASE_EVENTS_REPRESENTATION_IDS.authority },
    representations: present,
    siteCount: present.reduce((total, r) => total + r.sites.length, 0),
    measured:
      `Measured LIVE from source by \`authority-live-proof.ts\`: the contract declares ` +
      `${contractRows.length} event rows. Gate tables: ` +
      `${gateSites.filter((s) => s.kind === 'derived').length}/${gateSites.length} initializers computed. ` +
      `Playbook rows: ${playbookSites.filter((s) => s.kind === 'derived').length}/${playbookSites.length} ` +
      `computed. Skill prose: ${proseSites.length} event names in Markdown, compared by test, not computed.`,
  };
}

/** Read every phase-events source off disk. The only IO in the measurement. */
export function readPhaseEventsSources(repoRoot: string = REPO_ROOT): PhaseEventsSources {
  return {
    contract: readOrThrow(repoRoot, PHASE_EVENTS_SOURCES.contract),
    gate: readOrThrow(repoRoot, PHASE_EVENTS_SOURCES.gate),
    playbooks: readOrThrow(repoRoot, PHASE_EVENTS_SOURCES.playbooks),
    docs: PHASE_EVENTS_SOURCES.prose.map((file) => ({
      file,
      text: readOrThrow(repoRoot, file),
    })),
  };
}

/** {@link measurePhaseEvents} over the live tree. */
export function measurePhaseEventsLive(repoRoot: string = REPO_ROOT): MeasuredBoundary {
  return measurePhaseEvents(readPhaseEventsSources(repoRoot));
}

/** Every source the effect-event measurement reads, repo-relative. */
export const EFFECT_EVENT_SOURCES: {
  readonly carrier: string;
  readonly vcsLedger: string;
  readonly promotion: string;
} = Object.freeze({
  /** The carrier. It declares `EffectPlan.emits` and throws the commit gate. */
  carrier: 'src/dispatch/core/effect-carrier.ts',
  /**
   * The two owners that declare emissions on a plan. They are named, not
   * scanned, so a moved owner fails the read and does not shrink the denominator.
   */
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
 * The property that names the identity of a plan-declared emission in a sink.
 * `emission.when` selects the condition, and `emission.event` selects the
 * identity. Only a sink that reads the identity records a fact that follows the
 * plan.
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
 * Each emission sink that an owner builds, classified by whether the plan names
 * the fact that it records. A sink that appends `emission.event` follows the
 * plan. A sink that ignores the emission bakes its record. The commit gate
 * cannot tell them apart, because both mint a receipt. The measurement reads the
 * sink, not the append call, because an owner can append through a private
 * helper.
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
 * Counts the `throw new UnrecordedEmissionError` sites in the carrier. This
 * commit gate makes `EffectPlan.emits` an authority: a plan cannot commit a value
 * without a receipt for each declared emission. Zero sites throw, so a removal of
 * the gate also removes the authority claim.
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
 * Measures the effect-event boundary from source. It asks whether the planned
 * effect and the event that records it agree. Two facts answer it, and each can
 * fail alone. The `emits` set of the plan controls whether a record happens, and
 * {@link requireCommitGate} is a precondition for that. Whether the record
 * identity follows the plan is a fact for each owner. The type on
 * `EffectEmission.event` is not evidence, because a type cannot fail here.
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

/** The registry-side authority id of the committed row. */
export const CLI_REGISTRY_AUTHORITY = 'registry';
/** The literal-side authority id of the committed row. */
export const CLI_LITERAL_AUTHORITY = 'adapters/cli/cli.ts hand-written `.command()` literals';

/**
 * Builds the CLI-surface row from the live scan of `cli-derivation-guard.ts`.
 * The second authority exists only when the scan finds a baked `.command('…')`
 * name. The authority arm is computed from the count of authoritative
 * representations, so the row reports `single` when the last literal goes. The
 * literal representation id holds the live count, so a count drift changes the
 * census tuple. The scan gives no offsets, so each site has the span -1, and
 * {@link spliceSites} refuses it.
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
          file: GOVERNED_SOURCES[0] ?? EVENT_CATALOG_SOURCES.emissions,
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
      id: `the ${scan.literals.length} hand-written \`.command('…')\` literals in \`adapters/cli/cli.ts\``,
      binding: { kind: 'authoritative' },
      sites: scan.literals.map(toSite('literal')),
    });
  }

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

/**
 * Fields copied from the committed row. `enforceFrom` is a schedule claim and
 * `provenance` is a maintenance claim. Neither is a fact about the tree, so the
 * measurement does not restate them.
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
