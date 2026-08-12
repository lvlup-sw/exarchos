// Snapshot every action id the MCP registry advertises (DR-2, DR-9, task 015).
//
// The structural moves in Phase 1 can orphan a handler in a way that COMPILES
// CLEAN and only shows up as UNKNOWN_ACTION at runtime. This file is the
// before/after evidence that no move changed the advertised verb surface.
//
// Regenerate ONLY when an action is genuinely added or removed, and in the same
// commit as that change. A regrouping must leave it byte-identical.
//
// Reads the registry by parsing rather than importing: the registry pulls the
// SQLite substrate, which needs the workspace's `bun:sqlite` alias, and a
// measurement instrument should not need a test runner to produce a number.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tools/audit/verb-registration-baseline.json');

// Drive the real registry through the MCP workspace's own runner so the ids are
// the ones the server actually serves, not a regex's guess at them.
const script = `
import { TOOL_REGISTRY } from './src/registry.js';
const ids = [];
for (const tool of TOOL_REGISTRY) for (const a of tool.actions) ids.push(tool.name + '.' + a.name);
process.stdout.write(JSON.stringify(ids.sort()));
`;
const tmp = path.join(ROOT, 'servers/exarchos-mcp', '.tmp-verb-snapshot.mts');
fs.writeFileSync(tmp, script, 'utf8');
let ids;
try {
  const out = execFileSync('npx', ['tsx', tmp], {
    cwd: path.join(ROOT, 'servers/exarchos-mcp'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  ids = JSON.parse(out.slice(out.indexOf('[')));
} finally {
  fs.rmSync(tmp, { force: true });
}

const tree = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.writeFileSync(
  OUT,
  `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), tree, count: ids.length, actionIds: ids }, null, 2)}\n`,
);
console.log(`wrote ${ids.length} registered action ids -> ${path.relative(ROOT, OUT)}`);
