// Snapshots each action id that the MCP registry advertises.
//
// A structural move can orphan a handler. The code still compiles, and the fault
// shows only as UNKNOWN_ACTION at runtime. This snapshot is the before-and-after
// evidence that a move did not change the advertised verb surface.
//
// Regenerate it only when an action is added or removed, in the same commit as
// that change. A regrouping must leave it byte-identical.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tools/audit/verb-registration-baseline.json');

/** The tsx entry point. Node runs it directly because Windows cannot spawn the `npx` shim. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/**
 * A script that imports the real registry under `tsx`, so the ids are the ids
 * that the server serves.
 */
const script = `
import { TOOL_REGISTRY } from './src/registry.js';
const ids = [];
for (const tool of TOOL_REGISTRY) for (const a of tool.actions) ids.push(tool.name + '.' + a.name);
process.stdout.write(JSON.stringify(ids.sort()));
`;
const tmp = path.join(ROOT, '.tmp-verb-snapshot.mts');
fs.writeFileSync(tmp, script, 'utf8');
let ids;
try {
  const out = execFileSync(process.execPath, [TSX_CLI, tmp], {
    cwd: ROOT,
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
