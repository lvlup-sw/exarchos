import { default as yaml } from 'js-yaml';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.js';

export const AGGREGATOR_JOB = 'ci-gate';
/** The workflow that hosts the aggregator. */
export const CI_WORKFLOW = '.github/workflows/ci.yml';

// ─── Workflow model ──────────────────────────────────────────────────────────

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

export function needsList(job: WorkflowJob | undefined): string[] {
  const needs = job?.needs;
  if (needs === undefined) return [];
  // Discriminated on `typeof`, not `Array.isArray`: the latter does not narrow a
  // `readonly string[]` out of the union, and widening it back with an assertion
  // would spend cast budget to work around a check that already holds.
  return typeof needs === 'string' ? [needs] : [...needs];
}

/**
 * The `changes.outputs.<key>` set a job's `if:` gates on, parsed out of the raw
 * `if:` text. Never a hardcoded job→key table — the same derivation
 * `tests/scripts/ci-topology.test.ts` uses, for the same reason.
 */
export function pathFilterKeys(job: WorkflowJob | undefined): string[] {
  const ifText = job?.if ?? '';
  const pattern = /needs\.changes\.outputs\.([A-Za-z0-9_-]+)/g;
  const keys = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ifText)) !== null) {
    const key = match[1];
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

/** Recovers the `dorny/paths-filter` glob lists from the `changes` job. */
export function pathFilterGlobs(workflow: Workflow): Record<string, string[]> {
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

// ─── npm-script expansion ────────────────────────────────────────────────────
