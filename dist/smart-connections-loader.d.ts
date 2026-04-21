/**
 * Loader for Smart Connections data from the `.smart-env` directory.
 *
 * Responsibilities:
 *   1. Read `smart_env.json`.
 *   2. Read `embedding_models/embedding_models.ajson` (new format).
 *   3. Resolve the *active* embedding model key using the priority:
 *        env SMART_EMBED_MODEL_KEY  →  smart_env.json `embedding_models.default_model_key`
 *                                   →  autodetect most-frequent key in sources
 *   4. Load `multi/*.ajson`, keeping only `smart_sources:` entries that
 *      actually carry a vector under the active model. Everything else is
 *      skipped and counted (diagnostics only).
 *   5. Detect the true embedding dimension from the first non-empty vec —
 *      metadata `dims` in the plugin is known to lie (e.g. bge-m3 is 1024
 *      but the plugin records 384).
 */
import type { SmartSource, SmartEnvConfig, ActiveModel } from './types.js';
export interface LoadStats {
    sourceFilesScanned: number;
    sourcesKept: number;
    sourcesReplaced: number;
    sourcesSkippedNoEmbedding: number;
    sourcesSkippedNullPath: number;
    parseErrors: number;
}
export declare class SmartConnectionsLoader {
    private vaultPath;
    private smartEnvPath;
    private config;
    private sources;
    private embeddingModels;
    private active;
    private stats;
    constructor(vaultPath: string);
    initialize(): Promise<void>;
    private loadConfig;
    /**
     * Priority:
     *   1. env SMART_EMBED_MODEL_KEY (accepts full key `provider#ts` or bare `model_key`)
     *   2. smart_env.json `embedding_models.default_model_key`
     *   3. autodetect — scan first ~20 source files, pick the most common
     *      embedding key observed in source entries.
     *
     * No legacy fallback to `smart_sources.embed_model` — the new-format
     * plugin leaves that field stale and it is actively misleading.
     */
    private resolveActiveModel;
    private buildActiveFromHint;
    /**
     * Scan up to N `.ajson` files and count the most frequently used embedding
     * key across `smart_sources:*.embeddings`. Tie-break: first seen wins.
     */
    private autodetectActiveModel;
    private loadSources;
    private finalizeDims;
    private logStartupDiagnostics;
    getSources(): Map<string, SmartSource>;
    getSource(notePath: string): SmartSource | undefined;
    getConfig(): SmartEnvConfig | null;
    getActiveModel(): ActiveModel;
    /** @deprecated Kept for compatibility during migration; prefer getActiveModel().model_key. */
    getEmbeddingModelKey(): string;
    getVaultPath(): string;
    getLoadStats(): LoadStats;
    /**
     * Read a markdown note's content. `notePath` is vault-relative.
     * Path-traversal containment is enforced: the resolved target must lie
     * strictly within the vault root (symlinks resolved).
     */
    readNoteContent(notePath: string): string;
    extractBlockContent(notePath: string, blockHeading: string): string;
    /**
     * Join `notePath` onto the vault root and assert containment. Rejects
     * absolute paths, `..` escapes, and symlinks that point outside.
     */
    private resolveInsideVault;
}
//# sourceMappingURL=smart-connections-loader.d.ts.map