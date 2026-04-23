# HANDOFF — передача контекста после релиза v2.2.2

**Дата создания:** 2026-04-23 (финальная сессия v2.2.x)
**Источник:** wrapup после реализации патчей v2.2.1 и v2.2.2, двух live-тестов и финализации документации.

---

## Цель исследования

Fork MCP-сервера `msdanyg/smart-connections-mcp` → `ushakov-git/smart-connections-mcp`: переписать под современный формат Smart Connections (Ollama+bge-m3), добавить block-level семантический поиск, weighted hybrid RRF, post-processing (expand + dedup), контролируемый размер ответа, hot-reload, границы безопасности, skill-файл для корректного использования агентом.

Конечная цель — **повседневная эксплуатация** сервера на личном vault'е `Develop` (и потенциально на других) через Claude Code VSCode extension.

---

## Что сделано сегодня (последняя сессия)

Сессия началась с **v2.2.0** (уже выпущена в предыдущей сессии) и live-теста к ней. Завершилась выпуском **v2.2.2** и полной синхронизацией документации.

### v2.2.1 — четыре коммита (response-size fix + качество)

| SHA | Коммит |
|---|---|
| `3b7193f` | `fix(response-size): make note-hit blocks[] opt-in and capped` — решает Проблему 1 (160k+ JSON) и Проблему 2 (cap применялся к content, не к JSON). Новые параметры `include_blocks_list`, `max_blocks_per_hit` в search-tools, `max_blocks` в get_note_content. Breaking default: `include_blocks_list: false` в поиске. |
| `3e95429` | `fix(errors): unify get_block_content error to "Block not found"` — решает Проблему 3 из отчёта (расхождение текста ошибки с документацией). |
| `c720e75` | `test(smoke): cover v2.2.1 response-size knobs and coverage gaps` — **73 → 86 тестов**. Добавлены проверки: unified error, include_blocks_list default-off и opt-in, max_blocks truncation, expand_to_section="always", DISABLE_SEMANTIC_SEARCH fallback, 3 класса path-traversal guard. |
| `cb37c87` | `docs: v2.2.1 release — changelog, README, skill, CHANGES_v2.2.1` — package.json 2.2.0 → 2.2.1. |

### v2.2.2 — note-content cap 1M + env

| SHA | Коммит |
|---|---|
| `d21ecf3` | `feat(limits): raise note_content cap to 1M chars and make it env-configurable (v2.2.2)` — дефолт `MAX_NOTE_CONTENT_CHARS` 200_000 → 1_000_000 символов (~250-330k токенов русского). Новая env `MAX_NOTE_CONTENT_CHARS` (range 1_000 – 50_000_000). Startup-лог `note_content_cap=...`. package.json 2.2.1 → 2.2.2. |

### Post-release полировка документации (4 коммита)

| SHA | Коммит |
|---|---|
| `1505d9d` | `docs(ru): align search_blocks description with actual behaviour` — из TESTING_REPORT_v2.2.2.md §4.1: убрана ложная фраза "не возвращает блоки из той же заметки"; код исключает ТОЛЬКО сам block_key. |
| `005606e` | `docs(ru): surface MAX_NOTE_CONTENT_CHARS in the .mcp.json template` — шаблон .mcp.json в README_rus §"Claude Code (CLI)" получил новую переменную + полная справочная таблица по каждой env + явный список опциональных env. |
| `849cad8` | `docs(skill): remove retired "Block line range unknown" error, refresh example totals` — §9 error-table в skill очищена от ретро-сообщения; §4 totals 141/11796 → 147/12007. |
| `f3208b2` | `docs(skill): mark response example fields as vault-specific / default / per-request / state` — §4 получил legend-таблицу и inline-аннотации на каждом поле JSON-примера. Skill стал vault-agnostic. |

Плюс два коммита пользователя: `39fe8ec` (.gitignore + package-lock), `64aa09e` (.mcp.json template as new file).

---

## Ключевые находки

- **Live-тест v2.2.0** (TESTING_REPORT_v2.2.0.md): 9 tools OK, но найдены 3 проблемы — все связаны с размером ответа (Проблема 1: `blocks[]` bloat на note-granularity; Проблема 2: cap на `content`, не на JSON; Проблема 3: текст ошибки не совпадал с docs).
- **Live-тест v2.2.1** (TESTING_REPORT_v2.2.1.md): все проблемы закрыты. Найден новый limit — клиентский MCP token-limit режет большие заметки до server-cap'а. Сервер вне этого ограничения.
- **Live-тест v2.2.2** (TESTING_REPORT_v2.2.2.md): verdict OK. Заметка 421k символов возвращена целиком, `truncated: false`. §4.1 doc-mismatch в `search_blocks` (не связан с кодом — только документация).
- **Ключевой нюанс**: server-cap `MAX_NOTE_CONTENT_CHARS` — в **символах**, клиентский token-limit MCP — отдельное ограничение, сервер его не обходит. Это явно прописано во всех документах v2.2.2.

