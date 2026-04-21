/**
 * Zero-dependency .env loader.
 *
 * Reads a .env file next to the process cwd (or explicit path) and writes
 * entries into process.env *without overwriting* values already set by the
 * MCP client config. This lets a user keep a .env next to each vault and
 * reference it from their MCP-client config, OR keep using inline `env:`
 * values in the client config — both work, client config wins.
 *
 * Supported syntax (intentionally minimal):
 *   - KEY=VALUE
 *   - KEY="VALUE with spaces"
 *   - KEY='VALUE with spaces'
 *   - Lines starting with `#` are comments.
 *   - Blank lines are ignored.
 *   - Trailing whitespace is trimmed from unquoted values.
 *
 * No variable interpolation, no multiline values, no export prefixes.
 * If the file doesn't exist we silently continue.
 */
export declare function loadDotEnv(filePath?: string): {
    loaded: boolean;
    path: string;
    keys: string[];
};
//# sourceMappingURL=env-loader.d.ts.map