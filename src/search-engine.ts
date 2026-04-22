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
  HitExpansion,
} from './types.js';
import { cosineSimilarity, findNearestNeighbors } from './embedding-utils.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';
import type { OllamaClient } from './ollama-client.js';

export type Granularity = 'note' | 'block';
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';
export type ExpandMode = 'never' | 'high-similarity' | 'always';

/**
 * Post-processing knobs applied to ranked hits before returning.
 *
 * `deduplicate_by_section` groups block-level hits that share the same
 * `##`- (or `###`-) ancestor: the best-similarity hit is kept, the rest
 * move into that hit's `sibling_matches`.
 *
 * `expand_to_section` upgrades a hit's payload by reading the full
 * markdown of a parent section:
 *   - in `"high-similarity"` mode we expand when similarity ≥
 *     `expand_threshold`, OR when the heading ends with a `#{N}`
 *     fragment suffix (those are almost always topic-phrases without
 *     enough content in the excerpt).
 *   - in `"always"` we expand every block-level hit.
 *   - in `"never"` we leave the payload unchanged.
 *
 * Both features are opt-in. They apply to block-level hits only; note
 * granularity is passed through unchanged.
 */
export interface HitPostProcessOptions {
  expand_to_section?: ExpandMode;
  expand_threshold?: number;
  expand_max_chars?: number;
  deduplicate_by_section?: boolean;
  dedup_level?: 2 | 3;
}

export interface SearchOptions extends HitPostProcessOptions {
  threshold?: number;
  limit?: number;
  granularity?: Granularity;
  include_excerpt?: boolean;
  excerpt_chars?: number;
  /**
   * Whether note-granularity hits should carry the full `blocks[]` list
   * of heading keys for the matched note. Defaults to `false` in search
   * results — a single large note can contribute tens of kilobytes of
   * heading keys that dominate the response size. Agents that actually
   * need the list should request it explicitly.
   */
  include_blocks_list?: boolean;
  /**
   * Cap on `blocks[]` length per hit when `include_blocks_list` is true.
   * Extra keys are dropped; `blocks_truncated: true` and
   * `total_blocks_in_note` are set so the agent can decide to fetch the
   * full list via `get_note_content`.
   */
  max_blocks_per_hit?: number;
}

