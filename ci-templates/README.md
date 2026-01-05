# CI/CD Templates

Reusable CI/CD components for GitHub Actions with Blacksmith runners.

## Coverage Gate

The coverage gate script enforces code coverage thresholds and posts PR comments with coverage summaries.

### Features

- Parses Cobertura XML coverage reports
- Enforces configurable coverage threshold (default: 80%)
- Posts PR comment with coverage badge and per-project breakdown
- Sets GitHub Actions outputs for integration with other steps
- Portable: uses grep/sed/awk (no xmllint required)

### Quick Start

1. **Copy the script to your project:**

```bash
mkdir -p your-project/scripts/ci
cp coverage-gate/coverage-gate.sh your-project/scripts/ci/
chmod +x your-project/scripts/ci/coverage-gate.sh
```

2. **Copy the workflow template:**

```bash
mkdir -p your-project/.github/workflows
cp workflows/ci-dotnet.yml your-project/.github/workflows/ci.yml
```

3. **Update the workflow:**

Edit `ci.yml` and update:
- `SOLUTION_PATH` to your solution file
- `COVERAGE_THRESHOLD` if you want a different threshold
- `DOTNET_VERSION` if using a different .NET version

4. **Configure branch protection:**

In GitHub Settings > Branches > Branch protection rules:
- Add `coverage-gate` as a required status check

### Script Usage

```bash
./coverage-gate.sh [OPTIONS]

Options:
  --coverage-file <path>   Path to merged cobertura XML (default: ./coverage-merged/Cobertura.xml)
  --threshold <percent>    Minimum line coverage required (default: 80)
  --output-dir <path>      Directory for generated files (default: ./coverage-merged)

Exit codes:
  0 - Coverage meets threshold
  1 - Coverage below threshold
  2 - Error (missing file, parse error)
```

### PR Comment Format

The script generates a markdown file (`pr-comment.md`) with:

```markdown
## Coverage Report

![Coverage](https://img.shields.io/badge/coverage-85.20%25-brightgreen)

### Summary

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| Line Coverage | 85.20% | 80% | PASS |
| Branch Coverage | 78.20% | - | - |

### Per-Project Breakdown

| Project | Coverage |
|---------|----------|
| MyProject.Core | 92.10% |
| MyProject.Api | 84.30% |
```

### GitHub Actions Outputs

When running in GitHub Actions, the script sets these outputs:

| Output | Description |
|--------|-------------|
| `line-coverage` | Line coverage percentage |
| `branch-coverage` | Branch coverage percentage |
| `gate-status` | `PASS` or `FAIL` |

### Integration with CodeRabbit

The coverage gate works alongside CodeRabbit's SPEC COMPLIANCE check:

| Check | Threshold | Enforcement |
|-------|-----------|-------------|
| Coverage Gate (CI) | 80% line | Blocks merge |
| CodeRabbit SPEC COMPLIANCE | 80% line, 70% branch | PR comment |

Both thresholds are aligned at 80% line coverage.

### Dependencies

| Tool | Purpose | Notes |
|------|---------|-------|
| grep, sed, awk | XML parsing | Pre-installed on all runners |
| dotnet-coverage | Collect coverage | Installed via `dotnet tool` |
| ReportGenerator | Merge reports | Installed via `dotnet tool` |
| gh CLI | Post PR comments | Pre-installed on GitHub runners |

### Running Tests

```bash
./coverage-gate/coverage-gate.test.sh
```

### File Structure

```
ci-templates/
├── README.md                         # This file
├── coverage-gate/
│   ├── coverage-gate.sh              # Main script
│   ├── coverage-gate.test.sh         # Tests
│   ├── pr-comment.md.template        # PR comment template reference
│   └── fixtures/
│       └── sample-coverage.xml       # Test fixture
├── templates/
│   └── global.json                   # MTP runner config for .NET 10+
└── workflows/
    └── ci-dotnet.yml                 # .NET CI workflow template
```

## Workflow Templates

### ci-dotnet.yml

Complete CI workflow for .NET projects:

- **build-test**: Build and test with coverage collection
- **coverage-gate**: Enforce coverage threshold, post PR comment
- **update-baseline**: Cache coverage on main merge (optional)

#### .NET 10 Compatibility

This workflow uses `dotnet-coverage` tool for code coverage collection, which is compatible with both VSTest and Microsoft Testing Platform.

**Requirements:**
1. Add `global.json` with MTP runner config (see `templates/global.json`)
2. No special packages needed in test projects - coverage is collected externally

#### Customization

| Variable | Default | Description |
|----------|---------|-------------|
| `DOTNET_VERSION` | `10.0.x` | .NET SDK version |
| `DOTNET_QUALITY` | `preview` | SDK quality (preview, ga) |
| `SOLUTION_PATH` | `src/YourSolution.sln` | Path to solution file |
| `COVERAGE_THRESHOLD` | `80` | Minimum coverage percentage |

#### Runner

Uses Blacksmith runners (`blacksmith-4vcpu-ubuntu-2204`) for:
- 2x faster builds vs GitHub runners
- 40x faster Docker builds (NVMe caching)
- 75% cost reduction

To use GitHub runners instead, change `runs-on` to `ubuntu-latest`.
