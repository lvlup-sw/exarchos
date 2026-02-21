# Eval Framework

Deterministic and LLM-graded evaluation suites for Exarchos skills.

## Running Evals

```bash
# Local (rich terminal output)
cd servers/exarchos-mcp && echo '{}' | node dist/cli.js eval-run

# CI mode (GitHub Actions annotations)
echo '{"ci": true}' | node dist/cli.js eval-run

# Filter by skill
echo '{"skill": "delegation"}' | node dist/cli.js eval-run
```

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
