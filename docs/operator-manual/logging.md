---
title: Клиентское логирование
---

Gator использует стандартные VictoriaLogs, VMAuth и Vector. Generic gateway
Dashboard проверяет Kubernetes RBAC и связывает записи с основным GVK заказа.
Отдельного продуктового HTTP-сервиса или lifecycle controller для логирования нет.
Первый продуктовый источник — request access/error RGW. Retention — 30 дней.

## Data plane

Предварительные условия: VictoriaMetrics Operator с `VLSingle` API v1, Ingress
nginx, совместимый cert-manager ClusterIssuer, рабочий DNS/TLS, StorageClass и
заранее выделенные уникальные числовые tenant IDs. Используйте отдельный namespace
`logging`. Chart `gator-infrastructure/charts/logging` из комплекта поставляет
VLSingle, VMAuth, ingress только `/write/`, сетевые ограничения и проектные LogAccess.
VLSingle не обеспечивает HA. PVC сохраняется после удаления CR/release.

Примените logging CRD из chart Dashboard перед установкой. Подготовьте values:

```yaml
host: logs.example.org
storage: 50Gi
storageClass: local-path
retention: 30d
image: victoriametrics/victoria-logs:v1.53.0
authImage: victoriametrics/vmauth:v1.155.0
credentialSecret: gator-logging-auth
backend: native
source: s3
access: s3
projects:
- namespace: team-a
  namespaceUID: REPLACE_WITH_NAMESPACE_UID
  projectUID: REPLACE_WITH_PROJECT_UID
  accountID: 1001
```

Получите UID через выбранный контекст:

```sh
kubectl --context "$CONTEXT" get namespace team-a -o jsonpath='{.metadata.uid}'
kubectl --context "$CONTEXT" -n team-a get projects.dashboard.gatorstack.dev project -o jsonpath='{.metadata.uid}'
```

Tenant IDs не переиспользуются. При пересоздании namespace/Project подготовьте
новый ID и новый grant; старый UID не переносится автоматически. LogAccess spec
неизменяем. Храните реестр назначений и резервную копию grants вместе с backend.

Chart ожидает Secret `gator-logging-auth` с ключом `auth.yml`: native конфигурацию
VMAuth с разными Bearer credentials записи и чтения. Для каждого проекта читатель
имеет отдельный route: `src_paths: [/select/logsql/(query|hits)]`, точный `src_headers`
`AccountID: 1001`, fixed headers `AccountID: 1001`, `ProjectID: 0`, upstream
`http://vlsingle-customers.logging.svc:9428`. Writer route принимает только
`/write/team-a/insert/jsonline`, удаляет два сегмента префикса и назначает те же
fixed headers. Ни writer, ни reader не получают произвольные `/select/*`,
`/internal/*` или `/delete/*` endpoints. Внешний ingress публикует только writer.
Храните реальные credentials в Secret и закрытых файлах сборщика.

```sh
kubectl --context "$CONTEXT" create namespace logging
helm upgrade --install gator-logging gator-infrastructure/charts/logging \
  --kube-context "$CONTEXT" -n logging -f logging-values.yaml --wait
kubectl --context "$CONTEXT" -n logging get vlsingle,pods,pvc,certificate
```

Установка study автоматизирована `logging/deploy-study.py` из infrastructure.
Она проверяет сервер, UID проекта и protected owner GVK, сохраняет credentials,
проверяет коллизии tenant IDs и устанавливает штатные компоненты. RGW native ops
log и Vector на его VM настраиваются из продуктового Vector-профиля. Повторите
bootstrap при добавлении проекта; для нового бакета конфигурация не меняется.

## Gateway Dashboard

Создайте в namespace Dashboard Secret с ключом `token` для reader. В values:

```yaml
logging:
  backends:
  - name: native
    url: http://vmauth-logs.logging.svc:8427
    existingSecret: gator-logging-reader
```

Endpoint и файл credentials определяются установкой, а не пользовательским CR
или HTTP-запросом. Не открывайте VictoriaLogs напрямую. NetworkPolicy разрешает
его порт только VMAuth, а VMAuth — Dashboard и ingress controller. Для внешнего
сборщика обязательны HTTPS и отдельные write credentials.

## Подключение продукта через GVK

В namespace каталога создайте LogSource. Все поля здесь — разрешённый выходной
набор; identity поля могут использоваться для фильтрации без показа клиенту.

```yaml
apiVersion: logging.gatorstack.dev/v1alpha1
kind: LogSource
metadata:
  name: database-requests
  namespace: gator-dashboard
spec:
  backendRef: {name: native}
  accessRef: {name: database-requests}
  filters: {source: managed-database}
  fields:
  - {name: _time, title: Время}
  - {name: _msg, title: Сообщение}
  - {name: level, title: Уровень}
```

Продуктовый chart добавляет в свой ProductResource:

```yaml
spec:
  logging:
  - id: server
    sourceRef: {name: database-requests}
    matchFields:
      cluster_uid: /metadata/uid
```

И в `x-dashboard-detail.sections` страницы Detail:

```yaml
- title: Логи
  tab: logs
  renderer: resource-logs
  logRef: {name: server}
```

Объявите вкладку `logs` в `x-dashboard-detail.tabs`. Пример описывает подключение
будущего продукта: основной GVK/оператор и стандартный collector должны реально
существовать. Collector должен публиковать `cluster_uid` из доверенной metadata
оператора, не из произвольного текста приложения. Транспорт, нормализация и
tenant routing задаются штатными ресурсами/конфигурацией Vector или другого
совместимого collector в продуктовой поставке. GVK binding связывает существующие
данные с заказом и не создаёт отсутствующий источник автоматически.

