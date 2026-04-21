/**
 * Minimal Ollama embedding client.
 *
 * This is the *only* outbound network call the server can make, and it
 * is gated by OLLAMA_HOST + DISABLE_SEMANTIC_SEARCH. Default host is the
 * loopback `http://127.0.0.1:11434` — no external traffic. Uses Node's
 * built-in fetch (Node >= 18); no external HTTP deps.
 *
 * Response shape — Ollama `/api/embed`:
 *   { "model": "...", "embeddings": [[...floats]] }
 *
 * For a single-string `input` we take `embeddings[0]`.
 */

export interface OllamaClientOptions {
  host: string;
  model: string;
  expectedDims: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** LRU cache capacity for (model,input) → vector. 0 disables caching. */
  cacheSize?: number;
}

export interface OllamaHealth {
  reachable: boolean;
  modelAvailable: boolean;
  dimsMatch: boolean;
  observedDims: number;
  error?: string;
}

export class OllamaClient {
  private host: string;
  private model: string;
  private expectedDims: number;
  private timeoutMs: number;
  private cacheSize: number;
  private cache = new Map<string, number[]>();

  constructor(opts: OllamaClientOptions) {
    this.host = opts.host.replace(/\/+$/, '');
    this.model = opts.model;
    this.expectedDims = opts.expectedDims;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.cacheSize = opts.cacheSize ?? 100;
  }

  /**
   * Embed a single query string. Throws on HTTP errors, timeouts, or
   * when the returned vector length does not equal `expectedDims`. Use
   * `health()` if you want a non-throwing probe.
   */
  async embed(input: string): Promise<number[]> {
    const key = `${this.model}\x00${input}`;
    const hit = this.cache.get(key);
    if (hit) {
      // LRU-touch: re-insert to move to end.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${this.host}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input }),
        signal: ac.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama unreachable at ${this.host}: ${msg}`);
    }
    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Ollama /api/embed HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }

    const payload = (await resp.json()) as { embeddings?: number[][] };
    const vec = payload.embeddings?.[0];
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('Ollama /api/embed returned no vector');
    }
    if (vec.length !== this.expectedDims) {
      throw new Error(
        `Ollama returned ${vec.length}-d vector, expected ${this.expectedDims} (model ${this.model}). ` +
          `Vault embeddings were generated with a different model or dim — this would break cosine scoring.`,
      );
    }

    if (this.cacheSize > 0) {
      this.cache.set(key, vec);
      while (this.cache.size > this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return vec;
  }

  /** Non-throwing probe for startup diagnostics. */
  async health(): Promise<OllamaHealth> {
    try {
      const vec = await this.embed('healthcheck');
      return {
        reachable: true,
        modelAvailable: true,
        dimsMatch: vec.length === this.expectedDims,
        observedDims: vec.length,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reachable = !/unreachable/i.test(msg);
      const modelAvailable = reachable && !/HTTP 404|model .* not found/i.test(msg);
      return {
        reachable,
        modelAvailable,
        dimsMatch: false,
        observedDims: 0,
        error: msg,
      };
    }
  }

  describe(): { host: string; model: string; expectedDims: number; cacheSize: number } {
    return { host: this.host, model: this.model, expectedDims: this.expectedDims, cacheSize: this.cacheSize };
  }
}
