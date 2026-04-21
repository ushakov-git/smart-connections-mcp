/**
 * Loader for .smart-env/embedding_models/embedding_models.ajson.
 *
 * This file is authored by recent versions of the Obsidian Smart
 * Connections plugin and contains one entry per registered embedding
 * model, keyed `embedding_models:<provider>#<timestamp>`.
 *
 * Example entry:
 *   "embedding_models:ollama#1776670752600": {
 *     "provider_key": "ollama",
 *     "model_key": "bge-m3:latest",
 *     "dims": 384,                 // may LIE — we detect from vectors
 *     "host": "http://localhost:11434",
 *     "endpoint": "/api/embed",
 *     "key": "ollama#1776670752600",
 *     ...
 *   }
 *
 * We index these by the full `embedding_models:*` key, by the short
 * `provider#ts` key, and by `model_key` to support flexible lookups.
 */
export interface EmbeddingModelRecord {
    /** Full key as stored, e.g. "ollama#1776670752600". */
    key: string;
    /** Provider identifier, e.g. "ollama", "transformers", "openai". */
    provider_key: string;
    /** Name of the model as seen by the provider, e.g. "bge-m3:latest". */
    model_key: string;
    /** Metadata dims. NOT trusted — used only for diagnostics. */
    dims?: number;
    host?: string;
    endpoint?: string;
    max_tokens?: number;
    /** Raw record, kept for future fields we don't explicitly map. */
    raw: Record<string, unknown>;
}
export declare class EmbeddingModelsLoader {
    private smartEnvPath;
    /** Indexed by full provider#ts key. */
    private byFullKey;
    /** Indexed by model_key (last-writer-wins if duplicates — rare). */
    private byModelKey;
    constructor(smartEnvPath: string);
    load(): void;
    /** Accepts either the short full-key (`provider#ts`) or a bare `model_key`. */
    resolve(hint: string): EmbeddingModelRecord | undefined;
    all(): EmbeddingModelRecord[];
    isEmpty(): boolean;
}
//# sourceMappingURL=embedding-models-loader.d.ts.map