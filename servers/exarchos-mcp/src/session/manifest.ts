import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionManifestEntry, SessionManifestCompletion } from './types.js';

const SESSIONS_DIR = 'sessions';
const MANIFEST_FILE = '.manifest.jsonl';

export async function writeManifestEntry(stateDir: string, entry: SessionManifestEntry): Promise<void> {
  const sessionsDir = path.join(stateDir, SESSIONS_DIR);
  await fs.mkdir(sessionsDir, { recursive: true });
  const manifestPath = path.join(sessionsDir, MANIFEST_FILE);
  await fs.appendFile(manifestPath, JSON.stringify(entry) + '\n', 'utf-8');
}

export async function readManifestEntries(stateDir: string): Promise<SessionManifestEntry[]> {
  const manifestPath = path.join(stateDir, SESSIONS_DIR, MANIFEST_FILE);
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    return [];
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return [];
  }

  return trimmed
    .split('\n')
    .map((line) => JSON.parse(line) as SessionManifestEntry);
}

export async function writeManifestCompletion(stateDir: string, completion: SessionManifestCompletion): Promise<void> {
  const sessionsDir = path.join(stateDir, SESSIONS_DIR);
  await fs.mkdir(sessionsDir, { recursive: true });
  const completionPath = path.join(sessionsDir, '.completions.jsonl');
  await fs.appendFile(completionPath, JSON.stringify(completion) + '\n', 'utf-8');
}

export async function findUnextractedSessions(stateDir: string): Promise<SessionManifestEntry[]> {
  const entries = await readManifestEntries(stateDir);
  const sessionsDir = path.join(stateDir, SESSIONS_DIR);

  const results: SessionManifestEntry[] = [];
  for (const entry of entries) {
    const eventsPath = path.join(sessionsDir, `${entry.sessionId}.events.jsonl`);
    try {
      await fs.access(eventsPath);
    } catch {
      results.push(entry);
    }
  }

  return results;
}
