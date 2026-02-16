---
name: dotnet-standards
description: ".NET and C# coding standards, conventions, and project configuration. Use when working with .cs files, .NET projects, C# codebases, or the user says \"check .NET standards\". Provides SOLID constraints, naming conventions, error handling patterns, and project structure guidelines specific to the .NET ecosystem. Do NOT use for TypeScript or non-.NET projects."
metadata:
  author: exarchos
  version: 1.0.0
  category: standards
---

# .NET Standards Skill

Validates and enforces Levelup Software C# project standards across repositories.

## Commands

### `/dotnet-standards validate [path]`

Check project compliance against standards.

**Usage:**
```bash
/dotnet-standards validate              # Validate current directory
/dotnet-standards validate ./my-project # Validate specific path
```

**Reports:**
- Missing or outdated configuration files
- Directory structure violations
- Package version drift
- Analyzer configuration issues

### `/dotnet-standards sync [path]`

Interactive sync of configuration files.

**Usage:**
```bash
/dotnet-standards sync                  # Sync current directory
/dotnet-standards sync ./my-project     # Sync specific path
```

**Behavior:**
- Shows diff before applying changes
- Preserves project-local overrides (content below `=== PROJECT-LOCAL` markers)
- Updates to latest template versions
- Creates backup of modified files

### `/dotnet-standards scaffold <name> [--namespace <ns>] [--company <name>]`

Create new project with standard structure.

**Usage:**
```bash
/dotnet-standards scaffold MyProject
/dotnet-standards scaffold MyProject --namespace Lvlup.MyProject
/dotnet-standards scaffold MyProject --company "Ares Elite Sports Vision"
```

**Creates:**
- Standard directory layout (src/, docs/, .github/, scripts/)
- Configuration files from templates
- Solution file (.sln) and initial project structure
- README.md and LICENSE files

**Defaults:**
- Namespace: `{ProjectName}`
- Company: "Levelup Software"

---

## Project Structure Validation

Run .NET standards compliance check:

```bash
scripts/validate-dotnet-standards.sh --project-root <path>
```

**On exit 0:** Project is compliant.
**On exit 1:** Violations found — fix before proceeding.

### What It Checks

- `Directory.Build.props` exists in `src/`
- `Directory.Packages.props` exists with `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`
- `.editorconfig` exists in `src/`
- `global.json` exists with SDK version specified
- No individual `<PackageReference>` with `Version` attribute in `.csproj` files (CPM requires versions in `Directory.Packages.props`)

---

## Templates

Templates are stored in `~/.claude/skills/dotnet-standards/templates/`

### Placeholder Substitution

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{PROJECT_NAME}}` | Project name | `MyProject` |
| `{{NAMESPACE}}` | Root namespace | `Lvlup.MyProject` |
| `{{COMPANY_NAME}}` | Company for copyright | `Levelup Software` |

### Override Markers

Templates contain markers for project-local customization:

```xml
<!-- === PROJECT-LOCAL OVERRIDES BELOW === -->
```

Content below these markers is preserved during sync operations.

---

## Standard Directory Structure

```
{ProjectName}/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── release.yml
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md
│       └── feature_request.md
├── src/
│   ├── {ProjectName}.Core/
│   │   ├── Abstractions/
│   │   ├── Models/
│   │   └── {ProjectName}.Core.csproj
│   ├── {ProjectName}.Core.Tests/
│   │   └── {ProjectName}.Core.Tests.csproj
│   ├── Directory.Build.props
│   ├── Directory.Packages.props
│   ├── stylecop.json
│   ├── .editorconfig
│   ├── global.json
│   └── {ProjectName}.sln
├── docs/
│   ├── architecture/
│   ├── development/
│   └── adrs/
├── scripts/
├── README.md
├── LICENSE
└── .gitignore
```

---

## Validation Implementation

When `/dotnet-standards validate` is invoked:

1. **Locate src/ directory** - Find the source root (current dir or specified path)

2. **Check required files exist:**
   ```bash
   # Files that must exist in src/
   src/Directory.Build.props
   src/Directory.Packages.props
   src/stylecop.json
   src/.editorconfig
   src/global.json
   src/*.sln
   ```

3. **Check required directories exist:**
   ```bash
   src/
   docs/
   .github/workflows/
   ```

4. **Validate Directory.Build.props:**
   - Contains `<PackageReference Include="Lvlup.Build"`
   - Contains `<Nullable>enable</Nullable>`

5. **Validate Directory.Packages.props:**
   - Contains `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`

6. **Validate .editorconfig:**
   - Has `root = true`
   - Has `end_of_line = crlf`

7. **Compare against templates:**
   - Report differences (excluding project-local sections)
   - Flag outdated versions

8. **Output report:**
   ```
   === .NET Standards Validation Report ===

   Path: /path/to/project

   [ERROR] Missing file: src/global.json
   [WARN]  Outdated: src/.editorconfig (template v2.0, project v1.0)
   [INFO]  Consider adding: .github/ISSUE_TEMPLATE/

   Summary: 1 error, 1 warning, 1 info
   ```

---

## Sync Implementation

When `/dotnet-standards sync` is invoked:

1. **Run validation first** - Identify what needs syncing

2. **For each outdated/missing file:**
   - Show diff between template and current file
   - Preserve content below `=== PROJECT-LOCAL` markers
   - Ask for confirmation before applying

3. **Create backups:**
   - Save original files to `.backup/` before modifying

4. **Apply changes:**
   - Copy template content
   - Restore project-local sections
   - Replace placeholders with actual values

---

## Scaffold Implementation

When `/dotnet-standards scaffold` is invoked:

1. **Parse arguments:**
   - `<name>`: Required project name
   - `--namespace`: Optional, defaults to project name
   - `--company`: Optional, defaults to "Levelup Software"

2. **Create directory structure:**
   ```bash
   mkdir -p {name}/.github/workflows
   mkdir -p {name}/.github/ISSUE_TEMPLATE
   mkdir -p {name}/src/{name}.Core/Abstractions
   mkdir -p {name}/src/{name}.Core/Models
   mkdir -p {name}/src/{name}.Core.Tests
   mkdir -p {name}/docs/architecture
   mkdir -p {name}/docs/development
   mkdir -p {name}/docs/adrs
   mkdir -p {name}/scripts
   ```

3. **Copy and process templates:**
   - Replace `{{PROJECT_NAME}}` with project name
   - Replace `{{NAMESPACE}}` with namespace
   - Replace `{{COMPANY_NAME}}` with company name

4. **Create solution and projects:**
   ```bash
   cd {name}/src
   dotnet new sln -n {name}
   dotnet new classlib -n {name}.Core -o {name}.Core
   dotnet new classlib -n {name}.Core.Tests -o {name}.Core.Tests
   dotnet sln add {name}.Core/{name}.Core.csproj
   dotnet sln add {name}.Core.Tests/{name}.Core.Tests.csproj
   ```

5. **Initialize git:**
   ```bash
   cd {name}
   git init
   ```
