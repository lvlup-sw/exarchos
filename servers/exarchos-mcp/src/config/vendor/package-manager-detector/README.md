# Vendored: `package-manager-detector` lockfile map

This directory vendors a **small, stable data table** from
[`package-manager-detector`](https://github.com/antfu-collective/package-manager-detector)
(MIT © Anthony Fu): the `LOCKS` and `INSTALL_METADATA` maps that translate a
Node lockfile / install-state marker to its package-manager agent.

## Why vendored, not a dependency

`package-manager-detector`'s `detect()` is **async-only** (it `await`s `fs.stat`
/ `fs.readFile` and crawls parent directories). Our toolchain resolver
(`../../test-runtime-resolver.ts`) is **synchronous** and is called from ~6
synchronous call sites (`setup-worktree`, `verify-worktree-baseline`,
`pre-synthesis-check`, the `detect-test-commands` shim, and two injected
defaults). Taking the dependency would force the resolver — and every one of
those call sites and their pipelines — to become `async`, a sync→async shift
with real blast radius and (via `deasync`-style workarounds) an event-loop
blocking hazard for the MCP stdio server.

We need only the **data**, not the async traversal. The lockfile→agent map is
~16 entries that change rarely, so vendoring it keeps our resolver synchronous,
adds zero runtime dependency, and still tracks upstream's authoritative table.

This is the "vendor the lockfile table" path chosen in the
`refactor-v2-10-1-bundles` workflow (Bundle B, #1508 / #1507). See
`docs/plans/2026-05-31-toolchain-registry-consolidation.md`.

## Provenance & how to update

`lockfiles.generated.ts` is **generated — do not edit by hand**. Its header
records the exact upstream version and commit it was produced from.

To refresh against a newer upstream release:

1. Bump `VENDOR_VERSION` (and `VENDOR_COMMIT`) in
   [`scripts/sync-vendor-pm-detector.ts`](../../../../scripts/sync-vendor-pm-detector.ts).
2. From `servers/exarchos-mcp/`, run:
   ```bash
   npm run vendor:sync:pm-detector
   ```
   This re-fetches `src/constants.ts` + `LICENSE` at the pinned tag and
   regenerates `lockfiles.generated.ts` and `LICENSE` in this directory.
3. Commit the regenerated files.

Drift check (manual; opt-in for CI):
```bash
npm run vendor:check:pm-detector    # non-zero ONLY on genuine content drift
```
It re-fetches from the pinned tag and compares against the committed files. A
network/upstream failure is treated as an outage (warn + exit 0), not as drift,
so it is safe to wire into CI without becoming a network-flake source.

## License

The vendored data and `./LICENSE` are MIT, © Anthony Fu and contributors. Our
generated wrapper and the sync script are part of Exarchos and covered by the
repository license; the upstream attribution is preserved here and in the
generated file header per the MIT terms.
