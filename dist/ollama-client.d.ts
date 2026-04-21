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
export declare class OllamaClient {
    private host;
    private model;
    private expectedDims;
    private timeoutMs;
    private cacheSize;
    private cache;
    constructor(opts: OllamaClientOptions);
    /**
     * Embed a single query string. Throws on HTTP errors, timeouts, or
     * when the returned vector length does not equal `expectedDims`. Use
     * `health()` if you want a non-throwing probe.
     */
    embed(input: string): Promise<number[]>;
    /** Non-throwing probe for startup diagnostics. */
    health(): Promise<OllamaHealth>;
    describe(): {
        host: string;
        model: string;
        expectedDims: number;
        cacheSize: number;
    };
}
//# sourceMappingURL=ollama-client.d.ts.map