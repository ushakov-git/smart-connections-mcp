# Smart Connections MCP Server — подробное руководство (v2)

MCP-сервер, который делает твой Obsidian-vault доступным для любых
MCP-клиентов (Claude Desktop, Claude Code, произвольные агенты) через
протокол Model Context Protocol. Сервер не индексирует заметки сам — он
читает готовый индекс эмбеддингов плагина **Smart Connections**
(`<vault>/.smart-env/`) и отдаёт наружу семантический поиск, навигацию
по разделам и содержимое файлов.

Эта документация описывает v2.2.2 — форк, переписанный под современный
формат плагина, модели Ollama (в частности `bge-m3`), блочную
гранулярность поиска, горячую перезагрузку, расширение
результатов целыми разделами (`expand_to_section`),
дедупликацию (`deduplicate_by_section`) и управляемый размер ответа
(`include_blocks_list` / `max_blocks_per_hit` /
`MAX_NOTE_CONTENT_CHARS`). Для краткой английской версии смотри
[README.md](README.md).

## Что нового в v2.2.2 (кратко)

1. **Default `MAX_NOTE_CONTENT_CHARS`: 200 000 → 1 000 000 символов.**
   ~250-330k токенов на русском — покрывает Opus 4.7 (1M context).
   `full: true` по-прежнему снимает cap полностью.
2. **Новый env `MAX_NOTE_CONTENT_CHARS`** — конфигурируемый cap.
   Диапазон 1 000 – 50 000 000. Ставь значение под свой клиент.
3. **Важно**: клиентский MCP token-limit — отдельное ограничение.
   Сервер на него не влияет. Если клиент Claude Code режет ответ
   раньше server-cap'а — это клиентский лимит, повышение
   `MAX_NOTE_CONTENT_CHARS` тут не поможет. Для таких случаев
   пользуйся `get_block_content` (по разделам) или будущим
   `get_note_content_chunk` (в планах).

## Что нового в v2.2.1 (кратко)

1. **`include_blocks_list` / `max_blocks_per_hit`** — для
   `get_similar_notes`, `search_notes`, `get_embedding_neighbors`
   по умолчанию `false`: note-granularity хиты больше не тянут
   полный `blocks[]` с сотнями heading-ключей, что приводило к
   ответам, не влезающим в токен-лимит клиента. В
   `get_note_content` дефолт `true` (для совместимости) +
   `max_blocks` (150) — огромные заметки не раздувают JSON.
   Флаги `blocks_truncated` + `total_blocks_in_note` сообщают
   о трансформации.
2. **`get_block_content` на несуществующем heading** теперь
   бросает `"Block not found: <key>"` — как обещал README и
   CHANGES. Раньше сервер кидал "Block line range unknown..."
   вразрез с документацией.
3. **Smoke-тесты 73 → 86** — добавлены: унифицированный error,
   `include_blocks_list` default-off и opt-in, `max_blocks`
   truncation, `expand_to_section: "always"`, `DISABLE_SEMANTIC_SEARCH`
   fallback, три класса path-traversal guard.

**Breaking default:** если потребитель полагался на `blocks[]` в
note-granularity search-результатах — теперь нужно явно
`include_blocks_list: true`.

## Что нового в v2.2.0 (кратко)

1. **`expand_to_section`** — для high-similarity хитов и `#{N}`-фрагментов
   сервер автоматически подгружает полный markdown родительского раздела
   в `section_content`. Дефолт `"high-similarity"` с порогом cosine 0.8.
   В hybrid-режиме решение об expand принимается по pre-fusion cosine,
   а не по RRF-score.
2. **`deduplicate_by_section`** — хиты, попадающие в один и тот же
   `##`-раздел, схлопываются: остаётся лучший, остальные уходят в
   `sibling_matches`. Дефолт `true`, уровень 2.
3. **`rank_score` / `raw_rrf_score`** — в hybrid-ответе теперь есть
   нормализованная шкала 0..1 (top-1 = 1.0) и исходный RRF-score.
   `similarity` сохранён для обратной совместимости.
4. **Fuzzy heading lookup** — `get_block_content` и `search_blocks` при
   точном miss'е повторяют поиск с нормализацией whitespace/регистра и
   возвращают `warnings: ["fuzzy-matched: ..."]`.
5. **Дефолты подняты** — excerpt 500 → 1500, note-cap 100 000 → 200 000 (в v2.2.2 поднят ещё раз до 1 000 000 — см. выше).
6. **Skill `obsidian-knowledge-search`** — агентская инструкция в
   `.claude/skills/`, покрывает все 9 инструментов, паттерны
   использования, ошибки и антипаттерны.

Все изменения **аддитивны** — существующие поля ответа сохранены.

---

## Содержание

