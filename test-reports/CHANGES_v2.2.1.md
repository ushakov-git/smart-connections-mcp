---
title: Что поменялось в smart-connections-mcp v2.2.1 — чек-лист для ручного теста
date: 2026-04-23
---

# v2.2.1 — чек-лист изменений для ручного теста

Патч-релиз по итогам [TESTING_REPORT_v2.2.0.md](TESTING_REPORT_v2.2.0.md). Решены все три находки. Одно изменение дефолта поведения — отмечено ниже как **breaking default**.

## 1. Управляемый размер ответа (решает Проблемы 1 и 2 отчёта)

Live-тест показал, что `get_similar_notes(granularity: "note")` с `limit: 5` на vault с большими заметками давал 160k+ символов и упирался в token-limit клиента. Причина — каждый hit тянул полный `blocks: [все heading-keys]`.

### Новые параметры

**`get_similar_notes`, `search_notes`, `get_embedding_neighbors`:**

| Параметр | Дефолт | Что делает |
|---|---|---|
| `include_blocks_list` | `false` (**breaking default**) | Прикладывать ли `blocks[]` к note-granularity хитам. По умолчанию нет — это главный источник bloat'а. |
| `max_blocks_per_hit` | `30` (cap 500) | Если `include_blocks_list: true`, `blocks[]` срезается до этого лимита с флагом `blocks_truncated: true`. |

**`get_note_content`:**

| Параметр | Дефолт | Что делает |
|---|---|---|
| `include_blocks_list` | `true` (back-compat) | Возвращать ли `blocks[]`. Если заметка огромная и клиент режет ответ — ставь `false`. |
| `max_blocks` | `150` (cap 2000) | Cap на длину `blocks[]` с флагом `blocks_truncated: true`. |

**`search_blocks`** — без изменений (он block-only и этим полем не страдал).

### Как проверить

1. **Default-off в поиске.** Вызови:
   ```
   get_similar_notes(note_path: "<некая заметка>", granularity: "note", limit: 3)
   ```
   Ожидается: каждый hit НЕ содержит `blocks[]`. Размер ответа компактный.
2. **Opt-in и cap.** Вызови:
   ```
   get_similar_notes(note_path: "<некая заметка>", granularity: "note", limit: 3, include_blocks_list: true, max_blocks_per_hit: 5)
   ```
   Ожидается: `blocks[]` присутствует, длина ≤ 5, у хитов с большими заметками `blocks_truncated: true` и `total_blocks_in_note > 5`.
3. **`get_note_content` на огромной заметке.** На заметке 150k+:
   ```
   get_note_content(note_path: "<огромная заметка>", include_blocks_list: false)
   ```
   Ожидается: `content` возвращён, поле `blocks` отсутствует, но есть `total_blocks_in_note`. JSON теперь помещается в token-limit.
4. **`max_blocks`.**
   ```
   get_note_content(note_path: "<заметка с 200+ headings>", max_blocks: 50)
   ```
   Ожидается: `blocks.length === 50`, `blocks_truncated: true`, `total_blocks_in_note: 200+`.

### Ожидаемый сигнал в ответе

- `blocks_truncated: true` — срез произведён.
- `total_blocks_in_note: N` — всегда сообщает истинный размер.
- Отсутствие `blocks` в hit'е при `include_blocks_list: false` — ок (это дефолт для поиска).

### Breaking change

Потребители, явно использующие `results[].blocks` в ответе `get_similar_notes` / `search_notes` (note-granularity) — **теперь должны передавать `include_blocks_list: true`**. В отчёте по v2.2.0 это поле не использовалось; на практике агенты обычно получали `path` и звали `get_note_content` отдельно.

---

## 2. Унифицированный error message в `get_block_content` (решает Проблему 3)

Раньше несуществующий heading → `"Block line range unknown for <key>"`. README и CHANGES обещали `"Block not found: <key>"`. Теперь сервер бросает ровно задокументированный текст.

### Как проверить

```
get_block_content(path: "<любая заметка>.md", heading: "#Нет такого заголовка 7AB3F1")
```

Ожидается: `"error": "Block not found: <path>#Нет такого заголовка 7AB3F1"` (ключевое — префикс **«Block not found:»**, не «Block line range unknown»).

---

## 3. Расширенное покрытие smoke-тестов

Было 73/73, стало **86/86**. Добавлено 13 тестов:

- `get_block_content` — unified "Block not found".
- `include_blocks_list` default-off на note-granularity.
- `include_blocks_list: true` + `max_blocks_per_hit: 2` → cap + `blocks_truncated` + `total_blocks_in_note`.
- `get_note_content` — `include_blocks_list: false` не возвращает `blocks`.
- `get_note_content` — `max_blocks` с truncation-флагом.
- `expand_to_section: "always"` — все подходящие хиты получают `section_content`.
- `DISABLE_SEMANTIC_SEARCH`-режим: hybrid корректно fallback на keyword с warning.
- Path-traversal guard — 3 класса (`..`-escape, абсолютные, non-whitelisted extensions).

### Как запустить локально

```bash
TEST_VAULT_PATH="/Users/evgeny/Dropbox/8 SecondBrain/OBSIDIAN-NOTION/Develop/Develop" npm run smoke
```

Ожидается: `=== 86/86 passed ===`.

---

## 4. Версия пакета

- `package.json` → `2.2.1`.

---

## Что НЕ поменялось

- 9 tools unchanged (имена, типы).
- Механика expand / dedup / rank_score / fuzzy — без изменений.
- Weighted RRF, Ollama-бекенд, watcher, `resolve_link` — без изменений.
- Safety boundaries (path-traversal, whitelist, response caps) — без изменений.

---

## Соседние отчёты

- [TESTING_REPORT_v2.2.0.md](TESTING_REPORT_v2.2.0.md) — отчёт live-тестирования v2.2.0, из которого вырос этот патч.
- [CHANGES_v2.2.0.md](CHANGES_v2.2.0.md) — предыдущий чек-лист.
- [../CHANGELOG.md](../CHANGELOG.md) — полный список изменений.
- [../README_rus.md](../README_rus.md) — подробная русская документация.
