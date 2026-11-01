---
title: Контракты логирования
---

Все CR ниже namespaced, API `logging.gatorstack.dev/v1alpha1`.

| Kind | Размещение | Обязательные поля spec |
|---|---|---|
| LogSource | Защищённый namespace каталога | backendRef.name, accessRef.name, filters, fields |
| LogAccess | Namespace проекта | namespaceUID, projectUID, sourceRef.name, backendRef.name, accountID, projectID |

`LogSource.filters` — 1–8 обязательных точных равенств полей записи. `fields` —
1–24 пары `name`/`title` для проекции результата. `LogAccess.spec` неизменяем;
accountID — целое 1..4294967295, projectID — 0..4294967295. Запись grants разрешается
только администраторам. Отдельный permission — caller `get` конкретного LogAccess.

`ProductResource.spec.logging` — до 8 элементов: уникальный `id`, `sourceRef.name`,
`matchFields` (1–8 соответствий log field → JSON pointer основного CR), необязательные
`filters` (до 8 точных равенств). Пустое identity значение закрывает запрос. Поддержан
namespaced основной GVK со scope `CurrentProject`. Браузер не задаёт upstream URL,
tenant или identity predicates. `ProductPage` использует renderer `resource-logs`
и `logRef.name`, равный ID binding.

`POST /api/projects/{namespace}/products/{product}/pages/{page}/resources/{name}/logs/{id}`
требует сессию и `X-Gator-CSRF: 1`. JSON body: обязательный `uid`, необязательные
`query`, `start`, `end` (RFC3339), `limit` (1–1000; default 200). Неизвестные поля
и URL query parameters отвергаются. Максимум 30 дней и 4 MiB ответа. Выдача:
`fields`, `items`, `limit`, `retentionDays`. Ответы `Cache-Control: no-store`.
Автообновление и выгрузка используют те же полномочия. Постоянного tail endpoint нет.

[Установка и пример нового продукта](../operator-manual/logging.md).

## Проектные запросы

`GET /api/projects/{namespace}/logging/catalog` возвращает `streams`:
`resourceRef`, `logID`, `source`, `title`, `fields`, `resources` (name/uid/title).
Источники без LogAccess или доступных заказов отсутствуют. Каталог не выполняет
запросы в VictoriaLogs.

`POST /api/projects/{namespace}/logging/query` требует сессию и CSRF. JSON body:

```json
{
  "resourceRef": "s3-buckets",
  "logID": "access",
  "allResources": true,
  "query": "* | stats count() as count",
  "start": "2026-11-01T10:00:00Z",
  "end": "2026-11-01T11:00:00Z",
  "operation": "query",
  "limit": 200
}
```

`operation`: query (default) либо hits. При `allResources: false` укажите
`resources: [{"name":"order-name","uid":"immutable-uid"}]`; пустой массив даёт
пустую область. Одновременные allResources и непустой resources запрещены.
Лимиты: 128 ресурсов, 4096 символов query, 1000 строк и 4 MiB ответа, 30 дней.
Hits возвращает `buckets: [{time,count}]` и `total` без ограничения числом строк
таблицы. `fields/items` — безопасная проекция query, `resources` — проверенный scope.
Неизвестные поля, backend URLs/tenant IDs/filter overrides не принимаются.

`ProductResource.logging[].title` — подпись потока (до 160 символов),
`resourceTitlePath` — необязательный JSON pointer подписи заказа.
`LogSource.resultFields` — до 24 дополнительных name/title для вычисляемых колонок.
Общий page renderer: `x-dashboard-view: logging`.
