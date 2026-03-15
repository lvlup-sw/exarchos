import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { ProblemDefinition } from './types.js';

interface MetaJson {
  title: string;
  timeLimit: number;
  tags?: string[];
}

function parseMetaJson(filePath: string): MetaJson {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('title' in parsed) ||
    !('timeLimit' in parsed)
  ) {
    throw new Error(`Invalid meta.json at ${filePath}: missing required fields`);
  }

  const meta = parsed as Record<string, unknown>;

  if (typeof meta['title'] !== 'string') {
    throw new Error(`Invalid meta.json at ${filePath}: title must be a string`);
  }
  if (typeof meta['timeLimit'] !== 'number') {
    throw new Error(`Invalid meta.json at ${filePath}: timeLimit must be a number`);
  }

  return {
    title: meta['title'] as string,
    timeLimit: meta['timeLimit'] as number,
    tags: Array.isArray(meta['tags']) ? (meta['tags'] as string[]) : undefined,
  };
}

function loadSamples(
  samplesDir: string,
): Array<{ id: number; input: string; output: string }> {
  if (!existsSync(samplesDir)) {
    throw new Error(`Samples directory not found: ${samplesDir}`);
  }

  const files = readdirSync(samplesDir);
  const inputFiles = files
    .filter((f) => f.endsWith('.in'))
    .sort((a, b) => {
      const numA = parseInt(a.replace('.in', ''), 10);
      const numB = parseInt(b.replace('.in', ''), 10);
      return numA - numB;
    });

  if (inputFiles.length === 0) {
    throw new Error(`No sample input files found in ${samplesDir}`);
  }

  return inputFiles.map((inputFile) => {
    const id = parseInt(inputFile.replace('.in', ''), 10);
    const outputFile = `${id}.out`;
    const outputPath = resolve(samplesDir, outputFile);

    if (!existsSync(outputPath)) {
      throw new Error(`Missing output file for sample ${id}: ${outputPath}`);
    }

    return {
      id,
      input: readFileSync(resolve(samplesDir, inputFile), 'utf-8').trimEnd(),
      output: readFileSync(outputPath, 'utf-8').trimEnd(),
    };
  });
}

export function loadProblem(problemDir: string): ProblemDefinition {
  const metaPath = resolve(problemDir, 'meta.json');
  const statementPath = resolve(problemDir, 'problem.md');
  const samplesDir = resolve(problemDir, 'samples');

  if (!existsSync(metaPath)) {
    throw new Error(`meta.json not found in ${problemDir}`);
  }
  if (!existsSync(statementPath)) {
    throw new Error(`problem.md not found in ${problemDir}`);
  }

  const meta = parseMetaJson(metaPath);
  const statement = readFileSync(statementPath, 'utf-8');
  const samples = loadSamples(samplesDir);

  return {
    id: basename(problemDir),
    title: meta.title,
    timeLimit: meta.timeLimit,
    statement,
    samples,
    tags: meta.tags,
  };
}

export function loadCorpus(corpusDir: string): ProblemDefinition[] {
  if (!existsSync(corpusDir)) {
    throw new Error(`Corpus directory not found: ${corpusDir}`);
  }

  const entries = readdirSync(corpusDir, { withFileTypes: true });
  const problemDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  return problemDirs.map((dir) => loadProblem(resolve(corpusDir, dir)));
}
