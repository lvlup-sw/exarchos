/**
 * Minimal ambient type declarations for `bun:sqlite`.
 *
 * At runtime:
 *   - Under Bun (compiled binary), the import resolves to Bun's built-in module.
 *   - Under Node (vitest), `vitest.config.ts` aliases it to
 *     `src/storage/__shims__/bun-sqlite-node.ts`.
 *
 * This declaration covers only the surface used by `sqlite-backend.ts`:
 * `Database` (constructor + methods actually called) and `Statement` (opaque
 * type alias). Intentionally narrower than `@types/bun`'s full contract to
 * avoid pulling a second, competing `Bun` global into the project.
 */

declare module 'bun:sqlite' {
  export type SQLQueryBinding = string | number | boolean | null | bigint | Uint8Array | Buffer;

  export class Statement<ReturnType = unknown> {
    run(...bindings: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    get(...bindings: unknown[]): ReturnType | undefined;
    all(...bindings: unknown[]): ReturnType[];
    finalize(): void;
  }

  export class Database {
    constructor(filename?: string, options?: Record<string, unknown>);
    prepare<ReturnType = unknown>(sql: string): Statement<ReturnType>;
    query<ReturnType = unknown>(sql: string): Statement<ReturnType>;
    exec(sql: string, ...bindings: unknown[]): void;
    transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void;
    close(): void;
  }
}
