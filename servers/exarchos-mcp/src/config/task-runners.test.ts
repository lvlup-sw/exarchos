import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTaskRunner } from './task-runners.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-runners-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8');
}

describe('resolveTaskRunner — per-runner detection + target presence', () => {
  it('Taskfile.yml with a test task → `task test`', () => {
    write('Taskfile.yml', 'version: "3"\ntasks:\n  test:\n    cmds:\n      - echo hi\n  build:\n    cmds: [echo build]\n');
    expect(resolveTaskRunner(dir, 'test')).toEqual({ runner: 'task', target: 'test', command: 'task test' });
    expect(resolveTaskRunner(dir, 'build')).toEqual({ runner: 'task', target: 'build', command: 'task build' });
  });

  it('Taskfile without the requested target → undefined', () => {
    write('Taskfile.yml', 'version: "3"\ntasks:\n  build:\n    cmds: [echo build]\n');
    expect(resolveTaskRunner(dir, 'test')).toBeUndefined();
  });

  it('justfile recipe → `just test`', () => {
    write('justfile', 'test:\n\techo running\n\nbuild dir:\n\techo build\n');
    expect(resolveTaskRunner(dir, 'test')).toEqual({ runner: 'just', target: 'test', command: 'just test' });
    expect(resolveTaskRunner(dir, 'build')?.command).toBe('just build');
  });

  it('just variable assignment (`test := …`) is not a recipe', () => {
    write('justfile', 'test := "vitest"\nbuild:\n\techo b\n');
    expect(resolveTaskRunner(dir, 'test')).toBeUndefined();
  });

  it('just silent recipe (`@test:`) is detected', () => {
    write('justfile', '@test:\n\tvitest run\n');
    expect(resolveTaskRunner(dir, 'test')).toEqual({ runner: 'just', target: 'test', command: 'just test' });
  });

  it('mise [tasks.<name>] table → `mise run test`', () => {
    write('mise.toml', '[tools]\nnode = "20"\n\n[tasks.test]\nrun = "vitest run"\n');
    expect(resolveTaskRunner(dir, 'test')).toEqual({ runner: 'mise', target: 'test', command: 'mise run test' });
  });

  it('mise inline [tasks] entry → `mise run test`', () => {
    write('mise.toml', '[tasks]\ntest = "vitest run"\nlint = "eslint ."\n');
    expect(resolveTaskRunner(dir, 'test')?.command).toBe('mise run test');
  });

  it('Makefile target → `make test`', () => {
    write('Makefile', '.PHONY: test\ntest:\n\tgo test ./...\n');
    expect(resolveTaskRunner(dir, 'test')).toEqual({ runner: 'make', target: 'test', command: 'make test' });
  });

  it('Makefile variable (`test = …`) is not a target', () => {
    write('Makefile', 'test = something\nbuild:\n\tcc main.c\n');
    expect(resolveTaskRunner(dir, 'test')).toBeUndefined();
    expect(resolveTaskRunner(dir, 'build')?.command).toBe('make build');
  });
});

describe('resolveTaskRunner — kind candidates & priority', () => {
  it('typecheck falls back to a `check` target', () => {
    write('justfile', 'check:\n\ttsc --noEmit\n');
    expect(resolveTaskRunner(dir, 'typecheck')?.command).toBe('just check');
  });

  it('install falls back to a `deps` target', () => {
    write('Taskfile.yml', 'tasks:\n  deps:\n    cmds: [npm ci]\n');
    expect(resolveTaskRunner(dir, 'install')?.command).toBe('task deps');
  });

  it('prefers Taskfile over Makefile when both define test', () => {
    write('Taskfile.yml', 'tasks:\n  test:\n    cmds: [echo t]\n');
    write('Makefile', 'test:\n\techo m\n');
    expect(resolveTaskRunner(dir, 'test')?.runner).toBe('task');
  });

  it('no runner files → undefined', () => {
    expect(resolveTaskRunner(dir, 'test')).toBeUndefined();
  });
});
