# STATE

## Описание проекта
Fork `msdanyg/smart-connections-mcp` → `ushakov-git/smart-connections-mcp`. MCP-сервер **v2.2.2** для Obsidian Smart Connections. Релиз выпущен, сервер готов к повседневной эксплуатации.

## Фокус исследования
Проект завершён. Следующая сессия — эксплуатация и (возможно) v2.3.0-фичи из backlog.

## Стадии проекта
- ✅ v2.0.0 — v2.2.2 — все релизы выпущены.
- ✅ Live-тесты v2.2.0, v2.2.1, v2.2.2 — все прошли.
- ✅ Документация синхронизирована под v2.2.2 и vault-agnostic (skill §4 legend).
- ⬜ v2.3.0 backlog: `get_note_content_chunk` (line-based), canvas structure parsing, BM25 index, MCP SDK migration от deprecated Server API.

## Ключевые находки (итог)
- 🔴 Ветка `feat/v2-bge-m3-and-hardening`, 26 коммитов, **не запушена** (fork private, stance пользователя).
- 🔴 Smoke 86/86 (был 63/63 на старте v2.2.0).
- 🔴 Live-vault: `/Users/evgeny/Dropbox/8 SecondBrain/OBSIDIAN-NOTION/Develop/Develop/`, bge-m3, 147-148 notes, 12007-12022 blocks.
- 🔴 Дефолты v2.2.2: excerpt 1500, note-cap 1_000_000 (env `MAX_NOTE_CONTENT_CHARS`), expand threshold 0.8, expand_max_chars 5000, dedup level 2, include_blocks_list: false (поиск) / true (get_note_content), max_blocks_per_hit 30, max_blocks 150.
- 🔴 Env-переменные в шаблоне `.mcp.json`: SMART_VAULT_PATH, SMART_VAULT_NAME, OLLAMA_HOST, OLLAMA_EMBED_MODEL, RRF_K, RRF_SEMANTIC_WEIGHT, RRF_KEYWORD_WEIGHT, MAX_NOTE_CONTENT_CHARS. Опциональные (не в шаблоне): SMART_EMBED_MODEL_KEY, DISABLE_SEMANTIC_SEARCH, DISABLE_WATCHER.

## Активные гипотезы
- v2.3.0 `get_note_content_chunk(path, from_line, to_line)` — когда клиент обрезает большие заметки по токен-лимиту. `get_block_content` закрывает 80% кейсов через semantic boundaries. Добавлять только при конкретной необходимости.
- Deprecated warning `Server` из `@modelcontextprotocol/sdk` — backlog.

## Текущая задача
Проект завершён. Wrapup выполнен.

## Следующий шаг
В следующей сессии: прочитать HANDOFF.md → узнать у пользователя что изменилось (feedback по v2.2.2 / желаемые v2.3.0 фичи / push в origin).

## Важный контекст
- User: Evgeny Dorland, inbox.ushakov@gmail.com. Opus 4.7 с 1M context.
- Дата: 2026-04-23.
- Путь: `/Users/evgeny/Dropbox/4-Base-of-Skills/9-Instrumental-skills/Obsidian/mcp-to-obsidian-smart-connection/smart-connections-mcp/`.
- Skill: `.claude/skills/obsidian-knowledge-search/SKILL.md` + симлинк в `~/.claude/skills/`.
- `.claude/` в gitignore; tracked файлы продолжают обновляться (git add -f при необходимости).
