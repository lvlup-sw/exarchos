/**
 * Each `@skills/<path>` citation in a shipped file resolves inside the skill tree that the runtime installs.
 * The installer makes the tree of a runtime from `rendered/skills/standard` and `rendered/skills/<runtime>`.
 * This check reads that tree through `collectCanonicalSkillSet`, the function that the installer uses.
 * A command, an agent or a rule ships with each runtime, so its citations must resolve in the tree of each runtime.
 * A citation that does not resolve fails, unless a register entry names it with a reason and an owner.
 *
 * @oracle-sources: live-repository-tree, ../../src/install/install-skills.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { collectCanonicalSkillSet } from '../../src/install/install-skills.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The rendered tree, repo-relative. The package ships it. */
const RENDERED = 'rendered';

/** The rendered skill trees, repo-relative. Each runtime has a tree beside the shared `standard` tree. */
const SKILLS_ROOT = 'rendered/skills';

/** The tree of the skills that every runtime installs. It is not a runtime. */
const STANDARD_TREE = 'standard';

/** The rendered command aliases, repo-relative. Each runtime that declares aliases has its own directory. */
const ALIASES_ROOT = 'rendered/command-aliases';

/** A citation of a skill path. The path starts with a skill name, so a placeholder such as `<name>` is not a citation. */
const CITATION = /@skills\/([A-Za-z0-9_][A-Za-z0-9._/-]*)/g;

/** The fewest runtime trees, shipped files and citations that the live check must read. A smaller count means a broken scan. */
const FLOOR = { runtimes: 6, files: 220, citations: 400 } as const;

/** A shipped file that an install of the runtime carries. */
interface ShippedFile {
  /** The repo-relative path of the file. */
  readonly path: string;
  /** The name of the file across the runtimes, such as `skills/oneshot/SKILL.md`. A register entry names this value. */
  readonly source: string;
  readonly text: string;
}

/** The installed skill tree of one runtime and the shipped files that the install carries. */
interface RuntimeTree {
  readonly runtime: string;
  /** The repo-relative directory of each installed skill, by skill name. */
  readonly skills: ReadonlyMap<string, string>;
  readonly files: readonly ShippedFile[];
}

/** The inputs that the judge reads, so the live tree and a seeded defect go through the same judge. */
interface CitationWorld {
  readonly trees: readonly RuntimeTree[];
  /** True when a repo-relative path exists as a file or a directory. */
  readonly exists: (repoPath: string) => boolean;
}

/** A citation that does not resolve and that the register accepts. */
interface RegisteredCitation {
  /** The source name of the citing file, as {@link ShippedFile.source} gives it. */
  readonly source: string;
  /** The cited path after `@skills/`. */
  readonly citation: string;
  /** Why the citation stays. */
  readonly reason: string;
  /** Who owns the repair of the citation. */
  readonly owner: string;
}

/** The reason of each citation of the verification ladder, which no runtime ships. */
const UNSHIPPED_LADDER =
  'The verification ladder is in content/_shared, and the renderer does not ship that directory by design. ' +
  'The citation is older than this check, and no issue moves the ladder into a shipped reference yet.';

/**
 * The citations that do not resolve and that stay for now. This list is a deliberate subset of the citations,
 * because a citation joins it only when it is older than this check. An entry that names no dangling citation fails.
 */
const REGISTER: readonly RegisteredCitation[] = [
  { source: 'skills/oneshot/SKILL.md', citation: '_shared/references/verification.md', reason: UNSHIPPED_LADDER, owner: 'Reed' },
  {
    source: 'skills/plan/references/spec-template.md',
    citation: '_shared/references/verification.md',
    reason: UNSHIPPED_LADDER,
    owner: 'Reed',
  },
  {
    source: 'skills/plan/references/task-template.md',
    citation: '_shared/references/verification.md',
    reason: UNSHIPPED_LADDER,
    owner: 'Reed',
  },
  {
    source: 'skills/plan/references/worked-example.md',
    citation: '_shared/references/verification.md',
    reason: UNSHIPPED_LADDER,
    owner: 'Reed',
  },
];

/** A citation of a shipped file that does not resolve in the tree of a runtime. */
interface DanglingCitation {
  readonly runtime: string;
  readonly path: string;
  readonly source: string;
  readonly citation: string;
}

/** The cited paths of a text, with the end punctuation of a sentence removed. */
function citationsOf(text: string): readonly string[] {
  return [...text.matchAll(CITATION)].map((match) => (match[1] ?? '').replace(/\.+$/, ''));
}

