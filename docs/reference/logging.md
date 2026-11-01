---
title: Контракты логирования
---

LogSource и LogAccess — namespaced CR, API `logging.gatorstack.dev/v1alpha1`.

| Kind | Размещение | Обязательные поля spec |
|---|---|---|
| LogSource | Защищённый namespace каталога | backendRef.name, accessRef.name, filters, fields |
| LogAccess | Namespace проекта | namespaceUID, projectUID, sourceRef.name, backendRef.name, accountID, projectID |

`LogSource.filters` — 1–8 обязательных точных равенств полей записи. `fields` —
1–24 пары `name`/`title` для проекции результата. `LogAccess.spec` неизменяем;
accountID — целое 1..4294967295, projectID — 0..4294967295. Запись grants разрешается
только администраторам. Permission — caller `get logaccesses` без resourceName в namespace проекта.
Он проверяется через SelfSubjectAccessReview до и после query/hits.

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
`resourceRef`, `logID`, `source`, `title`, `fields`.
Источники без LogAccess отсутствуют; наличие заказов и product CRUD не проверяются. Каталог не выполняет
запросы в VictoriaLogs.

`POST /api/projects/{namespace}/logging/query` требует сессию и CSRF. JSON body:

```json
{
  "resourceRef": "s3-buckets",
  "logID": "access",
  "query": "* | stats count() as count",
  "start": "2026-11-01T10:00:00Z",
  "end": "2026-11-01T11:00:00Z",
  "operation": "query",
  "limit": 200
}
```

`operation`: query (default) либо hits. Область — весь project tenant для source/view.
Поля resources/allResources больше не принимаются (HTTP 400). Нет права logging —
HTTP 403 для каталога, query/hits и ресурсных logs endpoints.
Лимиты: 4096 символов query, 1000 строк и 4 MiB ответа, 30 дней.
Hits возвращает `buckets: [{time,count}]` и `total` без ограничения числом строк
таблицы. `fields/items` — безопасная проекция query.
Неизвестные поля, backend URLs/tenant IDs/filter overrides не принимаются.

`ProductResource.logging[].title` — подпись потока (до 160 символов),
`resourceTitlePath` — необязательный JSON pointer подписи заказа.
`LogSource.resultFields` — до 24 дополнительных name/title для вычисляемых колонок.
Общий page renderer: `x-dashboard-view: logging`.


## Автоматическое подключение и ingestion

`LogSource.spec.autoAccess` (boolean, default false) включает общую платформенную
Composition. Она создаёт immutable LogAccess во всех живых проектах данного
backend, включая проекты без заказов. Ручные grants и список проектов в продукте
не нужны. `ingestion` необязателен для уже существующего внешнего data plane.

| Поле ingestion | Значение |
| --- | --- |
| kafkaTopic | Уникальное имя `gator-logs-*`, до 180 символов; unrouted зарезервирован |
| ownership.resource | apiVersion/kind, необязательные namespace и matchLabels защищённого GVK |
| ownership.namespacePath | JSON pointer имени namespace в объекте владельца |
| ownership.namespaceUIDPath | Альтернатива namespacePath: pointer UID namespace |
| ownership.projectUIDPath | Обязательный pointer текущего Project UID |
| ownership.matchFields | 1–8 соответствий log field → pointer владельца, непустые строки |

Ровно один namespace pointer обязателен. Source.fields, Source.filters и identity
поля образуют allowlist ingestion; произвольные payload поля удаляются. GVK
владелец и его RBAC чтения для Crossplane поставляются chart продукта.

`LogAccessManager` — cluster-scoped XR того же API, один на backend. Его spec
задаёт catalog/system namespaces, registry, native routes/consumer ConfigMaps,
queryURL и Kafka параметры. Identity backend/registry и Kafka cluster/bootstrap
неизменяемы; partitions/replicas/retention настраиваются через values. Status содержит initialized,
registryUID, projectCount/sourceCount/grantCount, phase. Registry сохраняет ID,
UID и identity tombstones; удаление manager и очистка registry запрещены admission.
Это административный ресурс платформы; logging.viewer/owner его не изменяют.
