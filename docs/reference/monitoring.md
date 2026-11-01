---
title: Monitoring API
---

Группа `monitoring.gatorstack.dev/v1alpha1` описывает мониторинг ядра. Установка и
сетевые границы — в [руководстве администратора](../operator-manual/monitoring.md).

| Kind | Scope | Кто задаёт | Назначение |
|---|---|---|---|
| MonitoringBackend | Cluster | Администратор | Native VM refs, registry, export/network policy |
| ProjectMonitoring | Namespaced | Контроллер | Immutable привязка проекта к accountID |
| MetricSource | Cluster | Chart продукта | Native scrape spec и allowlist метрик |
| MetricOwnershipPolicy | Cluster | Chart продукта | Discovery GVK и predicates владения |
| MonitoringDashboard | Namespaced | Helm/GitOps/Kubernetes API | Панели, запросы, переменные, сетка |
| MetricExport | Namespaced | Пользователь | Remote write и credential Secret ref |

## Универсальный источник и владелец

Пример использует административную ConfigMap, которую создаёт интеграция продукта
в защищённом namespace `platform-identities`. Значения UID должны соответствовать
живым Namespace и Project/project. Клиент не должен иметь права менять эту карту.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: database-project-identity
  namespace: platform-identities
  labels: {example.cloud/product: database}
data:
  namespaceUID: replace-with-namespace-uid
  projectUID: replace-with-project-uid
  databaseTenant: tenant-123
---
apiVersion: monitoring.gatorstack.dev/v1alpha1
kind: MetricSource
metadata: {name: database-shared}
spec:
  backendRef: {name: platform}
  metricNames: database_.*
  staticScrape:
    jobName: database-projects
    targetEndpoints:
      - targets: [database-exporter.platform.svc:9100]
---
apiVersion: monitoring.gatorstack.dev/v1alpha1
kind: MetricOwnershipPolicy
metadata: {name: database-projects}
spec:
  sourceRefs: [database-shared]
  resource:
    apiVersion: v1
    kind: ConfigMap
    namespaces: [platform-identities]
    labelSelector:
      matchLabels: {example.cloud/product: database}
  project:
    namespaceUIDPath: /data/namespaceUID
    projectUIDPath: /data/projectUID
  metricLabels:
    tenant_id: {fieldPath: /data/databaseTenant}
```

`resource` принимает любой обнаруживаемый Kubernetes GVK. `namespaces` ограничивает
область чтения, `projectNamespaces: true` выбирает живые namespaces проектов;
`labelSelector` и `fieldSelector` передаются Kubernetes API. Для cluster-scoped
GVK namespaces не применяются. RBAC на GVK выдаётся отдельно.

`project` выбирает владельца по `namespaceUIDPath` либо `namespacePath`; без них
используется namespace исходного ресурса. `projectUIDPath` проверяет дополнительную
immutable привязку. JSON pointers используют экранирование `~1` для `/` в ключах.
`conditions` — список точных сравнений `{fieldPath, value}`; неподходящие ресурсы
не создают mappings.

`metricLabels` — непустая конъюнкция точных значений labels. Каждое значение берётся
из `fieldPath` либо константы `value`. Для JSON внутри base64-encoded поля можно
добавить `encoding: base64-json` и `jsonPointer`. Контроллер извлекает только
заявленное поле и не записывает исходный документ в status или registry.
Labels `vm_*`, `gator_*`, `__*` зарезервированы. Значения с разделителем `;` и
переводами строк отклоняются. Пересечения разных владельцев закрывают source.

Контроллер заменяет endpoint metricRelabelConfigs доверенной маршрутизацией.
Неподтверждённые ряды отбрасываются. Управляемые VMStaticScrape имеют label
`monitoring.gatorstack.dev/collector: projects`, который должен выбирать проектный
VMAgent. Provider integration управляет исходными ресурсами; ядро не знает их API.

## Дашборд из чарта продукта

Разместите ресурс в catalog namespace Dashboard, чтобы он появился в сервисном
списке. Тот же Kind в namespace проекта создаёт проектный дашборд. Оба вида
создаются и изменяются только через CRD; консоль предоставляет просмотр.

```yaml
apiVersion: monitoring.gatorstack.dev/v1alpha1
kind: MonitoringDashboard
metadata:
  name: database-overview
  namespace: gator-dashboard
spec:
  title: Database — нагрузка
  description: Запросы базы данных текущего проекта.
  productRef: {name: database}
  variables:
    - name: database
      title: База данных
      label: database
      query: count by(database)(database_queries_total)
  panels:
    - id: query-rate
      title: Запросы в секунду
      type: timeseries
      unit: ops/s
      layout: {x: 0, y: 0, w: 18, h: 11}
      queries:
        - datasource: project
          expr: sum by(database)(rate(database_queries_total{database=~"${database}"}[$__rate_interval]))
          legend: '{{database}}'
