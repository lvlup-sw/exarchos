interface ManifestEntry {
  readonly script?: unknown;
  readonly disposition?: unknown;
}

export function manifestPrimaries(manifestJson: unknown): string[] {
  if (manifestJson === null || typeof manifestJson !== 'object') return [];
  const primaries = (manifestJson as { primaries?: unknown }).primaries;
  if (!Array.isArray(primaries)) return [];
  const out: string[] = [];
  for (const raw of primaries) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry: ManifestEntry = raw;
    if (typeof entry.script !== 'string') continue;
    if (entry.disposition === 'retired') continue;
    out.push(entry.script);
  }
  return out.sort();
}

// ─── Channel 2: Wave-1 spec artifacts ────────────────────────────────────────

export interface SpecTask {
  readonly id: string;
  /** The `**Wave …**` label in force at the heading, or `null` before any header. */
  readonly wave: string | null;
  readonly isAnchor: boolean;
  readonly files: readonly string[];
}

/**
 * Parse the spec's task table. Wave membership comes from the `**Wave N…**`
 * headers; `[ANCHOR]` tasks are tagged from their own heading. Both are
 * structural features of the document, so a re-ordered or renumbered task set
 * stays correctly attributed.
 */
export function parseSpecTasks(specText: string): SpecTask[] {
  const tasks: { id: string; wave: string | null; isAnchor: boolean; files: string[] }[] = [];
  let wave: string | null = null;
  let current: { id: string; wave: string | null; isAnchor: boolean; files: string[] } | null = null;
  for (const line of specText.split('\n')) {
    const waveHeader = /^\*\*Wave\s+([^\s—-]+)/.exec(line);
    if (waveHeader !== null) {
      wave = waveHeader[1] ?? null;
      continue;
    }
    const heading = /^###\s+Task\s+(\d{3}):\s*(.*)$/.exec(line);
    if (heading !== null) {
      const id = heading[1];
      const title = heading[2] ?? '';
      if (id !== undefined) {
        current = { id, wave, isAnchor: title.trimStart().startsWith('[ANCHOR]'), files: [] };
        tasks.push(current);
      }
      continue;
    }
    if (current !== null && /^\*\*Files:\*\*/.test(line)) {
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const value = m[1];
        if (value !== undefined) current.files.push(value);
      }
    }
  }
  return tasks;
}

/** Wave-1 tasks: the wave label starts with `1` and the heading carries no `[ANCHOR]` tag. */
export function wave1Tasks(tasks: readonly SpecTask[]): SpecTask[] {
  return tasks.filter((t) => t.wave !== null && t.wave.startsWith('1') && !t.isAnchor);
}

/**
 * True for a backtick span that is shaped like a repo-relative file path.
 *
 * The `**Files:**` lines also carry directories (`src/`), slash-commands
 * (`/exarchos:invariants`) and bare prose (`as`). Requiring a dotted extension,
 * no whitespace, no colon and no leading slash keeps those out WITHOUT a
 * hand-maintained rejection list — and, crucially, keeps a renamed real path IN
 * (it stays path-shaped, so it surfaces via {@link GuardInventory.unresolvedSpecArtifacts}
 * instead of vanishing).
 */