/** True when the cited path is a skill of the tree, or a path inside such a skill. A `.` or `..` segment never resolves. */
function resolves(tree: RuntimeTree, citation: string, exists: CitationWorld['exists']): boolean {
  const [skill, ...rest] = citation.split('/').filter((segment) => segment.length > 0);
  if (skill === undefined || rest.some((segment) => segment === '.' || segment === '..')) return false;
  const dir = tree.skills.get(skill);
  if (dir === undefined) return false;
  return exists(rest.length === 0 ? dir : `${dir}/${rest.join('/')}`);
}

/** Each citation of each shipped file of each tree that does not resolve in that tree. */
function danglingCitations(world: CitationWorld): readonly DanglingCitation[] {
  return world.trees.flatMap((tree) =>
    tree.files.flatMap((file) =>
      citationsOf(file.text)
        .filter((citation) => !resolves(tree, citation, world.exists))
        .map((citation) => ({ runtime: tree.runtime, path: file.path, source: file.source, citation })),
    ),
  );
}

/** True when the register entry names the dangling citation. */
function names(entry: RegisteredCitation, dangling: DanglingCitation): boolean {
  return entry.source === dangling.source && entry.citation === dangling.citation;
}

/**
 * How the shipped files and the register disagree. A dangling citation that no entry names is a problem.
 * An entry that names no dangling citation, or that names no owner or no reason, is a problem too.
 */
function citationProblems(world: CitationWorld, register: readonly RegisteredCitation[]): readonly string[] {
  const dangling = danglingCitations(world);
  const problems: string[] = [];
  for (const item of dangling) {
    if (!register.some((entry) => names(entry, item))) {
      problems.push(`${item.path}: @skills/${item.citation} does not resolve in the ${item.runtime} skill tree`);
    }
  }
  for (const entry of register) {
    if (!dangling.some((item) => names(entry, item))) {
      problems.push(`the register entry ${entry.source} -> @skills/${entry.citation} names no dangling citation`);
    }
    if (entry.owner.trim().length === 0) problems.push(`the register entry ${entry.source} names no owner`);
    if (entry.reason.trim().length === 0) problems.push(`the register entry ${entry.source} names no reason`);
  }
  return problems;
}

/** The repo-relative path of each file under a repo-relative directory, in a stable order. A missing directory gives no file. */
function filesUnder(dir: string): readonly string[] {
  if (!existsSync(path.join(REPO_ROOT, dir))) return [];
  return readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return filesUnder(child);
      return entry.isFile() ? [child] : [];
    })
    .sort();
}

/** A shipped file of the live tree, read from disk. */
function shippedFile(repoPath: string, source: string): ShippedFile {
  return { path: repoPath, source, text: readFileSync(path.join(REPO_ROOT, repoPath), 'utf8') };
}

