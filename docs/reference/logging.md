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
