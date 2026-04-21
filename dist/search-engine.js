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
import { cosineSimilarity, findNearestNeighbors } from './embedding-utils.js';
const DEFAULT_EXCERPT_CHARS = 500;
export class SearchEngine {
    loader;
    active;
    vaultName;
    ollama;
    constructor(loader, vaultName, ollama = null) {
        this.loader = loader;
        this.active = loader.getActiveModel();
        this.vaultName = vaultName;
        this.ollama = ollama;
    }
    setOllama(client) {
        this.ollama = client;
    }
    hasSemantic() {
        return this.ollama !== null;
    }
    // -----------------------------------------------------------------
    // Similar (by existing note or block)
    // -----------------------------------------------------------------
    /**
     * Find items similar to the embedding of an existing note. Granularity
     * selects what populates the result set — blocks give heading-scoped
     * precision, notes give document-level overview.
     */
    getSimilarNotes(notePath, threshold = 0.5, limit = 10, opts = {}) {
        const source = this.loader.getSource(notePath);
        if (!source)
            throw new Error(`Note not found: ${notePath}`);
        const queryVec = source.embeddings[this.active.model_key]?.vec;
        if (!queryVec || queryVec.length === 0) {
            throw new Error(`No embedding for note under active model "${this.active.model_key}": ${notePath}`);
        }
        return this.rankByVector(queryVec, {
            threshold,
            limit,
            granularity: opts.granularity ?? 'block',
            include_excerpt: opts.include_excerpt ?? true,
            excerpt_chars: opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS,
            excludePath: notePath,
        });
    }
    /** Find blocks similar to an existing block identified by `path#heading-chain`. */
    getSimilarBlocks(blockKey, threshold = 0.5, limit = 10, opts = {}) {
        const block = this.loader.getBlock(blockKey);
        if (!block)
            throw new Error(`Block not found: ${blockKey}`);
        const queryVec = block.embeddings[this.active.model_key]?.vec;
        if (!queryVec)
            throw new Error(`No embedding for block under active model: ${blockKey}`);
        return this.rankByVector(queryVec, {
            threshold,
            limit,
            granularity: 'block',
            include_excerpt: opts.include_excerpt ?? true,
            excerpt_chars: opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS,
            excludeBlockKey: blockKey,
        });
    }
    // -----------------------------------------------------------------
    // Raw-vector search (for clients that have their own embedding)
    // -----------------------------------------------------------------
    getEmbeddingNeighbors(embeddingVector, k = 10, threshold = 0.5, opts = {}) {
        if (embeddingVector.length !== this.active.dims) {
            throw new Error(`embedding_vector has ${embeddingVector.length} dims, expected ${this.active.dims} (model: ${this.active.model_key})`);
        }
        return this.rankByVector(embeddingVector, {
            threshold,
            limit: k,
            granularity: opts.granularity ?? 'block',
            include_excerpt: opts.include_excerpt ?? true,
            excerpt_chars: opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS,
        });
    }
    // -----------------------------------------------------------------
    // Query search
    // -----------------------------------------------------------------
    /**
     * Unified query entry point.
     *   - `semantic`: embed via Ollama → cosine at the requested granularity.
     *     If Ollama is not configured, throws — caller can fall back.
     *   - `keyword`: substring scoring over note bodies (note granularity).
     *     Kept for BM25-flavoured recall and as Ollama-less fallback.
     *   - `hybrid`: RRF fusion of the two ranked lists with k=60.
     */
    async searchByQuery(queryText, opts = {}) {
        const mode = opts.mode ?? (this.ollama ? 'hybrid' : 'keyword');
        const limit = opts.limit ?? 10;
        const threshold = opts.threshold ?? 0.5;
        const granularity = opts.granularity ?? 'block';
        const include_excerpt = opts.include_excerpt ?? true;
        const excerpt_chars = opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS;
        const warnings = [];
        if ((mode === 'semantic' || mode === 'hybrid') && !this.ollama) {
            if (mode === 'semantic') {
                warnings.push('semantic requested but Ollama is not configured — falling back to keyword.');
                return { results: this.searchKeyword(queryText, limit, threshold), mode: 'keyword', fallback_from: 'semantic', warnings };
            }
            warnings.push('hybrid requested but Ollama is not configured — using keyword only.');
            return { results: this.searchKeyword(queryText, limit, threshold), mode: 'keyword', fallback_from: 'hybrid', warnings };
        }
        if (mode === 'keyword') {
            return { results: this.searchKeyword(queryText, limit, threshold), mode, warnings };
        }
        // semantic or hybrid — need a query vector
        let queryVec;
        try {
            queryVec = await this.ollama.embed(queryText);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(`Ollama embed failed: ${msg} — falling back to keyword.`);
            return { results: this.searchKeyword(queryText, limit, threshold), mode: 'keyword', fallback_from: mode, warnings };
        }
        const semantic = this.rankByVector(queryVec, {
            threshold: 0, // let RRF see full list; re-apply threshold at the end for pure-semantic
            limit: Math.max(limit * 3, 30),
            granularity,
            include_excerpt,
            excerpt_chars,
        });
        if (mode === 'semantic') {
            return {
                results: semantic.filter((r) => r.similarity >= threshold).slice(0, limit),
                mode,
                warnings,
            };
        }
        // hybrid: RRF over semantic + keyword
        const keyword = this.searchKeyword(queryText, Math.max(limit * 3, 30), 0);
        const fused = rrfFuse([
            { list: semantic, idOf: (h) => resultRefId(h) },
            { list: keyword, idOf: (h) => resultRefId(h) },
        ], limit);
        // Re-use the excerpt-enriched version from the semantic side when available,
        // otherwise fall back to the keyword entry.
        const semById = new Map(semantic.map((h) => [resultRefId(h), h]));
        const results = fused.map(({ id, score }) => {
            const hit = semById.get(id) ?? keyword.find((k) => resultRefId(k) === id);
            return { ...hit, similarity: score };
        });
        return { results, mode, warnings };
    }
    /** Substring-frequency scorer. Note-level only. */
    searchKeyword(queryText, limit, threshold) {
        const results = [];
        const queryLower = queryText.toLowerCase();
        const re = new RegExp(escapeRegex(queryLower), 'gi');
        for (const [p, source] of this.loader.getSources()) {
            try {
                const content = this.loader.readNoteContent(p).toLowerCase();
                const matches = (content.match(re) || []).length;
                if (matches > 0) {
                    const score = Math.min(matches / 10, 1.0);
                    if (score >= threshold) {
                        results.push({
                            path: p,
                            similarity: score,
                            blocks: Object.keys(source.blocks || {}),
                            vault_name: this.vaultName,
                        });
                    }
                }
            }
            catch {
                /* unreadable — ignore */
            }
        }
        return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    }
    // -----------------------------------------------------------------
    // Content access
    // -----------------------------------------------------------------
    getNoteWithContext(notePath, _includeBlocks = []) {
        const content = this.loader.readNoteContent(notePath);
        const source = this.loader.getSource(notePath);
        const availableBlocks = source ? Object.keys(source.blocks || {}) : [];
        return { path: notePath, content, blocks: availableBlocks };
    }
    /**
     * Extract a single block's markdown content. Accepts either the
     * compound block key (`path#heading`) or a split `{path, heading}`.
     * Throws if the block's line range is unknown.
     */
    getBlockContent(args) {
        let path;
        let heading;
        if (args.block_key) {
            const i = args.block_key.indexOf('#');
            if (i <= 0)
                throw new Error('Malformed block_key — expected "<path>#<heading>"');
            path = args.block_key.slice(0, i);
            heading = args.block_key.slice(i);
        }
        else if (args.path && args.heading) {
            path = args.path;
            heading = args.heading.startsWith('#') ? args.heading : `#${args.heading}`;
        }
        else {
            throw new Error('Supply either block_key or both (path, heading)');
        }
        const range = this.loader.resolveBlockRange(path, heading);
        if (!range || range[0] <= 0) {
            throw new Error(`Block line range unknown for ${path}${heading}`);
        }
        const full = this.loader.readNoteContent(path);
        const content = full.split('\n').slice(range[0] - 1, range[1]).join('\n');
        return { path, heading, lines: range, content, vault_name: this.vaultName };
    }
    // -----------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------
    getStats() {
        const sources = this.loader.getSources();
        const blocks = this.loader.getBlocks();
        let totalSourceBlocks = 0;
        for (const src of sources.values()) {
            totalSourceBlocks += Object.keys(src.blocks || {}).length;
        }
        return {
            totalNotes: sources.size,
            totalBlocks: blocks.size,
            totalSourceBlockHeadings: totalSourceBlocks,
            embeddingDimension: this.active.dims,
            modelKey: this.active.model_key,
            providerKey: this.active.provider_key || undefined,
            modelFullKey: this.active.full_key || undefined,
            modelResolution: this.active.resolution,
            vaultName: this.vaultName,
            vaultPath: this.loader.getVaultPath(),
        };
    }
    // -----------------------------------------------------------------
    // Connection graph — nested tree (no more flat list)
    // -----------------------------------------------------------------
    getConnectionGraph(notePath, depth = 2, threshold = 0.6, maxPerLevel = 5) {
        const visited = new Set();
        const build = (currentPath, currentDepth, similarity) => {
            visited.add(currentPath);
            const node = { path: currentPath, depth: currentDepth, similarity, children: [] };
            if (currentDepth >= depth)
                return node;
            try {
                const similar = this.getSimilarNotes(currentPath, threshold, maxPerLevel, {
                    granularity: 'note',
                    include_excerpt: false,
                });
                for (const hit of similar) {
                    if (visited.has(hit.path))
                        continue;
                    node.children.push(build(hit.path, currentDepth + 1, hit.similarity));
                }
            }
            catch {
                // note without embedding — leaf
            }
            return node;
        };
        const root = build(notePath, 0, 1.0);
        // Flatten for back-compat with the ConnectionGraph type, but also expose
        // the nested tree under `tree` so new clients can use it directly.
        const flat = [];
        const walk = (n) => {
            if (n.depth > 0)
                flat.push({ path: n.path, depth: n.depth, similarity: n.similarity });
            for (const c of n.children)
                walk(c);
        };
        walk(root);
        return {
            root: notePath,
            connections: flat,
            // `tree` is an extension that existing ConnectionGraph consumers ignore.
            ...{ tree: root },
        };
    }
    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------
    rankByVector(queryVec, opts) {
        const { granularity, threshold, limit, include_excerpt, excerpt_chars, excludePath, excludeBlockKey } = opts;
        const items = [];
        if (granularity === 'note') {
            for (const [p, src] of this.loader.getSources()) {
                if (excludePath && p === excludePath)
                    continue;
                const v = src.embeddings[this.active.model_key]?.vec;
                if (!v || v.length === 0)
                    continue;
                items.push({ id: p, vec: v, meta: { type: 'note', source: src } });
            }
        }
        else {
            for (const [k, block] of this.loader.getBlocks()) {
                if (excludeBlockKey && k === excludeBlockKey)
                    continue;
                if (excludePath && block.source_path === excludePath)
                    continue;
                const v = block.embeddings[this.active.model_key]?.vec;
                if (!v || v.length === 0)
                    continue;
                items.push({ id: k, vec: v, meta: { type: 'block', block } });
            }
        }
        const neighbors = findNearestNeighbors(queryVec, items, limit, threshold);
        return neighbors.map((n) => {
            const meta = (items.find((it) => it.id === n.id)?.meta);
            if (meta.type === 'note') {
                const src = meta.source;
                const hit = {
                    path: src.path,
                    similarity: n.similarity,
                    blocks: Object.keys(src.blocks || {}),
                    vault_name: this.vaultName,
                };
                if (include_excerpt) {
                    const ex = this.noteExcerpt(src.path, excerpt_chars);
                    if (ex) {
                        hit.excerpt = ex.text;
                        hit.excerpt_truncated = ex.truncated;
                    }
                }
                return hit;
            }
            else {
                const b = meta.block;
                const hit = {
                    path: b.source_path,
                    heading: b.heading,
                    lines: b.lines[0] > 0 ? b.lines : undefined,
                    similarity: n.similarity,
                    vault_name: this.vaultName,
                };
                if (include_excerpt) {
                    const ex = this.blockExcerpt(b, excerpt_chars);
                    if (ex) {
                        hit.excerpt = ex.text;
                        hit.excerpt_truncated = ex.truncated;
                    }
                }
                return hit;
            }
        });
    }
    noteExcerpt(notePath, maxChars) {
        try {
            const full = this.loader.readNoteContent(notePath);
            return truncate(full, maxChars);
        }
        catch {
            return null;
        }
    }
    blockExcerpt(block, maxChars) {
        if (block.lines[0] <= 0)
            return this.noteExcerpt(block.source_path, maxChars);
        try {
            const content = this.loader.readNoteContent(block.source_path);
            const sliced = content.split('\n').slice(block.lines[0] - 1, block.lines[1]).join('\n');
            return truncate(sliced, maxChars);
        }
        catch {
            return null;
        }
    }
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Stable identity for a hit, used to deduplicate across ranked lists in
 * hybrid search. Block-level hits are keyed by `path#heading`, note-level
 * by just `path`.
 */
function resultRefId(hit) {
    return hit.heading ? `${hit.path}${hit.heading}` : hit.path;
}
/**
 * Reciprocal Rank Fusion with k=60 (standard choice). Lists are already
 * sorted by their own relevance. We return the top-N ids with their RRF
 * scores in [0..~0.033]; callers typically replace similarity with this
 * score for display.
 */
function rrfFuse(lists, limit, k = 60) {
    const scores = new Map();
    for (const { list, idOf } of lists) {
        list.forEach((hit, rank) => {
            const id = idOf(hit);
            scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
        });
    }
    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id, score]) => ({ id, score }));
}
// cosineSimilarity is re-exported because older callers imported it from here.
export { cosineSimilarity };
//# sourceMappingURL=search-engine.js.map