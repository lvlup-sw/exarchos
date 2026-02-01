# Security Audit Report

## 1. JSON Injection in `install.sh`

- **Severity:** Medium
- **File path:** `scripts/install.sh:125`
- **Description:**
  The script injects the `$MCP_SERVER_PATH` variable directly into a `jq` filter string. If the repository is cloned into a directory with a name containing unescaped quotes (e.g., `repo", "injected": "val`), it allows for JSON injection into the user's `~/.claude.json` configuration file. This could allow an attacker to inject arbitrary configuration or overwrite existing settings if they can convince a user to clone the repository into a malicious path.
- **Recommended Fix:**
  Use `jq`'s `--arg` parameter to pass the variable safely instead of string concatenation.
  ```bash
  jq --arg path "$MCP_SERVER_PATH/dist/index.js" \
     --arg key "${JULES_API_KEY}" \
     '.mcpServers //= {} | .mcpServers.jules = {
         "type": "stdio",
         "command": "node",
         "args": [$path],
         "env": {
             "JULES_API_KEY": $key
         }
     }' "$HOME/.claude.json"
  ```

## 2. JSON Injection in `workflow-state.sh`

- **Severity:** Low
- **File path:** `scripts/workflow-state.sh:70` (function `cmd_init`)
- **Description:**
  The `cmd_init` function (specifically in the `cat` here-doc blocks around lines 89 and 129) injects the `feature_id` argument directly into a JSON structure. If the `feature_id` contains quotes, it can corrupt the JSON structure or inject arbitrary fields. While this is likely a local tool, it presents a robustness issue and potential vector if inputs are derived from untrusted sources.
- **Recommended Fix:**
  Use `jq` to construct the initial JSON object safely.

## 3. Insecure Credential Storage Recommendation

- **Severity:** Low
- **File path:** `scripts/install.sh:43`
- **Description:**
  The installation script recommends users to append their `JULES_API_KEY` to `~/.zshrc` using `echo 'export ...' >> ~/.zshrc`. This results in the API key being stored in plaintext on the disk, which is readable by any process running as the user. It also leaves the key in the shell history file if the command is executed directly.
- **Recommended Fix:**
  Recommend users to use a secrets manager or set the environment variable only for the current session. If persistence is needed, suggest ensuring the configuration file has restricted permissions (`chmod 600`).

## 4. Fragile XML Parsing in `coverage-gate.sh`

- **Severity:** Low
- **File path:** `ci-templates/coverage-gate/coverage-gate.sh:28`
- **Description:**
  The script uses `grep`, `sed`, and `awk` to parse XML coverage reports. This approach is fragile and relies on the XML having a specific layout (e.g., attributes on the same line). It can be easily broken by valid XML changes or exploited if the XML input is controlled by an attacker to bypass coverage gates.
- **Recommended Fix:**
  Use a dedicated XML parser like `xmllint` or a small script in a language with XML support (e.g., Python, Node.js) to parse the coverage report reliably.
