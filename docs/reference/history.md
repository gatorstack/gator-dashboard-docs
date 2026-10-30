---
title: HistoryRecord и HistoryPolicy
---

API-группа — `history.gatorstack.dev/v1alpha1`. Оператор поставляется отдельно:
[Gator History](https://github.com/gatorstack/gator-history).

| Сущность/поле | Назначение |
| --- | --- |
| HistoryPolicy | Cluster-scoped политика хранения |
| spec.retentionDays | Целое 1–365, стандартный профиль 30 |
| HistoryRecord | Namespaced запись, переживающая удаление target |
| spec.policyRef.name | Имя HistoryPolicy |
| spec.occurredAt / expiresAt | Время операции и предельный срок хранения |
| spec.actor | Проверенная Kubernetes-идентичность |
| spec.product / resource | Product и ProductResource либо встроенный IAM |
| spec.operation / action | create/update/delete и подпись именованного действия |
| spec.target / source | GVK, namespace, name, UID целевого и исходного объекта |
| spec.changes | path/title и разрешённые before/after в JSON-представлении скаляра |
| status.outcome | Accepted, Rejected, Unknown |
| status.target | Identity результата, включая UID созданного объекта |
| status.httpStatus | Код ошибки API без тела ответа |

Spec записи неизменяем. Кластерный администратор остаётся доверенной стороной:
это операционная история, без криптографической защиты от администратора.

`GET /api/projects/:namespace/activity` принимает `uid`, `actor`, `operation`,
`outcome`, `days`, `search` (до 256 байт), `limit` (1–100) и `continue`. Ответ: items, continue,
retentionDays. Права чтения проверяются от пользователя для текущего проекта.
`search` — регистронезависимая подстрока в метаданных: ID, инициатор, продукт,
контракт ресурса, операция/действие, name/UID/GVK target и source. Пробелы по
краям удаляются. Фильтрация идёт до пагинации; before/after не ищутся.
Лимит сканирования — 20 000 CR на запрос; при превышении сузьте период или фильтры.

Декларативные расширения: `ProductResource.spec.history.fields`,
`x-dashboard-view: activity-history` и Detail `renderer: activity-history`.
Подробнее — [руководство администратора](../operator-manual/history.md).

Операция `access` используется для явной выдачи connection credentials.
`action: reveal:<output id>` обозначает output ProductResource, а target —
основной CR. Secret data, Secret reference и значения полей в запись не включаются.
Итог Accepted подтверждает успешный Kubernetes GET, а не создание нового ключа.
