/** Verify the shipped local authoring path and its typed handoff. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { collectCanonicalSkillSet } from '../../src/install/install-skills.js';
import { prepareActions } from '../../src/registry/actions/orchestrate/prepare.js';
import { evaluatePlanCoverage, evaluatePlanExploration } from '../../src/workflow/design-record/plan-checks.js';
import { PrepareIntentSchema } from '../../src/verbs/prepare/intent.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { validateDesignRecord } from '../../src/workflow/design-record/validate.js';
import { extractSites } from '../../tools/audit/core/call-shape/extract.js';
import { readLiveCallShapeInputs } from '../../tools/audit/core/call-shape/measure.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTENT = path.join(ROOT, 'content');
const RENDERED = path.join(ROOT, 'rendered');
const AUTHORING = ['ideate', 'plan'];
const AUTHORING_FILES = [
  'ideate/SKILL.md',
  'ideate/references/constraint-anchoring.md',
  'ideate/references/design-template.md',
  'ideate/references/worked-example.md',
  'plan/SKILL.md',
  'plan/references/rationalization-refutation.md',
  'plan/references/spec-template.md',
  'plan/references/spec-tracing-guide.md',
  'plan/references/task-template.md',
  'plan/references/testing-strategy-guide.md',
  'plan/references/worked-example.md',
];
const DELEGATE = path.join(CONTENT, 'delivery/skills/delegate');
const DELEGATE_RECIPES = ['SKILL.md', 'references/worked-example.md', 'references/workflow-steps.md'];
const registry = readLiveCallShapeInputs(ROOT).registry;
const prepare = prepareActions.find((action) => action.name === 'prepare');
const DESIGN_REF = 'docs/specs/2026-02-28-add-email-validation.md';

const READ_ONLY_CITATION = /^(?:https?:|#|\.?\/?(?:docs|\.exarchos)\/)/;
const PROSE_RECIPE = /\b(?:ask|assign|delegate|dispatch|have|call|run|invoke|execute|use)\b[^.!?\n]{0,160}\b(?:(?:exarchos[_ -])?workflow[_ .:-]+(?:init|get|update|checkpoint|transition|describe)|(?:initialize|init|update|checkpoint|transition|start)\b[^.!?\n]{0,40}\b(?:the\s+)?(?:exarchos\s+)?(?:workflow|stream|phase)|check_[a-z_]+)\b/i;
const CLI_RECIPE = /\bexarchos\s+(?:workflow|orchestrate|event|view|prepare|settle)\b/;
const MCP_METADATA = /^\s*mcp-server:\s*exarchos\s*$/m;

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function sourceSkills(): Map<string, string> {
  const index = new Map<string, string>([['_shared', path.join(CONTENT, '_shared')]]);
  for (const domain of readdirSync(CONTENT)) {
    const base = path.join(CONTENT, domain, 'skills');
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const directory = path.join(base, name);
      if (existsSync(path.join(directory, 'SKILL.md'))) index.set(name, directory);
    }
  }
  return index;
}

/** Resolve the references and skill invocations that a reader can follow. */
function edges(file: string, markdown: string, skills: ReadonlyMap<string, string>): string[] {
  const refs = new Set<string>();
  const skillDir = (name: string): string => skills.get(name) ?? path.join('missing-skill', name);
  for (const [, name, relative] of markdown.matchAll(/@skills\/([\w-]+)\/([\w./-]+\.md)\b/g)) {
    if (name !== undefined && relative !== undefined) refs.add(path.join(skillDir(name), relative));
  }
  for (const [, target] of markdown.matchAll(/\]\((?!@skills\/)([^\s)#]+\.md)(?:#[^\s)]*)?\)/g)) {
    if (target !== undefined && !READ_ONLY_CITATION.test(target)) refs.add(path.resolve(path.dirname(file), target));
  }
  for (const [, target] of markdown.matchAll(/`((?:references\/)?[\w.-]+\.md)`/g)) {
    if (target !== undefined) refs.add(path.resolve(path.dirname(file), target));
  }
  for (const match of markdown.matchAll(/\{\{CHAIN next="([\w-]+)"|skill:\s*"exarchos:([\w-]+)"|Invoke the exarchos:([\w-]+) skill|Invoke the `([\w-]+)` skill/gi)) {
    const name = match.slice(1).find(Boolean);
    if (name !== undefined) refs.add(path.join(skillDir(name), 'SKILL.md'));
  }
  for (const [, name] of markdown.matchAll(/(?:\/exarchos:|\{\{COMMAND_PREFIX\}\})([\w-]+)/g)) {
    if (name !== undefined) refs.add(path.join(skillDir(name), 'SKILL.md'));
  }
  return [...refs];
}

function inspect(roots: readonly string[], skills: ReadonlyMap<string, string>) {
  const visited = new Set<string>();
  const findings: string[] = [];
  const pending = [...roots];
  for (const file of pending) {
    if (visited.has(file)) continue;
    visited.add(file);
    if (!existsSync(file)) {
      findings.push(`${file}: unresolved authoring reference`);
      continue;
    }
    const markdown = read(file);
    for (const site of extractSites(markdown, registry)) {
      if (site.status !== 'harness') findings.push(`${file}:${site.line}: ${site.call}`);
    }
    for (const recipe of [PROSE_RECIPE, CLI_RECIPE, MCP_METADATA]) {
      const match = recipe.exec(markdown);
      if (match) findings.push(`${file}: ${match[0]}`);
    }
    pending.push(...edges(file, markdown, skills));
  }
  return { visited, findings };
}

function commandPaths(directory: string) {
  return AUTHORING.map((name) => path.join(directory, `${name}.md`));
}

function assertAuthoringGraph(roots: readonly string[], skills: ReadonlyMap<string, string>) {
  const expected = AUTHORING_FILES.map((file) => {
    const [name, ...relative] = file.split('/');
    if (name === undefined) throw new Error(`Expected a skill path: ${file}`);
    const directory = skills.get(name);
    if (directory === undefined) throw new Error(`Missing authoring skill: ${name}`);
    return path.join(directory, ...relative);
  });
  const { visited, findings } = inspect(roots, skills);
  expect(findings).toEqual([]);
  expect([...visited].sort()).toEqual([...roots, ...expected].sort());
}

it('Authoring_AllReferencedPlanPaths_HaveZeroExarchosCalls', () => {
  const canonical = sourceSkills();
  assertAuthoringGraph(commandPaths(path.join(CONTENT, 'design/commands')), canonical);
  const runtimeNames = readdirSync(path.join(CONTENT, 'harness/runtimes'))
    .filter((file) => file.endsWith('.yaml')).map((file) => path.basename(file, '.yaml'));
  expect(runtimeNames).toEqual(['claude', 'codex', 'copilot', 'cursor', 'generic', 'opencode']);
  for (const runtime of runtimeNames) {
    const installed = collectCanonicalSkillSet(path.join(RENDERED, 'skills'), runtime);
    const skills = new Map(installed.map(({ name, dir }) => [name, dir]));
    const aliases = path.join(RENDERED, 'command-aliases', runtime);
    const roots = commandPaths(path.join(RENDERED, 'commands'));
    if (existsSync(aliases)) roots.push(...commandPaths(aliases));
    assertAuthoringGraph(roots, skills);
    const ideate = read(path.join(skills.get('ideate') ?? '', 'SKILL.md'));
    expect(ideate).toMatch(/(?:args: "|with args: )\$SPEC_PATH \$DESIGN_DEPTH/);
    for (const file of AUTHORING_FILES.filter((file) => file.includes('/references/'))) {
      const [name, ...relative] = file.split('/');
      expect(read(path.join(skills.get(name ?? '') ?? '', ...relative))).toBe(
        read(path.join(canonical.get(name ?? '') ?? '', ...relative)),
      );
    }
  }
});

function templateFences(source: string, marker: string, language: string) {
  const fence = new RegExp(`^${marker}${language}\\n([\\s\\S]*?)\\n${marker}$`, 'gm');
  return [...source.matchAll(fence)].map((match) => match[1] ?? '');
}

function authoredMarkdown(): string {
  const references = path.join(CONTENT, 'design/skills/plan/references');
  const [spec] = templateFences(read(path.join(references, 'spec-template.md')), '````', 'markdown');
  const tasks = templateFences(read(path.join(references, 'task-template.md')), '```', 'json');
  expect(tasks).toHaveLength(2);
  if (!spec?.includes('__TASK_OBJECTS__')) throw new Error('The spec template needs a task insertion marker.');
  return spec.replace('[Feature Name]', 'Validate imports').replace('__TASK_OBJECTS__', tasks.join(',\n    '));
}

function typedSnapshot(markdown: string) {
  const parsed = readDesignRecord(Buffer.from(markdown), DESIGN_REF);
  if (parsed.kind !== 'typed') throw new Error(`Expected typed Markdown: ${JSON.stringify(parsed)}`);
  return parsed.snapshot;
}

it('Templates_AuthoredTypedExample_Parses', () => {
  const deep = authoredMarkdown();
  const standard = deep.replace(/^### Exploration\n[\s\S]*?(?=^### Alternatives)/m, '');
  const thin = standard.replace(/^### Chosen Approach\n[\s\S]*?(?=^### DR-1)/m, '')
    .replace(/^### Technical Design\n[\s\S]*?(?=^## Decomposition)/m, '');
  expect(new Set([deep, standard, thin]).size).toBe(3);
  for (const markdown of [thin, standard, deep]) {
    const snapshot = typedSnapshot(markdown);
    expect(validateDesignRecord(snapshot).passed).toBe(true);
    expect(snapshot.requirements).toEqual(['DR-1', 'DR-2']);
    expect(snapshot.definitions.map(({ id }) => id)).toEqual(snapshot.requirements);
    expect(snapshot.tasks.map(({ span: _span, ...task }) => task)).toEqual([
      {
        id: 'T-01', title: 'Validate required fields', implements: ['DR-1'], blockedBy: [],
        files: ['src/import/validate.ts'], testFiles: ['tests/acceptance/import-required.test.ts'],
        riskTier: 'medium', boundaryTouching: false, testLayer: 'acceptance', parallelizable: true,
        acceptance: ['Report the first missing required field before writing the record.'],
        instructions: 'Validate required fields before any persistence. Cover a record with a missing field.',
      },
      {
        id: 'T-02', title: 'Reject duplicate identifiers', implements: ['DR-2'], blockedBy: ['T-01'],
        files: ['src/import/import.ts'], testFiles: ['tests/integration/import-duplicates.test.ts'],
        riskTier: 'high', boundaryTouching: true, testLayer: 'integration', parallelizable: false,
        acceptance: ['Report a duplicate identifier and persist only the first record.'],
        instructions: 'Reuse the required-field validator. Verify the import boundary with two records that share an identifier.',
      },
    ]);
    expect(evaluatePlanCoverage(snapshot).edges).toEqual([
      { requirementId: 'DR-1', taskId: 'T-01' }, { requirementId: 'DR-2', taskId: 'T-02' },
    ]);
    expect(evaluatePlanExploration(snapshot).passed).toBe(markdown === deep);
  }
  const secondFence = '\n```exarchos-plan-v1\n{}\n```\n';
  expect(readDesignRecord(Buffer.from(deep + secondFence), DESIGN_REF).kind).toBe('invalid');
  const demonstration = '\n> ```exarchos-plan-v1\n> {}\n> ```\n';
  expect(typedSnapshot(deep + demonstration).tasks).toHaveLength(2);
  expect(typedSnapshot(deep + '\n ').digest).not.toBe(typedSnapshot(deep).digest);
});

const initialBytes = authoredMarkdown();
const editedBytes = initialBytes.replace('persists them.', 'persists or indexes them.');
const sha256 = (markdown: string) => createHash('sha256').update(markdown).digest('hex');
const digests = new Map([
  ['approvedFileSha256', sha256(initialBytes)],
  ['approvedCurrentFileSha256', sha256(editedBytes)],
]);

/** Read only literal objects and the digest inputs of the recipe. */
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && digests.has(node.text)) return digests.get(node.text);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(node.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
        throw new Error(`Expected a named recipe field: ${property.getText()}`);
      }
      return [property.name.text, literal(property.initializer)];
    }));
  }
  throw new Error(`Expected literal recipe input: ${node.getText()}`);
}

function recipes(relative: string) {
  if (prepare === undefined) throw new Error('Missing registered prepare schema.');
  const source = read(path.join(DELEGATE, relative));
  const blocks = templateFences(source, '```', 'typescript').filter((block) => block.includes('action: "prepare"'));
  expect(blocks).toHaveLength(2);
  return blocks.map((block) => {
    const file = ts.createSourceFile(relative + '.ts', block, ts.ScriptTarget.Latest, true);
    const [statement] = file.statements;
    if (file.statements.length !== 1 || statement === undefined || !ts.isExpressionStatement(statement)
      || !ts.isCallExpression(statement.expression) || statement.expression.expression.getText() !== 'exarchos_orchestrate') {
      throw new Error(`Expected one prepare call in ${relative}`);
    }
    const [argument] = statement.expression.arguments;
    if (argument === undefined || !ts.isObjectLiteralExpression(argument)) throw new Error('Expected a prepare object.');
    const { action, ...input } = Object.fromEntries(argument.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) throw new Error('Expected a prepare field.');
      return [property.name.text, literal(property.initializer)];
    }));
    expect(action).toBe('prepare');
    const parsed = prepare.schema.parse(input);
    return { featureId: parsed.featureId, repoRoot: parsed.repoRoot, intent: PrepareIntentSchema.parse(parsed.intent) };
  });
}

