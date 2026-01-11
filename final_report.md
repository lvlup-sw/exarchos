## High Priority: Missing Error Handling in API Client

-   **Priority**: High
-   **File**: `plugins/jules/servers/jules-mcp/src/jules-client.ts`, line 32
-   **Description**: The `request` method in `JulesClient` does not properly handle non-JSON responses or network errors. If the API returns an HTML error page or plain text, the `response.json()` call will throw an unhandled exception, crashing the process. The current error handling also discards the HTTP status code, which is critical for debugging.
-   **Suggested Improvement**:
    1.  Wrap the `fetch` call in a `try/catch` block to handle network errors.
    2.  Check the `Content-Type` header before parsing the response. If it's not `application/json`, throw a descriptive error with the raw response body.
    3.  Include the HTTP status code in all thrown errors to provide better context for debugging.

## High Priority: Duplicate Code in Tool Registration

-   **Priority**: High
-   **File**: `plugins/jules/servers/jules-mcp/src/index.ts`, lines 31-231
-   **Description**: The file contains over 200 lines of repetitive boilerplate for registering eight different tools. This violates the DRY principle and makes the code difficult to maintain. Adding or modifying tools requires duplicating large blocks of code.
-   **Suggested Improvement**: Refactor the tool registration logic into a data-driven loop. Iterate over the `toolSchemas` and `toolDescriptions` exported from `tools.ts`, registering each tool programmatically. This will reduce the registration logic to a few lines and make the system more maintainable.

## Medium Priority: Duplicate Code in Tool Error Handling

-   **Priority**: Medium
-   **File**: `plugins/jules/servers/jules-mcp/src/tools.ts`, lines 329-573
-   **Description**: Each of the eight tool implementations in `createJulesTools` contains an identical `try/catch` block for handling Zod validation and other errors. This repeated code increases maintenance overhead.
-   **Suggested Improvement**: Create a higher-order wrapper function that takes a tool's implementation as an argument and returns a new function with the `try/catch` logic already included. This will centralize error handling and remove duplication.

## Medium Priority: Function Exceeding 50 Lines (Complexity)

-   **Priority**: Medium
-   **File**: `plugins/jules/servers/jules-mcp/src/tools.ts`, lines 326-575
-   **Description**: The `createJulesTools` function is over 250 lines long, containing the inline implementation of all eight tools. This makes the function monolithic and difficult to read and maintain.
-   **Suggested Improvement**: Break down the `createJulesTools` function by extracting each tool's implementation into its own separate, named function. This will improve modularity and make the code easier to navigate.

## Low Priority: Function Exceeding 50 Lines (Complexity)

-   **Priority**: Low
-   **File**: `plugins/jules/servers/jules-mcp/src/tools.ts`, lines 135-201
-   **Description**: The `getActivityContent` function is over 50 lines long and uses a long chain of `if` statements to parse different activity types. This pattern is not easily extensible and can become brittle as new activity types are added.
-   **Suggested Improvement**: Refactor the function to use a more scalable, declarative pattern, such as a map or a strategy pattern. This will make the code cleaner, more maintainable, and easier to extend.