В каждом проекте администратор создаёт LogAccess с именем из `accessRef`, UID
namespace/Project, sourceRef, backendRef и tenant IDs. Продуктовая viewer/auditor
роль получает только `get` `logaccesses` с `resourceNames` этого grant. Не выдавайте
проектным ролям запись LogAccess или конфигурации каталога. Одновременно требуется
`get` основного CR: grant сам по себе не разрешает читать все ресурсы tenant.

## Защита и эксплуатация

Gateway заново читает GVK с токеном caller, проверяет UID/selector/проект, применяет
native `extra_filters` по source и всем identity полям, ограничивает период датой
создания заказа и проецирует ответ на allowlist. Фильтры действуют в подзапросах
LogsQL. Права и identity повторно проверяются перед выдачей результата.

S3 file ops log содержит qualified `tenant/bucket`; он не содержит внутренний
`bucket_id`/owner из другого native RGW формата. Binding использует
`status.atProvider.bucket` и `tenant`, а UID заказа и обязательная временная
граница исключают наследование истории новым заказом под тем же именем.
Tenant маршрутизации определяется по бакету, а не вызывающему пользователю. Error — request записи с
HTTP 4xx/5xx. Vector до отправки удаляет URI/query strings, referrer, headers,
principal credentials и общие daemon/debug сообщения. Записи без известного
проектного tenant/бакета не направляются клиентам. Даже бакет того же Ceph account,
созданный вне заказа, нельзя выбрать через gateway.

Следите за диском VictoriaLogs, заполнением очередей Vector, HTTP errors,
счётчиками discarded events и задержкой доставки. Очередь ограничена; её потеря
или переполнение не дают гарантий exactly-once. Резервируйте место под слияния
и расширяйте PVC до заполнения. Retention не заменяет backup. Проверяйте restart
storage/collector и восстановление доставки после недоступности backend.

### Минимальный auth Secret

Замените placeholders защищёнными случайными credentials; не сохраняйте этот
файл в Git. Читатель и writer должны иметь разные значения.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gator-logging-auth
  namespace: logging
type: Opaque
stringData:
  auth.yml: |
    users:
    - bearer_token: REPLACE_READER_CREDENTIAL
      url_map:
      - src_paths: [/select/logsql/(query|hits)]
        src_headers: ['AccountID: 1001']
        headers: ['AccountID: 1001', 'ProjectID: 0']
        url_prefix: http://vlsingle-customers.logging.svc:9428
    - bearer_token: REPLACE_WRITER_CREDENTIAL
      url_map:
      - src_paths: [/write/team-a/insert/jsonline]
        drop_src_path_prefix_parts: 2
        headers: ['AccountID: 1001', 'ProjectID: 0']
        url_prefix: http://vlsingle-customers.logging.svc:9428
```

Повторите routes для каждого tenant. В Secret `gator-logging-reader` namespace
Dashboard ключ `token` должен содержать reader credential. Collector получает
только writer credential. После изменения native auth config перезапустите
VMAuth, сохранив существующие credentials и маршруты.

Автоматизация study дополнительно хранит UID pins и tombstones tenant IDs в
защищённом ConfigMap `logging/gator-logging-registry`, независимом от lifecycle
проектного namespace. При его потере существующее хранилище не подключается
автоматически к новому пустому registry. Восстановите исходную копию. Удаление
проекта не освобождает его ID. Raw RGW ops файл доступен только root; стандартный
logrotate ограничивает его локальную историю. Vector передаёт только безопасную
проекцию; raw файл и его backups также требуют административной защиты.

## Проектный исследователь логов

ProductPage с `schema.inline.x-dashboard-view: logging` подключает общий экран;
встроенный каталог мониторинга поставляет страницу `monitoring-logs`. Ни имя
продукта, ни GVK не зашиты в renderer. Explorer строит список источников из
ProductResource.logging, проверяет LogSource/LogAccess и выполняет discovery/list
основных CR с caller token. Каждый кандидат дополнительно проверяется через GET.
Стандартной роли продукта нужны list/get основного GVK и get его LogAccess.
Права мониторинга сами по себе не открывают все продуктовые источники.

Дополнительные поля binding:

```yaml
logging:
- id: requests
  title: Запросы
  resourceTitlePath: /metadata/annotations/example.org~1display-name
  sourceRef: {name: database-requests}
  matchFields:
    cluster_uid: /metadata/uid
```

Для вычисляемых результатов Source может объявить дополнительный allowlist:

```yaml
spec:
  resultFields:
  - {name: count, title: Количество}
  - {name: total, title: Итого}
  - {name: average, title: Среднее}
```

Это добавление к обычным `fields`: запрос `* | stats count() as count` показывает
вычисленную колонку, сохраняя безопасную проекцию. Произвольные поля backend
автоматически не публикуются. Нормализация и удаление чувствительных данных
перед ingestion остаются обязательными.

Native VMAuth reader должен разрешать только `/select/logsql/(query|hits)`.
Перечисление tenants, административные endpoints и произвольные пути закрыты.
Обе операции получают один и тот же проверенный tenant и native extra_filters.
Для нескольких заказов строятся полные ветки `(identity AND время создания) OR ...`;
отдельные списки значений разных identity полей не используются. Такой scope
применяется и к вложенным query/union/join. Гистограмма запрашивается через hits
с ignore_pipes=1 и ограниченным шагом, а не вычисляется по урезанной выдаче.
Лимит области — 128 заказов на binding; превышение закрывает запрос, не расширяет
его до всего tenant. Список каталога ограничен 256 ProductResource.
