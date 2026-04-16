---
title: Windows CLI no-op due to path separator + URL encoding mismatch
issue: 1085
tags: [bug, windows, cli]
---

# Windows: CLI is a no-op — isDirectExecution check fails due to path separator mismatch

## Bug

On Windows, running `exarchos mcp` (or any subcommand) silently exits with code 0 and no output. The CLI is a complete no-op.

## Root Cause

In `servers/exarchos-mcp/src/index.ts`, the `isDirectExecution` guard compares `import.meta.url` against `process.argv[1]`:

```ts
const isDirectExecution =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].replace(/\.ts$/, '.js')));
```

Two encoding hazards break that comparison:

1. **Path separator mismatch (Windows).** `import.meta.url` is a forward-slash file:// URL (`file:///C:/Users/.../exarchos.js`) while `process.argv[1]` uses backslashes (`C:\Users\...\exarchos.js`). `endsWith` never matches.
2. **Percent-encoded URL.** `import.meta.url` is in standard URL form, so path segments containing spaces or non-ASCII characters are percent-encoded (`%20` etc.) while `argv[1]` is a raw OS path. Even on POSIX, a user at `/Users/First Last/...` would hit this.

Either hazard alone turns `main()` into a silent no-op.

## Fix

Route `import.meta.url` through `fileURLToPath()` (which decodes percent-encoded characters and returns a platform path) and normalize both sides to forward slashes before comparing:

```ts
import { fileURLToPath } from 'node:url';

export function isDirectExecution(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const modulePath = fileURLToPath(metaUrl).replace(/\\/g, '/');
  const normalizedArgv = argv1.replace(/\\/g, '/');
  return (
    modulePath.endsWith(normalizedArgv) ||
    modulePath.endsWith(normalizedArgv.replace(/\.ts$/, '.js'))
  );
}
```

## Environment

- Windows 11
- Node.js v20.17.0 (also tested with v22.21.0 via Agency)
- `@lvlup-sw/exarchos@2.6.0` installed globally via `npm install -g`
- Also affects `npx @lvlup-sw/exarchos mcp`

## Workaround

Patch `dist/exarchos.js` after install to add the backslash normalization.

## Additional Note

The bundled `better-sqlite3` native binary also fails on this environment ("not a valid Win32 application"), but the JSONL fallback works correctly. This may be a separate issue related to the native binary being built for a different Node.js version/platform.
