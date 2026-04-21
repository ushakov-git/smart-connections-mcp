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

import type {
  SmartSource,
  SmartBlock,
  SimilarNote,
  ConnectionGraph,
  NoteContent,
  ActiveModel,
} from './types.js';
import { cosineSimilarity, findNearestNeighbors } from './embedding-utils.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';
import type { OllamaClient } from './ollama-client.js';

export type Granularity = 'note' | 'block';
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

export interface SearchOptions {
  threshold?: number;
  limit?: number;
  granularity?: Granularity;
  include_excerpt?: boolean;
  excerpt_chars?: number;
}

const DEFAULT_EXCERPT_CHARS = 500;

/**
 * Tunable parameters of the hybrid Reciprocal Rank Fusion step.
 *
 * Note on semantics:
 *   - `k` is a smoothing constant — it is applied identically to both
 *     the semantic and the keyword ranked lists, so changing `k` alone
 *     does NOT shift the balance between them. It just narrows the gap
 *     between adjacent ranks (larger k → flatter score curve).
 *   - `semantic_weight` / `keyword_weight` DO shift the balance. The
 *     fused score is
 *        score(id) = w_sem * Σ_semantic(1 / (k + rank + 1))
 *                  + w_kw  * Σ_keyword (1 / (k + rank + 1))
 *     Increase `semantic_weight` (e.g. 0.8 vs keyword 0.2) when you
 *     want embeddings to dominate; increase `keyword_weight` when you
 *     search mostly for rare names, quotations or acronyms that a
 *     general-purpose embedder may miss.
 */
export interface FusionOptions {
  k?: number;
  semantic_weight?: number;
  keyword_weight?: number;
}

export class SearchEngine {
  private loader: SmartConnectionsLoader;
  private active: ActiveModel;
  private vaultName?: string;
  private ollama: OllamaClient | null;
  private fusion: Required<FusionOptions>;

  constructor(
    loader: SmartConnectionsLoader,
    vaultName?: string,
    ollama: OllamaClient | null = null,
    fusion: FusionOptions = {},
  ) {
    this.loader = loader;
    this.active = loader.getActiveModel();
    this.vaultName = vaultName;
    this.ollama = ollama;
    this.fusion = {
      k: fusion.k ?? 60,
      semantic_weight: fusion.semantic_weight ?? 0.7,
      keyword_weight: fusion.keyword_weight ?? 0.3,
    };
  }

  setOllama(client: OllamaClient | null): void {
    this.ollama = client;
  }

  hasSemantic(): boolean {
    return this.ollama !== null;
  }

  getFusionConfig(): Required<FusionOptions> {
    return { ...this.fusion };
  }

  // -----------------------------------------------------------------
  // Similar (by existing note or block)
  // -----------------------------------------------------------------

