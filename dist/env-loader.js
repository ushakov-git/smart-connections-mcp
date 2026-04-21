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
import * as fs from 'fs';
import * as path from 'path';
export function loadDotEnv(filePath) {
    const resolved = filePath
        ? path.resolve(filePath)
        : path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(resolved)) {
        return { loaded: false, path: resolved, keys: [] };
    }
    const raw = fs.readFileSync(resolved, 'utf-8');
    const keys = [];
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        // Don't overwrite values already supplied by the MCP client.
        if (process.env[key] === undefined) {
            process.env[key] = value;
            keys.push(key);
        }
    }
    return { loaded: true, path: resolved, keys };
}
//# sourceMappingURL=env-loader.js.map