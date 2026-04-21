/**
 * AJSON parser for Smart Connections .ajson files.
 *
 * Format note: each non-empty line is a single top-level property like
 *     "collection:some_key": {...},
 * with a trailing comma. That is NOT valid JSON; the plugin uses this
 * append-friendly format so it can stream-write entries. To parse it we
 * strip the trailing comma and wrap the remainder in `{}`.
 *
 * The callback receives each `(key, value)` pair. Unparsable lines are
 * reported via `onError` but do not abort the scan.
 */
export function parseAjsonLines(content, onEntry, options = {}) {
    const lines = content.split('\n');
    for (const raw of lines) {
        const line = raw.trim();
        if (!line)
            continue;
        try {
            const cleaned = line.replace(/,\s*$/, '');
            const obj = JSON.parse(`{${cleaned}}`);
            for (const key of Object.keys(obj)) {
                onEntry(key, obj[key]);
            }
        }
        catch (err) {
            options.onError?.(line, err);
        }
    }
}
//# sourceMappingURL=ajson-parser.js.map