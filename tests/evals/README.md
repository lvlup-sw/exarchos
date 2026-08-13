# Eval Framework

Deterministic and LLM-graded evaluation suites for Exarchos skills.

## Running Evals

The eval CLI entry points (`eval-run`, `eval-capture`, `eval-compare`,
`eval-calibrate`) were removed in v2.9 install-rewrite task 3.8 alongside the
unreachable `servers/exarchos-mcp/src/cli.ts`. The eval framework libraries
under `servers/exarchos-mcp/src/evals/` remain; invoke them directly in
tests or via a new bespoke runner until a new CLI surface is designed.

## API Key Configuration

LLM-based graders (`llm-rubric`, `llm-similarity`) require `ANTHROPIC_API_KEY` to call the Anthropic API via Promptfoo.

**The key is optional.** When not set:
- LLM assertions are skipped (not failed)
- Non-LLM graders (`exact-match`, `schema`, `tool-call`, `trace-pattern`) run normally
- Skipped assertions are reported separately in output
- CI gate still passes for non-LLM regressions

```bash
# Enable LLM graders locally
export ANTHROPIC_API_KEY=sk-ant-...

# Enable in CI (add to GitHub repo secrets)
# Settings → Secrets → ANTHROPIC_API_KEY
```

**Note:** Claude Code subscriptions use OAuth, not API keys. LLM graders require a separate API key from [console.anthropic.com](https://console.anthropic.com).

## Suite Structure

```text
evals/
├── README.md
├── <skill-name>/
│   ├── suite.json          # Suite config: assertions + datasets
│   └── datasets/
│       ├── regression.jsonl # Known-good traces (must not regress)
│       └── golden.jsonl     # Capability test scenarios
```

## Assertion Types

| Type | Requires API Key | Description |
|------|:---:|---|
| `exact-match` | No | Field-level equality |
| `schema` | No | Zod schema validation |
| `tool-call` | No | Required tool invocations present |
| `trace-pattern` | No | Ordered/unordered pattern matching |
| `llm-rubric` | Yes | LLM judges output against a rubric |
| `llm-similarity` | Yes | LLM-based semantic similarity |
