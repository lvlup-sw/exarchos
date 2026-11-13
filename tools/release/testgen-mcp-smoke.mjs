import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function checkPackagedMcp(entry, cwd, expected) {
  const child = spawn(process.execPath, [entry], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let diagnostics = '';
  let sequence = 0;
  child.stderr.on('data', (chunk) => { diagnostics += chunk; });
  function rejectPending(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  child.on('error', rejectPending);
  child.on('exit', (code) => rejectPending(new Error(`MCP exited ${code}: ${diagnostics}`)));
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    } catch (error) { rejectPending(error); }
  });
  function request(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${diagnostics}`));
      }, 15_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'installed-smoke', version: '1' },
    });
    assert.equal(initialized.serverInfo.name, 'testgen');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const { tools } = await request('tools/list', {});
    assert.deepEqual(tools.map(({ name }) => name).sort(), expected.operations.map(({ name }) => name).sort());
    const result = await request('tools/call', { name: 'scaffold_tests', arguments: { name: 'Smoke', framework: 'vitest' } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.ok, true);
    assert.match(result.structuredContent.patch, /Implement the reviewed/);
    const invalid = await request('tools/call', { name: 'scaffold_tests', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, 'INVALID_INPUT');
  } finally {
    lines.close();
    child.kill();
    rejectPending(new Error('MCP smoke ended.'));
  }
}
