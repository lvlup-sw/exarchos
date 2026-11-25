# `scripts/` — Buildkite pipeline steps

The lvlup-sw CI contract fixes this path. Each step in
[`.buildkite/pipeline.yml`](../.buildkite/pipeline.yml) runs a script from
`scripts/ci/` in the CI image, on the tested merge of a pull request.

## Layout

- `ci/pr-lane.sh` — runs the `static` or `tests` suite. It checks the toolchain
  against the image, selects the lane mode from the diff, installs from the
  lockfile, and runs `npm run ci:pr:<suite>` offline.
- `ci/npm-pins.json` — the private packages that the admission build stages,
  with the `sha512` integrity that the lockfile must carry.

## What belongs here

- A script that a `.buildkite/` step runs, and the data that script reads.

## What does not

- What a suite runs. `tools/ci/pr-lane.mjs` and `tools/ci/pr-lane.json` own that.
- Other repo automation. Gates, build and publish scripts go in `tools/`.
- Credentials. The pull request build holds none, so a script must never need one.

## Changing the gate

`.github/CODEOWNERS` gives `.buildkite/` and `scripts/ci/` an owner, so a
second person reviews each change to the gate. The admission build reads the
pipeline from `main`, so a change takes effect for other PRs after it merges.

To bump `@lvlup-sw/strategos-contracts`, add the new lockfile URL and
integrity to `ci/npm-pins.json` and merge that first. Then merge the lockfile
change, and remove the old pin.

To bump Bun, publish a new `ci-worker-exarchos-validation` image, put its
digest in `.buildkite/pipeline.yml`, and merge that first. Then merge the
`.bun-version` change.
