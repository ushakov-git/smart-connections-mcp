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
export interface AjsonParseOptions {
    onError?: (line: string, err: unknown) => void;
}
export declare function parseAjsonLines(content: string, onEntry: (key: string, value: unknown) => void, options?: AjsonParseOptions): void;
//# sourceMappingURL=ajson-parser.d.ts.map