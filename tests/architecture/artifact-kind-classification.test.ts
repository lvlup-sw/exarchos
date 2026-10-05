/**
 * Every artifact kind is either authored or generated, and each declared
 * output path has a producer that writes it.
 *
 * A plugin manifest can point at an output directory that no producer emits.
 * A declared path that resolves to nothing looks the same as an empty
 * directory, so this suite requires the producer and the directory to exist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');
const CONTENT_ROOT = join(REPO_ROOT, 'content');

type Classification = 'authored' | 'generated';

interface ArtifactKind {
  readonly name: string;
  readonly classification: Classification;
  /** Directory the kind is published from, relative to the repo root. */
  readonly emittedTo: string;
  /** Module that writes `emittedTo`. Every generated path needs one. */
  readonly producer: string;
}

/** The closed classification. A new artifact kind starts here, and its row must name a producer. */
const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  {
    name: 'skills',
    classification: 'authored',
    emittedTo: 'rendered/skills',
    producer: 'src/install/build-skills.ts',
  },
  {
    name: 'commands',
    classification: 'authored',
    emittedTo: 'rendered/commands',
    producer: 'src/install/build-authored-artifacts.ts',
  },
  {
    name: 'rules',
    classification: 'authored',
    emittedTo: 'rendered/rules',
    producer: 'src/install/build-authored-artifacts.ts',
  },
  {
    name: 'command-aliases',
    classification: 'generated',
    emittedTo: 'rendered/command-aliases',
    producer: 'src/install/build-command-aliases.ts',
  },
  {
    name: 'agents',
    classification: 'generated',
    emittedTo: 'rendered/agents',
    producer: 'src/runtime/agents/generate-agents.ts',
  },
];

function directoriesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
}

describe('ArtifactKinds', () => {
  it('EveryKind_IsClassifiedAuthoredOrGenerated', () => {
    expect(ARTIFACT_KINDS.length).toBeGreaterThan(0);
    for (const kind of ARTIFACT_KINDS) {
      expect(['authored', 'generated'], `${kind.name} is unclassified`).toContain(
        kind.classification,
      );
    }
  });

  it('EveryAuthoredKind_HasSourcesUnderContent', () => {
    const authored = ARTIFACT_KINDS.filter((k) => k.classification === 'authored');
    expect(authored.length).toBeGreaterThan(0);

    for (const kind of authored) {
      const domainsHoldingIt = directoriesIn(CONTENT_ROOT).filter((domain) =>
        existsSync(join(CONTENT_ROOT, domain, kind.name)),
      );
      expect(
        domainsHoldingIt.length,
        `${kind.name} is classified authored but no domain under content/ holds it`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * The inverse of the test above. The build overwrites each emitted
   * directory, so a hand-maintained file must not live in one.
   */
  it('NoAuthoredSource_LivesInsideAnEmittedTree', () => {
    for (const kind of ARTIFACT_KINDS) {
      const emitted = join(REPO_ROOT, kind.emittedTo);
      if (!existsSync(emitted)) continue;
      const strays = readdirSync(emitted).filter(
        (e) => e.endsWith('.sh') || e === 'test-fixtures' || e === 'trigger-tests',
      );
      expect(strays, `hand-maintained files inside the generated ${kind.emittedTo}/`).toEqual(
        [],
      );
    }
  });
});

describe('RenderedTree', () => {
  /**
   * Checks both halves. A missing producer module means that the table does
   * not describe the build. A missing output directory means that no producer
   * wrote the declared path.
   */
  it('EveryDeclaredPath_HasAProducer', () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(
        existsSync(join(REPO_ROOT, kind.producer)),
        `${kind.name} names a producer that does not exist: ${kind.producer}`,
      ).toBe(true);
      expect(
        existsSync(join(REPO_ROOT, kind.emittedTo)),
        `${kind.name} declares ${kind.emittedTo}/ but nothing has emitted it`,
      ).toBe(true);
    }
  });

  /**
   * Each path that `plugin.json` declares must exist and must sit under the
   * output root of a producer. A file-level entry, such as an agent file,
   * resolves through the root that holds it.
   */
  it('EveryPluginDeclaredPath_ResolvesAndIsProduced', () => {
    const manifestPath = join(REPO_ROOT, '.claude-plugin/plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const producedRoots = new Set(ARTIFACT_KINDS.map((k) => k.emittedTo));

    const declared: string[] = [];
    for (const key of ['commands', 'skills', 'agents', 'rules', 'hooks']) {
      const value = manifest[key];
      if (typeof value === 'string') declared.push(value);
      else if (Array.isArray(value)) declared.push(...value.filter((v): v is string => typeof v === 'string'));
    }
    expect(declared.length).toBeGreaterThan(0);

    for (const raw of declared) {
      const rel = raw.replace(/^\.\//, '').replace(/\/$/, '');
      expect(existsSync(join(REPO_ROOT, rel)), `plugin.json declares ${raw}, which does not exist`).toBe(
        true,
      );

      const root = rel.startsWith('rendered/')
        ? rel.split('/').slice(0, 2).join('/')
        : rel.split('/')[0]!;
      expect(
        producedRoots.has(root),
        `plugin.json declares ${raw} under ${root}/, which no producer emits`,
      ).toBe(true);
    }
  });
});
