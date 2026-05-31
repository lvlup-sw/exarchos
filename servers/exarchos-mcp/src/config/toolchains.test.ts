import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectToolchain,
  BUILTIN_TOOLCHAINS,
  type Toolchain,
} from './toolchains.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toolchains-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(name: string): void {
  writeFileSync(join(dir, name), '', 'utf8');
}

describe('detectToolchain — ecosystem markers', () => {
  it.each([
    ['package.json', 'node', 'Node.js'],
    ['Cargo.toml', 'rust', 'Rust'],
    ['go.mod', 'go', 'Go'],
    ['pyproject.toml', 'python', 'Python'],
    ['requirements.txt', 'python', 'Python'],
    ['setup.py', 'python', 'Python'],
    ['tox.ini', 'python', 'Python'],
    ['pom.xml', 'java-maven', 'Java'],
    ['build.gradle', 'java-gradle', 'Java'],
    ['build.gradle.kts', 'java-gradle', 'Java'],
    ['Gemfile', 'ruby', 'Ruby'],
    ['composer.json', 'php', 'PHP'],
    ['mix.exs', 'elixir', 'Elixir'],
    ['Package.swift', 'swift', 'Swift'],
    ['CMakeLists.txt', 'cmake', 'C/C++'],
  ])('detects %s → %s (%s)', (marker, id, projectType) => {
    touch(marker);
    const tc = detectToolchain(dir);
    expect(tc?.id).toBe(id);
    expect(tc?.projectType).toBe(projectType);
  });
});

describe('detectToolchain — .NET solution formats (#1507)', () => {
  it.each(['App.csproj', 'App.sln', 'App.slnx'])(
    'detects %s as .NET',
    (file) => {
      touch(file);
      const tc = detectToolchain(dir);
      expect(tc?.id).toBe('dotnet');
      expect(tc?.projectType).toBe('.NET');
      expect(tc?.commands.test).toBe('dotnet test');
    },
  );

  it('detects a .slnx-only root (the modern default format) — regression for #1507', () => {
    touch('Dynatoi.slnx');
    expect(detectToolchain(dir)?.id).toBe('dotnet');
  });
});

describe('detectToolchain — priority & misses', () => {
  it('prefers node when package.json coexists with another marker', () => {
    touch('package.json');
    touch('Cargo.toml');
    expect(detectToolchain(dir)?.id).toBe('node');
  });

  it('returns undefined when no marker is present', () => {
    expect(detectToolchain(dir)).toBeUndefined();
  });

  it('returns undefined for an unreadable / nonexistent directory', () => {
    expect(detectToolchain(join(dir, 'does-not-exist'))).toBeUndefined();
  });

  it('matches an extension glob only on the right extension', () => {
    touch('notes.slnxx'); // not a real .slnx
    expect(detectToolchain(dir)).toBeUndefined();
  });
});

describe('detectToolchain — user extra entries (tier 3 override)', () => {
  const zig: Toolchain = {
    id: 'zig',
    projectType: 'Zig',
    markers: ['build.zig'],
    commands: { test: 'zig build test', typecheck: null, install: null },
  };

  it('detects a user-declared toolchain with zero built-in support', () => {
    touch('build.zig');
    expect(detectToolchain(dir, [zig])?.id).toBe('zig');
  });

  it('lets a user entry win over a built-in for the same marker', () => {
    touch('package.json');
    const customNode: Toolchain = {
      id: 'node-custom',
      projectType: 'Node.js',
      markers: ['package.json'],
      commands: { test: 'just test', typecheck: null, install: null },
    };
    expect(detectToolchain(dir, [customNode])?.id).toBe('node-custom');
  });
});

describe('BUILTIN_TOOLCHAINS — registry integrity', () => {
  it('has unique ids', () => {
    const ids = BUILTIN_TOOLCHAINS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every toolchain declares at least one marker and a test command', () => {
    for (const tc of BUILTIN_TOOLCHAINS) {
      expect(tc.markers.length).toBeGreaterThan(0);
      expect(tc.commands.test).toBeTruthy();
    }
  });

  it('dotnet recognizes all three solution formats', () => {
    const dotnet = BUILTIN_TOOLCHAINS.find((t) => t.id === 'dotnet');
    expect(dotnet?.markers).toEqual(
      expect.arrayContaining(['*.csproj', '*.sln', '*.slnx']),
    );
  });
});
