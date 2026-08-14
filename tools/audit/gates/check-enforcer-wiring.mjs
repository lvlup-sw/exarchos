#!/usr/bin/env node
/**
 * Enforcer-wiring gate (task 011, DR-5 / DR-8).
 *
 * A name-grep can tell you a `scripts/check-*` gate EXISTS. It cannot tell you
 * the gate is actually WIRED so that a real regression fails CI. This gate
 * closes that gap by TRANSITIVELY walking npm-script chains and CI workflow
 * run-steps, inspecting per-term exit-code handling, and reconciling every
 * primary against a manifest of dispositions. It models four trap classes a
 * grep is blind to:
 *
 *   1. orphan               — a `scripts/check-*|lint-*` primary that no
 *                             workflow references at all.
 *   2. unreachable-npm      — referenced only from an npm script that no
 *                             workflow invokes (e.g. `npm run validate`, which
 *                             no workflow runs).
 *   3. exit-code-swallowed  — runs in CI but its exit code is eaten (`|| true`
 *                             in an npm chain, or `continue-on-error: true` on
 *                             the step) so it can never fail the job.
 *   4. missing-synchronize  — a DIFF-DEPENDENT gate that is wired-and-failable
 *                             but hosted in a workflow whose `pull_request`
 *                             trigger omits `synchronize`, so a diff pushed
 *                             after the PR opens leaves a stale green standing.
 *   5. filtered-ci-path     — an entry CLAIMING an unfiltered CI path
 *                             (`unfilteredCiPath: true`) whose host workflow is
 *                             actually narrowed by `on.<event>.paths` /
 *                             `paths-ignore` / `branches`, or whose hosting
 *                             job/step is gated by a filtering `if:` (DR-15).
 *                             The claim used to be free text checked only for
 *                             filename shape.
 *
 * The manifest (`tools/audit/gates/enforcer-wiring-manifest.json` by default) lists every
 * primary with a disposition:
 *
 *   gating   → MUST be reachable-AND-failable from its named `workflow`; if
 *              `diffDependent`, that workflow's `pull_request` trigger MUST
 *              include `synchronize`.
 *   advisory → intentionally non-blocking (neutered / continue-on-error);
 *              MUST still be reachable from some workflow + carry a rationale.
 *   retired  → deliberately dead; MUST NOT be reachable-and-failable from any
 *              workflow + carry a rationale (file typically deleted).
 *
 * Completeness is enforced both ways: every primary on disk MUST have a
 * manifest entry (a newly-added orphan can't hide), and every non-retired
 * manifest entry MUST point at a file that exists.
 *
 * Exit 0 — clean. Exit 1 — violations OR a tool/manifest failure (fail closed).
 * Exit 2 — usage error (bad flag).
 *
 * Zero runtime dependencies: only Node built-ins. Designed to run as a
 * grep-gates CI step (no install, no build) on the unfiltered host so it fires
 * on every PR (DR-8: a gate in a path-filtered job is skipped-as-passed).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const VALID_DISPOSITIONS = new Set(['gating', 'advisory', 'retired']);

// ─── Command exit-code analysis ────────────────────────────────────────────
//
// The one rule that captures GitHub's default `bash -eo pipefail` semantics
// for our purposes: an atom's non-zero exit PROPAGATES unless the operator
// immediately after it is `||` (which catches the failure). `&&`, `;`,
// newline, and `|` all leave the atom failable. Failability composes through
// nested `( … )` groups: a group caught by `||` at its parent level makes
// every ref inside it non-failable too.

/**
 * Split a shell command into top-level atoms, honoring quotes and parens, and
 * record the operator that FOLLOWS each atom.
 *
 * @param {string} text
 * @returns {{ atom: string, opAfter: '&&' | '||' | ';' | '|' | '' }[]}
 */
export function splitTopLevel(text) {
  /** @type {{ atom: string, opAfter: '&&' | '||' | ';' | '|' | '' }[]} */
  const parts = [];
  let buf = '';
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const c2 = text[i + 1];
    if (quote) {
      buf += c;
      if (c === '\\' && quote !== "'") {
        if (c2 !== undefined) buf += c2;
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '(') {
      depth++;
      buf += c;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth--;
      buf += c;
      continue;
    }
    if (depth === 0) {
      if (c === '&' && c2 === '&') {
        parts.push({ atom: buf, opAfter: '&&' });
        buf = '';
        i++;
        continue;
      }
      if (c === '|' && c2 === '|') {
        parts.push({ atom: buf, opAfter: '||' });
        buf = '';
        i++;
        continue;
      }
      if (c === '|') {
        parts.push({ atom: buf, opAfter: '|' });
        buf = '';
        continue;
      }
      if (c === ';' || c === '\n') {
        parts.push({ atom: buf, opAfter: ';' });
        buf = '';
        continue;
      }
    }
    buf += c;
  }
  parts.push({ atom: buf, opAfter: '' });
  return parts;
}

/**
 * Pull the primary-script and npm-run references out of a single simple atom,
 * tagging each with the supplied `failable`.
 *
 * @param {string} atom
 * @param {boolean} failable
 * @param {{ type: 'npm' | 'script', name?: string, path?: string, failable: boolean }[]} out
 */
