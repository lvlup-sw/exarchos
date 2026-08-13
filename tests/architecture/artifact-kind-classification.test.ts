import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every artifact kind is either authored or generated, and a generated path is
 * only declared when something writes it.
 *
 * The failure this prevents is specific: an earlier revision pointed the plugin
 * manifest at an output directory no producer emitted. Nothing detected it,
 * because a declared path that resolves to nothing looks exactly like a path
 * whose contents are simply empty.
 */

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

/**
 * The closed classification. A new artifact kind is added here first, which
 * forces the question of who emits it to be answered rather than discovered.
 */
const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  {
    name: 'skills',
    classification: 'authored',
    emittedTo: 'skills',
    producer: 'src/install/build-skills.ts',
  },
  {
    name: 'commands',
    classification: 'authored',
    emittedTo: 'commands',
    producer: 'src/install/build-authored-artifacts.ts',
  },
  {
    name: 'rules',
    classification: 'authored',
    emittedTo: 'rules',
    producer: 'src/install/build-authored-artifacts.ts',
  },
  {
    name: 'command-aliases',
    classification: 'generated',
    emittedTo: 'command-aliases',
    producer: 'src/install/build-command-aliases.ts',
  },
  {
    name: 'agents',
    classification: 'generated',
    emittedTo: 'agents',
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

  it('NoAuthoredSource_LivesInsideAnEmittedTree', () => {
    // The inverse of the rule above, and the one that was actually violated:
    // live, hand-maintained files sitting inside a directory the build
    // overwrites. Anything authored must be reachable under `content/`.
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
  it('EveryDeclaredPath_HasAProducer', () => {
    // Both halves matter. A declared path with no producer is the revision-1
    // defect; a producer named in this table that does not exist on disk means
    // the table has drifted from the build it claims to describe.
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

      // A declared directory must be someone's output. File-level declarations
      // (the agents list) are checked through the root they sit in.
      const root = rel.split('/')[0]!;
      expect(
        producedRoots.has(root),
        `plugin.json declares ${raw} under ${root}/, which no producer emits`,
      ).toBe(true);
    }
  });
});