```

Сетка имеет 36 колонок; координаты и размеры заданы целыми числами. Поддерживаются
`timeseries`, `stat`, `table`, `text`; текст — обычный текст. `unit`: `bytes`,
`bytes/s`, `percent`, `ops/s`, `boolean`, `quota-bytes`, `quota-objects` либо пустое значение.
Для quota-units отрицательное значение отображается как «Не задана». До 32 панелей и 8 запросов на
панель. Datasource всегда `project`; внешних URL и исполняемых JS-плагинов нет.

Переменные получают значения labels из результата собственного PromQL query.
`${name}` подставляется как экранированное regex-значение; «Все» — `.*`.
`$__interval` и `$__rate_interval` учитывают выбранный период. Legend поддерживает
`{{label}}`. Для Helm экранируйте двойные фигурные скобки или храните spec в values
с последующим `toYaml`, чтобы шаблонизатор Helm не интерпретировал legend.

## Графики в карточке ресурса

В `ProductPage.spec.schema.inline.x-dashboard-detail.sections[]` добавьте секцию
`renderer: monitoring`. Она работает с любым GVK ресурса и тем же форматом панелей,
что `MonitoringDashboard`. Ниже — фрагмент schema карточки условной базы данных:

```yaml
x-dashboard-detail:
  tabs:
    - {id: overview, title: Обзор}
    - {id: monitoring, title: Мониторинг}
  sections:
    - title: Основное
      tab: overview
      renderer: fields
      paths: [/metadata/name]
    - title: Нагрузка базы данных
      tab: monitoring
      renderer: monitoring
      emptyText: Метрики появятся после создания базы данных.
      monitoring:
        bindings:
          database:
            path: /status/databaseID
          region:
            path: /spec/region
            fallbackPath: /status/region
        panels:
          - id: queries
            title: Запросы в секунду
            type: timeseries
            unit: ops/s
            queries:
              - datasource: project
                expr: sum(rate(database_queries_total{database=~"${database}",region=~"${region}"}[$__rate_interval]))
                legend: Запросы
            layout: {x: 0, y: 0, w: 36, h: 11}
```

`monitoring.bindings` содержит до 8 переменных. `{path, fallbackPath?}` читает
скаляр из текущего объекта; `{value: строка}` задаёт константу. Не смешивайте
`value` и пути. Имя переменной — буквы, цифры и `_`, начинается с буквы или `_`;
префикс `__` зарезервирован. Каждый `${name}` в запросах должен быть объявлен.
Используйте regex-селекторы `=~`: значение экранируется как буквальный regex и
JSON-строка. Даже `.*` из поля объекта не превращается в выбор всех ресурсов.

Если обязательное значение отсутствует, пусто, является массивом или объектом,
секция показывает `emptyText` и не отправляет запросы. При смене ресурса или
его идентификатора прежние графики сбрасываются. Скрытая вкладка запросы не
выполняет. Период, обновление, единицы и сетка общие с основными дашбордами.

Datasource всегда `project`; запросы проходят существующий авторизованный
gateway текущего проекта. Пользователю нужны права на ресурс и мониторинг.
Адреса VictoriaMetrics, учётные данные и tenant ID в schema не задаются.
Для этой секции требуется включённое ядро мониторинга и сбор соответствующих
метрик продуктом. Создания или редактора графиков в консоли нет.

## Экспорт через Kubernetes API

```yaml
apiVersion: monitoring.gatorstack.dev/v1alpha1
kind: MetricExport
metadata:
  name: central-monitoring
  namespace: project-a
spec:
  enabled: true
  interval: 30s
  remoteWrite:
    url: https://metrics.example.com/api/v1/write
    sendTimeout: 30s
```

RemoteWrite соответствует native VMAgentRemoteWriteSpec. Источник, routing scope,
агрегация/произвольный relabeling, proxy URL, файловые credential paths и размер
очереди контролируются ядром. `url`, Basic/Bearer/OAuth2/TLS Secret refs, headers,
timeout и протокол доступны в пределах backend policy.

Для секретов проще использовать UI: он создаёт protected Secret после успешной
записи CR от имени пользователя. При работе напрямую с Kubernetes создайте Secret
в том же namespace, задайте ownerReference на фактический MetricExport UID и labels
`monitoring.gatorstack.dev/project-uid` и `monitoring.gatorstack.dev/namespace-uid`.
Задайте `immutable: true` и label `monitoring.gatorstack.dev/export-config`: SHA-256
канонического JSON remoteWrite, первые 20 hex-символов. Для вычисления все
Secret selector names заменяются на `credentials`, ключи JSON сортируются,
пробелы между элементами отсутствуют. Fingerprint не включает значения Secret.
В Helm это `toJson | sha256sum | trunc 20` для такой канонической конфигурации.
После изменения подключения или ключей создайте новый immutable Secret с новым
именем и fingerprint; затем одним изменением CR задайте remoteWrite и ссылку.
В `credentialsSecretRef` укажите его имя. Все native SecretKeySelector внутри
remoteWrite должны ссылаться только на этот Secret. Межпроектные ссылки не допускаются.
Контроллер копирует данные в system namespace с привязкой к Export UID.

В status доступны observedGeneration, conditions, phase и agentRef. Значения
credentials в status отсутствуют. `Disabled`, `Starting`, `Running`, `Error`
описывают состояние агента. Удаление и ошибочная конфигурация останавливают экспорт.