function extractRefsFromAtom(atom, failable, out) {
  for (const m of atom.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_.-]+)/g)) {
    out.push({ type: 'npm', name: m[1], failable });
  }
  for (const m of atom.matchAll(
    /tools\/audit\/gates\/((?:check|lint)-[A-Za-z0-9._-]+?)\.(mjs|sh)\b/g,
  )) {
    const rel = `tools/audit/gates/${m[1]}.${m[2]}`;
    // A co-located `*.test.sh` / `*.test.mjs` self-test is NOT the primary.
    if (/\.test\.(mjs|sh)$/.test(rel)) continue;
    out.push({ type: 'script', path: rel, failable });
  }
}

/**
 * Analyze a command string into its primary/npm references, each carrying a
 * `failable` flag that already accounts for enclosing `||`-caught groups.
 *
 * @param {string} cmd
 * @param {boolean} [parentFailable=true]
 * @returns {{ type: 'npm' | 'script', name?: string, path?: string, failable: boolean }[]}
 */
export function analyzeCommandRefs(cmd, parentFailable = true) {
  /** @type {{ type: 'npm' | 'script', name?: string, path?: string, failable: boolean }[]} */
  const refs = [];
  for (const { atom, opAfter } of splitTopLevel(cmd)) {
    const atomFailable = parentFailable && opAfter !== '||';
    const trimmed = atom.trim();
    const group = trimmed.match(/^\(([\s\S]*)\)\s*$/);
    if (group) {
      refs.push(...analyzeCommandRefs(group[1], atomFailable));
      continue;
    }
    extractRefsFromAtom(trimmed, atomFailable, refs);
  }
  return refs;
}

/**
 * Transitively resolve the primaries reachable from a command, expanding
 * `npm run <name>` references through the package.json script map. Failability
 * composes multiplicatively along each path; a primary reachable-and-failable
 * via ANY path is recorded as failable.
 *
 * @param {string} cmd
 * @param {Record<string, string>} scripts
 * @param {Set<string>} [seenNpm]
 * @returns {Map<string, { reachable: true, failable: boolean }>}
 */
export function reachPrimariesFromCommand(cmd, scripts, seenNpm = new Set()) {
  /** @type {Map<string, { reachable: true, failable: boolean }>} */
  const result = new Map();
  const merge = (p, failable) => {
    const cur = result.get(p);
    if (!cur) result.set(p, { reachable: true, failable });
    else cur.failable = cur.failable || failable;
  };
  for (const ref of analyzeCommandRefs(cmd)) {
    if (ref.type === 'script' && ref.path) {
      merge(ref.path, ref.failable);
    } else if (ref.type === 'npm' && ref.name) {
      if (seenNpm.has(ref.name)) continue; // cycle guard (per-path)
      const body = scripts[ref.name];
      if (typeof body !== 'string') continue; // references a non-existent script
      const sub = reachPrimariesFromCommand(
        body,
        scripts,
        new Set([...seenNpm, ref.name]),
      );
      for (const [p, info] of sub) merge(p, ref.failable && info.failable);
    }
  }
  return result;
}

// ─── Workflow parsing (zero-dep, targeted — not a general YAML parser) ──────

/**
 * Group a workflow's lines into list items (steps). Each returned item is the
 * slice of lines belonging to one `- …` entry, used to associate a `run:`
 * block with its own `continue-on-error:`.
 *
 * @param {string[]} lines
 * @returns {string[][]}
 */
function groupListItems(lines) {
  /** @type {string[][]} */
  const items = [];
  /** @type {string[] | null} */
  let current = null;
  let currentIndent = -1;
  const flush = () => {
    if (current) items.push(current);
    current = null;
    currentIndent = -1;
  };
  for (const line of lines) {
    const marker = line.match(/^(\s*)-\s/);
    if (marker) {
      const indent = marker[1].length;
      if (current && indent <= currentIndent) flush();
      if (!current) {
        current = [line];
        currentIndent = indent;
      } else {
        current.push(line); // nested (deeper) list entry
      }
      continue;
    }
    if (current) {
      const contentIndent = line.search(/\S/);
      if (contentIndent !== -1 && contentIndent <= currentIndent) {
        flush(); // dedented out of the list item
        continue;
      }
      current.push(line);
    }
  }
  flush();
  return items;
}

/**
 * Extract the shell command from a step's lines (inline `run: cmd` or a
 * `run: |` block scalar). Returns null if the step has no `run:`.
 *
 * @param {string[]} stepLines
 * @returns {string | null}
 */
function extractRunCommand(stepLines) {
  for (let i = 0; i < stepLines.length; i++) {
    const m = stepLines[i].match(/^(\s*)(?:-\s+)?run:\s?(.*)$/);
    if (!m) continue;
    const rest = m[2];
    const isBlock = /^[|>][+-]?\s*$/.test(rest.trim());
    if (!isBlock && rest.trim() !== '') return rest;
    // Block scalar: gather the more-indented following lines and dedent them.
    /** @type {string[]} */
    const block = [];
    let contentIndent = null;
    for (let j = i + 1; j < stepLines.length; j++) {
      const bl = stepLines[j];
      if (bl.trim() === '') {
        block.push('');
        continue;
      }
      const ind = bl.search(/\S/);
      if (contentIndent === null) contentIndent = ind;
      if (ind < contentIndent) break; // sibling key at the run: level ends it
      block.push(bl.slice(contentIndent));
    }
    return block.join('\n');
  }
  return null;
}

