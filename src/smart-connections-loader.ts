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

import * as fs from 'fs';
import * as path from 'path';
import type { SmartSource, SmartBlock, SmartEnvConfig, ActiveModel } from './types.js';
import { parseAjsonLines } from './ajson-parser.js';
import { EmbeddingModelsLoader } from './embedding-models-loader.js';

const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.canvas']);

function assertAllowedExtension(notePath: string): void {
  const ext = path.extname(notePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `File extension "${ext || '(none)'}" is not permitted; allowed: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`,
    );
  }
}

/**
 * Normalize a heading chain for fuzzy comparison. Keeps `#`-structure
 * (so we still match on heading levels) but lowercases and collapses
 * all other whitespace runs into single spaces. This absorbs trailing
 * spaces, CRLF artefacts, and case drift — the common failure modes
 * we saw between tools that exchange heading keys.
 */
function normalizeHeading(heading: string): string {
  return heading.toLowerCase().replace(/[ \t\r]+/g, ' ').trim();
}

export interface LoadStats {
  sourceFilesScanned: number;
  sourcesKept: number;
  sourcesReplaced: number;
  sourcesSkippedNoEmbedding: number;
  sourcesSkippedNullPath: number;
  blocksKept: number;
  blocksReplaced: number;
  blocksSkippedNoEmbedding: number;
  blocksSkippedBadKey: number;
  parseErrors: number;
}

