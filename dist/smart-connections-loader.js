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
import { parseAjsonLines } from './ajson-parser.js';
import { EmbeddingModelsLoader } from './embedding-models-loader.js';
export class SmartConnectionsLoader {
    vaultPath;
    smartEnvPath;
    config = null;
    sources = new Map();
    embeddingModels;
    active = null;
    stats = {
        sourceFilesScanned: 0,
        sourcesKept: 0,
        sourcesReplaced: 0,
        sourcesSkippedNoEmbedding: 0,
        sourcesSkippedNullPath: 0,
        parseErrors: 0,
    };
    constructor(vaultPath) {
        this.vaultPath = path.resolve(vaultPath);
        this.smartEnvPath = path.join(this.vaultPath, '.smart-env');
        this.embeddingModels = new EmbeddingModelsLoader(this.smartEnvPath);
    }
    async initialize() {
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
    loadConfig() {
        const configPath = path.join(this.smartEnvPath, 'smart_env.json');
        if (!fs.existsSync(configPath)) {
            throw new Error(`Configuration file not found at: ${configPath}`);
        }
        this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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
    resolveActiveModel() {
        const envHint = process.env.SMART_EMBED_MODEL_KEY?.trim();
        if (envHint) {
            const fromEnv = this.buildActiveFromHint(envHint, 'env-override');
            if (fromEnv)
                return fromEnv;
            throw new Error(`SMART_EMBED_MODEL_KEY="${envHint}" did not match any entry in embedding_models.ajson ` +
                `and is not a known model_key. Check available models via embedding_models.ajson.`);
        }
        const defaultKey = this.config?.embedding_models?.default_model_key;
        if (defaultKey) {
            const fromDefault = this.buildActiveFromHint(defaultKey, 'default-model-key');
            if (fromDefault)
                return fromDefault;
        }
        const autodetected = this.autodetectActiveModel();
        if (autodetected)
            return autodetected;
        throw new Error('Could not resolve active embedding model. Set SMART_EMBED_MODEL_KEY or ensure ' +
            '.smart-env/smart_env.json has embedding_models.default_model_key pointing at a ' +
            'valid entry in embedding_models/embedding_models.ajson.');
    }
    buildActiveFromHint(hint, resolution) {
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
    autodetectActiveModel() {
        const multiPath = path.join(this.smartEnvPath, 'multi');
        if (!fs.existsSync(multiPath))
            return null;
        const files = fs.readdirSync(multiPath).filter((f) => f.endsWith('.ajson')).slice(0, 20);
        const counts = new Map();
        for (const file of files) {
            const content = fs.readFileSync(path.join(multiPath, file), 'utf-8');
            parseAjsonLines(content, (key, value) => {
                if (!key.startsWith('smart_sources:'))
                    return;
                const src = value;
                if (!src?.embeddings)
                    return;
                for (const embKey of Object.keys(src.embeddings)) {
                    counts.set(embKey, (counts.get(embKey) ?? 0) + 1);
                }
            });
        }
        if (counts.size === 0)
            return null;
        let best = null;
        let bestCount = -1;
        for (const [k, c] of counts) {
            if (c > bestCount) {
                bestCount = c;
                best = k;
            }
        }
        if (!best)
            return null;
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
    loadSources() {
        const multiPath = path.join(this.smartEnvPath, 'multi');
        if (!fs.existsSync(multiPath)) {
            throw new Error(`Multi directory not found at: ${multiPath}`);
        }
        if (!this.active)
            throw new Error('loadSources called before resolveActiveModel');
        const files = fs.readdirSync(multiPath).filter((f) => f.endsWith('.ajson'));
        this.stats.sourceFilesScanned = files.length;
        for (const file of files) {
            const filePath = path.join(multiPath, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            parseAjsonLines(content, (key, value) => {
                if (!key.startsWith('smart_sources:'))
                    return;
                const src = value;
                if (!src)
                    return;
                if (!src.path) {
                    this.stats.sourcesSkippedNullPath += 1;
                    return;
                }
                const vec = src.embeddings?.[this.active.model_key]?.vec;
                if (!Array.isArray(vec) || vec.length === 0) {
                    this.stats.sourcesSkippedNoEmbedding += 1;
                    return;
                }
                if (this.sources.has(src.path)) {
                    this.stats.sourcesReplaced += 1;
                }
                else {
                    this.stats.sourcesKept += 1;
                }
                this.sources.set(src.path, src);
            }, {
                onError: () => {
                    this.stats.parseErrors += 1;
                },
            });
        }
    }
    finalizeDims() {
        if (!this.active)
            return;
        for (const src of this.sources.values()) {
            const vec = src.embeddings?.[this.active.model_key]?.vec;
            if (Array.isArray(vec) && vec.length > 0) {
                this.active.dims = vec.length;
                return;
            }
        }
    }
    // --------------------------------------------------------- diagnostics
    logStartupDiagnostics() {
        const a = this.active;
        const s = this.stats;
        console.error(`[smart-connections-mcp] active model: model_key="${a.model_key}" ` +
            `provider="${a.provider_key || 'n/a'}" full_key="${a.full_key || 'n/a'}" ` +
            `dims=${a.dims} resolution=${a.resolution}`);
        console.error(`[smart-connections-mcp] sources: ${s.sourcesKept} kept / ${s.sourcesReplaced} replaced / ` +
            `${s.sourcesSkippedNoEmbedding} no-embedding / ${s.sourcesSkippedNullPath} null-path / ` +
            `${s.parseErrors} parse-errors (from ${s.sourceFilesScanned} .ajson files)`);
        if (s.sourcesKept === 0) {
            console.error(`[smart-connections-mcp] WARNING: 0 sources matched active model "${a.model_key}". ` +
                `Available model_keys observed in vault may differ — check embedding_models.ajson ` +
                `or set SMART_EMBED_MODEL_KEY.`);
        }
    }
    // --------------------------------------------------------- accessors
    getSources() {
        return this.sources;
    }
    getSource(notePath) {
        return this.sources.get(notePath);
    }
    getConfig() {
        return this.config;
    }
    getActiveModel() {
        if (!this.active)
            throw new Error('Active model not resolved yet — call initialize() first');
        return this.active;
    }
    /** @deprecated Kept for compatibility during migration; prefer getActiveModel().model_key. */
    getEmbeddingModelKey() {
        return this.getActiveModel().model_key;
    }
    getVaultPath() {
        return this.vaultPath;
    }
    getLoadStats() {
        return { ...this.stats };
    }
    /**
     * Read a markdown note's content. `notePath` is vault-relative.
     * Path-traversal containment is enforced: the resolved target must lie
     * strictly within the vault root (symlinks resolved).
     */
    readNoteContent(notePath) {
        const full = this.resolveInsideVault(notePath);
        return fs.readFileSync(full, 'utf-8');
    }
    extractBlockContent(notePath, blockHeading) {
        const content = this.readNoteContent(notePath);
        const source = this.getSource(notePath);
        const range = source?.blocks?.[blockHeading];
        if (!range)
            return '';
        const [startLine, endLine] = range;
        const lines = content.split('\n');
        return lines.slice(startLine - 1, endLine).join('\n');
    }
    /**
     * Join `notePath` onto the vault root and assert containment. Rejects
     * absolute paths, `..` escapes, and symlinks that point outside.
     */
    resolveInsideVault(notePath) {
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
//# sourceMappingURL=smart-connections-loader.js.map