# RCA: CI `npm ci` wedges for 300s — promptfoo's optional Playwright Chromium download

## Summary

Every CI job that installs full devDependencies (`Root Package`, `Exarchos MCP
Server`, `E2E Process`, `Outcome Tests`) fails on `ubuntu-latest` with `npm ci`
timing out — SIGTERM after the 300s per-attempt cap, on all 3 retries, on every
branch including `main`. The wedge is **not** network egress and **not** the
`better-sqlite3` prebuild fetch that an earlier mitigation targeted. The actual
cause is `promptfoo`'s **optional** dependency `@playwright/browser-chromium`,
whose postinstall downloads a ~150MB Chromium build from the Playwright CDN — a
host that is uncached, unprobed, and unaffected by `npm_config_build_from_source`.

## Symptom

```text
==> npm ci attempt 1/3 (timeout 300s, kill-after 30s): npm ci
added 189 packages, and audited 190 packages in 6s
npm warn deprecated prebuild-install@7.1.3: No longer maintained. …
   <~5 minutes of silence>
npm error signal SIGTERM
==> npm ci attempt 1/3 stalled or failed; retrying in 5s...
   …repeats for attempts 2/3 and 3/3…
==> npm ci failed after 3 attempts
##[error]Process completed with exit code 1.
```

`mergeStateStatus: BLOCKED`, `CI Gate: FAILURE`. All PRs are unmergeable.

### Reproduction Steps

1. On a cold runner (no `~/.cache/ms-playwright`), run a full-devDependency
   `npm ci` in `servers/exarchos-mcp` (i.e. **without** `--omit=dev`).
2. Tarball install finishes in ~6s (npm cache warm), then the lifecycle-script
   phase runs `@playwright/browser-chromium`'s postinstall, which fetches a
   fallback Chromium from the Playwright CDN.
3. The download exceeds the 300s `npm-ci-retry.sh` cap and is SIGTERM/SIGKILLed;
   each retry restarts the download cold, so all 3 attempts fail identically.

Locally reproduced with `npm ci --foreground-scripts`, which surfaces the
otherwise-buffered postinstall output:

```text
> @playwright/browser-chromium@1.58.2 install
BEWARE: your OS is not officially supported by Playwright;
        downloading fallback build for ubuntu24.04-x64.
```

### Observed vs Expected

- **Observed:** `npm ci` hangs in the postinstall phase and is killed at 300s,
  consistently, on every full-install job.
- **Expected:** `npm ci` completes in well under the cap (~47s once the browser
  download is skipped — verified locally).

## Root Cause

`promptfoo` (an **eval-only** devDependency of `servers/exarchos-mcp`) declares
these as **optional** dependencies, each with a binary-downloading install
script:

| Optional dep (via promptfoo) | Postinstall behavior |
|------------------------------|----------------------|
| `@playwright/browser-chromium` | downloads ~150MB Chromium from the Playwright CDN |
| `@huggingface/transformers` → `onnxruntime-node` | downloads ONNX runtime binaries |
| `sharp` / `@huggingface/transformers` → `sharp` | libvips native binary |

A plain `npm ci` installs `optionalDependencies` by default, so the full-install
CI jobs pull and run all of these. `@playwright/browser-chromium` is the wedge:
the GitHub-hosted `ubuntu-latest` image is now **ubuntu-24.04**, which Playwright
1.58.2 marks "not officially supported", so it downloads an even slower
**fallback** Chromium build. The download is not in the npm cache, lives on a CDN
none of our diagnostics probed, and routinely exceeds the 300s cap on a cold
runner.

### Why the existing mitigations missed it

- **`npm_config_build_from_source: 'true'`** (added in `dfb51ff9` for the same
  symptom) only governs `prebuild-install` (better-sqlite3). It has no effect on
  Playwright/ONNX/sharp downloads — and npm itself flags it as an *"Unknown env
  config"* anyway (prebuild-install reads it directly from env).
- **The CDN connectivity probe** checked `registry.npmjs.org`,
  `objects.githubusercontent.com`, the better-sqlite3 releases host, and
  `nodejs.org` — all healthy (0.05–0.8s). It never probed the Playwright CDN, so
  "all healthy" was misleading.
