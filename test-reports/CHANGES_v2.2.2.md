---
title: Что поменялось в smart-connections-mcp v2.2.2 — чек-лист для ручного теста
date: 2026-04-23
---

# v2.2.2 — чек-лист изменений для ручного теста

Патч-релиз. Адресует финальное наблюдение из live-тестирования v2.2.1: заметки в сотни тысяч символов (под 1M-context модели вроде Opus 4.7) ограничивались server-cap'ом `MAX_NOTE_CONTENT_CHARS = 200_000`. Cap поднят в 5 раз и стал конфигурируемым через env.

## 1. Default cap на `get_note_content`: 200 000 → 1 000 000 символов

- На русском markdown ≈ 250-330k токенов. На смешанном (код + кириллица) ≈ 220-280k токенов. Помещается в 1M-context окне.
- `full: true` по-прежнему снимает cap полностью.
- `meta.truncated` + `meta.original_length` работают без изменений.

### Как проверить

На заметке 200k–500k символов:

```
get_note_content(note_path: "<очень большая заметка>.md")
```

Ожидается: `meta.truncated: false`, `meta.original_length: <реальный размер>`, полный `content`. Раньше (v2.2.1 и раньше) этот же вызов дал бы `truncated: true` уже на 200k символов.

На заметке >1M символов:

```
get_note_content(note_path: "<огромная заметка>.md")
```

Ожидается: `meta.truncated: true`, `meta.original_length: >1_000_000`, `content.length === 1_000_000`. Для полного текста — добавить `full: true`.

## 2. Новый env `MAX_NOTE_CONTENT_CHARS`

- Диапазон: 1 000 – 50 000 000 (символов, не токенов).
- Валидация через существующий `parseNum` — неверные значения логируются в stderr и откатываются на дефолт.
- Пример настройки в `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "smart-connections-develop": {
      "command": "node",
      "args": [".../smart-connections-mcp/dist/index.js"],
      "env": {
        "SMART_VAULT_PATH": "/path/to/vault",
        "SMART_VAULT_NAME": "Develop",
        "MAX_NOTE_CONTENT_CHARS": "2000000"
      }
    }
  }
}
```

### Как проверить

При старте сервер логирует в stderr:

```
[smart-connections-mcp] note_content_cap=1000000 chars (default)
```

Если env выставлен:

```
[smart-connections-mcp] note_content_cap=2000000 chars (from env)
```

## 3. Важно: client token-limit — отдельное ограничение

Server-cap и клиентский MCP token-limit — разные вещи. Сервер не может повлиять на то, как клиент (Claude Code VSCode, Claude Desktop, произвольный MCP-клиент) режет ответ в своём слое. В [TESTING_REPORT_v2.2.1.md](TESTING_REPORT_v2.2.1.md) тест №6 это явно зафиксировал: 152k-символьная заметка возвращалась валидным JSON от сервера, но клиент обрезал её по собственному лимиту токенов.

Если клиент Claude Code режет ответ раньше server-cap'а — поднятие `MAX_NOTE_CONTENT_CHARS` не поможет. Что делать в таком случае:

1. **Используй `get_block_content`** — чтение по разделам (heading'ам). Каждый раздел — отдельный ответ, уложится в клиентский лимит.
2. **Используй `search_blocks` → выдача `section_content`** — на high-similarity хитах сервер уже возвращает полный markdown раздела (до `expand_max_chars = 5000`, можно поднять).
3. **Ждём v2.3.0** — в backlog `get_note_content_chunk(path, from_line, to_line)` для постраничного чтения.

## 4. Что НЕ поменялось

- Smoke-тесты: 86/86, регрессий нет.
- Все 9 tools — без изменения контракта.
- Cap'ы на excerpt (5 000), expand (20 000), blocks_per_hit (500), max_blocks (2 000) — без изменений.
- `full: true`, `include_blocks_list`, `max_blocks` — работают как в v2.2.1.

## 5. Версия пакета

- `package.json`: 2.2.1 → 2.2.2.

---

## Соседние отчёты

- [TESTING_REPORT_v2.2.1.md](TESTING_REPORT_v2.2.1.md) — live-тест, из которого вырос этот патч.
- [CHANGES_v2.2.1.md](CHANGES_v2.2.1.md) — предыдущий чек-лист.
- [../CHANGELOG.md](../CHANGELOG.md) — полный список изменений.
