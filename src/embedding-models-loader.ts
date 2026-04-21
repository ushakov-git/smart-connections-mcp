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

import * as fs from 'fs';
import * as path from 'path';
import { parseAjsonLines } from './ajson-parser.js';

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

export class EmbeddingModelsLoader {
  private smartEnvPath: string;
  /** Indexed by full provider#ts key. */
  private byFullKey = new Map<string, EmbeddingModelRecord>();
  /** Indexed by model_key (last-writer-wins if duplicates — rare). */
  private byModelKey = new Map<string, EmbeddingModelRecord>();

  constructor(smartEnvPath: string) {
    this.smartEnvPath = smartEnvPath;
  }

  load(): void {
    const filePath = path.join(this.smartEnvPath, 'embedding_models', 'embedding_models.ajson');
    if (!fs.existsSync(filePath)) return; // older plugin layout — soft-fail

    const content = fs.readFileSync(filePath, 'utf-8');
    parseAjsonLines(
      content,
      (key, value) => {
        if (!key.startsWith('embedding_models:')) return;
        if (!value || typeof value !== 'object') return;

        const data = value as Record<string, unknown>;
        const shortKey =
          typeof data.key === 'string'
            ? data.key
            : key.slice('embedding_models:'.length);

        const providerKey = typeof data.provider_key === 'string' ? data.provider_key : '';
        const modelKey = typeof data.model_key === 'string' ? data.model_key : '';
        if (!modelKey) return;

        const record: EmbeddingModelRecord = {
          key: shortKey,
          provider_key: providerKey,
          model_key: modelKey,
          dims: typeof data.dims === 'number' ? data.dims : undefined,
          host: typeof data.host === 'string' ? data.host : undefined,
          endpoint: typeof data.endpoint === 'string' ? data.endpoint : undefined,
          max_tokens: typeof data.max_tokens === 'number' ? data.max_tokens : undefined,
          raw: data,
        };

        this.byFullKey.set(shortKey, record);
        this.byModelKey.set(modelKey, record);
      },
      { onError: (line, err) => console.error('embedding_models parse error:', err, line.slice(0, 120)) },
    );
  }

  /** Accepts either the short full-key (`provider#ts`) or a bare `model_key`. */
  resolve(hint: string): EmbeddingModelRecord | undefined {
    return this.byFullKey.get(hint) ?? this.byModelKey.get(hint);
  }

  all(): EmbeddingModelRecord[] {
    return Array.from(this.byFullKey.values());
  }

  isEmpty(): boolean {
    return this.byFullKey.size === 0;
  }
}