  /**
   * Find items similar to the embedding of an existing note. Granularity
   * selects what populates the result set — blocks give heading-scoped
   * precision, notes give document-level overview.
   */
  getSimilarNotes(
    notePath: string,
    threshold = 0.5,
    limit = 10,
    opts: Omit<SearchOptions, 'threshold' | 'limit'> = {},
  ): SimilarNote[] {
    const source = this.loader.getSource(notePath);
    if (!source) throw new Error(`Note not found: ${notePath}`);
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
  getSimilarBlocks(
    blockKey: string,
    threshold = 0.5,
    limit = 10,
    opts: Omit<SearchOptions, 'threshold' | 'limit' | 'granularity'> = {},
  ): SimilarNote[] {
    const block = this.loader.getBlock(blockKey);
    if (!block) throw new Error(`Block not found: ${blockKey}`);
    const queryVec = block.embeddings[this.active.model_key]?.vec;
    if (!queryVec) throw new Error(`No embedding for block under active model: ${blockKey}`);
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

  getEmbeddingNeighbors(
    embeddingVector: number[],
    k = 10,
    threshold = 0.5,
    opts: Omit<SearchOptions, 'threshold' | 'limit'> = {},
  ): SimilarNote[] {
    if (embeddingVector.length !== this.active.dims) {
      throw new Error(
        `embedding_vector has ${embeddingVector.length} dims, expected ${this.active.dims} (model: ${this.active.model_key})`,
      );
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
  async searchByQuery(
    queryText: string,
    opts: {
      mode?: SearchMode;
      limit?: number;
      threshold?: number;
      granularity?: Granularity;
      include_excerpt?: boolean;
      excerpt_chars?: number;
    } = {},
  ): Promise<{ results: SimilarNote[]; mode: SearchMode; fallback_from?: SearchMode; warnings: string[] }> {
    const mode: SearchMode = opts.mode ?? (this.ollama ? 'hybrid' : 'keyword');
    const limit = opts.limit ?? 10;
    const threshold = opts.threshold ?? 0.5;
    const granularity: Granularity = opts.granularity ?? 'block';
    const include_excerpt = opts.include_excerpt ?? true;
    const excerpt_chars = opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS;
    const warnings: string[] = [];

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
    let queryVec: number[];
    try {
      queryVec = await this.ollama!.embed(queryText);
    } catch (err) {
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

    // hybrid: weighted RRF over semantic + keyword
    const keyword = this.searchKeyword(queryText, Math.max(limit * 3, 30), 0);
    const fused = rrfFuse(
      [
        { list: semantic, idOf: (h) => resultRefId(h), weight: this.fusion.semantic_weight },
        { list: keyword, idOf: (h) => resultRefId(h), weight: this.fusion.keyword_weight },
      ],
      limit,
      this.fusion.k,
    );
    // Re-use the excerpt-enriched version from the semantic side when available,
    // otherwise fall back to the keyword entry.
    const semById = new Map(semantic.map((h) => [resultRefId(h), h] as const));
    const results = fused.map(({ id, score }) => {
      const hit = semById.get(id) ?? keyword.find((k) => resultRefId(k) === id)!;
      return { ...hit, similarity: score };
    });
    return { results, mode, warnings };
  }

  /** Substring-frequency scorer. Note-level only. */
  private searchKeyword(queryText: string, limit: number, threshold: number): SimilarNote[] {
    const results: SimilarNote[] = [];
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
      } catch {
        /* unreadable — ignore */
      }
    }
    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  // -----------------------------------------------------------------
  // Content access
  // -----------------------------------------------------------------

  getNoteWithContext(notePath: string, _includeBlocks: string[] = []): NoteContent {
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
  getBlockContent(args: { block_key?: string; path?: string; heading?: string }): {
    path: string;
    heading: string;
    lines: [number, number];
    content: string;
    vault_name?: string;
  } {
    let path: string;
    let heading: string;
    if (args.block_key) {
      const i = args.block_key.indexOf('#');
      if (i <= 0) throw new Error('Malformed block_key — expected "<path>#<heading>"');
      path = args.block_key.slice(0, i);
      heading = args.block_key.slice(i);
    } else if (args.path && args.heading) {
      path = args.path;
      heading = args.heading.startsWith('#') ? args.heading : `#${args.heading}`;
    } else {
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

  getConnectionGraph(
    notePath: string,
    depth = 2,
    threshold = 0.6,
    maxPerLevel = 5,
  ): ConnectionGraph {
    const visited = new Set<string>();

    type Node = {
      path: string;
      depth: number;
      similarity: number;
      children: Node[];
    };

    const build = (currentPath: string, currentDepth: number, similarity: number): Node => {
      visited.add(currentPath);
      const node: Node = { path: currentPath, depth: currentDepth, similarity, children: [] };
      if (currentDepth >= depth) return node;
      try {
        const similar = this.getSimilarNotes(currentPath, threshold, maxPerLevel, {
          granularity: 'note',
          include_excerpt: false,
        });
        for (const hit of similar) {
          if (visited.has(hit.path)) continue;
          node.children.push(build(hit.path, currentDepth + 1, hit.similarity));
        }
      } catch {
        // note without embedding — leaf
      }
      return node;
    };

    const root = build(notePath, 0, 1.0);

    // Flatten for back-compat with the ConnectionGraph type, but also expose
    // the nested tree under `tree` so new clients can use it directly.
    const flat: ConnectionGraph['connections'] = [];
    const walk = (n: Node) => {
      if (n.depth > 0) flat.push({ path: n.path, depth: n.depth, similarity: n.similarity });
      for (const c of n.children) walk(c);
    };
    walk(root);

    return {
      root: notePath,
      connections: flat,
      // `tree` is an extension that existing ConnectionGraph consumers ignore.
      ...({ tree: root } as object),
    } as ConnectionGraph;
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private rankByVector(
    queryVec: number[],
    opts: {
      threshold: number;
      limit: number;
      granularity: Granularity;
      include_excerpt: boolean;
      excerpt_chars: number;
      excludePath?: string;
      excludeBlockKey?: string;
    },
  ): SimilarNote[] {
    const { granularity, threshold, limit, include_excerpt, excerpt_chars, excludePath, excludeBlockKey } = opts;

    const items: Array<{ id: string; vec: number[]; meta: { type: 'note' | 'block'; source?: SmartSource; block?: SmartBlock } }> = [];

    if (granularity === 'note') {
      for (const [p, src] of this.loader.getSources()) {
        if (excludePath && p === excludePath) continue;
        const v = src.embeddings[this.active.model_key]?.vec;
        if (!v || v.length === 0) continue;
        items.push({ id: p, vec: v, meta: { type: 'note', source: src } });
      }
    } else {
      for (const [k, block] of this.loader.getBlocks()) {
        if (excludeBlockKey && k === excludeBlockKey) continue;
        if (excludePath && block.source_path === excludePath) continue;
        const v = block.embeddings[this.active.model_key]?.vec;
        if (!v || v.length === 0) continue;
        items.push({ id: k, vec: v, meta: { type: 'block', block } });
      }
    }

    const neighbors = findNearestNeighbors(queryVec, items, limit, threshold);
    return neighbors.map((n) => {
      const meta = (items.find((it) => it.id === n.id)?.meta) as {
        type: 'note' | 'block';
        source?: SmartSource;
        block?: SmartBlock;
      };
      if (meta.type === 'note') {
        const src = meta.source!;
        const hit: SimilarNote = {
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
      } else {
        const b = meta.block!;
        const hit: SimilarNote = {
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

  private noteExcerpt(notePath: string, maxChars: number): { text: string; truncated: boolean } | null {
    try {
      const full = this.loader.readNoteContent(notePath);
      return truncate(full, maxChars);
    } catch {
      return null;
    }
  }

  private blockExcerpt(block: SmartBlock, maxChars: number): { text: string; truncated: boolean } | null {
    if (block.lines[0] <= 0) return this.noteExcerpt(block.source_path, maxChars);
    try {
      const content = this.loader.readNoteContent(block.source_path);
      const sliced = content.split('\n').slice(block.lines[0] - 1, block.lines[1]).join('\n');
      return truncate(sliced, maxChars);
    } catch {
      return null;
    }
  }
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stable identity for a hit, used to deduplicate across ranked lists in
 * hybrid search. Block-level hits are keyed by `path#heading`, note-level
 * by just `path`.
 */
function resultRefId(hit: SimilarNote): string {
  return hit.heading ? `${hit.path}${hit.heading}` : hit.path;
}

/**
 * Weighted Reciprocal Rank Fusion. Each ranked list contributes
 *   weight * 1 / (k + rank + 1)
 * to every item it contains, and items' contributions sum across lists.
 *
 * `k` is a smoothing constant shared by all lists — it does not shift
 * the balance between them. To tilt the fusion toward one list, change
 * its `weight` (see FusionOptions in the SearchEngine for details).
 */
function rrfFuse(
  lists: Array<{ list: SimilarNote[]; idOf: (h: SimilarNote) => string; weight?: number }>,
  limit: number,
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const { list, idOf, weight = 1 } of lists) {
    list.forEach((hit, rank) => {
      const id = idOf(hit);
      scores.set(id, (scores.get(id) ?? 0) + weight * (1 / (k + rank + 1)));
    });
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}

// Unused imports kept-away from eslint-nopunctuation by referencing types.
export type { ConnectionGraph };
// cosineSimilarity is re-exported because older callers imported it from here.
export { cosineSimilarity };
