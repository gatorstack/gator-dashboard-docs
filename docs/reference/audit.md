---
title: AuditTrail
---

`audit.gatorstack.dev/v1alpha1`, kind `AuditTrail`, scope Namespaced.
Основной XR одного трейла. Его namespace — проект, а Composition закреплена XRD.

## Параметры

| Поле | Значение |
| --- | --- |
| `spec.enabled` | Включить сбор/доставку |
| `spec.projectUID`, `namespaceUID` | Назначаются admission, неизменяемые identity |
| `spec.captureFrom` | Назначается admission; обновляется при повторном включении |
| `spec.events.sources` | Непустое множество `console`, `kubernetes`, `s3` |
| `spec.events.categories` | `management`, `data` |
| `spec.events.readWrite` | `All`, `Read`, `Write` |
| `spec.events.include`, `exclude` | Точные типы или префиксы с завершающим `*` |
| `spec.destination.type` | Одно из `logging`, `s3`, `siem` |
| `destination.s3.bucketRef`, `userRef` | `{name, uid}` текущих S3Bucket/S3User проекта |
| `destination.s3.prefix` | Непустой выделенный префикс архива |
| `destination.siem.host`, `port` | Адрес syslog-приёмника, порт 1–65535 |
| `destination.siem.transport` | `TCP`, `UDP`, `TLS` |
| `destination.siem.format` | `RFC3164`, `RFC5424` |
| `destination.siem.caSecret` | Имя Secret с `ca.crt`, необязательно |
| `destination.siem.clientSecret` | Имя Secret с `tls.crt`/`tls.key`, необязательно |
| `destination.siem.serverName` | Проверяемое имя TLS; по умолчанию host |

Пример трейла, отправляющего изменения в логирование:

```yaml
apiVersion: audit.gatorstack.dev/v1alpha1
kind: AuditTrail
metadata:
  name: project-changes
  namespace: example-project
spec:
  enabled: true
  events:
    sources: [console, kubernetes, s3]
    categories: [management, data]
    readWrite: Write
    exclude: [kubernetes.core.events.*]
  destination:
    type: logging
```

Project/namespace UID и время сбора добавит webhook. Замените namespace на
существующий проект. S3 refs должны содержать UID фактических ресурсов, а не
произвольные строки. Loopback, unspecified и link-local literal SIEM адреса
запрещены. Исходящий доступ к приёмникам также ограничивайте сетевой политикой
своей среды.

Форма использует Content revision для S3-каталогов: изменения служебных
timestamps не требуют повторного выбора. UID, готовность, значимые поля
выбранного ресурса и доступ пользователя проверяются при каждом сохранении.

## Состояние доставки

`status.delivery` содержит `ready`, `reason`, `observedGeneration`, `delivered`,
`lastEventID`, `lastDeliveredAt`, `lastFailureAt`, `updatedAt`. Счётчик отражает
успешные попытки; он не является количеством уникальных событий.
`logAccessUID`, `logAccountID`, `logProjectUID`, `logNamespaceUID` закрепляют
проектный endpoint логирования. Чувствительных значений в status нет.
Crossplane `Ready=True` отражает готовность composed state для текущей generation.

## Каноническое событие

| Поля | Смысл |
| --- | --- |
| `event_id`, `event_time` | Стабильная identity и исходное UTC время |
| `event_source`, `event_type` | Источник и тип действия |
| `category`, `read_only` | Категория и признак чтения |
| `actor`, `actor_type` | Нативный субъект, user/service_account |
| `namespace`, `namespace_uid`, `project_uid` | Подтверждённая проектная принадлежность |
| `resource`, `resource_uid` | Цель действия; UID, если источник его предоставляет |
| `outcome`, `http_status` | Принятие/отказ/неопределённость и код API |
| `request_id`, `source_ip`, `user_agent` | Доступные исходные метаданные |
| `trail_uid`, `trail_name` | Identity доставляющего трейла |
| `_time`, `_msg`, `gator_source` | Поля проектного логирования; source=`cloud-audit` |

Тип Kubernetes: `kubernetes.<apiGroup или core>.<resource>.<verb>`.
Тип консоли: `console.<product>.<resource>.<operation>`.
Тип S3: `s3.<native operation>`, например `s3.put_obj`.
Системные события без namespaced цели не присваиваются проекту по догадке.

CEF header использует vendor `GatorStack`, product `Audit`, version `1`.
Extension содержит `externalId`, `rt`, `suser`, `act`, `outcome`, `request`,
`cs1=Project UID`, `cs2=Resource`, `cs3=Source`, `cs4=Trail UID` и соответствующие
labels. `src` передаётся только для корректного IP. Header/extension экранируются
отдельно; CR/LF не создают дополнительных syslog сообщений.

Для проектного экрана источник задаётся декларативно:

```yaml
x-dashboard-view: logging
x-dashboard-logging:
  sourceRef:
    name: audit
```

Этот фильтр выбирает источник интерфейса. Авторизацию и проектную изоляцию
продолжает обеспечивать общий контракт LogAccess.

В JSON Schema форм `x-dashboard-widget: checkbox-group` на массиве с `items.enum`
показывает набор переключателей. `items.x-dashboard-enumLabels` задаёт подписи,
а `minItems`/`uniqueItems` остаются обычной JSON Schema валидацией.

В режиме History Webhook источник console ждёт подтверждённого API-кода и
Dashboard context marker. Native-only HistoryRecord не считается действием
консоли. Изменение resource outcome в истории не меняет исход API в аудите.
Kubernetes event ID учитывает серверное время начала/завершения запроса и цель,
поэтому повторный клиентский Audit-ID не схлопывает разные запросы.
