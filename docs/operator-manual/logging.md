---
title: Клиентское логирование
---

Gator использует стандартные VictoriaLogs, VMAuth и Vector. Generic gateway
Dashboard проверяет проектную роль логирования; GVK описывает источники и виды.
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

В каждом проекте администратор создаёт LogAccess с именем из accessRef, UID
namespace/Project, sourceRef, backendRef и tenant IDs. Не выдавайте запись
LogAccess клиентским ролям. Для чтения назначается отдельная logging.viewer,
а не продуктовая роль. Права на заказы не являются границей проектных логов.

## IAM-роли

| Роль | Возможности |
| --- | --- |
| logging.viewer | Все клиентские логи выбранного проекта, query/hits/выгрузка |
| logging.owner | Тот же просмотр, управление RoleBinding проекта, bind только logging.viewer/logging.owner |

Роли создаются chart Dashboard при настройке logging.backends и включённом
rbac.roleCatalog.enabled. Они видны в IAM в группе «Логирование». Общие
viewer/editor/owner агрегируют logging.viewer. Продуктовые S3 роли и auditor
самостоятельного доступа к логам не дают. logging.owner не меняет LogAccess,
LogSource, ClusterRole или backend credentials. Управление RoleBinding подчиняется
штатной проверке эскалации Kubernetes.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: project-log-readers
  namespace: team-a
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: logging.viewer
subjects:
- kind: Group
  name: team-a-log-readers
  apiGroup: rbac.authorization.k8s.io
```

Gateway проверяет native SelfSubjectAccessReview: get logaccesses без name в
namespace проекта. Старые resourceNames: [s3] grants недостаточны. После миграции
назначьте logging.viewer выбранным получателям. Для отзыва удалите соответствующие
RoleBinding, включая общие viewer/editor/owner, если они дают тот же доступ.

## Защита и эксплуатация

Gateway проверяет Project/namespace/LogAccess, immutable UID/tenant pins и роль
до и после query/hits. Native extra_filters ограничивают source, представление
и время создания Project/namespace. Проектный explorer включает все клиентские
записи своего tenant, включая удалённые заказы и бакеты вне каталога. Заказ и его
GET/LIST/UID не являются границей авторизации. В карточке остаётся удобный фильтр
по текущему ресурсу, требующий доступа к его metadata. Подзапросы LogsQL не снимают
серверные фильтры; ответы проецируются на безопасный allowlist.

S3 file ops log содержит qualified tenant/bucket. Маршрутизация определяется по
проектному tenant бакета, а не вызывающему пользователю. Vector удаляет URI/query
strings, referrer, headers, credentials и общие daemon/debug сообщения. Записи без
известного project tenant/бакета не направляются клиентам.

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
ProductResource.logging и проверяет LogSource/LogAccess. Заказы не перечисляются;
источники видны независимо от текущих CR и продуктовых GET/LIST разрешений.
Наличие logging.viewer открывает все настроенные клиентские источники проекта.
Права только на мониторинг его не заменяют.

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
Source/view/time predicates применяются и к вложенным query/union/join.
Гистограмма запрашивается через hits с ignore_pipes=1 и ограниченным шагом,
а не вычисляется по урезанной выдаче. Каталог ограничен 256 ProductResource;
число заказов больше не ограничивает запросы.

### Сохранение периода логов при смене основного GVK

В Dashboard 0.21.2+ у `ProductResource.spec.logging[]` есть необязательное поле
`resourceCreatedAtPath`: JSON Pointer в `status` основного CR с датой RFC3339.
Укажите его, если новый composite представляет уже существующий внешний ресурс.
Например, S3Bucket использует `/status/atProvider/creationTime`. Без настройки
начало периода ограничено `metadata.creationTimestamp` основного CR.
Отсутствующая или некорректная дата блокирует запрос до готовности identity;
изменение даты во время запроса отклоняет ответ. Ограничения проекта, namespace,
RBAC и срока хранения сохраняются.
