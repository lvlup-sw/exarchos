/**
 * Real filesystem hooks for the invariant-authoring handlers (P2).
 *
 * `handleScaffold` / `handleAdd` are pure-by-default — they take injected fs
 * deps so tests can drive them against an in-memory map. This module binds
 * those hooks to `node:fs` for the production dispatch path.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

import type { ScaffoldDeps } from './scaffold.js';

/** Production fs hooks. `write` ensures the parent directory exists first. */
export function realScaffoldDeps(): ScaffoldDeps {
  return {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, contents) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, contents, 'utf8');
    },
  };
}