/**
 * Parse a workflow file into its run-steps (command + continue-on-error) and
 * its pull_request trigger shape.
 *
 * @param {string} text
 * @returns {{ runSteps: { command: string, continueOnError: boolean }[], pullRequest: { present: boolean, types: string[] | null } }}
 */
export function parseWorkflow(text) {
  const lines = text.split('\n');
  const runSteps = [];
  for (const stepLines of groupListItems(lines)) {
    const command = extractRunCommand(stepLines);
    if (command == null) continue;
    const continueOnError = stepLines.some((l) =>
      /^\s*continue-on-error:\s*true\s*$/.test(l),
    );
    runSteps.push({ command, continueOnError });
  }
  return { runSteps, pullRequest: parsePullRequestTrigger(lines) };
}

/**
 * @param {string[]} lines
 * @returns {{ present: boolean, types: string[] | null }}
 */
function parsePullRequestTrigger(lines) {
  // Locate the top-level `on:` key.
  let onIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^["']?on["']?:/.test(lines[i])) {
      onIdx = i;
      break;
    }
  }
  if (onIdx === -1) return { present: false, types: null };

  // Inline flow form: `on: [push, pull_request]`.
  const inline = lines[onIdx].match(/^["']?on["']?:\s*\[([^\]]*)\]/);
  if (inline) {
    const present = inline[1].split(',').some((s) => s.trim() === 'pull_request');
    return { present, types: null };
  }

  // Block form: collect the indented `on:` block.
  /** @type {string[]} */
  const onBlock = [];
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      onBlock.push(lines[i]);
      continue;
    }
    if (lines[i].search(/\S/) === 0) break; // next top-level key
    onBlock.push(lines[i]);
  }

  let prIdx = -1;
  let prIndent = -1;
  for (let i = 0; i < onBlock.length; i++) {
    const m = onBlock[i].match(/^(\s*)pull_request:\s*(.*)$/);
    if (m) {
      prIdx = i;
      prIndent = m[1].length;
      break;
    }
  }
  if (prIdx === -1) return { present: false, types: null };

  // Collect the pull_request sub-block (more indented than `pull_request:`).
  /** @type {string[]} */
  const prBlock = [];
  for (let i = prIdx + 1; i < onBlock.length; i++) {
    if (onBlock[i].trim() === '') continue;
    if (onBlock[i].search(/\S/) <= prIndent) break;
    prBlock.push(onBlock[i]);
  }

  const types = parseTypesList(prBlock);
  return { present: true, types };
}

/**
 * Extract a `types:` list from a pull_request sub-block. Returns null when no
 * explicit `types:` is present (a bare `pull_request:` defaults to
 * [opened, synchronize, reopened], which DOES include synchronize).
 *
 * @param {string[]} prBlock
 * @returns {string[] | null}
 */
