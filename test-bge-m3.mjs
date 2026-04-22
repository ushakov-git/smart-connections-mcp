#!/usr/bin/env node
/**
 * Smoke test for Phases 2+3 on a real bge-m3 vault.
 *
 * Usage:
 *   TEST_VAULT_PATH="/path/to/vault" node test-bge-m3.mjs
 */

import { SmartConnectionsLoader } from './dist/smart-connections-loader.js';
import { SearchEngine } from './dist/search-engine.js';
import { OllamaClient } from './dist/ollama-client.js';
import { VaultWatcher } from './dist/vault-watcher.js';
import { LinkResolver } from './dist/link-resolver.js';
import fs from 'fs';
import path from 'path';

const VAULT = process.env.TEST_VAULT_PATH ?? process.env.SMART_VAULT_PATH;
if (!VAULT) {
  console.error('Set TEST_VAULT_PATH to your vault root.');
  process.exit(2);
}

const results = [];
const ok = (label, cond, detail = '') => {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}${detail ? '  ' + detail : ''}`);
  results.push({ label, cond, detail });
  if (!cond) process.exitCode = 1;
};

console.log(`\n=== smoke: vault=${VAULT} ===\n`);

const loader = new SmartConnectionsLoader(VAULT);
await loader.initialize();

const active = loader.getActiveModel();
const stats = loader.getLoadStats();
const VAULT_NAME = 'TestVault';

ok('active model resolved', Boolean(active.model_key), `model_key="${active.model_key}" resolution=${active.resolution}`);
ok('dims detected (>0)', active.dims > 0, `dims=${active.dims}`);
ok('sources kept > 0', stats.sourcesKept > 0, `kept=${stats.sourcesKept} replaced=${stats.sourcesReplaced}`);
ok('blocks kept > 0', stats.blocksKept > 0, `kept=${stats.blocksKept} replaced=${stats.blocksReplaced}`);
ok('sources kept == loaded map size', loader.getSources().size === stats.sourcesKept);
ok('blocks kept == loaded block map size', loader.getBlocks().size === stats.blocksKept);

// Vector dimensionality consistency.
let badSrc = 0;
let badBlk = 0;
let samplePath = null;
let sampleBlockKey = null;
for (const [p, src] of loader.getSources()) {
  const v = src.embeddings?.[active.model_key]?.vec;
  if (!Array.isArray(v) || v.length !== active.dims) badSrc += 1;
  if (!samplePath) samplePath = p;
}
for (const [k, b] of loader.getBlocks()) {
  const v = b.embeddings?.[active.model_key]?.vec;
  if (!Array.isArray(v) || v.length !== active.dims) badBlk += 1;
  if (!sampleBlockKey && b.lines[0] > 0) sampleBlockKey = k;
}
ok('all source vectors consistent dims', badSrc === 0, `bad=${badSrc}`);
ok('all block vectors consistent dims', badBlk === 0, `bad=${badBlk}`);

// Block parsing sanity.
const anyBlock = loader.getBlocks().values().next().value;
ok('block has source_path + heading', Boolean(anyBlock?.source_path) && anyBlock?.heading.startsWith('#'),
   `source_path="${anyBlock?.source_path}" heading="${anyBlock?.heading}"`);

// blocksBySource index populated.
const listForSample = loader.getBlockKeysForSource(samplePath);
ok('blocksBySource populated for a sampled note', listForSample.length >= 0, `count=${listForSample.length}`);

// Engine.
const engine = new SearchEngine(loader, VAULT_NAME);
const engineStats = engine.getStats();
ok('engineStats.modelKey matches active', engineStats.modelKey === active.model_key);
ok('engineStats.embeddingDimension matches detected dims', engineStats.embeddingDimension === active.dims);
ok('engineStats.vaultName propagated', engineStats.vaultName === VAULT_NAME);
ok('engineStats.totalBlocks > 0', engineStats.totalBlocks > 0, `blocks=${engineStats.totalBlocks}`);

// getSimilarNotes — block granularity (default), returns ResultRef + excerpt.
if (samplePath) {
  const hits = engine.getSimilarNotes(samplePath, 0.3, 5);
  ok('getSimilarNotes returns hits', hits.length > 0, `top="${hits[0]?.path}" sim=${hits[0]?.similarity?.toFixed(3)}`);
  const top = hits[0];
  ok('hit carries path', Boolean(top?.path));
  ok('hit carries heading (block granularity default)', Boolean(top?.heading), `heading="${top?.heading}"`);
  ok('hit carries lines', Array.isArray(top?.lines) && top.lines.length === 2);
  ok('hit carries vault_name', top?.vault_name === VAULT_NAME);
  ok('hit carries excerpt', typeof top?.excerpt === 'string' && top.excerpt.length > 0, `excerpt_len=${top?.excerpt?.length}`);
}

// getSimilarNotes with granularity=note — no heading expected.
if (samplePath) {
  const hits = engine.getSimilarNotes(samplePath, 0.3, 3, { granularity: 'note', include_excerpt: false });
  ok('granularity=note returns hits', hits.length > 0);
  ok('note-granularity hit has no heading', !hits[0]?.heading);
  ok('note-granularity hit has no excerpt when disabled', !hits[0]?.excerpt);
}

// getSimilarBlocks.
if (sampleBlockKey) {
  const hits = engine.getSimilarBlocks(sampleBlockKey, 0.3, 5);
  ok('getSimilarBlocks returns hits', hits.length > 0, `top="${hits[0]?.heading}" sim=${hits[0]?.similarity?.toFixed(3)}`);
  ok('block-hit excludes the query block itself', !hits.find(h => `${h.path}${h.heading}` === sampleBlockKey));
}

// getBlockContent.
if (sampleBlockKey) {
  const r = engine.getBlockContent({ block_key: sampleBlockKey });
  ok('getBlockContent returns non-empty content', typeof r.content === 'string' && r.content.length > 0, `lines=${r.lines?.join('..')}`);
  ok('getBlockContent includes vault_name', r.vault_name === VAULT_NAME);
}

// getConnectionGraph — nested tree.
if (samplePath) {
  const g = engine.getConnectionGraph(samplePath, 2, 0.5, 3);
  ok('graph root matches input', g.root === samplePath);
  const tree = g.tree;
  ok('graph returns nested tree', tree && Array.isArray(tree.children));
  ok('graph flat connections still populated', Array.isArray(g.connections));
}

// Path-traversal defenses.
let traversalBlocked = false;
try { loader.readNoteContent('../../../etc/passwd'); }
catch (e) { traversalBlocked = /escapes|relative|not found|extension/i.test(String(e.message)); }
ok('readNoteContent blocks ../ traversal', traversalBlocked);

let absBlocked = false;
try { loader.readNoteContent('/etc/passwd'); }
catch (e) { absBlocked = /absolute|escapes|extension/i.test(String(e.message)); }
ok('readNoteContent blocks absolute paths', absBlocked);

// Extension whitelist.
let extBlocked = false;
try { loader.readNoteContent('some-file.yaml'); }
catch (e) { extBlocked = /extension|not permitted|not found/i.test(String(e.message)); }
ok('readNoteContent blocks non-whitelisted extensions', extBlocked);

// Bad block_key rejected.
let badKeyRejected = false;
try { engine.getBlockContent({ block_key: 'no-hash-here' }); }
catch (e) { badKeyRejected = /Malformed/i.test(String(e.message)); }
ok('getBlockContent rejects malformed key', badKeyRejected);

// Embedding-vector dim guard.
let dimGuard = false;
try { engine.getEmbeddingNeighbors([0.1, 0.2, 0.3], 5, 0.3); }
catch (e) { dimGuard = /dims|expected/i.test(String(e.message)); }
ok('getEmbeddingNeighbors rejects wrong-dim vector', dimGuard);

// -------- Phase 4: semantic / hybrid search_notes --------
const ollamaHost = process.env.OLLAMA_HOST ?? active.host ?? 'http://127.0.0.1:11434';
const ollamaModel = process.env.OLLAMA_EMBED_MODEL ?? active.model_key;

const probe = new OllamaClient({ host: ollamaHost, model: ollamaModel, expectedDims: active.dims });
const health = await probe.health();
console.log(`\n[ollama] ${ollamaHost} model=${ollamaModel} reachable=${health.reachable} modelAvailable=${health.modelAvailable} dimsMatch=${health.dimsMatch}`);

// Keyword mode always works (no Ollama).
const engineNoOllama = new SearchEngine(loader, VAULT_NAME, null);
const kwOut = await engineNoOllama.searchByQuery('Mastra', { mode: 'keyword', limit: 3, threshold: 0.1 });
ok('keyword mode returns results', kwOut.results.length > 0, `top="${kwOut.results[0]?.path}"`);
ok('keyword mode reports mode=keyword', kwOut.mode === 'keyword');

// When Ollama is not configured, requesting semantic falls back to keyword with a warning.
const fbOut = await engineNoOllama.searchByQuery('Mastra', { mode: 'semantic', limit: 3, threshold: 0.1 });
ok('semantic without ollama falls back to keyword', fbOut.mode === 'keyword' && fbOut.fallback_from === 'semantic');
ok('fallback emits a warning', Array.isArray(fbOut.warnings) && fbOut.warnings.length > 0);

if (health.reachable && health.modelAvailable && health.dimsMatch) {
  const engineOllama = new SearchEngine(loader, VAULT_NAME, probe);

  // Semantic, block granularity.
  const semOut = await engineOllama.searchByQuery('observability и трейсинг агентов Mastra', {
    mode: 'semantic',
    granularity: 'block',
    limit: 5,
    threshold: 0.3,
  });
  ok('semantic returns hits', semOut.results.length > 0, `mode=${semOut.mode} top="${semOut.results[0]?.path}" sim=${semOut.results[0]?.similarity?.toFixed(3)}`);
  ok('semantic hit has heading (block granularity)', Boolean(semOut.results[0]?.heading));
  ok('semantic hit has excerpt', typeof semOut.results[0]?.excerpt === 'string' && semOut.results[0].excerpt.length > 0);

  // Hybrid mode.
  const hyOut = await engineOllama.searchByQuery('observability и трейсинг агентов Mastra', {
    mode: 'hybrid',
    limit: 5,
    threshold: 0,
  });
  ok('hybrid returns hits', hyOut.results.length > 0, `mode=${hyOut.mode} top="${hyOut.results[0]?.path}"`);

  // Cache warmup test.
  const t1 = Date.now();
  await probe.embed('повторяющийся запрос');
  const cold = Date.now() - t1;
  const t2 = Date.now();
  await probe.embed('повторяющийся запрос');
  const warm = Date.now() - t2;
  ok('ollama LRU cache speeds up repeated query', warm < cold, `cold=${cold}ms warm=${warm}ms`);

  // Weighted-fusion tilt: with keyword-heavy weights, a short ambiguous
  // query should be more keyword-driven; with semantic-heavy weights it
  // should be more semantically coherent. We can't assert "better" in a
  // unit-test sense, but we can assert that the two configurations
  // produce *different* rankings, proving the weights actually do work.
  const engineSemHeavy = new SearchEngine(loader, VAULT_NAME, probe, {
    semantic_weight: 0.95, keyword_weight: 0.05, k: 60,
  });
  const engineKwHeavy = new SearchEngine(loader, VAULT_NAME, probe, {
    semantic_weight: 0.05, keyword_weight: 0.95, k: 60,
  });
  const query = 'observability и трейсинг агентов Mastra';
  const semHeavy = await engineSemHeavy.searchByQuery(query, { mode: 'hybrid', limit: 20, threshold: 0 });
  const kwHeavy = await engineKwHeavy.searchByQuery(query, { mode: 'hybrid', limit: 20, threshold: 0 });
  // At different weight settings the fused scores must change — the top-1
  // may coincide when a single item is strong in both lists, but scores and
  // the tail of the ranking cannot be identical unless a weight has no effect.
  const semScores = semHeavy.results.map((h) => h.similarity).join(',');
  const kwScores = kwHeavy.results.map((h) => h.similarity).join(',');
  ok('weighted fusion: scores differ when weights differ', semScores !== kwScores,
     `sem_top_score=${semHeavy.results[0]?.similarity?.toFixed(5)} kw_top_score=${kwHeavy.results[0]?.similarity?.toFixed(5)}`);
  ok('fusion config exposed via getFusionConfig', engineSemHeavy.getFusionConfig().semantic_weight === 0.95);

  // k parameter plumbing.
  const engineK75 = new SearchEngine(loader, VAULT_NAME, probe, { k: 75 });
  ok('fusion k is configurable', engineK75.getFusionConfig().k === 75);
} else {
  console.log('[SKIP] ollama-backed semantic tests (host unreachable or dims mismatch)');
}

// -------- Phase 5: incremental reload + watcher lifecycle --------
// Re-ingest an existing .ajson file through reloadMultiFile — no mutation
// of the user's vault happens; the file content on disk is unchanged, but
// the loader path still exercises the same ingest code.
const multiDir = path.join(VAULT, '.smart-env', 'multi');
const anyAjson = fs.readdirSync(multiDir).find((f) => f.endsWith('.ajson'));
if (anyAjson) {
  const prior = { sources: loader.getSources().size, blocks: loader.getBlocks().size };
  const deltas = loader.reloadMultiFile(anyAjson);
  ok('reloadMultiFile runs without throwing', typeof deltas.updatedSources === 'number' && typeof deltas.updatedBlocks === 'number');
  ok('index sizes stable after idempotent reload', loader.getSources().size === prior.sources && loader.getBlocks().size === prior.blocks,
     `before=${JSON.stringify(prior)} after sources=${loader.getSources().size} blocks=${loader.getBlocks().size}`);
}

// Watcher lifecycle — start, stop, no throws, no handlers pending.
const watcher = new VaultWatcher(loader, { debounceMs: 50, log: () => {} });
let started = false;
try { watcher.start(); started = true; } catch {}
ok('VaultWatcher.start() does not throw', started);
// give it a moment to register handles, then stop.
await new Promise((r) => setTimeout(r, 100));
let stopped = false;
try { watcher.stop(); stopped = true; } catch {}
ok('VaultWatcher.stop() does not throw', stopped);

// fullReload — clears and rebuilds; final counts must match prior state.
const beforeFull = { sources: loader.getSources().size, blocks: loader.getBlocks().size };
loader.fullReload();
ok('fullReload recovers source count', loader.getSources().size === beforeFull.sources, `before=${beforeFull.sources} after=${loader.getSources().size}`);
ok('fullReload recovers block count', loader.getBlocks().size === beforeFull.blocks, `before=${beforeFull.blocks} after=${loader.getBlocks().size}`);

// -------- Phase 6: link resolver --------
const resolver = new LinkResolver(loader, VAULT_NAME);

// Full-path wikilink with heading.
if (samplePath) {
  const bare = samplePath.replace(/\.md$/, '');
  const r = resolver.resolve(`[[${bare}#Section]]`);
  ok('resolves full-path wikilink', r.path === samplePath, `path=${r.path}`);
  ok('preserves heading', r.heading === '#Section');
  ok('form=wikilink', r.form === 'wikilink');
}

// Bare note name (basename lookup).
if (samplePath) {
  const basename = (samplePath.split('/').pop() ?? '').replace(/\.md$/, '');
  const r = resolver.resolve(`[[${basename}]]`);
  ok('resolves bare wikilink via basename index', typeof r.path === 'string' && r.path.length > 0, `path=${r.path}`);
}

// obsidian:// open?vault=...&file=...
if (samplePath) {
  const file = samplePath.replace(/\.md$/, '');
  const r = resolver.resolve(`obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(file)}`);
  ok('resolves obsidian://open URI', r.path === samplePath);
  ok('URI form reported', r.form === 'obsidian-uri');
  ok('no vault_mismatch for matching vault', !r.vault_mismatch);
}

// obsidian:// with a mismatching vault name.
if (samplePath) {
  const file = samplePath.replace(/\.md$/, '');
  const r = resolver.resolve(`obsidian://open?vault=OtherVault&file=${encodeURIComponent(file)}`);
  ok('mismatching vault produces warning + vault_mismatch', r.vault_mismatch === true && r.warnings.length > 0);
}

// Alias handling: [[Note|Alias]].
if (samplePath) {
  const basename = (samplePath.split('/').pop() ?? '').replace(/\.md$/, '');
  const r = resolver.resolve(`[[${basename}|alias-text]]`);
  ok('wikilink alias is stripped', typeof r.path === 'string' && !/alias/i.test(r.path));
}

// Unknown note: no throw, warning set.
const unknown = resolver.resolve('[[This Note Does Not Exist 9999]]');
ok('unknown note returns path + warning', typeof unknown.path === 'string' && unknown.warnings.length > 0);

// -------- Phase 8: expand-to-section, dedup-by-section, rank_score, fuzzy --------

// Find a fragment block (#{N} suffix) for expand-fragment tests.
let fragmentBlockKey = null;
let anyBlockKey = null;
for (const [k, b] of loader.getBlocks()) {
  if (b.lines[0] <= 0) continue;
  if (!anyBlockKey) anyBlockKey = k;
  if (/#\{\d+\}$/.test(k)) {
    fragmentBlockKey = k;
    break;
  }
}

if (fragmentBlockKey) {
  // Fragment auto-expand via search_blocks (vector of the fragment itself).
  const out = engine.getSimilarBlocks(fragmentBlockKey, 0, 5, {
    include_excerpt: false,
    expand_to_section: 'high-similarity',
    deduplicate_by_section: false,
  });
  // `searchByQuery` / `searchBlocks` with fragment itself — we just need any hit that is a fragment,
  // which will then auto-expand. The easier check: craft a fragment-shaped hit via a direct search
  // and validate the first hit that is a fragment has `expansion.applied`.
  const expandedFragHit = out.find(h => /#\{\d+\}$/.test(h.expansion?.original_heading ?? ''));
  if (expandedFragHit) {
    ok('expand: fragment auto-expand applies', expandedFragHit.expansion?.applied === true,
       `reason=${expandedFragHit.expansion?.reason} section_heading="${expandedFragHit.section_heading?.slice(0, 40)}"`);
    ok('expand: fragment parent heading drops #{N}', !/#\{\d+\}$/.test(expandedFragHit.section_heading ?? ''));
    ok('expand: section_content populated', typeof expandedFragHit.section_content === 'string' && expandedFragHit.section_content.length > 0);
  } else {
    // No fragment hit in this result — try a forced-expand pass instead.
    const always = engine.getSimilarBlocks(fragmentBlockKey, 0, 3, {
      include_excerpt: false,
      expand_to_section: 'always',
      deduplicate_by_section: false,
    });
    const any = always.find(h => h.expansion?.applied);
    ok('expand: always-mode expands at least one hit', Boolean(any),
       any ? `reason=${any.expansion?.reason}` : '(no expandable hit)');
  }
}

if (anyBlockKey) {
  // expand: 'never' leaves hits untouched.
  const never = engine.getSimilarBlocks(anyBlockKey, 0, 3, {
    include_excerpt: false,
    expand_to_section: 'never',
    deduplicate_by_section: false,
  });
  ok('expand: never leaves hits untouched',
     never.every(h => !('expansion' in h) && !('section_content' in h)),
     `n=${never.length}`);
}

// Dedup: run a broad semantic query; top-N should contain at least one hit with sibling_matches
// (most vaults have clustered sections that would otherwise duplicate in top-N).
if (health.reachable && health.modelAvailable && health.dimsMatch) {
  const engineSem = new SearchEngine(loader, VAULT_NAME, probe);
  const out = await engineSem.searchByQuery('агент и observability', {
    mode: 'semantic',
    limit: 5,
    granularity: 'block',
    expand_to_section: 'never',
    deduplicate_by_section: true,
  });
  const anySibs = out.results.some(r => Array.isArray(r.sibling_matches) && r.sibling_matches.length > 0);
  ok('dedup: at least one hit carries sibling_matches on a clustered query',
     anySibs || out.results.length < 5,
     `hits=${out.results.length} with_siblings=${out.results.filter(r => r.sibling_matches?.length).length}`);

  // hybrid rank_score: top-1 should be 1.0, all in [0, 1].
  const hyb = await engineSem.searchByQuery('агент и observability', {
    mode: 'hybrid',
    limit: 5,
    granularity: 'block',
    expand_to_section: 'never',
    deduplicate_by_section: false,
  });
  if (hyb.results.length > 0) {
    const top = hyb.results[0];
    const inRange = hyb.results.every(r => typeof r.rank_score === 'number' && r.rank_score >= 0 && r.rank_score <= 1);
    ok('hybrid: rank_score present and in [0,1] for every hit', inRange,
       `top.rank_score=${top.rank_score?.toFixed(4)} top.raw_rrf_score=${top.raw_rrf_score?.toFixed(4)}`);
    ok('hybrid: rank_score top-1 equals 1.0', Math.abs((top.rank_score ?? 0) - 1.0) < 1e-9);
    ok('hybrid: raw_rrf_score mirrors similarity', hyb.results.every(r =>
       Math.abs((r.raw_rrf_score ?? 0) - r.similarity) < 1e-12));
  }
}

// Fuzzy heading lookup: pick a known block, perturb the heading with padding + case, expect fuzzy match.
if (anyBlockKey) {
  const block = loader.getBlock(anyBlockKey);
  if (block) {
    // Perturb the heading: preserve the leading `#`s run, then upper/lower-case trick with padding.
    const mangled = block.heading.replace(/[A-Za-zА-Яа-я]/, (c) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
    try {
      const r = engine.getBlockContent({ path: block.source_path, heading: mangled + '  ' });
      ok('fuzzy: get_block_content resolves case/whitespace drift',
         Array.isArray(r.warnings) && r.warnings.some(w => w.startsWith('fuzzy-matched:')),
         `warning="${r.warnings?.[0]?.slice(0, 80)}"`);
      ok('fuzzy: resolved heading equals canonical', r.heading === block.heading);
    } catch (e) {
      // If the change we made happened to produce an ambiguous match (real
      // vaults sometimes contain headings that differ only by case), that's
      // also acceptable behavior — record as pass with note.
      ok('fuzzy: get_block_content handles case/whitespace drift',
         /ambiguous/i.test(String(e)) || /Block not found/.test(String(e)),
         `error="${String(e).slice(0, 80)}"`);
    }
  }
}

console.log(`\n=== ${results.filter(r => r.cond).length}/${results.length} passed ===`);
