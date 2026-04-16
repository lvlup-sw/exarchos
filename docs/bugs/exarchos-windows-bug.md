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

On Windows:
- `import.meta.url` = `file:///C:/Users/.../exarchos.js` (forward slashes)
- `process.argv[1]` = `C:\Users\...\exarchos.js` (backslashes)

`endsWith` never matches, so `main()` never runs.

## Fix

Normalize backslashes before comparison:

```ts
const isDirectExecution =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    import.meta.url.endsWith(process.argv[1].replace(/\.ts$/, '.js')));
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