function parseTypesList(prBlock) {
  for (let i = 0; i < prBlock.length; i++) {
    const inline = prBlock[i].match(/^\s*types:\s*\[([^\]]*)\]/);
    if (inline) {
      return inline[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const block = prBlock[i].match(/^(\s*)types:\s*$/);
    if (block) {
      const typesIndent = block[1].length;
      /** @type {string[]} */
      const items = [];
      for (let j = i + 1; j < prBlock.length; j++) {
        const item = prBlock[j].match(/^(\s*)-\s*(\S+)\s*$/);
        if (!item) break;
        if (item[1].length <= typesIndent) break;
        items.push(item[2]);
      }
      return items;
    }
  }
  return null;
}

// ─── CI path-filter modelling (DR-15) ───────────────────────────────────────
//
// "Runs on an unfiltered CI path" used to be a FREE-TEXT claim checked only for
// filename shape: `.github/workflows/<name>.yml` matched a regex and the claim
// was accepted. A workflow triggered by `on: pull_request: paths: ['docs/**']`
// satisfies that regex and does NOT run on an unfiltered path — a gate hosted
// there is skipped-as-passed on most PRs (DR-8). The model below parses the
// trigger and the job/step `if:` gates so the claim is VERIFIED, not asserted.
//
// A CI path is UNFILTERED for an event (default `pull_request`) iff ALL hold:
//   1. the workflow declares that event at all;
//   2. the event carries no `paths:` / `paths-ignore:` narrowing;
//   3. the event carries no `branches:` / `branches-ignore:` narrowing;
//   4. at least one step matching the caller's `stepMatch` is hosted by a job
//      whose `if:` is non-filtering AND whose own step `if:` is non-filtering.
//
// Rule 4 is "reachable via ANY unfiltered host": a gate re-asserted on an
// unfiltered job is unfiltered even if another copy rides a filtered job
// (the DR-10 re-assert pattern).
//
// SHAPES DELIBERATELY NOT MODELLED (documented gaps, not silent ones):
//   - `on.<event>.paths` inherited from a reusable/called workflow
//     (`workflow_call` + `uses:` at job level) — a job that delegates to
//     another workflow file is not followed.
//   - matrix/`strategy` exclusions, `concurrency` cancellation, and
//     `timeout-minutes` — none of these narrow the PATH surface.
//   - shell-level early exits inside a `run:` block (`set +e`, `if ... exit 0`,
//     a `changed-files` guard implemented in bash) — the model reads YAML
//     structure, not step bodies.
//   - `on: <event>: types:` — a `types:` narrowing is NOT treated as a path
//     filter (it selects PR lifecycle events, not file paths); the pre-existing
//     `missing-synchronize` trap class already covers the one shape that
//     matters there.

/**
 * The fork-guard idiom this repo puts on essentially every job. It is a
 * SECURITY guard (skip PRs from forks, which have no secrets), not a path
 * filter, so it must not make a CI path "filtered".
 */
const FORK_GUARD_RE =
  /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository\s*\|\|\s*github\.event_name\s*!=\s*'pull_request'/g;

/** Status functions that do not narrow which PRs a step runs on. */
const STATUS_FUNCTION_RE = /\b(?:always|success|cancelled|failure)\s*\(\s*\)/g;

/**
 * True when an `if:` expression does NOT narrow the set of pull requests the
 * step/job runs on. Recognized non-filtering shapes: empty/absent, the fork
 * guard above, and the status functions `always()/success()/cancelled()/
 * failure()` (optionally negated), in any `&&`/`||`/paren combination.
 *
 * ANY other expression — notably `needs.changes.outputs.<x> == 'true'`, the
 * `dorny/paths-filter` idiom this repo uses to path-filter a job — is treated
 * as FILTERING. That is deliberately conservative: an unrecognized guard fails
 * the "unfiltered" claim rather than silently passing it.
 *
 * @param {string | null | undefined} expr
 * @returns {boolean}
 */
export function isNonFilteringIf(expr) {
  if (expr === null || expr === undefined) return true;
  let s = String(expr).trim();
  if (s === '') return true;
  s = s.replace(/\$\{\{/g, ' ').replace(/\}\}/g, ' ');
  s = s.replace(FORK_GUARD_RE, ' ');
  s = s.replace(STATUS_FUNCTION_RE, ' ');
  s = s.replace(/[()!\s]/g, '');
  s = s.replace(/&&/g, '').replace(/\|\|/g, '');
  return s === '';
}

/** Collapse whitespace for readable violation text. @param {string} s */
function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/** True for a line that carries no YAML content (blank or comment-only). */
function isNoiseLine(line) {
  return line.trim() === '' || /^\s*#/.test(line);
}

/**
 * The lines strictly more indented than the key at `startIdx` (its block).
 *
 * @param {string[]} lines
 * @param {number} startIdx index OF the key line
 * @param {number} keyIndent indentation of the key line
 * @returns {string[]}
 */
function indentedBlock(lines, startIdx, keyIndent) {
  /** @type {string[]} */
  const block = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isNoiseLine(line)) {
      block.push(line);
      continue;
    }
    if (line.search(/\S/) <= keyIndent) break;
    block.push(line);
  }
  return block;
}

/**
 * The direct child mapping keys of a block — the `key: rest` lines at the
 * block's minimum indentation.
 *
 * @param {string[]} block
 * @returns {{ key: string, rest: string, idx: number, indent: number }[]}
 */
