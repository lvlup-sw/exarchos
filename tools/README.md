# `tools/` — repo automation

Everything that inspects, builds or publishes this repository, and nothing that
ships to a user. The distinction is the package boundary, not the language:
code here is TypeScript like `src/`, and none of it is in the tarball.

## Layout

- `audit/` — the gates. `gates/` holds the executable checks and their
  manifests, `core/` the censuses, `lib/` the shared classifiers, and the
  `*-baseline.json` files each guard compares against.
- `release/` — build and publish: the binary builder, the signed release
  manifest, the installer scripts served from GitHub Releases.
- `conformance/` — a real package with its own tsconfig, holding the censuses
  that audit the product's contracts. Its suites are co-located under `src/`
  because that is the directory the `conformance` vitest project collects.
- `tools/eslint-rules/`, `tools/renovate-config/`, `tools/migrations/`,
  `tools/evals/`, `tools/test-helpers/` — the rest of the automation, one
  directory per concern. Named with their prefix because several of them used
  to sit at the repository root, and a bare name here would read as the old
  location.

## What belongs here

- A check that runs in CI.
- A script `package.json` invokes.
- A baseline or manifest one of the above reads.

## What does not

- Product code. If a user's install needs it, it belongs in `src/`.
- Tests of product behavior — those go to `tests/`. The exception is a guard's
  own self-test, which stays beside the guard so the two run in the same CI
  job.

## Before adding a gate

Register it. `tools/audit/gates/guard-inventory.ts` discovers guards through
four independent channels and reports which CI job runs each one, whether that
job is path-filtered, and whether it blocks or merely observes. A guard that
ships and is called by nothing is the failure that inventory exists to catch —
it has happened repeatedly, and every instance was reported by the work that
shipped it, against itself.