export class SmartConnectionsLoader {
  private vaultPath: string;
  private smartEnvPath: string;
  private config: SmartEnvConfig | null = null;
  private sources: Map<string, SmartSource> = new Map();
  private blocks: Map<string, SmartBlock> = new Map();
  /** Secondary index: source path → list of block keys it contains. */
  private blocksBySource: Map<string, string[]> = new Map();
  private embeddingModels: EmbeddingModelsLoader;
  private active: ActiveModel | null = null;
  private stats: LoadStats = {
    sourceFilesScanned: 0,
    sourcesKept: 0,
    sourcesReplaced: 0,
    sourcesSkippedNoEmbedding: 0,
    sourcesSkippedNullPath: 0,
    blocksKept: 0,
    blocksReplaced: 0,
    blocksSkippedNoEmbedding: 0,
    blocksSkippedBadKey: 0,
    parseErrors: 0,
  };

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
    this.smartEnvPath = path.join(this.vaultPath, '.smart-env');
    this.embeddingModels = new EmbeddingModelsLoader(this.smartEnvPath);
  }

  async initialize(): Promise<void> {
    if (!fs.existsSync(this.smartEnvPath)) {
      throw new Error(`Smart Connections directory not found at: ${this.smartEnvPath}`);
    }
    this.loadConfig();
    this.embeddingModels.load();
    this.active = this.resolveActiveModel();
    this.loadSources();
    this.finalizeDims();
    this.logStartupDiagnostics();
  }

  // ------------------------------------------------------------- config

  private loadConfig(): void {
    const configPath = path.join(this.smartEnvPath, 'smart_env.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file not found at: ${configPath}`);
    }
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as SmartEnvConfig;
  }

  // --------------------------------------------------------- model resolve

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
  private resolveActiveModel(): ActiveModel {
    const envHint = process.env.SMART_EMBED_MODEL_KEY?.trim();
    if (envHint) {
      const fromEnv = this.buildActiveFromHint(envHint, 'env-override');
      if (fromEnv) return fromEnv;
      throw new Error(
        `SMART_EMBED_MODEL_KEY="${envHint}" did not match any entry in embedding_models.ajson ` +
          `and is not a known model_key. Check available models via embedding_models.ajson.`,
      );
    }

    const defaultKey = this.config?.embedding_models?.default_model_key;
    if (defaultKey) {
      const fromDefault = this.buildActiveFromHint(defaultKey, 'default-model-key');
      if (fromDefault) return fromDefault;
    }

    const autodetected = this.autodetectActiveModel();
    if (autodetected) return autodetected;

    throw new Error(
      'Could not resolve active embedding model. Set SMART_EMBED_MODEL_KEY or ensure ' +
        '.smart-env/smart_env.json has embedding_models.default_model_key pointing at a ' +
        'valid entry in embedding_models/embedding_models.ajson.',
    );
  }

  private buildActiveFromHint(hint: string, resolution: ActiveModel['resolution']): ActiveModel | null {
    const record = this.embeddingModels.resolve(hint);
    if (record) {
      return {
        model_key: record.model_key,
        provider_key: record.provider_key,
        full_key: record.key,
        dims: 0, // filled after first vec is seen
        host: record.host,
        endpoint: record.endpoint,
        resolution,
      };
    }
    // No entry in embedding_models.ajson — allow raw model_key as-is.
    return {
      model_key: hint,
      provider_key: '',
      full_key: '',
      dims: 0,
      resolution,
    };
  }

  /**
   * Scan up to N `.ajson` files and count the most frequently used embedding
   * key across `smart_sources:*.embeddings`. Tie-break: first seen wins.
   */
  private autodetectActiveModel(): ActiveModel | null {
    const multiPath = path.join(this.smartEnvPath, 'multi');
    if (!fs.existsSync(multiPath)) return null;

    const files = fs.readdirSync(multiPath).filter((f) => f.endsWith('.ajson')).slice(0, 20);
    const counts = new Map<string, number>();

    for (const file of files) {
      const content = fs.readFileSync(path.join(multiPath, file), 'utf-8');
      parseAjsonLines(content, (key, value) => {
        if (!key.startsWith('smart_sources:')) return;
        const src = value as Partial<SmartSource> | null;
        if (!src?.embeddings) return;
        for (const embKey of Object.keys(src.embeddings)) {
          counts.set(embKey, (counts.get(embKey) ?? 0) + 1);
        }
      });
    }

    if (counts.size === 0) return null;

    let best: string | null = null;
    let bestCount = -1;
    for (const [k, c] of counts) {
      if (c > bestCount) {
        bestCount = c;
        best = k;
      }
    }
    if (!best) return null;

    const record = this.embeddingModels.resolve(best);
    return {
      model_key: best,
      provider_key: record?.provider_key ?? '',
      full_key: record?.key ?? '',
      dims: 0,
      host: record?.host,
      endpoint: record?.endpoint,
      resolution: 'autodetect-sources',
    };
  }

  // --------------------------------------------------------- sources

  private loadSources(): void {
    const multiPath = path.join(this.smartEnvPath, 'multi');
    if (!fs.existsSync(multiPath)) {
      throw new Error(`Multi directory not found at: ${multiPath}`);
    }
    if (!this.active) throw new Error('loadSources called before resolveActiveModel');

    const files = fs.readdirSync(multiPath).filter((f) => f.endsWith('.ajson'));
    this.stats.sourceFilesScanned = files.length;

    for (const file of files) {
      const filePath = path.join(multiPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      parseAjsonLines(
        content,
        (key, value) => {
          if (key.startsWith('smart_sources:')) {
            this.ingestSource(value);
          } else if (key.startsWith('smart_blocks:')) {
            this.ingestBlock(key.slice('smart_blocks:'.length), value);
          }
        },
        {
          onError: () => {
            this.stats.parseErrors += 1;
          },
        },
      );
    }
  }

  private ingestSource(value: unknown): void {
    const src = value as SmartSource | null;
    if (!src) return;
    if (!src.path) {
      this.stats.sourcesSkippedNullPath += 1;
      return;
    }
    const vec = src.embeddings?.[this.active!.model_key]?.vec;
    if (!Array.isArray(vec) || vec.length === 0) {
      this.stats.sourcesSkippedNoEmbedding += 1;
      return;
    }
    if (this.sources.has(src.path)) this.stats.sourcesReplaced += 1;
    else this.stats.sourcesKept += 1;
    this.sources.set(src.path, src);
  }

  /**
   * `compoundKey` is the ajson key minus the `smart_blocks:` prefix,
   * e.g. `"01 MASTRA/Foo.md#---frontmatter---"` or `"Note.md#Section#Subsection"`.
   *
   * Parsing: Obsidian forbids `#` in file names, so the first `#` always
   * marks the boundary between source path and heading chain. The heading
   * chain is kept verbatim — including the leading `#` — to match the
   * format used inside `SmartSource.blocks`.
   */
  private ingestBlock(compoundKey: string, value: unknown): void {
    const raw = value as Record<string, unknown> | null;
    if (!raw) return;

    const hashIdx = compoundKey.indexOf('#');
    if (hashIdx <= 0) {
      this.stats.blocksSkippedBadKey += 1;
      return;
    }
    const sourcePath = compoundKey.slice(0, hashIdx);
    const heading = compoundKey.slice(hashIdx);

    const embeddings = raw.embeddings as SmartBlock['embeddings'] | undefined;
    const vec = embeddings?.[this.active!.model_key]?.vec;
    if (!Array.isArray(vec) || vec.length === 0) {
      this.stats.blocksSkippedNoEmbedding += 1;
      return;
    }

    const linesRaw = raw.lines;
    const lines: [number, number] =
      Array.isArray(linesRaw) && linesRaw.length === 2 && typeof linesRaw[0] === 'number' && typeof linesRaw[1] === 'number'
        ? [linesRaw[0], linesRaw[1]]
        : [0, 0];

    const block: SmartBlock = {
      key: compoundKey,
      source_path: sourcePath,
      heading,
      lines,
      size: typeof raw.size === 'number' ? raw.size : undefined,
      embeddings: embeddings!, // guaranteed non-null: we bailed above if vec was missing
    };

    if (this.blocks.has(compoundKey)) this.stats.blocksReplaced += 1;
    else this.stats.blocksKept += 1;
    this.blocks.set(compoundKey, block);

    const list = this.blocksBySource.get(sourcePath);
    if (list) {
      if (!list.includes(compoundKey)) list.push(compoundKey);
    } else {
      this.blocksBySource.set(sourcePath, [compoundKey]);
    }
  }

  private finalizeDims(): void {
    if (!this.active) return;
    for (const src of this.sources.values()) {
      const vec = src.embeddings?.[this.active.model_key]?.vec;
      if (Array.isArray(vec) && vec.length > 0) {
        this.active.dims = vec.length;
        return;
      }
    }
    for (const block of this.blocks.values()) {
      const vec = block.embeddings?.[this.active.model_key]?.vec;
      if (Array.isArray(vec) && vec.length > 0) {
        this.active.dims = vec.length;
        return;
      }
    }
  }

  // --------------------------------------------------------- diagnostics

  private logStartupDiagnostics(): void {
    const a = this.active!;
    const s = this.stats;
    console.error(
      `[smart-connections-mcp] active model: model_key="${a.model_key}" ` +
        `provider="${a.provider_key || 'n/a'}" full_key="${a.full_key || 'n/a'}" ` +
        `dims=${a.dims} resolution=${a.resolution}`,
    );
    console.error(
      `[smart-connections-mcp] sources: ${s.sourcesKept} kept / ${s.sourcesReplaced} replaced / ` +
        `${s.sourcesSkippedNoEmbedding} no-embedding / ${s.sourcesSkippedNullPath} null-path / ` +
        `${s.parseErrors} parse-errors (from ${s.sourceFilesScanned} .ajson files)`,
    );
    console.error(
      `[smart-connections-mcp] blocks:  ${s.blocksKept} kept / ${s.blocksReplaced} replaced / ` +
        `${s.blocksSkippedNoEmbedding} no-embedding / ${s.blocksSkippedBadKey} bad-key`,
    );
    if (s.sourcesKept === 0) {
      console.error(
        `[smart-connections-mcp] WARNING: 0 sources matched active model "${a.model_key}". ` +
          `Available model_keys observed in vault may differ — check embedding_models.ajson ` +
          `or set SMART_EMBED_MODEL_KEY.`,
      );
    }
  }

  // --------------------------------------------------------- accessors

  getSources(): Map<string, SmartSource> {
    return this.sources;
  }

  getSource(notePath: string): SmartSource | undefined {
    return this.sources.get(notePath);
  }

  getBlocks(): Map<string, SmartBlock> {
    return this.blocks;
  }

  getBlock(blockKey: string): SmartBlock | undefined {
    return this.blocks.get(blockKey);
  }

  /**
   * Fuzzy block lookup. Returns the exact match when present; otherwise
   * searches the block index for a single entry whose (path, normalized
   * heading) matches. Normalization lowercases and collapses whitespace
   * — enough to forgive trailing-space pastes and case drift between
   * tools while still refusing ambiguous matches.
   *
   * Returns:
   *   - `exact`: the block as `getBlock()` would return, `matched = true`;
   *   - `fuzzy`: exactly one normalized match, with `warning` describing
   *     the resolution and `canonical_key`;
   *   - `ambiguous`: more than one normalized match — returns the list
   *     so the caller can surface a helpful error;
   *   - `miss`: no match.
   */
  findBlockFuzzy(args: { key?: string; path?: string; heading?: string }): {
    status: 'exact' | 'fuzzy' | 'ambiguous' | 'miss';
    block?: SmartBlock;
    canonical_key?: string;
    warning?: string;
    candidates?: string[];
  } {
    // Build the "requested" key we're trying to resolve.
    let requestedKey: string;
    if (args.key) {
      requestedKey = args.key;
    } else if (args.path && args.heading) {
      const heading = args.heading.startsWith('#') ? args.heading : `#${args.heading}`;
      requestedKey = `${args.path}${heading}`;
    } else {
      return { status: 'miss' };
    }

    const exact = this.blocks.get(requestedKey);
    if (exact) return { status: 'exact', block: exact, canonical_key: requestedKey };

    // Split into path + heading for normalized comparison.
    const firstHash = requestedKey.indexOf('#');
    if (firstHash <= 0) return { status: 'miss' };
    const reqPath = requestedKey.slice(0, firstHash);
    const reqHeading = requestedKey.slice(firstHash);
    const reqNorm = normalizeHeading(reqHeading);

    // Scan blocks under the same path (usually 10-200 entries — cheap).
    const pathKeys = this.blocksBySource.get(reqPath);
    const candidates: string[] = [];
    const source = pathKeys ?? [];
    for (const k of source) {
      const h = k.slice(reqPath.length);
      if (normalizeHeading(h) === reqNorm) candidates.push(k);
    }

    if (candidates.length === 1) {
      return {
        status: 'fuzzy',
        block: this.blocks.get(candidates[0]),
        canonical_key: candidates[0],
        warning: `fuzzy-matched: requested heading "${reqHeading}" resolved to "${candidates[0].slice(reqPath.length)}"`,
      };
    }
    if (candidates.length > 1) {
      return { status: 'ambiguous', candidates };
    }
    return { status: 'miss' };
  }

  /** List block keys contained in a given note. Empty array if none indexed. */
  getBlockKeysForSource(notePath: string): string[] {
    return this.blocksBySource.get(notePath) ?? [];
  }

  getConfig(): SmartEnvConfig | null {
    return this.config;
  }

  getActiveModel(): ActiveModel {
    if (!this.active) throw new Error('Active model not resolved yet — call initialize() first');
    return this.active;
  }

  /** @deprecated Kept for compatibility during migration; prefer getActiveModel().model_key. */
  getEmbeddingModelKey(): string {
    return this.getActiveModel().model_key;
  }

  getVaultPath(): string {
    return this.vaultPath;
  }

  getLoadStats(): LoadStats {
    return { ...this.stats };
  }

  /**
   * Re-read a single `multi/*.ajson` file and merge its entries into the
   * current index. Used by the watcher when Smart Connections rewrites an
   * entry after re-embedding. Silently no-ops if the file no longer exists.
   *
   * This does not remove stale entries whose path/compound-key is absent
   * from the file — the plugin's append-friendly format means deletions
   * are rare and would normally arrive as a file rewrite elsewhere. A
   * full reload covers that case.
   */
  reloadMultiFile(fileName: string): { updatedSources: number; updatedBlocks: number } {
    if (!this.active) throw new Error('reloadMultiFile called before initialize()');
    const filePath = path.join(this.smartEnvPath, 'multi', fileName);
    if (!fs.existsSync(filePath)) return { updatedSources: 0, updatedBlocks: 0 };

    const before = { sources: this.sources.size, blocks: this.blocks.size };
    let srcChanged = 0;
    let blkChanged = 0;

    const content = fs.readFileSync(filePath, 'utf-8');
    parseAjsonLines(
      content,
      (key, value) => {
        if (key.startsWith('smart_sources:')) {
          const pathBefore = (value as SmartSource | null)?.path;
          const had = pathBefore ? this.sources.has(pathBefore) : false;
          this.ingestSource(value);
          if (pathBefore && (!had || this.sources.get(pathBefore) === value)) srcChanged += 1;
        } else if (key.startsWith('smart_blocks:')) {
          const compound = key.slice('smart_blocks:'.length);
          const had = this.blocks.has(compound);
          this.ingestBlock(compound, value);
          if (!had || this.blocks.get(compound)) blkChanged += 1;
        }
      },
      { onError: () => (this.stats.parseErrors += 1) },
    );

    // Crude "updated" metric — counts entries we touched, not net delta.
    // For diagnostics only.
    void before;
    return { updatedSources: srcChanged, updatedBlocks: blkChanged };
  }

  /** Full reload — scan all multi/*.ajson again, rebuilding indexes. */
  fullReload(): void {
    this.sources.clear();
    this.blocks.clear();
    this.blocksBySource.clear();
    this.stats.sourcesKept = 0;
    this.stats.sourcesReplaced = 0;
    this.stats.sourcesSkippedNoEmbedding = 0;
    this.stats.sourcesSkippedNullPath = 0;
    this.stats.blocksKept = 0;
    this.stats.blocksReplaced = 0;
    this.stats.blocksSkippedNoEmbedding = 0;
    this.stats.blocksSkippedBadKey = 0;
    this.stats.parseErrors = 0;
    this.stats.sourceFilesScanned = 0;
    this.embeddingModels = new EmbeddingModelsLoader(this.smartEnvPath);
    this.embeddingModels.load();
    this.loadSources();
    this.finalizeDims();
  }

  /**
   * Read a markdown note's content. `notePath` is vault-relative.
   * Path-traversal containment is enforced: the resolved target must lie
   * strictly within the vault root (symlinks resolved). Only notebook-like
   * files are served (`.md`, `.markdown`, `.canvas`) — the server has no
   * legitimate reason to read arbitrary file types, and this whitelist
   * defangs a hypothetical prompt-injection that asks for
   * `.env`/`.zshrc`/etc. even if they happen to live inside the vault.
   */
  readNoteContent(notePath: string): string {
    const full = this.resolveInsideVault(notePath);
    assertAllowedExtension(notePath);
    return fs.readFileSync(full, 'utf-8');
  }

  extractBlockContent(notePath: string, blockHeading: string): string {
    const content = this.readNoteContent(notePath);
    const range = this.resolveBlockRange(notePath, blockHeading);
    if (!range) return '';
    const [startLine, endLine] = range;
    const lines = content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  }

  /**
   * Resolve a block's line range, preferring the block index (indexed by
   * compound key `path#heading`) and falling back to the parent source's
   * `blocks` map. Returns `undefined` if unknown.
   */
  resolveBlockRange(notePath: string, blockHeading: string): [number, number] | undefined {
    const block = this.blocks.get(`${notePath}${blockHeading}`);
    if (block && block.lines[0] > 0) return block.lines;
    const range = this.getSource(notePath)?.blocks?.[blockHeading];
    return range ? [range[0], range[1]] : undefined;
  }

  /**
   * Join `notePath` onto the vault root and assert containment. Rejects
   * absolute paths, `..` escapes, and symlinks that point outside.
   */
  private resolveInsideVault(notePath: string): string {
    if (typeof notePath !== 'string' || notePath.length === 0) {
      throw new Error('notePath must be a non-empty string');
    }
    if (path.isAbsolute(notePath)) {
      throw new Error('notePath must be vault-relative, not absolute');
    }
    const joined = path.resolve(this.vaultPath, notePath);
    const base = path.resolve(this.vaultPath) + path.sep;
    if (joined !== path.resolve(this.vaultPath) && !joined.startsWith(base)) {
      throw new Error('Path escapes vault root');
    }
    if (!fs.existsSync(joined)) {
      throw new Error(`Note not found at: ${joined}`);
    }
    // Follow symlinks and re-check — defeats symlink-escape tricks.
    const real = fs.realpathSync(joined);
    const realBase = fs.realpathSync(this.vaultPath) + path.sep;
    if (real !== fs.realpathSync(this.vaultPath) && !real.startsWith(realBase)) {
      throw new Error('Resolved path escapes vault root');
    }
    return real;
  }
}