function childKeys(block) {
  let min = Infinity;
  for (const line of block) {
    if (isNoiseLine(line)) continue;
    const ind = line.search(/\S/);
    if (ind >= 0 && ind < min) min = ind;
  }
  if (min === Infinity) return [];
  /** @type {{ key: string, rest: string, idx: number, indent: number }[]} */
  const out = [];
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (isNoiseLine(line)) continue;
    if (line.search(/\S/) !== min) continue;
    const m = line.match(/^\s*["']?([A-Za-z0-9_.-]+)["']?:\s?(.*)$/);
    if (!m) continue;
    out.push({ key: m[1], rest: m[2] ?? '', idx: i, indent: min });
  }
  return out;
}

/** Strip surrounding quotes from a scalar. @param {string} s */
function unquote(s) {
  return s.trim().replace(/^['"]/, '').replace(/['"]$/, '');
}

/**
 * Read a `key:` list value out of a block — either the inline flow form
 * (`paths: [a, b]`) or the block form (`paths:` then `- a`). Returns null when
 * the key is absent (absent ≠ empty: an empty list is still a narrowing).
 *
 * @param {string[]} block
 * @param {string} key
 * @returns {string[] | null}
 */
function readListValue(block, key) {
  const keyRe = new RegExp(`^(\\s*)${key.replace(/[-]/g, '\\-')}:\\s?(.*)$`);
  for (let i = 0; i < block.length; i++) {
    if (isNoiseLine(block[i])) continue;
    const m = block[i].match(keyRe);
    if (!m) continue;
    const rest = (m[2] ?? '').trim();
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      const inner = rest.slice(1, close === -1 ? rest.length : close);
      return inner.split(',').map(unquote).filter((s) => s !== '');
    }
    if (rest !== '' && !rest.startsWith('#')) return [unquote(rest)];
    const keyIndent = (m[1] ?? '').length;
    /** @type {string[]} */
    const items = [];
    for (let j = i + 1; j < block.length; j++) {
      if (isNoiseLine(block[j])) continue;
      const ind = block[j].search(/\S/);
      if (ind <= keyIndent) break;
      const item = block[j].match(/^\s*-\s*(.*)$/);
      if (!item) break;
      items.push(unquote(item[1] ?? ''));
    }
    return items;
  }
  return null;
}

/**
 * @typedef {Object} EventTrigger
 * @property {string[] | null} paths
 * @property {string[] | null} pathsIgnore
 * @property {string[] | null} branches
 * @property {string[] | null} branchesIgnore
 * @property {string[] | null} types
 */

/** An event with no narrowing at all. @returns {EventTrigger} */
function openTrigger() {
  return { paths: null, pathsIgnore: null, branches: null, branchesIgnore: null, types: null };
}

/**
 * Parse a workflow's `on:` block into per-event trigger shapes. Handles the
 * three GitHub forms: `on: push`, `on: [push, pull_request]`, and the block
 * mapping with per-event `paths` / `paths-ignore` / `branches` /
 * `branches-ignore` / `types`.
 *
 * @param {string} text
 * @returns {Record<string, EventTrigger>}
 */
export function parseWorkflowTriggers(text) {
  const lines = text.split('\n');
  let onIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^["']?on["']?:/.test(lines[i])) {
      onIdx = i;
      break;
    }
  }
  if (onIdx === -1) return {};

  /** @type {Record<string, EventTrigger>} */
  const out = {};
  const rest = lines[onIdx].replace(/^["']?on["']?:\s?/, '').trim();

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    const inner = rest.slice(1, close === -1 ? rest.length : close);
    for (const name of inner.split(',').map(unquote).filter((s) => s !== '')) {
      out[name] = openTrigger();
    }
    return out;
  }
  if (rest !== '' && !rest.startsWith('#')) {
    out[unquote(rest)] = openTrigger();
    return out;
  }

  const onBlock = indentedBlock(lines, onIdx, lines[onIdx].search(/\S/));
  for (const child of childKeys(onBlock)) {
    const sub = indentedBlock(onBlock, child.idx, child.indent);
    out[child.key] = {
      paths: readListValue(sub, 'paths'),
      pathsIgnore: readListValue(sub, 'paths-ignore'),
      branches: readListValue(sub, 'branches'),
      branchesIgnore: readListValue(sub, 'branches-ignore'),
      types: readListValue(sub, 'types'),
    };
  }
  return out;
}

/**
 * @typedef {Object} WorkflowStep
 * @property {string | null} name
 * @property {string | null} run
 * @property {string | null} uses
 * @property {string | null} if
 * @property {boolean} continueOnError
 */

/**
 * @typedef {Object} WorkflowJob
 * @property {string} name
 * @property {string | null} if
 * @property {boolean} continueOnError
 * @property {WorkflowStep[]} steps
 */

/** Read a single-line scalar for a child key. @param {{rest: string}} child */
function readScalar(child) {
  const rest = child.rest.trim();
  if (rest === '' || /^[|>][+-]?$/.test(rest)) return null;
  // Strip quotes ONLY when the whole scalar is wrapped in a matching pair —
  // a GitHub `if:` expression routinely ENDS in a quoted literal
  // (`… != 'pull_request'`) and must not lose its trailing quote.
  const wrapped = rest.match(/^(['"])([\s\S]*)\1$/);
  return wrapped ? (wrapped[2] ?? '') : rest;
}

/**
 * Parse a `steps:` block into structured steps.
 *
 * @param {string[]} stepsBlock
 * @returns {WorkflowStep[]}
 */
function parseSteps(stepsBlock) {
  /** @type {WorkflowStep[]} */
  const steps = [];
  for (const item of groupListItems(stepsBlock)) {
    const field = (key) => {
      for (const line of item) {
        const m = line.match(new RegExp(`^\\s*(?:-\\s+)?${key}:\\s?(.*)$`));
        if (m) return (m[1] ?? '').trim();
      }
      return null;
    };
    const coe = field('continue-on-error');
    steps.push({
      name: field('name') === null ? null : unquote(String(field('name'))),
      run: extractRunCommand(item),
      uses: field('uses'),
      if: field('if') === null || field('if') === '' ? null : String(field('if')),
      // Any non-`false` value softens the step; `${{ … }}` expressions are
      // treated as softening (they can evaluate true).
      continueOnError: coe !== null && coe !== '' && !/^false$/i.test(coe),
    });
  }
  return steps;
}

/**
 * Parse a workflow's `jobs:` mapping into structured jobs + steps.
 *
 * @param {string} text
 * @returns {WorkflowJob[]}
 */
export function parseWorkflowJobs(text) {
  const lines = text.split('\n');
  let jobsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^["']?jobs["']?:\s*$/.test(lines[i])) {
      jobsIdx = i;
      break;
    }
  }
  if (jobsIdx === -1) return [];
  const jobsBlock = indentedBlock(lines, jobsIdx, lines[jobsIdx].search(/\S/));
  /** @type {WorkflowJob[]} */
  const jobs = [];
  for (const jobKey of childKeys(jobsBlock)) {
    const jobBlock = indentedBlock(jobsBlock, jobKey.idx, jobKey.indent);
    /** @type {WorkflowJob} */
    const job = { name: jobKey.key, if: null, continueOnError: false, steps: [] };
    for (const child of childKeys(jobBlock)) {
      if (child.key === 'if') {
        job.if = readScalar(child);
      } else if (child.key === 'continue-on-error') {
        const v = child.rest.trim();
        job.continueOnError = v !== '' && !/^false$/i.test(v);
      } else if (child.key === 'steps') {
        job.steps = parseSteps(indentedBlock(jobBlock, child.idx, child.indent));
      }
    }
    jobs.push(job);
  }
  return jobs;
}

/**
 * @typedef {Object} CiPathFilter
 * @property {'no-trigger'|'paths'|'paths-ignore'|'branches'|'branches-ignore'|'step-not-found'|'job-if'|'step-if'} kind
 * @property {string} detail
 */

/**
 * @typedef {Object} CiPathAnalysis
 * @property {string} event
 * @property {boolean} unfiltered
 * @property {CiPathFilter[]} filters
 */

/** The event an "unfiltered CI path" claim is about: fires on every PR. */
export const CI_PATH_EVENT = 'pull_request';

/**
 * Model the path filters guarding a claimed CI path. This is the replacement
 * for the free-text/filename-shape check: the claim is decided against the
 * PARSED trigger + the parsed job/step `if:` gates.
 *
 * @param {string} text  workflow file contents
 * @param {{ stepMatch?: string | null, event?: string }} [options]
 *   `stepMatch` — a plain SUBSTRING (not a regex) matched against each step's
 *   `name` / `run` / `uses`. Omit it to model only the workflow-level trigger.
 * @returns {CiPathAnalysis}
 */
export function analyzeCiPathFilters(text, options = {}) {
  const event = options.event ?? CI_PATH_EVENT;
  const stepMatch = options.stepMatch ?? null;
  /** @type {CiPathFilter[]} */
  const filters = [];

  const trigger = parseWorkflowTriggers(text)[event];
  if (!trigger) {
    filters.push({
      kind: 'no-trigger',
      detail: `workflow declares no \`${event}\` trigger — it never runs on that event`,
    });
  } else {
    if (trigger.paths) {
      filters.push({
        kind: 'paths',
        detail: `on.${event}.paths narrows to [${trigger.paths.join(', ')}]`,
      });
    }
    if (trigger.pathsIgnore) {
      filters.push({
        kind: 'paths-ignore',
        detail: `on.${event}.paths-ignore excludes [${trigger.pathsIgnore.join(', ')}]`,
      });
    }
    if (trigger.branches) {
      filters.push({
        kind: 'branches',
        detail: `on.${event}.branches narrows to [${trigger.branches.join(', ')}]`,
      });
    }
    if (trigger.branchesIgnore) {
      filters.push({
        kind: 'branches-ignore',
        detail: `on.${event}.branches-ignore excludes [${trigger.branchesIgnore.join(', ')}]`,
      });
    }
  }

  if (stepMatch) {
    /** @type {CiPathFilter[][]} */
    const perHost = [];
    for (const job of parseWorkflowJobs(text)) {
      for (const step of job.steps) {
        const haystack = `${step.name ?? ''}\n${step.run ?? ''}\n${step.uses ?? ''}`;
        if (!haystack.includes(stepMatch)) continue;
        /** @type {CiPathFilter[]} */
        const gates = [];
        if (!isNonFilteringIf(job.if)) {
          gates.push({
            kind: 'job-if',
            detail: `job '${job.name}' is gated by \`if: ${collapse(String(job.if))}\``,
          });
        }
        if (!isNonFilteringIf(step.if)) {
          gates.push({
            kind: 'step-if',
            detail:
              `step '${step.name ?? '(unnamed)'}' in job '${job.name}' is gated by ` +
              `\`if: ${collapse(String(step.if))}\``,
          });
        }
        perHost.push(gates);
      }
    }
    if (perHost.length === 0) {
      filters.push({
        kind: 'step-not-found',
        detail: `no step matches ${JSON.stringify(stepMatch)} — this workflow does not run it`,
      });
    } else if (!perHost.some((gates) => gates.length === 0)) {
      // Every host is gated; report the first host's gates.
      filters.push(...perHost[0]);
    }
  }

  return { event, unfiltered: filters.length === 0, filters };
}

// ─── Reachability across all workflows ──────────────────────────────────────

/**
 * @param {Record<string, string>} workflows  path → file text
 * @param {Record<string, string>} scripts    npm-script name → command
 * @returns {Map<string, Map<string, { reachable: boolean, failable: boolean }>>}
 *          primaryPath → (workflowPath → {reachable, failable})
 */
export function computeReachability(workflows, scripts) {
  /** @type {Map<string, Map<string, { reachable: boolean, failable: boolean }>>} */
  const byPrimary = new Map();
  for (const [wfPath, text] of Object.entries(workflows)) {
    const { runSteps } = parseWorkflow(text);
    for (const step of runSteps) {
      const sub = reachPrimariesFromCommand(step.command, scripts);
      for (const [primary, info] of sub) {
        const failable = info.failable && !step.continueOnError;
        if (!byPrimary.has(primary)) byPrimary.set(primary, new Map());
        const perWf = byPrimary.get(primary);
        const cur = perWf.get(wfPath);
        if (!cur) perWf.set(wfPath, { reachable: true, failable });
        else cur.failable = cur.failable || failable;
      }
    }
  }
  return byPrimary;
}

/**
 * Is a primary directly referenced by ANY npm-script body? Used to distinguish
 * the "unreachable-npm" trap (referenced in package.json but not run by a
 * workflow) from a true orphan (referenced nowhere).
 *
 * @param {string} primary
 * @param {Record<string, string>} scripts
 * @returns {boolean}
 */
function referencedByAnyNpmScript(primary, scripts) {
  for (const body of Object.values(scripts)) {
    for (const ref of analyzeCommandRefs(body)) {
      if (ref.type === 'script' && ref.path === primary) return true;
    }
  }
  return false;
}

// ─── Audit ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ManifestEntry
 * @property {string} script
 * @property {'gating'|'advisory'|'retired'} disposition
 * @property {string} [workflow]
 * @property {boolean} [diffDependent]
 * @property {boolean} [unfilteredCiPath]  claim: `workflow` runs this primary on
 *   an UNFILTERED CI path (fires on every PR). Verified against the parsed
 *   trigger + job/step `if:` gates by {@link analyzeCiPathFilters}. Omit the
 *   key to make no claim.
 * @property {string} [ciStepMatch]  substring locating the hosting step when
 *   verifying `unfilteredCiPath` (defaults to `script`).
 * @property {string} [rationale]
 */

/**
 * Pure audit. All inputs are in-memory so this is directly unit-testable with
 * synthetic trap-class fixtures.
 *
 * @param {{
 *   manifest: { primaries: ManifestEntry[] },
 *   scripts: Record<string, string>,
 *   workflows: Record<string, string>,
 *   primaryFiles: string[],
 * }} input
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function audit({ manifest, scripts, workflows, primaryFiles }) {
  /** @type {string[]} */
  const violations = [];

  if (!manifest || !Array.isArray(manifest.primaries)) {
    return {
      ok: false,
      violations: ['manifest: missing or non-array `primaries`'],
    };
  }

  const reachability = computeReachability(workflows, scripts);
  const onDisk = new Set(primaryFiles);
  const listed = new Set();

  for (const entry of manifest.primaries) {
    const p = entry.script;
    if (!p || typeof p !== 'string') {
      violations.push(`manifest entry missing \`script\`: ${JSON.stringify(entry)}`);
      continue;
    }
    listed.add(p);

    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      violations.push(
        `${p}  [unknown-disposition]  "${entry.disposition}" (expected gating|advisory|retired)`,
      );
      continue;
    }

    const perWf = reachability.get(p) ?? new Map();
    const failableWorkflows = [...perWf.entries()]
      .filter(([, v]) => v.failable)
      .map(([w]) => w);
    const reachableWorkflows = [...perWf.keys()];

    // ── DR-15: an "unfiltered CI path" claim is VERIFIED, not asserted. ──
    // Previously the only thing standing behind this claim anywhere in the
    // repo was a filename-shaped string. Now the workflow's trigger and the
    // hosting job/step `if:` gates decide it.
    if (entry.unfilteredCiPath === true) {
      if (!entry.workflow) {
        violations.push(
          `${p}  [unfiltered-path-unverifiable]  claims an unfiltered CI path but names no \`workflow\``,
        );
      } else if (!(entry.workflow in workflows)) {
        violations.push(
          `${p}  [unfiltered-path-unverifiable]  claims an unfiltered CI path in "${entry.workflow}", ` +
            `which is not present in the workflow set`,
        );
      } else {
        const analysis = analyzeCiPathFilters(workflows[entry.workflow], {
          stepMatch: entry.ciStepMatch ?? p,
        });
        if (!analysis.unfiltered) {
          violations.push(
            `${p}  [filtered-ci-path]  claims an unfiltered CI path in ${entry.workflow} but the ` +
              `${analysis.event} lane is filtered: ` +
              analysis.filters.map((f) => `${f.kind} — ${f.detail}`).join('; '),
          );
        }
      }
    }

    if (entry.disposition === 'gating') {
      if (!entry.workflow) {
        violations.push(`${p}  [missing-workflow]  a gating entry must name its \`workflow\``);
        continue;
      }
      if (!(entry.workflow in workflows)) {
        violations.push(
          `${p}  [unknown-workflow]  names "${entry.workflow}", not present in the workflow set`,
        );
        continue;
      }
      if (!onDisk.has(p)) {
        violations.push(`${p}  [missing-file]  gating entry points at a file that does not exist`);
        continue;
      }
      if (failableWorkflows.length === 0) {
        if (reachableWorkflows.length > 0) {
          violations.push(
            `${p}  [exit-code-swallowed]  reachable from ${reachableWorkflows.join(', ')} but its ` +
              `exit code is swallowed (\`|| true\` or continue-on-error) — it can never fail CI`,
          );
        } else if (referencedByAnyNpmScript(p, scripts)) {
          violations.push(
            `${p}  [unreachable-npm]  referenced only from an npm script that no workflow invokes ` +
              `(e.g. \`npm run validate\`) — a real regression would pass CI`,
          );
        } else {
          violations.push(
            `${p}  [orphan]  no workflow references it at all — declared gating but never runs`,
          );
        }
        continue;
      }
      if (!failableWorkflows.includes(entry.workflow)) {
        violations.push(
          `${p}  [wrong-workflow]  reachable-and-failable from ${failableWorkflows.join(', ')} ` +
            `but the manifest claims ${entry.workflow}`,
        );
        continue;
      }
      if (entry.diffDependent) {
        const pr = parseWorkflow(workflows[entry.workflow]).pullRequest;
        const hasSync =
          pr.present && (pr.types === null || pr.types.includes('synchronize'));
        if (!hasSync) {
          violations.push(
            `${p}  [missing-synchronize-trigger]  diff-dependent gate in ${entry.workflow}, whose ` +
              `pull_request trigger omits \`synchronize\` — a diff pushed after open leaves a stale green`,
          );
        }
      }
      continue;
    }

    if (entry.disposition === 'advisory') {
      if (!entry.rationale || !entry.rationale.trim()) {
        violations.push(`${p}  [missing-rationale]  advisory entries must record why they are non-blocking`);
      }
      if (!onDisk.has(p)) {
        violations.push(`${p}  [missing-file]  advisory entry points at a file that does not exist`);
      } else if (reachableWorkflows.length === 0) {
        violations.push(
          `${p}  [advisory-orphan]  labeled advisory but no workflow references it — an advisory ` +
            `label must not hide a true orphan`,
        );
      }
      continue;
    }

    // retired
    if (!entry.rationale || !entry.rationale.trim()) {
      violations.push(`${p}  [missing-rationale]  retired entries must record why they were retired`);
    }
    if (failableWorkflows.length > 0) {
      violations.push(
        `${p}  [retired-still-wired]  retired but still reachable-and-failable from ` +
          `${failableWorkflows.join(', ')} — retiring a live enforcer is a wiring lie`,
      );
    }
  }

  // Completeness: every primary on disk must be dispositioned.
  for (const p of onDisk) {
    if (!listed.has(p)) {
      violations.push(
        `${p}  [unlisted-primary]  present on disk but absent from the manifest — add a disposition`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

// ─── Filesystem adapters (used only by the CLI) ─────────────────────────────

/** @param {string} scriptsDir @returns {string[]} repo-relative primary paths */
export function enumeratePrimaryFiles(scriptsDir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(scriptsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/^(check|lint)-.+\.(mjs|sh)$/.test(e.name)) continue;
    if (/\.test\.(mjs|sh)$/.test(e.name)) continue;
    out.push(`scripts/${e.name}`);
  }
  return out.sort();
}

/** @param {string} dir @returns {Record<string, string>} repo-rel path → text */
function loadWorkflows(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !/\.ya?ml$/.test(e.name)) continue;
    out[`.github/workflows/${e.name}`] = readFileSync(path.join(dir, e.name), 'utf8');
  }
  return out;
}

// ─── CLI main ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let manifestPath = path.join(SCRIPT_DIR, 'enforcer-wiring-manifest.json');
  let repoRoot = REPO_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') {
      const v = argv[++i];
      if (!v) return { error: '--manifest requires a path' };
      manifestPath = path.resolve(v);
    } else if (argv[i] === '--repo-root') {
      const v = argv[++i];
      if (!v) return { error: '--repo-root requires a path' };
      repoRoot = path.resolve(v);
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      return { help: true };
    } else {
      return { error: `unrecognized argument: ${argv[i]}` };
    }
  }
  return { manifestPath, repoRoot };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node tools/audit/gates/check-enforcer-wiring.mjs [--manifest <path>] [--repo-root <path>]',
      '',
      'Verifies every scripts/check-*|lint-* primary is dispositioned in the manifest and',
      'that each disposition holds under a transitive walk of npm chains + CI workflows.',
      '',
      'Exit codes: 0 clean, 1 violations / tool failure (fail closed), 2 usage error.',
      '',
    ].join('\n'),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.error) {
    process.stderr.write(`check-enforcer-wiring: ${args.error}\n`);
    return 2;
  }

  const { manifestPath, repoRoot } = args;

  // Tool/manifest-parse failure = FAIL (exit 1), so a broken gate fails CI
  // rather than silently passing.
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`check-enforcer-wiring: cannot read/parse manifest ${manifestPath}: ${msg}\n`);
    return 1;
  }

  let scripts;
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`check-enforcer-wiring: cannot read/parse package.json: ${msg}\n`);
    return 1;
  }

  let result;
  try {
    const workflows = loadWorkflows(path.join(repoRoot, '.github', 'workflows'));
    const primaryFiles = enumeratePrimaryFiles(path.join(repoRoot, 'tools', 'audit', 'gates'));
    result = audit({ manifest, scripts, workflows, primaryFiles });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`check-enforcer-wiring: internal error: ${msg}\n`);
    return 1;
  }

  if (!result.ok) {
    process.stderr.write(
      `check-enforcer-wiring: ${result.violations.length} violation(s):\n` +
        result.violations.map((v) => `  ${v}`).join('\n') +
        '\n',
    );
    return 1;
  }
  process.stdout.write(
    `check-enforcer-wiring: clean — ${manifest.primaries.length} primaries dispositioned.\n`,
  );
  return 0;
}

const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return (
      argv1 === fileURLToPath(import.meta.url) ||
      argv1.endsWith('/check-enforcer-wiring.mjs') ||
      argv1.endsWith('\\check-enforcer-wiring.mjs')
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main());
}