---

## Принятые решения

1. **Default `include_blocks_list: false` в поисковых tools (breaking)** — `blocks[]` дублировался N раз на hits, был главным источником bloat'а. Ломать default безопасно: в отчётах пользователь не ссылался на это поле, агенты использовали `path` + `get_note_content` когда блоки реально нужны.
2. **Default `include_blocks_list: true` в get_note_content** — back-compat, там поле одно.
3. **`MAX_NOTE_CONTENT_CHARS` = 1_000_000 + env** (вариант A из нашего обсуждения) — покрывает Opus 4.7 1M context, не конфликтует с клиентским token-limit.
4. **`get_note_content_chunk` отложен в backlog v2.3.0** — `get_block_content` закрывает 80% use-cases через semantic boundaries; добавлять tool без конкретной необходимости = overengineering.
5. **Skill vault-agnostic** — §4 JSON-пример размечен по 4 категориям (vault-specific / server-default / per-request / state) для использования на любых vault'ах.

---

## Что в процессе

Ничего. Проект завершён.

---

## Следующие шаги (для будущих сессий)

1. **Сначала прочитай** `CLAUDE.md`, `STATE.md`, `OBSERVATIONS.md` (имеют @import в CLAUDE.md).
2. **Узнай у пользователя** — что произошло:
   - Появились ли новые проблемы в повседневной эксплуатации?
   - Хочет ли push в origin `ushakov-git/smart-connections-mcp`?
   - Хочет ли реализацию v2.3.0 фич (chunked reading, canvas parsing, BM25, MCP SDK migration)?
3. **Если новый баг или фича** — создай план через `Plan` агента или обсуди с пользователем, потом реализуй.
4. **Если push** — `git push -u origin feat/v2-bge-m3-and-hardening` (пользователь решает сам — stance "fork private").

### Backlog v2.3.0 (приоритет от высокого к низкому)

1. **`get_note_content_chunk(path, from_line, to_line)`** — для заметок, которые клиент режет по токен-лимиту. Line-based предпочтителен (совместим с `lines: [start, end]` из search hits).
2. **Миграция от deprecated `Server`** `@modelcontextprotocol/sdk` — техдолг, уже warning в билде.
3. **`meta.response_bytes`** — diagnostic-поле для оценки близости к клиентскому token-limit.
4. **Canvas structure parsing** — в whitelist `.canvas`, но возвращается raw JSON; можно парсить структуру.
5. **BM25 index** для keyword-режима на крупных vault'ах (сейчас linear substring scoring).
6. **Unicode-нормализация в fuzzy lookup** — эмодзи, zero-width chars сейчас не учитываются.

---

## Блокеры и открытые вопросы

Нет блокеров. Сервер готов к работе. Единственный оставшийся внешний фактор — **клиентский MCP token-limit** Claude Code VSCode, который сервер не контролирует. Это документировано в CHANGES_v2.2.2.md §3 и в skill §5.5.

---

## Как быстро запустить сервер (для отладки)

```bash
cd /Users/evgeny/Dropbox/4-Base-of-Skills/9-Instrumental-skills/Obsidian/mcp-to-obsidian-smart-connection/smart-connections-mcp
npm run build
SMART_VAULT_PATH="/Users/evgeny/Dropbox/8 SecondBrain/OBSIDIAN-NOTION/Develop/Develop" \
SMART_VAULT_NAME="Develop" \
OLLAMA_HOST="http://127.0.0.1:11434" \
OLLAMA_EMBED_MODEL="bge-m3:latest" \
MAX_NOTE_CONTENT_CHARS="1000000" \
  node dist/index.js
```

Smoke-тест:

```bash
TEST_VAULT_PATH="/Users/evgeny/Dropbox/8 SecondBrain/OBSIDIAN-NOTION/Develop/Develop" npm run smoke
# expected: === 86/86 passed ===
```

---

## Ссылки

- Ключевые исходники: [src/index.ts](src/index.ts), [src/search-engine.ts](src/search-engine.ts), [src/smart-connections-loader.ts](src/smart-connections-loader.ts), [src/types.ts](src/types.ts).
- Документация: [README.md](README.md), [README_rus.md](README_rus.md), [CHANGELOG.md](CHANGELOG.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- Skill: [.claude/skills/obsidian-knowledge-search/SKILL.md](.claude/skills/obsidian-knowledge-search/SKILL.md).
- Отчёты: `test-reports/TESTING_REPORT_v2.2.0.md`, `TESTING_REPORT_v2.2.1.md`, `TESTING_REPORT_v2.2.2.md`, `CHANGES_v2.2.0.md`, `CHANGES_v2.2.1.md`, `CHANGES_v2.2.2.md`.
- Шаблон конфига: `test-reports/.mcp.json` (gitignore'd) + текст в `README_rus.md` §"Claude Code (CLI)".
