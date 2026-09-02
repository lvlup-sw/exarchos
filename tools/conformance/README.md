# `tools/conformance`

First-party architectural conformance censuses, extracted from the tree they
govern (task 018a).

## Why there is no `package.json` here

The plan called for `tools/conformance/{package.json,tsconfig.json,src/,tests/}`
— a real, independently-installable package. The tree does not permit it, and
the reason is structural rather than incidental.

Every census in this package is pure with respect to its subject: it takes the
tables, schemas and directories it needs as parameters. The composition root
(`src/bindings/`) is where that inversion is discharged, and it necessarily
imports the real values from the subject. That single edge is what keeps the
censuses asserting against what actually ships rather than against a copy — but
it also means this package inherits the subject's dependency closure. An
independent `npm install` here would have to duplicate the MCP server's entire
dependency tree to type-check one import.

So the conformance code resolves its dependencies from the repository root, and
carries no manifest. `tests/architecture/build-graph.test.ts` enforces that every
tracked `package.json` is declared *and* has a lockfile beside it — "a manifest
without a lockfile installs unpinned". Adding a manifest here would have meant
either a third install in CI or a decorative lockfile nobody installs from. The
guard is right; the manifest is what was wrong.

`tsconfig.json` stays. It gives the package a real type-check boundary, and the
root `typecheck` script runs it — without that, these modules would sit outside
every tsconfig's `include` and go unchecked entirely.

## The subject root

`src/subject-root.ts` resolves the repository root by searching upward for the
sentinel `package.json` named `@lvlup-sw/exarchos`, once, and throws rather than
guessing when it cannot be found. It replaces the
`path.resolve(__dirname, '../../../..')` idiom these modules inherited, which
fails silently across a move: a stale hop count still resolves to a real
directory, so a census scans the wrong tree, finds nothing, and reports green.

Relocating the subject tree — task 019 folds `servers/exarchos-mcp/src/` up to
`src/` — is a one-line change to `SUBJECT_SRC_REL`.

## What is here, and what stayed behind

The extraction is partial, deliberately. `tools/audit/conformance-extraction-exceptions.md`
is the measurement: which modules moved, which stayed, and why each one that
stayed could not move. A third of the original `architecture/` directory is not
conformance code at all — it is shared infrastructure that production imports —
so moving it would have inverted the dependency direction.
