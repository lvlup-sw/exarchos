# Security Audit Report

## 1. Path Traversal in Jules Client

- **Severity**: Medium
- **File path**: `plugins/jules/servers/jules-mcp/src/jules-client.ts`, line 69 (getSession)
- **Description**: The `JulesClient` class concatenates the `sessionId` directly into the URL path without sufficient validation or encoding. The `normalizeSessionId` method only removes the `sessions/` prefix but allows path traversal characters (`..`). An attacker providing a malicious `sessionId` (e.g., `../other-resource`) can cause the client to make requests to unintended API endpoints.
- **Recommended Fix**:
  1.  Validate that `sessionId` matches the expected format (e.g., UUID or `sessions/UUID`).
  2.  Use `encodeURIComponent` when constructing the URL path.

  ```typescript
  // Example Fix
  private normalizeSessionId(sessionId: string): string {
    const id = sessionId.replace(/^sessions\//, '');
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      throw new Error('Invalid session ID format');
    }
    return id;
  }
  ```

## 2. Potential Arbitrary Code Execution via Config Sourcing

- **Severity**: Low
- **File path**: `hooks/workflow-notify.sh`, line 38
- **Description**: The script executes `source "$CONFIG_FILE"` to load configuration. If the configuration file (`~/.config/workflow-gateway/config`) is writable by an attacker, they can inject arbitrary shell commands that will be executed when this hook runs.
- **Recommended Fix**: Parse the configuration file safely instead of executing it.

  ```bash
  # Example Fix
  if [[ -f "$CONFIG_FILE" ]]; then
      # Read only known keys
      GATEWAY_URL=$(grep "^WORKFLOW_GATEWAY_URL=" "$CONFIG_FILE" | cut -d= -f2-)
      GATEWAY_TOKEN=$(grep "^WORKFLOW_GATEWAY_TOKEN=" "$CONFIG_FILE" | cut -d= -f2-)
  fi
  ```

## 3. Insecure File Write in Workflow Script

- **Severity**: Low
- **File path**: `scripts/workflow-state.sh`, line 42 (`resolve_state_file`) and line 73 (`cat > "$state_file"`)
- **Description**: The `resolve_state_file` function accepts absolute paths. The `init` command writes to the resolved path. While it checks for file existence to prevent overwriting, this behavior could be abused to create files in system directories (if permissions allow) or pollute the filesystem.
- **Recommended Fix**: Restrict state files to the `docs/workflow-state` directory or a specific allowed path. Reject absolute paths or sanitize them to ensure they are within the repository.

## 4. Weak Input Validation in MCP Tools

- **Severity**: Low
- **File path**: `plugins/jules/servers/jules-mcp/src/tools.ts`, line 16
- **Description**: The Zod schemas for tools like `jules_check_status` only validate that `sessionId` is a non-empty string. This allows potentially malicious strings to be passed to the `JulesClient`, contributing to the path traversal issue.
- **Recommended Fix**: Define a stricter schema for `sessionId`.

  ```typescript
  const sessionIdSchema = z.string().regex(/^sessions\/[a-zA-Z0-9-]+$|^[a-zA-Z0-9-]+$/, 'Invalid session ID format');
  ```