const DEFAULT_EXCERPT_CHARS = 1_500;
const DEFAULT_EXPAND_THRESHOLD = 0.8;
const DEFAULT_EXPAND_MAX_CHARS = 5_000;
const DEFAULT_DEDUP_LEVEL: 2 | 3 = 2;
const DEFAULT_EXPAND_MODE: ExpandMode = 'high-similarity';
const DEFAULT_DEDUP_ENABLED = true;
const DEDUP_FETCH_MULTIPLIER = 3;
const DEFAULT_INCLUDE_BLOCKS_LIST_IN_SEARCH = false;
const DEFAULT_MAX_BLOCKS_PER_HIT = 30;
const DEFAULT_MAX_BLOCKS_IN_NOTE_CONTENT = 150;

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
    const granularity = opts.granularity ?? 'block';
    const raw = this.rankByVector(queryVec, {
      threshold,
      limit: overFetchLimit(limit, granularity, opts),
      granularity,
      include_excerpt: opts.include_excerpt ?? true,
      excerpt_chars: opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS,
      include_blocks_list: opts.include_blocks_list ?? DEFAULT_INCLUDE_BLOCKS_LIST_IN_SEARCH,
      max_blocks_per_hit: opts.max_blocks_per_hit ?? DEFAULT_MAX_BLOCKS_PER_HIT,
      excludePath: notePath,
    });
    return this.postProcessHits(raw, limit, { ...opts, granularity });
  }

  /** Find blocks similar to an existing block identified by `path#heading-chain`. */
  getSimilarBlocks(
    blockKey: string,
    threshold = 0.5,
    limit = 10,
    opts: Omit<SearchOptions, 'threshold' | 'limit' | 'granularity'> = {},
  ): SimilarNote[] & { warnings?: string[] } {
    const lookup = this.loader.findBlockFuzzy({ key: blockKey });
    if (lookup.status === 'ambiguous') {
      throw new Error(
        `Block key matched ${lookup.candidates?.length ?? 0} candidates after normalization — refine the heading. Candidates: ${(lookup.candidates ?? []).slice(0, 5).join(' | ')}`,
      );
    }
    const block = lookup.block;
    if (!block) throw new Error(`Block not found: ${blockKey}`);
    const queryVec = block.embeddings[this.active.model_key]?.vec;
    if (!queryVec) throw new Error(`No embedding for block under active model: ${blockKey}`);
    const excludeKey = lookup.canonical_key ?? blockKey;
    const raw = this.rankByVector(queryVec, {
      threshold,
      limit: overFetchLimit(limit, 'block', opts),
      granularity: 'block',
      include_excerpt: opts.include_excerpt ?? true,
      excerpt_chars: opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS,
      excludeBlockKey: excludeKey,
    });
    const results = this.postProcessHits(raw, limit, { ...opts, granularity: 'block' });
    if (lookup.status === 'fuzzy' && lookup.warning) {
      return Object.assign(results, { warnings: [lookup.warning] });
    }
    return results;
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
    const granularity = opts.granularity ?? 'block';
    const raw = this.rankByVector(embeddingVector, {
      threshold,
      limit: overFetchLimit(k, granularity, opts),
      granularity,
      include_excerpt: opts.include_excerpt ?? true,
      excerpt_chars: opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS,
      include_blocks_list: opts.include_blocks_list ?? DEFAULT_INCLUDE_BLOCKS_LIST_IN_SEARCH,
      max_blocks_per_hit: opts.max_blocks_per_hit ?? DEFAULT_MAX_BLOCKS_PER_HIT,
    });
    return this.postProcessHits(raw, k, { ...opts, granularity });
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
      include_blocks_list?: boolean;
      max_blocks_per_hit?: number;
    } & HitPostProcessOptions = {},
  ): Promise<{ results: SimilarNote[]; mode: SearchMode; fallback_from?: SearchMode; warnings: string[] }> {
    const mode: SearchMode = opts.mode ?? (this.ollama ? 'hybrid' : 'keyword');
    const limit = opts.limit ?? 10;
    const threshold = opts.threshold ?? 0.5;
    const granularity: Granularity = opts.granularity ?? 'block';
    const include_excerpt = opts.include_excerpt ?? true;
    const excerpt_chars = opts.excerpt_chars ?? DEFAULT_EXCERPT_CHARS;
    const include_blocks_list = opts.include_blocks_list ?? DEFAULT_INCLUDE_BLOCKS_LIST_IN_SEARCH;
    const max_blocks_per_hit = opts.max_blocks_per_hit ?? DEFAULT_MAX_BLOCKS_PER_HIT;
    const warnings: string[] = [];

    if ((mode === 'semantic' || mode === 'hybrid') && !this.ollama) {
      if (mode === 'semantic') {
        warnings.push('semantic requested but Ollama is not configured — falling back to keyword.');
        const kw = this.searchKeyword(queryText, overFetchLimit(limit, granularity, opts), threshold, { include_blocks_list, max_blocks_per_hit });
        return { results: this.postProcessHits(kw, limit, { ...opts, granularity }), mode: 'keyword', fallback_from: 'semantic', warnings };
      }
      warnings.push('hybrid requested but Ollama is not configured — using keyword only.');
      const kw = this.searchKeyword(queryText, overFetchLimit(limit, granularity, opts), threshold, { include_blocks_list, max_blocks_per_hit });
      return { results: this.postProcessHits(kw, limit, { ...opts, granularity }), mode: 'keyword', fallback_from: 'hybrid', warnings };
    }

    if (mode === 'keyword') {
      const kw = this.searchKeyword(queryText, overFetchLimit(limit, granularity, opts), threshold, { include_blocks_list, max_blocks_per_hit });
      return { results: this.postProcessHits(kw, limit, { ...opts, granularity }), mode, warnings };
    }

    // semantic or hybrid — need a query vector
    let queryVec: number[];
    try {
      queryVec = await this.ollama!.embed(queryText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Ollama embed failed: ${msg} — falling back to keyword.`);
      const kw = this.searchKeyword(queryText, overFetchLimit(limit, granularity, opts), threshold, { include_blocks_list, max_blocks_per_hit });
      return { results: this.postProcessHits(kw, limit, { ...opts, granularity }), mode: 'keyword', fallback_from: mode, warnings };
    }

    // Always overfetch for semantic — we need headroom for RRF and for
    // dedup/expand post-processing regardless of whether it's requested.
    const overLimit = Math.max(limit * 3, 30);
    const semantic = this.rankByVector(queryVec, {
      threshold: 0, // let RRF see full list; re-apply threshold at the end for pure-semantic
      limit: overLimit,
      granularity,
      include_excerpt,
      excerpt_chars,
      include_blocks_list,
      max_blocks_per_hit,
    });

    if (mode === 'semantic') {
      const filtered = semantic.filter((r) => r.similarity >= threshold);
      return { results: this.postProcessHits(filtered, limit, { ...opts, granularity }), mode, warnings };
    }

    // hybrid: weighted RRF over semantic + keyword
    const keyword = this.searchKeyword(queryText, overLimit, 0);
    const fused = rrfFuse(
      [
        { list: semantic, idOf: (h) => resultRefId(h), weight: this.fusion.semantic_weight },
        { list: keyword, idOf: (h) => resultRefId(h), weight: this.fusion.keyword_weight },
      ],
      overLimit, // keep headroom for post-processing
      this.fusion.k,
    );
    // Build a semantic-cosine map so that expand decisions in hybrid still
    // reference the cosine scale, not the RRF score.
    const cosineById = new Map(semantic.map((h) => [resultRefId(h), h.similarity] as const));
    const semById = new Map(semantic.map((h) => [resultRefId(h), h] as const));
    const fusedHits = fused.map(({ id, score }) => {
      const hit = semById.get(id) ?? keyword.find((k) => resultRefId(k) === id)!;
      return { ...hit, similarity: score };
    });
    const postProcessed = this.postProcessHits(fusedHits, limit, {
      ...opts,
      granularity,
      expandSimilarityOverride: cosineById,
    });
    // Normalize RRF scores to [0, 1] on the final returned set so the
    // agent has a hybrid-native 0..1 scale to reason over. `similarity`
    // is left as the raw RRF score for back-compat with existing
    // callers/smoke assertions.
    const maxRrf = postProcessed.reduce((m, h) => Math.max(m, h.similarity), 0);
    const results = postProcessed.map((h) => ({
      ...h,
      raw_rrf_score: h.similarity,
      rank_score: maxRrf > 0 ? h.similarity / maxRrf : 0,
    }));
    return { results, mode, warnings };
  }

  /** Substring-frequency scorer. Note-level only. */
  private searchKeyword(
    queryText: string,
    limit: number,
    threshold: number,
    opts: { include_blocks_list?: boolean; max_blocks_per_hit?: number } = {},
  ): SimilarNote[] {
    const include_blocks_list = opts.include_blocks_list ?? DEFAULT_INCLUDE_BLOCKS_LIST_IN_SEARCH;
    const max_blocks_per_hit = opts.max_blocks_per_hit ?? DEFAULT_MAX_BLOCKS_PER_HIT;
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
            const hit: SimilarNote = {
              path: p,
              similarity: score,
              vault_name: this.vaultName,
            };
            if (include_blocks_list) {
              const all = Object.keys(source.blocks || {});
              hit.total_blocks_in_note = all.length;
              if (all.length > max_blocks_per_hit) {
                hit.blocks = all.slice(0, max_blocks_per_hit);
                hit.blocks_truncated = true;
              } else {
                hit.blocks = all;
                hit.blocks_truncated = false;
              }
            }
            results.push(hit);
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

  getNoteWithContext(
    notePath: string,
    _includeBlocks: string[] = [],
    opts: { include_blocks_list?: boolean; max_blocks?: number } = {},
  ): NoteContent {
    const include_blocks_list = opts.include_blocks_list ?? true;
    const max_blocks = opts.max_blocks ?? DEFAULT_MAX_BLOCKS_IN_NOTE_CONTENT;
    const content = this.loader.readNoteContent(notePath);
    const source = this.loader.getSource(notePath);
    const all = source ? Object.keys(source.blocks || {}) : [];
    if (!include_blocks_list) {
      return { path: notePath, content, total_blocks_in_note: all.length };
    }
    if (all.length > max_blocks) {
      return {
        path: notePath,
        content,
        blocks: all.slice(0, max_blocks),
        blocks_truncated: true,
        total_blocks_in_note: all.length,
      };
    }
    return {
      path: notePath,
      content,
      blocks: all,
      blocks_truncated: false,
      total_blocks_in_note: all.length,
    };
  }

  /**
   * Extract a single block's markdown content. Accepts either the
   * compound block key (`path#heading`) or a split `{path, heading}`.
   *
   * On exact miss we retry through a fuzzy lookup (whitespace/case
   * normalization) — this absorbs the common failure where one tool
   * emits a heading with literal spaces or case drift that another
   * tool then can't find. Fuzzy resolutions come back with a
   * `warnings` array naming the canonical key that was used.
   */
  getBlockContent(args: { block_key?: string; path?: string; heading?: string }): {
    path: string;
    heading: string;
    lines: [number, number];
    content: string;
    vault_name?: string;
    warnings?: string[];
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

    let range = this.loader.resolveBlockRange(path, heading);
    const warnings: string[] = [];
    if (!range || range[0] <= 0) {
      const fuzzy = this.loader.findBlockFuzzy({ path, heading });
      if (fuzzy.status === 'ambiguous') {
        throw new Error(
          `Heading "${heading}" is ambiguous for ${path} (matched ${fuzzy.candidates?.length ?? 0} candidates). Use the exact heading.`,
        );
      }
      if (fuzzy.status === 'fuzzy' && fuzzy.block) {
        range = fuzzy.block.lines;
        heading = fuzzy.block.heading;
        if (fuzzy.warning) warnings.push(fuzzy.warning);
      }
    }
    if (!range || range[0] <= 0) {
      throw new Error(`Block not found: ${path}${heading}`);
    }
    const full = this.loader.readNoteContent(path);
    const content = full.split('\n').slice(range[0] - 1, range[1]).join('\n');
    return {
      path,
      heading,
      lines: range,
      content,
      vault_name: this.vaultName,
      ...(warnings.length ? { warnings } : {}),
    };
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
      include_blocks_list?: boolean;
      max_blocks_per_hit?: number;
      excludePath?: string;
      excludeBlockKey?: string;
    },
  ): SimilarNote[] {
    const {
      granularity,
      threshold,
      limit,
      include_excerpt,
      excerpt_chars,
      include_blocks_list = DEFAULT_INCLUDE_BLOCKS_LIST_IN_SEARCH,
      max_blocks_per_hit = DEFAULT_MAX_BLOCKS_PER_HIT,
      excludePath,
      excludeBlockKey,
    } = opts;

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
          vault_name: this.vaultName,
        };
        if (include_blocks_list) {
          const all = Object.keys(src.blocks || {});
          hit.total_blocks_in_note = all.length;
          if (all.length > max_blocks_per_hit) {
            hit.blocks = all.slice(0, max_blocks_per_hit);
            hit.blocks_truncated = true;
          } else {
            hit.blocks = all;
            hit.blocks_truncated = false;
          }
        }
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

  // -----------------------------------------------------------------
  // Post-processing: dedup-by-section + expand-to-section
  // -----------------------------------------------------------------

  /**
   * Apply dedup and/or expand to a ranked hit list. Both features
   * target block-level hits only; note-level hits are passed through
   * unchanged. Safe to call with empty/no-op opts — it then only
   * slices down to `limit`.
   *
   * `expandSimilarityOverride` lets the hybrid caller steer expand
   * decisions with the pre-RRF cosine scale instead of the RRF score
   * that lives in `hit.similarity` after fusion.
   */
  private postProcessHits(
    hits: SimilarNote[],
    limit: number,
    opts: HitPostProcessOptions & {
      granularity?: Granularity;
      expandSimilarityOverride?: Map<string, number>;
    },
  ): SimilarNote[] {
    const granularity = opts.granularity ?? 'block';
    const dedupEnabled = (opts.deduplicate_by_section ?? DEFAULT_DEDUP_ENABLED) && granularity === 'block';
    const expandMode: ExpandMode = opts.expand_to_section ?? DEFAULT_EXPAND_MODE;
    const expandEnabled = expandMode !== 'never' && granularity === 'block';

    let out = hits;
    if (dedupEnabled) {
      const level = opts.dedup_level ?? DEFAULT_DEDUP_LEVEL;
      out = dedupBySection(out, level);
    }
    if (out.length > limit) out = out.slice(0, limit);

    if (expandEnabled) {
      out = this.applyExpand(out, {
        mode: expandMode,
        threshold: opts.expand_threshold ?? DEFAULT_EXPAND_THRESHOLD,
        max_chars: opts.expand_max_chars ?? DEFAULT_EXPAND_MAX_CHARS,
        similarityOverride: opts.expandSimilarityOverride,
      });
    }
    return out;
  }

  private applyExpand(
    hits: SimilarNote[],
    opts: {
      mode: ExpandMode;
      threshold: number;
      max_chars: number;
      similarityOverride?: Map<string, number>;
    },
  ): SimilarNote[] {
    return hits.map((hit) => {
      if (!hit.heading) return hit;

      const sourceKey = `${hit.path}${hit.heading}`;
      const decisionSim = opts.similarityOverride?.get(sourceKey) ?? hit.similarity;
      const isFragment = /#\{\d+\}$/.test(hit.heading);
      const isHighSim = decisionSim >= opts.threshold;
      const isTopLevel = /^##[^#]+$/.test(hit.heading);

      let reason: HitExpansionReason | null = null;
      if (opts.mode === 'always') {
        reason = 'forced';
      } else {
        // 'high-similarity'
        if (isFragment) reason = 'fragment auto-expand';
        else if (isHighSim && !isTopLevel) reason = 'similarity >= threshold';
        else if (isHighSim && isTopLevel) reason = 'high-sim ##-section inline';
      }
      if (!reason) return hit;

      const targetBlock: SmartBlock | null =
        isTopLevel && !isFragment
          ? this.loader.getBlock(sourceKey) ?? null
          : this.findParentBlock(sourceKey);

      if (!targetBlock) {
        return {
          ...hit,
          expansion: {
            applied: false,
            reason: 'parent block not in index',
            original_heading: hit.heading,
            truncated_to_max_chars: false,
          },
        };
      }

      let content: string;
      try {
        content = this.loader.extractBlockContent(targetBlock.source_path, targetBlock.heading);
      } catch {
        return {
          ...hit,
          expansion: {
            applied: false,
            reason: 'block content unavailable',
            original_heading: hit.heading,
            truncated_to_max_chars: false,
          },
        };
      }

      if (!content) {
        return {
          ...hit,
          expansion: {
            applied: false,
            reason: 'block content unavailable',
            original_heading: hit.heading,
            truncated_to_max_chars: false,
          },
        };
      }

      const truncated = content.length > opts.max_chars;
      const section_content = truncated ? content.slice(0, opts.max_chars) : content;

      return {
        ...hit,
        section_content,
        section_heading: targetBlock.heading,
        section_lines: targetBlock.lines[0] > 0 ? targetBlock.lines : undefined,
        expansion: {
          applied: true,
          reason,
          original_heading: hit.heading,
          truncated_to_max_chars: truncated,
        },
      };
    });
  }

  /**
   * Walk up the heading chain of a block key until we find an ancestor
   * that exists in the block index. Returns `null` if the walk reaches
   * the note level (no `#` left) without hitting a known block — in
   * that case the caller should leave the hit unchanged instead of
   * promoting it to note-level content.
   */
  private findParentBlock(childKey: string): SmartBlock | null {
    let key = childKey;
    while (true) {
      const lastHash = key.lastIndexOf('#');
      if (lastHash === -1) return null;
      key = key.slice(0, lastHash);
      // strip trailing '#' residues left by "##" markers — each pass
      // removes one # and also aborts if that takes us below note level.
      while (key.endsWith('#')) {
        const stripped = key.slice(0, -1);
        if (!stripped.includes('#')) return null;
        key = stripped;
      }
      if (!key.includes('#')) return null;
      const candidate = this.loader.getBlock(key);
      if (candidate) return candidate;
    }
  }
}

type HitExpansionReason = HitExpansion['reason'];

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

/**
 * Larger fetch window when dedup or expand is enabled: dedup can
 * collapse many hits into one, so without overfetch we would starve
 * the final limit. Capped at 100 to match MAX_LIMIT upstream.
 */
function overFetchLimit(
  limit: number,
  granularity: Granularity,
  opts: HitPostProcessOptions,
): number {
  if (granularity !== 'block') return limit;
  const dedupOn = opts.deduplicate_by_section ?? DEFAULT_DEDUP_ENABLED;
  const expandMode = opts.expand_to_section ?? DEFAULT_EXPAND_MODE;
  if (!dedupOn && expandMode === 'never') return limit;
  return Math.min(limit * DEDUP_FETCH_MULTIPLIER, 100);
}

/**
 * Group block-level hits by their `##` (level=2) or `###` (level=3)
 * ancestor and keep the best-similarity hit per group. The dropped
 * siblings are attached to the kept hit as `sibling_matches`.
 *
 * Note-level hits and block-level hits whose heading does not start
 * with `##` are passed through unchanged (their group key degrades
 * to path+heading, so they self-dedupe without side effects).
 */
function dedupBySection(hits: SimilarNote[], level: 2 | 3): SimilarNote[] {
  if (hits.length === 0) return hits;
  const groups = new Map<string, SimilarNote[]>();
  const order: string[] = [];
  for (const hit of hits) {
    const k = sectionKeyFor(hit, level);
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k)!.push(hit);
  }
  const kept: SimilarNote[] = [];
  for (const k of order) {
    const group = groups.get(k)!;
    // group preserves original ranked order — best similarity comes first.
    const [best, ...siblings] = group;
    if (siblings.length > 0) {
      kept.push({
        ...best,
        sibling_matches: siblings.map((s) => ({
          heading: s.heading ?? '',
          similarity: s.similarity,
          lines: s.lines,
        })),
      });
    } else {
      kept.push(best);
    }
  }
  return kept;
}

/**
 * Section key used by `dedupBySection`. Splits the heading chain into
 * segments (the `#`-runs between them become part of the delimiter) and
 * groups by the first `level` segments. Smart Connections frequently
 * encodes the note's H1 title as the first segment, so `level=2` means
 * "same top-level subsection under the same document" — which is the
 * coverage-improving grouping we want by default.
 *
 * Fragment-only hits (`#{N}` with nothing before) and note-level hits
 * degrade to a per-hit key so they don't collapse into unrelated
 * groups.
 */
function sectionKeyFor(hit: SimilarNote, level: 2 | 3): string {
  if (!hit.heading) return hit.path;
  const segments = hit.heading.split(/#+/).filter((s) => s.length > 0);
  if (segments.length === 0) return `${hit.path}${hit.heading}`;
  const take = Math.min(level, segments.length);
  const parts = segments.slice(0, take);
  return `${hit.path}|${parts.join('|')}`;
}

// Unused imports kept-away from eslint-nopunctuation by referencing types.
export type { ConnectionGraph };
// cosineSimilarity is re-exported because older callers imported it from here.
export { cosineSimilarity };