it('Delegate_BootstrapRetry_KeepsEntryIntent', () => {
  for (const file of DELEGATE_RECIPES) {
    const [first] = recipes(file);
    expect(first).toMatchObject({
      intent: {
        mode: 'bootstrap', workflowType: 'feature', baseRef: expect.any(String), designRef: expect.stringMatching(/^docs\/specs\//),
        designDepth: 'standard', approval: { decision: 'approved', designDigest: typedSnapshot(initialBytes).digest },
      },
    });
    const source = read(path.join(DELEGATE, file));
    expect(source).toMatch(/resend the identical saved bootstrap request/i);
    expect(source).toMatch(/original approval and depth/i);
  }
});

it('Delegate_PlanEdit_UsesCompileMode', () => {
  for (const file of DELEGATE_RECIPES) {
    const [first, continuation] = recipes(file);
    expect(continuation).toMatchObject({
      featureId: first?.featureId, repoRoot: first?.repoRoot,
      intent: {
        mode: 'compile', designDepth: 'standard', designRef: first?.intent?.designRef,
        approval: { decision: 'approved', designDigest: typedSnapshot(editedBytes).digest },
      },
    });
    expect(continuation?.intent?.approval.designDigest).not.toBe(first?.intent?.approval.designDigest);
    expect(read(path.join(DELEGATE, file))).toMatch(/approv(?:e|al)[^.]+(?:new|edited)[^.]+bytes/i);
  }
});