/** The runtimes of the live rendered tree: each skill tree other than `standard`. */
function liveRuntimes(): readonly string[] {
  return readdirSync(path.join(REPO_ROOT, SKILLS_ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== STANDARD_TREE)
    .map((entry) => entry.name)
    .sort();
}

/**
 * The live world. The tree of each runtime holds the files of its installed skills and its command aliases.
 * It also holds each other rendered file outside the skill and alias trees.
 */
function liveWorld(): CitationWorld {
  const shared = filesUnder(RENDERED)
    .filter((file) => !file.startsWith(`${SKILLS_ROOT}/`) && !file.startsWith(`${ALIASES_ROOT}/`))
    .map((file) => shippedFile(file, file.slice(RENDERED.length + 1)));
  const trees = liveRuntimes().map((runtime): RuntimeTree => {
    const skills = new Map(
      collectCanonicalSkillSet(path.join(REPO_ROOT, SKILLS_ROOT), runtime).map(({ name, dir }) => [
        name,
        path.relative(REPO_ROOT, dir).split(path.sep).join('/'),
      ]),
    );
    const skillFiles = [...skills.entries()].flatMap(([name, dir]) =>
      filesUnder(dir).map((file) => shippedFile(file, `skills/${name}/${file.slice(dir.length + 1)}`)),
    );
    const aliasDir = `${ALIASES_ROOT}/${runtime}`;
    const aliasFiles = filesUnder(aliasDir).map((file) =>
      shippedFile(file, `command-aliases/${file.slice(aliasDir.length + 1)}`),
    );
    return { runtime, skills, files: [...skillFiles, ...aliasFiles, ...shared] };
  });
  return { trees, exists: (repoPath) => existsSync(path.join(REPO_ROOT, repoPath)) };
}

/** The live world with one file added to the tree of the first runtime. */
function withSeededFile(world: CitationWorld, file: ShippedFile): CitationWorld {
  const [first, ...rest] = world.trees;
  if (first === undefined) return world;
  return { ...world, trees: [{ ...first, files: [...first.files, file] }, ...rest] };
}

describe('ShippedSkillCitations — each @skills citation of a shipped file resolves in its runtime tree', () => {
  /** The scan reads each runtime, the shipped files and their citations, so a scan that reads nothing cannot pass. */
  it('ShippedSkillCitations_LiveScan_ReadsAtLeastTheFloor', () => {
    const world = liveWorld();
    const files = new Set(world.trees.flatMap((tree) => tree.files.map((file) => file.path)));
    const citations = world.trees.flatMap((tree) => tree.files.flatMap((file) => citationsOf(file.text)));
    expect(world.trees.length).toBeGreaterThanOrEqual(FLOOR.runtimes);
    expect(files.size).toBeGreaterThanOrEqual(FLOOR.files);
    expect(citations.length).toBeGreaterThanOrEqual(FLOOR.citations);
    for (const tree of world.trees) {
      expect(tree.skills.has('delegate'), `${tree.runtime} installs no delegate skill`).toBe(true);
      expect(tree.skills.has('oneshot'), `${tree.runtime} installs no oneshot skill`).toBe(true);
    }
  });

  /** Each citation of the live tree resolves, or the register names it with a reason and an owner. */
  it('ShippedSkillCitations_LiveTree_EveryCitationResolvesOrIsRegistered', () => {
    expect(citationProblems(liveWorld(), REGISTER)).toEqual([]);
  });

  /** The test reference of the kill probe ships in the delegate skill of each runtime, with the `test:files` rule. */
  it('ShippedSkillCitations_ProbeTestCommand_ShipsInEachRuntimeTree', () => {
    for (const tree of liveWorld().trees) {
      const reference = tree.files.find((file) => file.source === 'skills/delegate/references/testing-patterns.md');
      expect(reference, `${tree.runtime} ships no delegate testing reference`).toBeDefined();
      expect(reference?.text).toContain('npm run test:files -- <files>');
      expect(reference?.text).toContain('The script comes first, also when `.exarchos.yml` sets `test`.');
      expect(reference?.text).toContain('make the scoped tests pass on the task source');
    }
  });

  /** An empty register names each dangling citation of the live tree, so the register is not vacuous. */
  it('ShippedSkillCitations_EmptyRegister_NamesEachRegisteredCitation', () => {
    const world = liveWorld();
    const problems = citationProblems(world, []);
    expect(problems.length).toBeGreaterThanOrEqual(REGISTER.length);
    for (const entry of REGISTER) {
      expect(problems.some((problem) => problem.includes(`@skills/${entry.citation}`))).toBe(true);
    }
  });

  /**
   * The test seeds a file whose citation does not resolve, and its twin, whose citation resolves.
   * The judge names the first and passes the twin. A `..` segment does not resolve, also when the file exists.
   */
  it('ShippedSkillCitations_SeededDanglingCitationAndItsTwin_OnlyTheDanglingOneIsNamed', () => {
    const world = liveWorld();
    const runtime = world.trees[0]?.runtime ?? '';
    const dangling: ShippedFile = {
      path: 'seeded/dangling.md',
      source: 'seeded/dangling.md',
      text: 'See `@skills/delegate/references/no-such-reference.md`.',
    };
    const twin: ShippedFile = {
      path: 'seeded/twin.md',
      source: 'seeded/twin.md',
      text: 'See `@skills/delegate/references/testing-patterns.md`.',
    };
    expect(citationProblems(withSeededFile(world, twin), REGISTER)).toEqual([]);
    expect(citationProblems(withSeededFile(world, dangling), REGISTER)).toEqual([
      `seeded/dangling.md: @skills/delegate/references/no-such-reference.md does not resolve in the ${runtime} skill tree`,
    ]);

    const escaping: ShippedFile = { ...twin, text: 'See @skills/delegate/../oneshot/SKILL.md.' };
    expect(citationProblems(withSeededFile(world, escaping), REGISTER)).toEqual([
      `seeded/twin.md: @skills/delegate/../oneshot/SKILL.md does not resolve in the ${runtime} skill tree`,
    ]);
  });

  /** A register entry that names no dangling citation, or that names no owner or no reason, is named. */
  it('ShippedSkillCitations_SeededRegisterDefects_AreNamed', () => {
    const world = liveWorld();
    const [entry] = REGISTER;
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const stale: RegisteredCitation = { ...entry, source: 'skills/oneshot/references/none.md' };
    expect(citationProblems(world, [...REGISTER, stale])).toEqual([
      'the register entry skills/oneshot/references/none.md -> @skills/_shared/references/verification.md names no dangling citation',
    ]);
    const rest = REGISTER.filter((candidate) => candidate !== entry);
    expect(citationProblems(world, [{ ...entry, owner: ' ', reason: '' }, ...rest])).toEqual([
      `the register entry ${entry.source} names no owner`,
      `the register entry ${entry.source} names no reason`,
    ]);
  });
});