1. [Зачем это нужно](#зачем-это-нужно)
2. [Архитектура в общих чертах](#архитектура-в-общих-чертах)
3. [Как сервер работает с vault Obsidian](#как-сервер-работает-с-vault-obsidian)
4. [Заметки и блоки — модель данных](#заметки-и-блоки--модель-данных)
5. [Выбор активной эмбеддинг-модели](#выбор-активной-эмбеддинг-модели)
6. [Взаимодействие с Ollama](#взаимодействие-с-ollama)
7. [Режимы поиска в `search_notes`](#режимы-поиска-в-search_notes)
8. [Горячая перезагрузка (watcher)](#горячая-перезагрузка-watcher)
9. [Модель безопасности](#модель-безопасности)
10. [Установка и сборка](#установка-и-сборка)
11. [Переменные окружения и `.env`](#переменные-окружения-и-env)
12. [Подключение к MCP-клиенту](#подключение-к-mcp-клиенту)
13. [Сценарии для нескольких vault](#сценарии-для-нескольких-vault)
14. [Каталог tools (подробно)](#каталог-tools-подробно)
15. [Формат ответов](#формат-ответов)
16. [Диагностика и типовые проблемы](#диагностика-и-типовые-проблемы)
17. [Ограничения и что осталось за кадром](#ограничения-и-что-осталось-за-кадром)

---

## Зачем это нужно

У плагина Smart Connections уже есть:
- пайплайн эмбеддинга заметок и их разделов (блоков),
- кэш векторов на диске,
- встроенный UI похожих заметок внутри Obsidian.

Но плагин сам по себе не отдаёт эти данные наружу. Если ты хочешь,
чтобы **внешний агент** (условно Claude Code) мог искать по твоей базе
знаний, нужен мост. Эта прослойка — читает артефакты плагина и
превращает их в набор MCP-tools, которые агент может вызывать.

Что получает агент на выходе каждого поискового вызова:

- **релевантные заметки и блоки** с числовой мерой похожести,
- **ссылочный пакет** (`path`, `heading`, `lines`) — чтобы при
  необходимости дочитать нужный раздел,
- **excerpt** — первые ~500 символов содержимого для мгновенного
  использования,
- **метаданные запроса** — какая модель, сколько миллисекунд, сколько
  заметок в индексе, какие были предупреждения.

Сервер **только читает** данные (никогда не пишет в vault), работает
**локально** и делает максимум один исходящий сетевой вызов — на
`localhost` в Ollama, и то только если семантический поиск включён.

---

## Архитектура в общих чертах

Сервер — это тонкий конвейер из независимых модулей в
[`src/`](src/):

```
   MCP-клиент (Claude Desktop / Code / …)
              │  stdio (MCP JSON-RPC)
              ▼
  ┌──────────────────────────────────────────────────────┐
  │  index.ts  — точка входа, список tools, диспетчер    │
  └──┬──────────┬────────────┬──────────────┬───────────┘
     ▼          ▼            ▼              ▼
  loader    search-engine  link-resolver  ollama-client
     │          │            │              │
     ▼          ▼            ▼              ▼
  vault-watcher      types       ajson-parser  env-loader
     │
     ▼
  <vault>/.smart-env/*        +   локальная файловая система
                                   (для чтения .md-заметок)
```

Что делает каждый модуль:

- [`src/env-loader.ts`](src/env-loader.ts) — читает `.env` файл (если
  есть) в рабочей директории, не переопределяя переменные, уже
  заданные клиентом MCP.
- [`src/ajson-parser.ts`](src/ajson-parser.ts) — парсит
  специфический формат `*.ajson`, которым пользуется Smart Connections
  (важно: это не валидный JSON, см. ниже).
- [`src/embedding-models-loader.ts`](src/embedding-models-loader.ts) —
  читает новый формат плагина `embedding_models/embedding_models.ajson`,
  строит индексы моделей.
- [`src/smart-connections-loader.ts`](src/smart-connections-loader.ts)
  — основной loader: читает `smart_env.json`, выбирает активную модель,
  загружает в память все заметки и блоки с эмбеддингами.
- [`src/embedding-utils.ts`](src/embedding-utils.ts) — математика:
  cosine similarity, `findNearestNeighbors`.
- [`src/search-engine.ts`](src/search-engine.ts) — поисковые алгоритмы
  (nearest-neighbor, keyword substring, hybrid RRF), сборка hit'ов с
  excerpt'ами, построение графа связей.
- [`src/ollama-client.ts`](src/ollama-client.ts) — минимальный клиент
  Ollama `/api/embed` (fetch + AbortController + LRU-кэш на 100
  запросов).
- [`src/vault-watcher.ts`](src/vault-watcher.ts) — `fs.watch` на
  `.smart-env/multi/`, debounce, инкрементальная или полная
  перезагрузка индекса.
- [`src/link-resolver.ts`](src/link-resolver.ts) — парсер
  Obsidian-ссылок (`[[...]]`, `obsidian://…`).
- [`src/index.ts`](src/index.ts) — точка входа: загружает `.env`,
  стартует loader, проверяет Ollama, запускает watcher, вешает
  shutdown-хуки, регистрирует MCP tools и обрабатывает вызовы.
- [`src/types.ts`](src/types.ts) — все интерфейсы (`SmartSource`,
  `SmartBlock`, `ActiveModel`, `SimilarNote`, `ResultRef`, …).

Такая декомпозиция сделана специально: каждый модуль легко заменить
или расширить, и большинство будущих правок локальны (например, можно
добавить клиента для другого провайдера эмбеддингов рядом с
`ollama-client.ts`, не трогая остальное).

---

## Как сервер работает с vault Obsidian

Сервер ожидает, что Smart Connections уже отработал в Obsidian хотя бы
один раз и создал директорию `<vault>/.smart-env/`. Ниже — что
именно в ней сервер читает и как это понимает.

### Структура `.smart-env/`

```
.smart-env/
├── smart_env.json                     # глобальный конфиг плагина
├── embedding_models/
│   └── embedding_models.ajson         # реестр всех настроенных моделей
├── multi/
│   ├── <имя-заметки-1>.ajson          # заметка + её блоки
│   ├── <имя-заметки-2>.ajson
│   └── ...
├── chat_completion_models/            # (не читается сервером)
├── ranking_models/                    # (не читается сервером)
└── ...                                # прочее — игнорируется
```

### `smart_env.json`

Обычный JSON. Оттуда сервер берёт:

- `embedding_models.default_model_key` — **основной источник правды**
  о том, какая модель активна (например, `ollama#1776670752600`).
- Поле `smart_sources.embed_model` в v2.0.0 **игнорируется** — в
  новых версиях Smart Connections оно устаревает и начинает врать.

### `embedding_models/embedding_models.ajson`

Список конфигураций эмбеддинг-моделей. Одна строка — одна запись:

```
"embedding_models:ollama#1776670752600": {"provider_key":"ollama","model_key":"bge-m3:latest","dims":384,"host":"http://localhost:11434","endpoint":"/api/embed", ...}
```

Важные поля для сервера:

- `provider_key` — например `"ollama"` или `"transformers"`.
- `model_key` — то, как модель называет сама себя (и под этим
  ключом сервер ищет вектор внутри каждой заметки, например
  `"bge-m3:latest"`).
- `host`, `endpoint` — адрес для Ollama (сервер возьмёт их как
  fallback, если не задан `OLLAMA_HOST`).
- `dims` — **не доверяем**. Для bge-m3 там стоит `384`, хотя реальная
  размерность векторов — `1024`. Поэтому сервер определяет
  размерность рантайм по первому встреченному вектору.

### `multi/*.ajson` — сами заметки и блоки

Основной массив данных. Каждый файл — один markdown-документ и его
разбивка на блоки. Формат — построчный, одна строка = одна запись:

```
"smart_sources:01 MASTRA/Mastra 1.md": {"path":"01 MASTRA/Mastra 1.md","embeddings":{"bge-m3:latest":{"vec":[...]}}, "blocks":{...}},
"smart_blocks:01 MASTRA/Mastra 1.md#---frontmatter---": {"key":"01 MASTRA/Mastra 1.md#---frontmatter---","lines":[1,14],"size":671,"embeddings":{"bge-m3:latest":{"vec":[...]}}},
"smart_blocks:01 MASTRA/Mastra 1.md#Введение": {"lines":[15,80], ...},
"smart_blocks:01 MASTRA/Mastra 1.md#Введение#Цели": {"lines":[20,45], ...},
...
```

Ключевые моменты:

- **Это не валидный JSON.** Каждая строка — пара `"ключ": {...}` с
  висящей запятой в конце. Парсер сервера
  ([`src/ajson-parser.ts`](src/ajson-parser.ts)) срезает запятую и
  оборачивает остаток в фигурные скобки, чтобы получить валидный
  JSON-объект, после чего передаёт пары наружу.
- Префикс `smart_sources:` обозначает заметку целиком, `smart_blocks:`
  — один раздел.
- Для блоков ключ имеет формат `<vault-relative-path>#<heading-chain>`.
  Первый `#` — граница между путём и цепочкой заголовков. В именах
  файлов Obsidian запрещает `#`, поэтому граница однозначна.
- У каждой записи есть поле `embeddings`, где **ключ — это `model_key`**
  (например, `"bge-m3:latest"`), а значение — `{vec: number[], last_embed: {...}}`.

### Что происходит при старте

1. Загружается `smart_env.json`.
2. Загружается `embedding_models/embedding_models.ajson`.
3. Резолвится активная модель (см. раздел ниже).
4. Сканируется `multi/*.ajson`. Для каждого `.ajson`-файла:
   - все `smart_sources:`-записи идут в индекс заметок (`Map<path, SmartSource>`),
   - все `smart_blocks:`-записи — в индекс блоков (`Map<blockKey, SmartBlock>`),
   - плюс вспомогательный индекс «source → list of block keys».
5. Записи **без вектора под активной моделью пропускаются** и
   считаются отдельно — сервер не хранит «полу-записи».
6. Определяется фактическая размерность эмбеддинга (по первому
   непустому вектору).
7. В лог (stderr) пишется сводка: сколько заметок и блоков в индексе,
   сколько пропущено, какие параметры активной модели.

Пример реального стартового лога на vault с bge-m3:

```
[smart-connections-mcp] active model: model_key="bge-m3:latest" provider="ollama" full_key="ollama#1776670752600" dims=1024 resolution=default-model-key
[smart-connections-mcp] sources: 140 kept / 8 replaced / 3 no-embedding / 0 null-path / 0 parse-errors (from 140 .ajson files)
[smart-connections-mcp] blocks:  11686 kept / 12 replaced / 9357 no-embedding / 0 bad-key
[smart-connections-mcp] semantic search: Ollama healthy — host="http://localhost:11434" model="bge-m3:latest" dims=1024
[smart-connections-mcp] ready — vault="Develop" path="/…" model="bge-m3:latest" dims=1024 sources=140 blocks=11686 semantic=on
[watcher] started — multi=true models=true root=true
[smart-connections-mcp] running on stdio
```

Расшифровка:

- `sources: 140 kept / 8 replaced` — 140 уникальных заметок, 8 из
  которых встретились в `.ajson`-файлах больше одного раза (типичная
  ситуация после перемещений файлов внутри Obsidian).
- `3 no-embedding` — три заметки по какой-то причине не имеют вектора
  под активной моделью (например, она слишком короткая или не
  переиндексирована).
- `blocks: 11686 kept / 9357 no-embedding` — из ~21k разделов 11.6k
  имеют эмбеддинг. Остальные короче `smart_blocks.min_chars` (200 по
  умолчанию в Smart Connections) и не эмбеддятся — это нормально.

### Чтение содержимого заметок

Содержимое markdown читается лениво, по запросу, через
[`SmartConnectionsLoader.readNoteContent`](src/smart-connections-loader.ts):

1. Путь проверяется на выход за пределы vault
   (path-traversal-guard, включая `realpath` против symlink-escape).
2. Проверяется расширение — разрешены только `.md`, `.markdown`,
   `.canvas`.
3. Файл читается через `fs.readFileSync`.

Для извлечения **раздела** используется соответствующий диапазон строк
(`lines: [start, end]`) из блочного индекса.

---

## Заметки и блоки — модель данных

Ключевая идея v2 в том, что сервер различает два уровня гранулярности.

### Заметка (note, `SmartSource`)

Целый markdown-файл. У него один эмбеддинг на весь текст. Полезно для
запросов уровня «какие ещё документы похожи на этот». Ключ в
индексе — vault-relative путь, например
`01 MASTRA/1. MASTRA – Основной КУРС/Mastra 1.md`.

### Блок (`SmartBlock`)

Раздел заметки, ограниченный заголовком. У блока:

- составной ключ вида `<path>#<heading-chain>`, например
  `01 MASTRA/Mastra 1.md#Введение#Цели`;
- диапазон строк `lines: [startLine, endLine]` (1-based, включительно);
- собственный эмбеддинг под тем же `model_key`;
- размер в байтах на момент индексации (`size`).

Cap на `min_chars` в Smart Connections (по умолчанию 200) означает,
что короткие блоки **не получают эмбеддинг** и не попадают в
поисковый индекс. Сервер это видит и учитывает: такие блоки
фиксируются в счётчике `blocks: no-embedding` и не возвращаются в
результатах.

### Зачем различать

У типичной заметки 100–300 блоков. Искать на уровне блоков — значит
попадать точно в нужный раздел, а не в огромный документ. Именно
поэтому **гранулярность по умолчанию — блок** (`granularity: "block"`).

Если тебе нужен документ целиком — передай `granularity: "note"`.
Сервер это честно поддерживает в `get_similar_notes` и
`get_embedding_neighbors`.

Каждый возвращаемый hit несёт **ссылочный пакет** (`ResultRef`):

```jsonc
{
  "path": "01 MASTRA/Mastra 1.md",   // vault-relative путь
  "heading": "#Введение#Цели",       // цепочка заголовков, только для блоков
  "lines": [20, 45],                 // только для блоков
  "similarity": 0.742,
  "excerpt": "…первые ~500 симв.…",
  "excerpt_truncated": false,
  "vault_name": "Develop"
}
```

Это минимальный набор, которого достаточно агенту, чтобы:

- показать пользователю чтобы тот кликнул (`path` + `heading`),
- собрать цитату на лету (`excerpt`),
- при желании запросить полное содержимое раздела
  (`get_block_content` с тем же `block_key`).

---

## Выбор активной эмбеддинг-модели

Один vault может содержать эмбеддинги от нескольких моделей сразу
(особенно если ты менял модель в Smart Connections). Сервер
обязан выбрать **одну** активную на весь runtime. Алгоритм
резолвинга ([`resolveActiveModel`](src/smart-connections-loader.ts)):

1. **`SMART_EMBED_MODEL_KEY` из окружения** — самый высокий
   приоритет. Принимает либо полный ключ
   (`"ollama#1776670752600"`), либо короткий `model_key`
   (`"bge-m3:latest"`). Если значение задано, но не нашлось в
   `embedding_models.ajson`, сервер упадёт с понятным сообщением —
   это сознательно, чтобы не подставлять втихую не ту модель.

2. **`smart_env.json → embedding_models.default_model_key`** — то,
   что Smart Connections выбирает сам.

3. **Автоопределение.** Сервер сканирует первые 20 `.ajson`-файлов
   и выбирает тот `model_key`, который встречается чаще всего в
   `embeddings.*`. Полезно для vault'ов, где `default_model_key` ещё
   не проставлен.

Источник выбора сохраняется в поле `ActiveModel.resolution`:
`"env-override" | "default-model-key" | "autodetect-sources"`. Его
можно увидеть в ответе `get_stats`.

### Автодетект размерности (dims)

Поле `dims` из `embedding_models.ajson` **игнорируется**. В реальных
vault'ах оно может быть неверным (например, для `bge-m3` там `384`, а
реальные векторы — `1024`). Сервер определяет `dims` рантайм, по
первому непустому вектору; это значение потом идёт во все проверки
(в частности, в `get_embedding_neighbors`).

### Что значит «нет эмбеддинга под активной моделью»

Если ты переключил модель в Smart Connections, но ещё не перестроил
индекс, часть заметок будет иметь векторы только под старой моделью.
Сервер их **не возьмёт в индекс** (потому что cosine между векторами
разных моделей бессмыслен) и честно посчитает в `sourcesSkippedNoEmbedding`.
Решение — либо переиндексировать vault в Smart Connections, либо
переключить `SMART_EMBED_MODEL_KEY` на старую модель.

---

## Взаимодействие с Ollama

Ollama нужна **только** для семантического поиска по произвольному
запросу (`search_notes` в режимах `semantic` и `hybrid`). Всё
остальное — похожие заметки/блоки, граф связей, чтение содержимого —
работает без Ollama, поскольку все векторы уже лежат в
`.smart-env/multi/`.

### Когда Ollama включается

Semantic опт-ин: сервер включает его **только** если при старте
выполнены **все** три условия:

1. `DISABLE_SEMANTIC_SEARCH != 1`,
2. задан `OLLAMA_HOST` (явно или через `embedding_models.ajson.host`),
3. `health()`-проба прошла успешно: сервер достижим, модель
   загружена, **размерность вектора совпадает с тем, что в vault**.

Если размерности не совпали — сервер **принципиально не включает**
semantic-путь. Иначе cosine-score при сравнении `query-vec` (чужой
модели) с `vault-vec` (правильной модели) получится мусорным, и
результаты выглядели бы «правильными», но были бы не связаны с
запросом.

### Как именно сервер обращается к Ollama

[`src/ollama-client.ts`](src/ollama-client.ts) шлёт одиночный HTTP
POST-запрос:

```
POST http://localhost:11434/api/embed
Content-Type: application/json

{
  "model": "bge-m3:latest",
  "input": "твой запрос"
}
```

и ожидает ответа формата

```json
{"model":"bge-m3:latest","embeddings":[[ ... 1024 floats ... ]]}
```

После чего сервер считает cosine между этим вектором и всеми векторами
заметок/блоков в индексе, сортирует по убыванию и возвращает топ.

Дополнительно:

- **Timeout 10 секунд** через `AbortController`. Если модель не
  отвечает — ошибка ловится, идёт fallback на keyword-поиск с
  предупреждением в `meta.warnings`.
- **LRU-кэш на 100 запросов**: повторяющийся запрос возвращает
  cached-вектор мгновенно (в smoke-тесте: 88 ms холодный → 0 ms тёплый).
- **Никаких других сетевых вызовов сервер не делает.** Ни телеметрия,
  ни update-check, ни что-то ещё.

### Как выбрать, что конкретно подаёт сервер в Ollama

По умолчанию: тот же `model_key`, что использован в vault'е. Если
нужно переопределить (например, если твоя модель в Ollama называется
иначе), задай `OLLAMA_EMBED_MODEL`.

### Полное отключение

`DISABLE_SEMANTIC_SEARCH=1` — сервер даже не пробует Ollama. Режим
`semantic` в `search_notes` будет автоматически отдавать keyword с
предупреждением.

---

## Режимы поиска в `search_notes`

`search_notes` принимает произвольный текстовый запрос и умеет три
режима:

### `semantic`

1. Запрос эмбеддится в Ollama.
2. Считается cosine между query-vec и каждым вектором в индексе
   (по гранулярности, block-level по умолчанию).
3. Возвращается топ-N с пометкой `search_mode: "semantic"`.

### `keyword`

Простейший substring-скоринг:

- ищется подстрока (регистронезависимо) в теле каждой заметки;
- score = `min(число совпадений / 10, 1.0)`.

Медленнее семантики (читает файлы с диска на каждый запрос), но
работает без внешних сервисов и хорошо ловит редкие термины, имена
собственные, акронимы.

### `hybrid` (по умолчанию, если Ollama доступна)

Берёт топ из `semantic` и топ из `keyword`, сливает их **взвешенным**
алгоритмом Reciprocal Rank Fusion:

```
score(doc) = w_sem × Σ_semantic(1 / (k + rank + 1))
           + w_kw  × Σ_keyword (1 / (k + rank + 1))
```

где `rank` — позиция документа в соответствующем списке, начиная с 0.

**Параметры настройки** (через env, подхватываются при старте):

| Переменная | Что делает | Default |
|---|---|---|
| `RRF_K` | Сглаживающая константа. Применяется одинаково к обоим спискам, поэтому **сама по себе не смещает баланс** semantic ↔ keyword — она только сглаживает разницу между соседними рангами (большее `k` → меньше разница). | 60 |
| `RRF_SEMANTIC_WEIGHT` | Вес семантического списка. Увеличь (например, 0.8–0.95), чтобы эмбеддинги доминировали. | 0.7 |
| `RRF_KEYWORD_WEIGHT` | Вес keyword-списка. Увеличь, если много ищешь имена собственные, цитаты, акронимы — то, на что общая модель эмбеддинга плохо попадает. | 0.3 |

> **Важно про `k`:** распространённая интуиция «больший `k` усилит
> семантику» — неверна. `k` входит в формулу симметрично по обоим
> спискам, поэтому сам по себе не меняет их баланс. Для реального
> сдвига в сторону семантики повышай `RRF_SEMANTIC_WEIGHT` (или
> уменьшай `RRF_KEYWORD_WEIGHT`). Текущие дефолты (`0.7 / 0.3`)
> уже дают ощутимый перекос к эмбеддингам, оставляя keyword как
> страховку на редкие термины.

Преимущество гибридного режима: устойчивость к «слепым зонам»
семантики (редкие термины, точные цитаты) и к «слепым зонам» keyword
(синонимы, парафразы, перевод между языками).

Идентификатор hit'а в fusion — `path#heading` для блоков или `path`
для нот, так что один и тот же раздел из двух списков честно
суммируется.

Текущую фьюжн-конфигурацию видно в `meta.fusion` в каждом ответе
и в выводе `get_stats`.

### Graceful fallback

Если semantic или hybrid запрошен, но Ollama внезапно недоступна (или
не настроена), сервер:

- возвращает keyword-результаты,
- выставляет `meta.search_mode: "keyword"`,
- выставляет `meta.fallback_from: "semantic"` или `"hybrid"`,
- дописывает строку в `meta.warnings` с понятной причиной.

Агент всегда видит, какой путь реально отработал.

---

## Горячая перезагрузка (watcher)

Если Smart Connections в фоне переиндексирует заметки (ты поправил
файл, плагин дотаскивает новый эмбеддинг), сервер не нужно
перезапускать. За это отвечает
[`src/vault-watcher.ts`](src/vault-watcher.ts):

- `fs.watch` на `.smart-env/multi/` — при изменении любого `.ajson`
  перечитывается только этот файл, новые/обновлённые записи мержатся
  в индекс по ключу `path` (для заметок) или `blockKey` (для блоков).
- `fs.watch` на `.smart-env/embedding_models/` и `.smart-env/smart_env.json`
  — **полная** перезагрузка: при изменении конфига может смениться
  активная модель, а это инвалидирует весь индекс.
- Debounce 500 мс (на файл) — «всплески» записи от плагина
  схлопываются в один reload.
- Удаления `.ajson`-файлов не обрабатываются специально — устаревшие
  записи остаются, пока не произойдёт следующий полный reload. На
  практике это редкость.

Выключить: `DISABLE_WATCHER=1`.

---

## Модель безопасности

Сервер спроектирован так, чтобы его можно было запускать в том же
процессе, что имеет доступ к HOME-директории — но при этом не раздавать
секреты, если агента обманул prompt injection внутри заметки.

### Только чтение

Во всём коде нет ни одного `fs.writeFile` / `unlink` / `rename` /
`mkdir` и т.п. Сервер физически не может изменить vault или
что-то ещё.

### Path-traversal containment

[`resolveInsideVault`](src/smart-connections-loader.ts) делает три
проверки подряд:

1. путь должен быть **относительным** и непустым;
2. `path.resolve(vault, notePath)` должен лежать внутри `vault` (с
   точностью до `path.sep`);
3. после `fs.realpathSync` результат всё ещё должен лежать внутри
   (защита от symlink-escape).

Любой из вариантов `../../.ssh/id_rsa`, `/etc/passwd`, symlink на
`/etc/passwd` внутри vault'а — зарежется ещё до `readFileSync`.

### Whitelist расширений

Даже если путь формально внутри vault, сервер отдаст только
`.md`, `.markdown`, `.canvas`. Попытка прочитать `.env`, `.yaml`,
бинарник и т.п. — сразу ошибка.

### Лимиты на тяжёлые параметры

В tools-схемах захардкожены cap'ы:

- `limit` ≤ 100,
- `depth` ≤ 4 (граф),
- `max_per_level` ≤ 25 (граф — защита от экспоненциального обхода),
- `excerpt_chars` ≤ 5000,
- `query` ≤ 2000 символов,
- `get_note_content` обрезает ответ до 100 000 символов (если не
  передано `full: true`).

### Dim-guard

`get_embedding_neighbors` проверяет, что длина присланного вектора
ровно совпадает с размерностью активной модели. То же самое в
Ollama-клиенте: если Ollama вернула вектор «не той длины», сервер
бросит понятную ошибку и не загрязнит поиск.

### Исходящая сеть

Единственная возможная исходящая связь — POST на `OLLAMA_HOST`.
По умолчанию это `127.0.0.1:11434` (loopback). Никаких
analytics/telemetry/update-check нет.

---

## Установка и сборка

### Требования

- Node.js **18+** (нужен встроенный `fetch` и `AbortController`).
- Obsidian-vault, где **уже отработал** плагин Smart Connections
  (должна существовать директория `<vault>/.smart-env/smart_env.json`
  и наполненная `<vault>/.smart-env/multi/`).
- *Опционально*: Ollama с нужной эмбеддинг-моделью (для семантического
  `search_notes`).

### Шаги

```bash
git clone https://github.com/ushakov-git/smart-connections-mcp.git
cd smart-connections-mcp
npm install
npm run build       # собирает dist/ из src/
```

`dist/` **не коммитится** в репозиторий — всегда пересобирай локально,
чтобы исключить артефакты чужой сборки.

### Быстрая проверка

Если Smart Connections-vault уже есть, можно прогнать
интеграционный smoke-тест:

```bash
TEST_VAULT_PATH="/путь/к/vault" npm run smoke
```

Тест выполнит ~60 проверок: резолвер модели, консистентность dims,
счётчики, поиск по блокам/нотам, traversal-защиту, resolve_link.
Ollama-специфичные проверки автоматически пропускаются, если эндпоинт
не доступен.

---

## Переменные окружения и `.env`

Сервер настраивается через переменные окружения. Их можно передавать
двумя способами: inline в конфиге MCP-клиента (секция `env`) или через
файл `.env` рядом с рабочей директорией сервера. Значения из конфига
клиента имеют приоритет.

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `SMART_VAULT_PATH` | Абсолютный путь к корню vault. | *обязательна* |
| `SMART_VAULT_NAME` | Человекочитаемое имя vault'а, попадает в `meta.vault_name` в каждом ответе. | `basename(SMART_VAULT_PATH)` |
| `SMART_EMBED_MODEL_KEY` | Принудительно задать модель: полный ключ (`ollama#1776670752600`) или короткий `model_key` (`bge-m3:latest`). | резолвится из `smart_env.json` |
| `OLLAMA_HOST` | Если задан — включает semantic-поиск. Пример: `http://127.0.0.1:11434`. | `embedding_models.ajson.host` если есть, иначе — не используется |
| `OLLAMA_EMBED_MODEL` | Имя модели, которое сервер пошлёт в поле `model` запроса Ollama. | активный `model_key` |
| `DISABLE_SEMANTIC_SEARCH` | `1` — жёстко выключить Ollama-путь даже при валидном `OLLAMA_HOST`. | unset |
| `DISABLE_WATCHER` | `1` — не запускать hot-reload watcher (актуально на сетевых/Dropbox-томах, где `fs.watch` теряет события). | unset |
| `RRF_K` | Сглаживающая константа гибридного RRF. Чем больше, тем ближе scores соседних рангов. Баланс semantic/keyword **не меняет** (симметрична). | 60 |
| `RRF_SEMANTIC_WEIGHT` | Вес семантического списка в гибриде. Увеличь (например, до 0.85), чтобы эмбеддинги доминировали ещё сильнее. | 0.7 |
| `RRF_KEYWORD_WEIGHT` | Вес keyword-списка в гибриде. Увеличь, если чаще ищешь редкие термины, имена или цитаты. | 0.3 |

### Формат `.env`

Поддерживается только базовый синтаксис:

```
KEY=value
KEY="значение с пробелами"
KEY='с одинарными тоже можно'
# комментарий
```

Без подстановки переменных, без многострочных значений, без `export`.
Файл читается при старте. Строки, которые уже выставлены клиентом,
никогда не перезаписываются.

---

## Подключение к MCP-клиенту

### Claude Desktop

Файл конфигурации:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Минимальный пример:

```json
{
  "mcpServers": {
    "smart-connections-develop": {
      "command": "node",
      "args": ["/ABS/PATH/smart-connections-mcp/dist/index.js"],
      "env": {
        "SMART_VAULT_PATH": "/Users/me/Vaults/Develop",
        "SMART_VAULT_NAME": "Develop"
      }
    }
  }
}
```

Полный пример (с Ollama):

```json
{
  "mcpServers": {
    "smart-connections-develop": {
      "command": "node",
      "args": ["/ABS/PATH/smart-connections-mcp/dist/index.js"],
      "env": {
        "SMART_VAULT_PATH": "/Users/me/Vaults/Develop",
        "SMART_VAULT_NAME": "Develop",
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "OLLAMA_EMBED_MODEL": "bge-m3:latest"
      }
    }
  }
}
```

После сохранения конфига — **полностью** закрыть Claude Desktop
(Cmd+Q на macOS) и запустить заново. В UI появится индикатор
подключённых MCP-tools; логи сервера пишутся в
`~/Library/Logs/Claude/` (macOS).

### Claude Code (CLI)

Два типовых способа.

**Вариант A — один сервер на vault** (через `.mcp.json` в корне
vault'а, который Claude Code подхватывает, когда запускается из этой
директории).

Шаблон, который можно скопировать в любой vault — потом достаточно
поменять `SMART_VAULT_PATH` и `SMART_VAULT_NAME`:

```json
{
  "mcpServers": {
    "smart-connections-develop": {
      "command": "node",
      "args": [
        "/Users/evgeny/Dropbox/4-Base-of-Skills/9-Instrumental-skills/Obsidian/mcp-to-obsidian-smart-connection/smart-connections-mcp/dist/index.js"
      ],
      "env": {
        "SMART_VAULT_PATH": "/Users/me/Vaults/Develop",
        "SMART_VAULT_NAME": "Develop",
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "OLLAMA_EMBED_MODEL": "bge-m3:latest",
        "RRF_K": "60",
        "RRF_SEMANTIC_WEIGHT": "0.7",
        "RRF_KEYWORD_WEIGHT": "0.3"
      }
    }
  }
}
```

Этот файл уже лежит в `Develop`-vault как образец. Для новых vault'ов:
копируешь `.mcp.json` рядом, меняешь две строки — и всё, Claude Code
подхватит новый сервер.

**Вариант B — регистрация из CLI**:

```bash
claude mcp add smart-connections-develop \
  /ABS/PATH/smart-connections-mcp/dist/index.js \
  -e SMART_VAULT_PATH=/Users/me/Vaults/Develop \
  -e SMART_VAULT_NAME=Develop
```

### Любой другой MCP-клиент

Сервер общается по stdio. Клиенту достаточно:

1. Запустить процесс `node /ABS/PATH/smart-connections-mcp/dist/index.js`
   с нужными `env`.
2. Читать stdout как поток JSON-RPC (MCP-сообщения), писать в stdin
   свои запросы.
3. Смотреть stderr — там стартовый лог, диагностика, сообщения
   watcher'а. **На stdout** сервер пишет только MCP-трафик.

---

## Сценарии для нескольких vault

Один инстанс MCP-сервера обслуживает **ровно один** vault. Это
сознательное решение:

- проще безопасность (path-containment в границах одного vault);
- `meta.vault_name` в каждом ответе — надёжный ярлык для агента;
- рестарт/fsреасшifr одного инстанса не мешает другим.

### Как зарегистрировать несколько

Каждый vault — отдельная запись в `mcpServers`, с уникальным именем:

```json
{
  "mcpServers": {
    "sc-develop": {
      "command": "node",
      "args": ["/ABS/PATH/smart-connections-mcp/dist/index.js"],
      "env": {
        "SMART_VAULT_PATH": "/Users/me/Vaults/Develop",
        "SMART_VAULT_NAME": "Develop"
      }
    },
    "sc-personal": {
      "command": "node",
      "args": ["/ABS/PATH/smart-connections-mcp/dist/index.js"],
      "env": {
        "SMART_VAULT_PATH": "/Users/me/Vaults/Personal",
        "SMART_VAULT_NAME": "Personal"
      }
    },
    "sc-work": {
      "command": "node",
      "args": ["/ABS/PATH/smart-connections-mcp/dist/index.js"],
      "env": {
        "SMART_VAULT_PATH": "/Users/me/Vaults/Work",
        "SMART_VAULT_NAME": "Work",
        "DISABLE_SEMANTIC_SEARCH": "1"
      }
    }
  }
}
```

Клиент автоматически префиксует tool-имена именем сервера, так что у
агента получается `mcp__sc-develop__search_notes`,
`mcp__sc-personal__search_notes` и т.д. — плюс `meta.vault_name` в
ответе, если вдруг префикс не виден.

### Как хранить настройки по vault

Удобный паттерн — положить в каждом vault (или рядом) свой `.env`:

```
/Users/me/mcp-configs/develop.env
/Users/me/mcp-configs/personal.env
```

И запускать сервер с `cwd` на нужной директории. Либо просто
перечислять переменные inline в конфиге клиента — что тебе удобнее.

---

## Каталог tools (подробно)

Все tools принимают JSON-объект и возвращают JSON. Всё выполняется
**локально**; единственный возможный внешний вызов — Ollama, и то
только в `search_notes` с режимом `semantic`/`hybrid`.

### 1. `get_similar_notes`

**Что делает.** Ищет семантически похожие заметки или блоки по
готовому вектору из vault'а. Это самый частый сценарий: «у меня есть
заметка X, что у меня ещё есть на эту тему».

**Параметры:**

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `note_path` | string | — | Vault-relative путь к заметке. |
| `threshold` | number (0–1) | 0.5 | Нижняя граница cosine similarity. |
| `limit` | int (1–100) | 10 | Максимум hit'ов. |
| `granularity` | `"note" \| "block"` | `"block"` | По умолчанию — блочная гранулярность. |
| `include_excerpt` | boolean | true | Добавлять ли excerpt в hit. |
| `excerpt_chars` | int (1–5000) | 500 | Длина excerpt'а в символах. |

**Пример вызова:**

```json
{
  "note_path": "01 MASTRA/Mastra 1.md",
  "limit": 5,
  "threshold": 0.6
}
```

**Пример ответа (сокращённо):**

```jsonc
{
  "meta": {
    "vault_name": "Develop",
    "model_key": "bge-m3:latest",
    "dims": 1024,
    "semantic_available": true,
    "total_notes": 140,
    "total_blocks": 11686,
    "execution_ms": 12
  },
  "results": [
    {
      "path": "01 MASTRA/Mastra 1 (NotebookLM).md",
      "heading": "#Архитектура",
      "lines": [42, 98],
      "similarity": 0.844,
      "excerpt": "…",
      "excerpt_truncated": false,
      "vault_name": "Develop"
    }
  ]
}
```

**Когда использовать.** Пользователь спрашивает «что ещё у меня
есть про X», открыт конкретный документ, нужен контекст «соседних»
разделов.

### 2. `search_blocks`

**Что делает.** Ищет блоки, похожие на указанный блок (не на заметку
целиком). Как `get_similar_notes`, но исходная точка — раздел, а не
файл.

**Параметры:**

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `block_key` | string | — | Составной ключ `"<path>#<heading-chain>"`. |
| `threshold` | number (0–1) | 0.5 | — |
| `limit` | int (1–100) | 10 | — |
| `include_excerpt` | boolean | true | — |
| `excerpt_chars` | int (1–5000) | 1500 | С v2.2.0 дефолт поднят с 500. |

Сервер автоматически исключает сам `block_key` из результатов (через
поле `excludeBlockKey` в [src/search-engine.ts](src/search-engine.ts)).
Другие блоки той же заметки **возвращаются** — это сознательно: дедуп
по `##`-секциям уже свёртывает непосредственных соседей внутри секции,
а показ остальных секций той же заметки обычно даёт полезный контекст.
Если хочется видеть только блоки из других заметок, отфильтруй
результаты по `hit.path !== <исходный path>` на стороне клиента.

**Пример:**

```json
{
  "block_key": "01 MASTRA/Mastra 1.md#Архитектура#Слой агентов",
  "limit": 8
}
```

### 3. `search_notes`

**Что делает.** Поиск по произвольному тексту запроса. Три режима,
подробно описаны в разделе «Режимы поиска».

**Параметры:**

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `query` | string (1–2000) | — | Сам запрос. |
| `mode` | `"semantic" \| "keyword" \| "hybrid"` | `hybrid` если Ollama есть, иначе `keyword` | — |
| `granularity` | `"note" \| "block"` | `"block"` | Только для `semantic`/`hybrid`. Keyword работает только по нотам. |
| `limit` | int (1–100) | 10 | — |
| `threshold` | number (0–1) | 0.5 | Порог similarity (применяется после fusion в hybrid). |
| `include_excerpt` | boolean | true | — |
| `excerpt_chars` | int (1–5000) | 500 | — |

**Пример:**

```json
{
  "query": "observability и трейсинг агентов Mastra",
  "mode": "hybrid",
  "limit": 5
}
```

Ответ дополнительно содержит в `meta`:

```jsonc
{
  "search_mode": "hybrid",
  "fallback_from": "hybrid",   // если был fallback, иначе поля нет
  "warnings": ["…"]            // человекочитаемые причины fallback
}
```

### 4. `get_embedding_neighbors`

**Что делает.** Принимает «сырой» вектор (массив float) и возвращает
ближайших соседей в vault'е. Полезно, когда у клиента уже есть свой
эмбеддер/векторное представление.

**Параметры:**

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `embedding_vector` | `number[]` | — | Длина **должна точно** совпадать с активной `dims`. |
| `k` | int (1–100) | 10 | — |
| `threshold` | number (0–1) | 0.5 | — |
| `granularity` | `"note" \| "block"` | `"block"` | — |
| `include_excerpt` | boolean | true | — |
| `excerpt_chars` | int (1–5000) | 500 | — |

Ошибка `embedding_vector has X dims, expected Y` означает, что клиент
использует другой эмбеддер. Это не баг — это защита от молчаливых
мусорных результатов.

### 5. `get_connection_graph`

**Что делает.** Строит **дерево** семантических связей от стартовой
заметки на заданную глубину.

**Параметры:**

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `note_path` | string | — | Vault-relative путь к корневой заметке. |
| `depth` | int (1–4) | 2 | Глубина обхода. |
| `threshold` | number (0–1) | 0.6 | Минимальная similarity для связи. |
| `max_per_level` | int (1–25) | 5 | Сколько соседей брать на каждом уровне. |

**Пример ответа:**

```jsonc
{
  "meta": { ... },
  "graph": {
    "root": "01 MASTRA/Mastra 1.md",
    "connections": [
      { "path": "…", "depth": 1, "similarity": 0.82 },
      { "path": "…", "depth": 2, "similarity": 0.71 }
    ],
    "tree": {
      "path": "01 MASTRA/Mastra 1.md",
      "depth": 0,
      "similarity": 1.0,
      "children": [
        {
          "path": "…",
          "depth": 1,
          "similarity": 0.82,
          "children": [ … ]
        }
      ]
    }
  }
}
```

Совмещает **плоский список** (для простых агентов) и настоящее
**дерево** (для тех, кто хочет иерархию). Обход защищён от циклов:
каждая заметка посещается не более одного раза.

### 6. `get_note_content`

**Что делает.** Возвращает markdown-содержимое заметки.

**Параметры:**

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `note_path` | string | — | Vault-relative путь (только `.md` / `.markdown` / `.canvas`). |
| `include_blocks` | `string[]` | — | Опциональный список заголовков — для совместимости с v1, в v2 ответ всегда включает полный текст. |
| `full` | boolean | false | `true` — снять cap 100 000 символов. |

**Пример ответа:**

```jsonc
{
  "meta": {
    "vault_name": "Develop",
    "truncated": false,
    "original_length": 8421,
    "execution_ms": 3,
    ...
  },
  "path": "01 MASTRA/Mastra 1.md",
  "content": "# Mastra 1…\n\n…",
  "blocks": ["#---frontmatter---", "#Введение", "#Введение#Цели", ...]
}
```

Если содержимое было обрезано, `meta.truncated: true` и
`meta.original_length` содержит реальную длину.

### 7. `get_block_content`

**Что делает.** Возвращает markdown только одного раздела, без
остального документа. Идеально после `get_similar_notes` /
`search_blocks`, когда excerpt'а не хватило.

**Параметры** (нужен один из двух вариантов):

| Поле | Тип | Описание |
|---|---|---|
| `block_key` | string | Составной ключ `"<path>#<heading>"`. |
| `path` + `heading` | string + string | Альтернативная форма. `heading` можно передавать с ведущим `#` или без. |

**Пример:**

```json
{
  "block_key": "01 MASTRA/Mastra 1.md#Архитектура#Слой агентов"
}
```

**Ответ:**

```jsonc
{
  "meta": { ... },
  "path": "01 MASTRA/Mastra 1.md",
  "heading": "#Архитектура#Слой агентов",
  "lines": [120, 168],
  "content": "## Слой агентов\n\n…",
  "vault_name": "Develop"
}
```

### 8. `resolve_link`

**Что делает.** Разбирает Obsidian-ссылку и отдаёт нормализованный
путь/раздел. Сервер **не читает сам файл** — это чисто парсер, он
работает вместе с `get_note_content` / `get_block_content`.

**Параметры:**

| Поле | Тип | Описание |
|---|---|---|
| `link` | string | Вики-ссылка или `obsidian://` URI. |

**Поддерживаемые форматы:**

- `[[Note]]` — bare-wikilink, резолвится по индексу basename'ов.
- `[[Folder/Note]]` — полный путь внутри vault.
- `[[Note#Heading]]`, `[[Note#H1#H2]]` — с цепочкой заголовков.
- `[[Note|Alias]]` — alias срезается.
- `obsidian://open?vault=X&file=Folder/Note` — стандартный URI.
- `obsidian://advanced-uri?...&filepath=...&heading=...` —
  `advanced-uri`-плагин.
- `obsidian://...&block=blockref` — преобразуется в `#^blockref`.

**Пример:**

```json
{"link":"[[01 MASTRA/Mastra 1#Архитектура]]"}
```

**Ответ:**

```jsonc
{
  "meta": {
    "vault_name": "Develop",
    "warnings": []
  },
  "input": "[[01 MASTRA/Mastra 1#Архитектура]]",
  "form": "wikilink",
  "path": "01 MASTRA/Mastra 1.md",
  "heading": "#Архитектура",
  "warnings": []
}
```

**Что попадает в `warnings`:**

- `ambiguous wikilink "..." — N candidates: ...` — basename встречается
  в нескольких местах; сервер возвращает первый найденный,
  но предупреждает.
- `obsidian:// URI targets vault "Other", this server serves "..."` —
  URI адресован другому vault'у (`vault_mismatch: true` в основном
  объекте ответа).
- `path "..." is not present in the Smart Connections index` — в
  индексе такого пути нет; возможно, заметка ещё не переиндексирована,
  или путь с ошибкой.

### 9. `get_stats`

**Что делает.** Сводка о состоянии сервера: какая модель активна, что
лежит в индексе, доступна ли Ollama.

**Параметры:** нет.

**Пример ответа:**

```jsonc
{
  "meta": { ... },
  "totalNotes": 140,
  "totalBlocks": 11686,
  "totalSourceBlockHeadings": 22054,
  "embeddingDimension": 1024,
  "modelKey": "bge-m3:latest",
  "providerKey": "ollama",
  "modelFullKey": "ollama#1776670752600",
  "modelResolution": "default-model-key",
  "vaultName": "Develop",
  "vaultPath": "/Users/me/Vaults/Develop",
  "load": {
    "sourceFilesScanned": 140,
    "sourcesKept": 140,
    "sourcesReplaced": 8,
    "sourcesSkippedNoEmbedding": 3,
    "sourcesSkippedNullPath": 0,
    "blocksKept": 11686,
    "blocksReplaced": 12,
    "blocksSkippedNoEmbedding": 9357,
    "blocksSkippedBadKey": 0,
    "parseErrors": 0
  }
}
```

Полезно при отладке, чтобы понять, что именно сервер «видит» в
vault'е.

---

## Формат ответов

У каждого tool-ответа **одинаковый** верхний конверт:

```jsonc
{
  "meta": {
    "vault_name": "Develop",
    "model_key": "bge-m3:latest",
    "dims": 1024,
    "semantic_available": true,
    "total_notes": 140,
    "total_blocks": 11686,
    "execution_ms": 37,
    // у search_notes дополнительно:
    "search_mode": "hybrid",
    "fallback_from": "semantic",   // если было, иначе поля нет
    "warnings": [ "…" ]
  },
  // … полезная нагрузка конкретного tool'а
}
```

Если tool упал, ответ выглядит так:

```jsonc
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\": \"…\", \"meta\": { ... }}"
    }
  ],
  "isError": true
}
```

Агент всегда может посмотреть `meta`, чтобы понять:

- какой vault,
- какая модель,
- сколько заметок/блоков в индексе на момент запроса,
- сколько это заняло,
- если был fallback — почему.

---

## Диагностика и типовые проблемы

Коротко. Полная версия — в [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

### Сервер не стартует: `Could not resolve active embedding model`

Не нашёл активную модель. Варианты:

- в `smart_env.json` нет `embedding_models.default_model_key` —
  открой Obsidian с плагином хотя бы раз;
- задай `SMART_EMBED_MODEL_KEY` вручную (короткий `model_key` или
  полный `provider#ts`).

### `WARNING: 0 sources matched active model "X"`

Все заметки проиндексированы под другой моделью. Либо переиндексируй
vault в Obsidian, либо задай `SMART_EMBED_MODEL_KEY` на ту модель,
которая реально использовалась.

### `search_notes` возвращает keyword вместо semantic

В `meta.warnings` будет причина. Типовые случаи:

- Ollama не запущена/не подтягивается (`curl http://localhost:11434/api/tags`).
- Модель не скачана (`ollama pull bge-m3:latest`).
- Dims mismatch между Ollama и vault'ом (переиндексируй или
  переконфигурируй).
- Явно `DISABLE_SEMANTIC_SEARCH=1`.

### `Ollama returned N-d vector, expected M`

Сервер отказывается работать с разными размерностями. Приведи в
соответствие: либо в Ollama поставь ту же модель, что использовалась в
vault'е, либо переиндексируй vault новой моделью.

### Watcher не видит правок

- macOS/Windows работают хорошо;
- на Linux/Dropbox/сетевых томах `fs.watch` может терять события —
  вариант: `DISABLE_WATCHER=1` и перезапускать сервер руками, или
  периодически вызывать `get_stats` (сервер всё равно не lazy, но
  внешний пинок может помочь).

### Сервер не появляется в Claude Desktop

- проверь, что JSON-конфиг без trailing commas;
- пути должны быть абсолютными;
- **полностью** выйди из Claude Desktop (Cmd+Q) и открой заново;
- логи в `~/Library/Logs/Claude/` (macOS).

---

## Ограничения и что осталось за кадром

- **Один vault на инстанс.** По соображениям безопасности и
  предсказуемости.
- **Только Smart Connections формат.** Если плагин не запустили —
  сервер не поднимется.
- **Keyword-режим читает все файлы на каждый запрос** и делает
  regex-скан. Это устраивает на vault'ах до нескольких тысяч заметок,
  на десятках тысяч станет ощутимо медленно. В будущем можно добавить
  BM25-индекс.
- **Удаления заметок в `.ajson` не инвалидируют индекс мгновенно.**
  Последний reload при старте даст актуальную картину; в редких
  случаях может потребоваться рестарт сервера.
- **Поиск «по многим моделям» не поддерживается.** Один inventor на
  startup — одна модель. Если у тебя смешанный vault, явно задай
  `SMART_EMBED_MODEL_KEY`.
- **Нет поддержки `.canvas`-сериализации внутри `get_note_content`.**
  Расширение в whitelist есть, но содержимое возвращается как raw JSON
  файла Obsidian-canvas. Для markdown-заметок это не актуально.

---

## Ссылки

- Проект Smart Connections:
  <https://github.com/brianpetro/obsidian-smart-connections>
- Model Context Protocol: <https://modelcontextprotocol.io/>
- Этот репозиторий: <https://github.com/ushakov-git/smart-connections-mcp>
- Ollama: <https://ollama.com/>

Если что-то в этом документе устарело относительно кода — код в
[`src/`](src/) источник истины. Исправления приветствуются.
