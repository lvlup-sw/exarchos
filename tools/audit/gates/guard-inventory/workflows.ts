import { default as yaml } from 'js-yaml';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.js';

/** The aggregator job. In the CI workflow, only a job that it needs can fail a PR. */
export const AGGREGATOR_JOB = 'ci-gate';
/** The workflow that hosts the aggregator. */
export const CI_WORKFLOW = '.github/workflows/ci.yml';
/** The manifest of the org `ci-lanes` action. It holds the path globs of each lane. */
const CI_LANES_MANIFEST = '.github/ci-lanes.toml';
/** The lane that matches each path. The inventory reads a job on this lane as unfiltered. */
const ALWAYS_LANE = 'always';

export interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly 'working-directory'?: string;
  readonly 'continue-on-error'?: boolean | string;
}

export interface WorkflowJob {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly steps?: readonly WorkflowStep[];
  readonly defaults?: { readonly run?: { readonly 'working-directory'?: string } };
  readonly 'continue-on-error'?: boolean | string;
}

export interface Workflow {
  readonly on?: unknown;
  readonly jobs?: Record<string, WorkflowJob>;
}

/** A workflow file plus its repo-relative path. */
export interface LoadedWorkflow {
  readonly path: string;
  readonly doc: Workflow;
}

export function parseWorkflow(path: string, raw: string): LoadedWorkflow {
  const loaded: unknown = yaml.load(raw);
  if (loaded === null || typeof loaded !== 'object') {
    throw new Error(`${path}: workflow did not parse to an object`);
  }
  const doc: Workflow = loaded;
  if (doc.jobs === undefined || typeof doc.jobs !== 'object') {
    throw new Error(`${path}: parsed workflow has no top-level "jobs" map`);
  }
  return { path, doc };
}

/** Loads every `.yml`/`.yaml` under `.github/workflows`. Fails closed on an unreadable dir. */
export function loadWorkflows(repoRoot: string = REPO_ROOT): LoadedWorkflow[] {
  const dir = join(repoRoot, '.github', 'workflows');
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: LoadedWorkflow[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const rel = `.github/workflows/${entry.name}`;
    out.push(parseWorkflow(rel, readFileSync(join(dir, entry.name), 'utf8')));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The `needs` of a job as a list. The check uses `typeof`, because
 * `Array.isArray` does not narrow a `readonly string[]` out of the union.
 */
export function needsList(job: WorkflowJob | undefined): string[] {
  const needs = job?.needs;
  if (needs === undefined) return [];
  return typeof needs === 'string' ? [needs] : [...needs];
}

/**
 * The lane keys a job's `if:` gates on, parsed out of the raw `if:` text.
 * Accepts both the ci-lanes canonical skip
 * (`fromJSON(needs.plan.outputs.lanes).<lane>`) and the retired
 * `needs.changes.outputs.<key>` form used by fixtures. Lane `always` is
 * omitted: it matches every path, so it is not a skip-as-passed filter.
 */
export function pathFilterKeys(job: WorkflowJob | undefined): string[] {
  const ifText = job?.if ?? '';
  const keys = new Set<string>();
  const patterns = [
    /fromJSON\(\s*needs\.plan\.outputs\.lanes\s*\)\.([A-Za-z0-9_]+)/g,
    /needs\.changes\.outputs\.([A-Za-z0-9_-]+)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(ifText)) !== null) {
      const key = match[1];
      if (key !== undefined && key !== ALWAYS_LANE) keys.add(key);
    }
  }
  return [...keys].sort();
}

/** Recovers lane glob lists from `.github/ci-lanes.toml`, with a dorny fallback. */
export function pathFilterGlobs(workflow: Workflow, repoRoot: string = REPO_ROOT): Record<string, string[]> {
  const fromManifest = lanePathsFromManifest(repoRoot);
  if (Object.keys(fromManifest).length > 0) return fromManifest;

  const job = workflow.jobs?.['changes'];
  const filterStep = (job?.steps ?? []).find(
    (s) => typeof s.uses === 'string' && s.uses.startsWith('dorny/paths-filter'),
  );
  const raw = filterStep?.with?.['filters'];
  if (typeof raw !== 'string') return {};
  const parsed: unknown = yaml.load(raw);
  if (parsed === null || typeof parsed !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      out[key] = value.filter((v): v is string => typeof v === 'string');
    }
  }
  return out;
}

/** Parses `[lanes.<key>].paths` out of the ci-lanes manifest. */
export function lanePathsFromManifest(repoRoot: string = REPO_ROOT): Record<string, string[]> {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, CI_LANES_MANIFEST), 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  let inPaths = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '');
    const table = /^\[lanes\.([a-z][a-z0-9_]*)\]\s*$/.exec(line);
    if (table) {
      current = table[1] ?? null;
      inPaths = false;
      if (current && out[current] === undefined) out[current] = [];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      inPaths = false;
      continue;
    }
    if (current === null) continue;
    const inline = /^\s*paths\s*=\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      out[current] = quotedStrings(inline[1] ?? '');
      inPaths = false;
      continue;
    }
    if (/^\s*paths\s*=\s*\[\s*$/.test(line)) {
      out[current] = [];
      inPaths = true;
      continue;
    }
    if (inPaths) {
      if (/^\s*\]\s*$/.test(line)) {
        inPaths = false;
        continue;
      }
      out[current]?.push(...quotedStrings(line));
    }
  }
  return out;
}

function quotedStrings(fragment: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment)) !== null) {
    const value = match[1];
    if (value !== undefined && value !== '') values.push(value);
  }
  return values;
}