- **`--omit=dev` jobs pass** (Binary Matrix) precisely because they prune
  `promptfoo` and therefore its optional browser/ML downloads — the clean
  control that isolates devDependencies as the differentiator.

### Code Location

- `scripts/npm-ci-retry.sh` — the shared install chokepoint (used by `ci.yml`
  and `eval-gate.yml`); 300s cap with no browser-download suppression.
- `servers/exarchos-mcp/package.json` — `promptfoo` devDependency.
- `.github/workflows/ci.yml:22-23` — `npm_config_build_from_source` env (the
  mitigation that addressed the wrong binary).

## Contributing Factors

- [x] Wrong layer mitigated — the prior fix and the probe both targeted the
      better-sqlite3 / GitHub-Releases path, not the Playwright CDN.
- [x] Heavy eval-only tooling on the critical install path — `promptfoo`'s
      browser/ML optional deps are installed by jobs that never use them.
- [x] Buffered postinstall output — npm's default (non-`--foreground-scripts`)
      hides which install script is hanging, so the symptom read as a generic
      "npm ci hang" rather than "Chromium download hang".
- [x] Runner image drift — `ubuntu-latest` → 24.04 pushed Playwright onto its
      slower unsupported-OS fallback download.

## Fix Approach

Default `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` inside `scripts/npm-ci-retry.sh`,
the single shared install primitive. No job that runs `npm ci` through the
wrapper drives a browser (the eval configs use LLM/assertion providers — no
Playwright browser provider), so skipping the download is safe for every
consumer (`ci.yml` and `eval-gate.yml`) in one place. The default is an
override-able floor: a job that genuinely needs browsers sets
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0`.

### Changes Required

| File | Change |
|------|--------|
| `scripts/npm-ci-retry.sh` | `export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-1}"` before the retry loop, with rationale comment |
| `scripts/npm-ci-retry.test.sh` | Two assertions: default is `1`; a caller-set value is not clobbered |

### Risks

- Skipping the browser breaks any job that drives a Playwright browser. None do
  today (confirmed: no browser provider in `servers/exarchos-mcp/src/evals/`),
  and the opt-out (`=0`) restores the download for a future one. Low risk.
- The fix lives in the wrapper, so it also changes `eval-gate.yml`'s install.
  Verified the eval suite needs `promptfoo` but not its browser. Low risk.

### Verification

- `bash scripts/npm-ci-retry.test.sh` → 7/7 pass.
- Scratch `npm ci` through the wrapper (cold `node_modules`, no env preset):
  install completes in **47s** (was 300s×3 wedge), `@playwright/browser-chromium
  install` prints *"Skipping browsers download…"*, and `better-sqlite3`'s native
  binary is still built and present.

## Prevention

### Immediate Actions

- [x] Skip the browser download at the shared wrapper (this change).

### Long-term Improvements

- [ ] Re-evaluate whether `npm_config_build_from_source` is still needed now that
      the real wedge is gone (the better-sqlite3 releases CDN probed healthy);
      if kept, set it as a recognized npm config to drop the "Unknown env config"
      warning, or scope it to `prebuild-install` only.
- [ ] Consider moving `promptfoo` out of the default MCP devDependency install
      (e.g. an opt-in eval install) so eval-only tooling never sits on the
      critical path for unit/integration/e2e jobs.
- [ ] Extend the CDN connectivity probe to include the Playwright CDN so a future
      browser-download stall is visible in the probe rather than as a silent hang.

## Timeline

| Event | Date | Notes |
|-------|------|-------|
| Reported | 2026-05-31 | `npm ci` failures across CI during `/exarchos:shepherd` of PR #1497 |
| Investigated | 2026-05-31 | Thorough track; root cause confirmed via foreground-scripts repro + `--omit=dev` control |
| Fixed | 2026-05-31 | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` default in `npm-ci-retry.sh` |
| Verified | 2026-05-31 | 7/7 wrapper tests; 47s scratch install with browser skipped, better-sqlite3 intact |

## Related

- Prior (mis-targeted) mitigation: `dfb51ff9` `npm_config_build_from_source` + CDN probe, referencing RCA `docs/rca/2026-05-30-state-source-integrity.md`.
- Unblocks: PR #1497 (`refactor/design-gate-parity`) and `main` CI.
