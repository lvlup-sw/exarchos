# Ship-gate pre-push hook (opt-in)

A documented, **opt-in** git `pre-push` hook that runs an Exarchos ship-path verb before every `git push` and blocks the push when the gate reports a blocking finding.
It is the forcing-function trigger from the ship-gate methodology (DR-5, [#1597](https://github.com/lvlup-sw/exarchos/issues/1597)) — quality is enforced at the push boundary rather than left to memory.

The hook ships as a sample at [`hooks/pre-push.ship-gate.sample`](../../hooks/pre-push.ship-gate.sample) and does **nothing** until you explicitly install it.

## Posture (why it is shaped this way)

- **Opt-in, never auto-installed (POLA).** Cloning or pulling this repo never installs the hook and never runs it. Installing a hook that can block every push is a user decision, not a repo-side side effect. This mirrors the worktree design's user-scope-hooks rule — no surprise execution on a cloned repo.
- **A thin trigger, not a daemon (INV-15).** The hook is ~3 lines of logic: ask the ship-path gate, honor the answer. There is no background process, no bare gate repo, and no second orchestrator — the engine stays Exarchos. This is deliberately **not** a `post-receive` daemon.
- **Harness/OS-neutral (INV-4).** It is a POSIX `sh` script in the git domain. It carries no bashisms and needs no `jq`; it runs the same on macOS, Linux, and Git-for-Windows.
- **Degrades open.** If Exarchos is not installed (or the gate cannot reach a verdict), the hook prints a clear message and **allows** the push. You opted into a quality gate, not into "every push fails when an optional tool is missing."

## Install

Installing is a single explicit action in your local clone:

```sh
cp hooks/pre-push.ship-gate.sample .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

That is the whole install. The hook now runs on each `git push`.

> Git only runs hooks from `.git/hooks/` (or `core.hooksPath`). The `.sample` file under `hooks/` is inert until you copy it into place — exactly so that pulling the repo cannot arm it.

## Behaviour

On `git push` the hook:

1. Resolves the Exarchos binary (`EXARCHOS_BIN`, default `exarchos`). If it is not on `PATH`, it prints a skip message to stderr and **exits 0** (push allowed).
2. Runs the ship-path verb with JSON output — by default `exarchos orch check_static_analysis --feature-id pre-push --json` (lint + typecheck).
3. Inspects the result:
   - A **blocking finding** (`data.passed: false` / `data.ready: false`) → prints a summary and **exits 1**, so git aborts the push.
   - A **clean gate** (`data.passed: true` / `data.ready: true`) → **exits 0**, push proceeds.
   - **No recognizable verdict** (the verb errored, was skipped for lack of a toolchain, or returned an unexpected shape) → prints a diagnostic and **exits 0** (degrade-open — an inconclusive gate never blocks a push).

### Exit contract

| Exit | Meaning |
|------|---------|
| `0` | Gate passed, **or** the engine was unavailable / could not reach a verdict (degrade-open). |
| `1` | The ship-path gate reported a blocking finding — git aborts the push. |

## Configuration

The hook reads three environment variables (all optional):

| Variable | Default | Purpose |
|----------|---------|---------|
| `EXARCHOS_BIN` | `exarchos` | The Exarchos binary to invoke. Point it at a custom build, or rely on `PATH`. |
| `EXARCHOS_SHIP_VERB` | `orch check_static_analysis` | The ship-path verb (and subcommand) to run. Any verb that emits a `ToolResult` with a `data.passed` / `data.ready` boolean works. |
| `EXARCHOS_SHIP_FEATURE_ID` | `pre-push` | The synthetic feature id passed to the verb. It only labels the emitted gate event. |

Set them in your shell profile, or inline per push:

```sh
EXARCHOS_SHIP_VERB="orch prepare_synthesis --repo-root $PWD" git push
```

`EXARCHOS_SHIP_VERB` is word-split, so it can carry the verb's own flags — which is how a verb with required inputs beyond `--feature-id` is reachable here.
`prepare_synthesis` needs `--repo-root`: it shells out on four legs and refuses to guess which tree they measure, so omitting it makes the verb exit `INVALID_INPUT` and the hook degrade open rather than gate anything.

## Bypass and uninstall

- **One-off bypass:** `git push --no-verify` skips all pre-push hooks for that push.
- **Uninstall:** delete the installed hook — `rm .git/hooks/pre-push`.

## Relationship to the rest of the ship path

The hook is only a *trigger*. It runs the same verbs the SYNTHESIZE kind and the shepherd loop already run (`check_static_analysis`, `prepare_synthesis`, …), so a clean local push and a clean CI run check the same gate.
It does not replace review or CI — it moves the cheapest, most mechanical checks to the earliest point where they are free to fix, before the push leaves your machine.
