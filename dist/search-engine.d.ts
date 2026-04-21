/**
 * Semantic search engine for Smart Connections MCP.
 *
 * The engine operates over two parallel indexes:
 *   - Notes  (SmartSource, one embedding per note)
 *   - Blocks (SmartBlock, one embedding per heading-scoped section)
 *
 * Every returned hit is enriched with a `ResultRef`:
 *     { path, heading?, lines?, vault_name? }
 * plus `excerpt`/`excerpt_truncated` when `include_excerpt` is set. This
 * lets the calling agent either use the embedding match directly or
 * follow the reference to read the underlying markdown via
 * `get_note_content` / `get_block_content`.
 */
import type { SimilarNote, ConnectionGraph, NoteContent } from './types.js';
import { cosineSimilarity } from './embedding-utils.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';
export type Granularity = 'note' | 'block';
export interface SearchOptions {
    threshold?: number;
    limit?: number;
    granularity?: Granularity;
    include_excerpt?: boolean;
    excerpt_chars?: number;
}
export declare class SearchEngine {
    private loader;
    private active;
    private vaultName?;
    constructor(loader: SmartConnectionsLoader, vaultName?: string);
    /**
     * Find items similar to the embedding of an existing note. Granularity
     * selects what populates the result set — blocks give heading-scoped
     * precision, notes give document-level overview.
     */
    getSimilarNotes(notePath: string, threshold?: number, limit?: number, opts?: Omit<SearchOptions, 'threshold' | 'limit'>): SimilarNote[];
    /** Find blocks similar to an existing block identified by `path#heading-chain`. */
    getSimilarBlocks(blockKey: string, threshold?: number, limit?: number, opts?: Omit<SearchOptions, 'threshold' | 'limit' | 'granularity'>): SimilarNote[];
    getEmbeddingNeighbors(embeddingVector: number[], k?: number, threshold?: number, opts?: Omit<SearchOptions, 'threshold' | 'limit'>): SimilarNote[];
    searchByQuery(queryText: string, limit?: number, threshold?: number): SimilarNote[];
    getNoteWithContext(notePath: string, _includeBlocks?: string[]): NoteContent;
    /**
     * Extract a single block's markdown content. Accepts either the
     * compound block key (`path#heading`) or a split `{path, heading}`.
     * Throws if the block's line range is unknown.
     */
    getBlockContent(args: {
        block_key?: string;
        path?: string;
        heading?: string;
    }): {
        path: string;
        heading: string;
        lines: [number, number];
        content: string;
        vault_name?: string;
    };
    getStats(): {
        totalNotes: number;
        totalBlocks: number;
        totalSourceBlockHeadings: number;
        embeddingDimension: number;
        modelKey: string;
        providerKey: string | undefined;
        modelFullKey: string | undefined;
        modelResolution: "env-override" | "default-model-key" | "autodetect-sources";
        vaultName: string | undefined;
        vaultPath: string;
    };
    getConnectionGraph(notePath: string, depth?: number, threshold?: number, maxPerLevel?: number): ConnectionGraph;
    private rankByVector;
    private noteExcerpt;
    private blockExcerpt;
}
export type { ConnectionGraph };
export { cosineSimilarity };
//# sourceMappingURL=search-engine.d.ts.map