import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { default as ts } from 'typescript';
import { REPO_ROOT } from './paths.js';

export type SuiteId = 'root';

export interface VitestProject {
  /** The project's declared `name`, or `'default'` for a config with one unnamed suite. */
  readonly name: string;
  readonly includes: readonly string[];
}

/**
 * The vitest PROJECTS a config declares, by PARSE.
 *
 * Two things make the naive version wrong, and both bit this module before the
 * project axis existed:
 *
 *   1. Only the `include` sitting DIRECTLY on a `test:` object is a suite glob.
 *      Both configs also carry `coverage: { include: ['src/**' + '/*.ts'] }` and
 *      `benchmark: { include: [...] }`; folding those in makes every source file
 *      look like a collected test.
 *   2. The project NAME matters, because `npm run test:process` expands to
 *      `vitest run --project process` — which runs the `process` project ONLY.
 *      Without the name, the `e2e-process` and `outcome-tests` jobs read as hosts
 *      of every root-suite test, and a genuinely filtered guard reads as covered
 *      by an unfiltered job that never runs it.
 *
 * A regex would also read the globs out of the long explanatory comments that
 * surround them in both files.
 */
export function parseVitestProjects(source: string, fileName: string): VitestProject[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: VitestProject[] = [];
  const directProperty = (object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name;
      const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
      if (text === key) return property.initializer;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'test') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'test')) &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const includeNode = directProperty(node.initializer, 'include');
      if (includeNode !== undefined && ts.isArrayLiteralExpression(includeNode)) {
        const includes: string[] = [];
        for (const element of includeNode.elements) {
          if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
            includes.push(element.text);
          }
        }
        const nameNode = directProperty(node.initializer, 'name');
        const name =
          nameNode !== undefined && (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode))
            ? nameNode.text
            : 'default';
        out.push({ name, includes });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return out;
}

/** `--project X` / `--project=X` selectors on a vitest invocation tail. */
export function vitestProjectSelectors(tail: string): string[] {
  const out: string[] = [];
  const re = /--project(?:=|\s+)([A-Za-z0-9._-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tail)) !== null) {
    const name = match[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}

/**
 * Minimal glob matcher for the shapes the two vitest configs and the
 * `dorny/paths-filter` lists actually use (`dir/**` + `/*.test.ts`, `src/**`,
 * `AGENTS.md`). `**` crosses path separators, `*` does not, and `a/**` + `/b`
 * also matches `a/b` because the middle segment is optional.
 *
 * Tokenising the glob — rather than running a chain of `String.replace` passes
 * over a half-built pattern — is what keeps a metacharacter produced by an
 * EARLIER substitution from being re-consumed by a later one, which is the
 * classic way a hand-rolled glob compiler quietly starts matching the wrong
 * thing.
 */
export function globMatches(glob: string, path: string): boolean {
  let pattern = '';
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      pattern += '(?:.*/)?';
      index += 3;
    } else if (glob.startsWith('**', index)) {
      pattern += '.*';
      index += 2;
    } else if (glob[index] === '*') {
      pattern += '[^/]*';
      index += 1;
    } else {
      const ch = glob[index] ?? '';
      pattern += /[.+^${}()|[\]\\?]/.test(ch) ? `\\${ch}` : ch;
      index += 1;
    }
  }
  return new RegExp(`^${pattern}$`).test(path);
}

export interface SuiteConfig {
  readonly id: SuiteId;
  /** Repo-relative directory the vitest config lives in (`''` for the root). */
  readonly dir: string;
  readonly projects: readonly VitestProject[];
}

export function loadSuiteConfigs(repoRoot: string = REPO_ROOT): SuiteConfig[] {
  const read = (dir: string): VitestProject[] => {
    const file = join(repoRoot, dir, 'vitest.config.ts');
    const projects = parseVitestProjects(readFileSync(file, 'utf8'), `${dir}/vitest.config.ts`);
    if (projects.length === 0) {
      // Fail closed: a config the parser cannot read must not contribute an
      // empty project set, which would silently unhost every co-located test.
      throw new Error(`${dir || '.'}/vitest.config.ts: parsed zero vitest projects`);
    }
    return projects;
  };
  return [{ id: 'root', dir: '', projects: read('') }];
}

/** Which vitest suite + project(s) collect a repo-relative test path. */
export interface SuiteMembership {
  readonly suite: SuiteId;
  readonly projects: readonly string[];
}

export function suiteForTest(testPath: string, suites: readonly SuiteConfig[]): SuiteMembership | null {
  // Longest package dir first, so an MCP test is never claimed by the root suite.
  const ordered = [...suites].sort((a, b) => b.dir.length - a.dir.length);
  for (const suite of ordered) {
    const prefix = suite.dir === '' ? '' : `${suite.dir}/`;
    if (!testPath.startsWith(prefix)) continue;
    const relative = testPath.slice(prefix.length);
    if (suite.dir === '' && relative.startsWith('servers/')) continue;
    const projects = suite.projects
      .filter((project) => project.includes.some((glob) => globMatches(glob, relative)))
      .map((project) => project.name);
    if (projects.length > 0) return { suite: suite.id, projects };
  }
  return null;
}

// ─── Hosting resolution ──────────────────────────────────────────────────────
