---
title: Клиентское логирование
---

Gator использует Kafka (Strimzi), Vector, VMAuth и VictoriaLogs. Dashboard проверяет
проектную роль логирования; продукт объявляет GVK владельца и безопасные поля в
LogSource. Общая Crossplane Composition автоматически подключает проекты.
Отдельного продуктового HTTP-сервиса для логирования нет. VictoriaLogs хранит
клиентские записи 30 дней; Kafka служит ограниченной очередью доставки.

## Как проходит запись

1. Продуктовый collector читает штатный источник и удаляет чувствительные поля.
   Для S3 это Vector на RGW VM, читающий access/error ops JSONL.
2. Collector отправляет JSON в топик продукта по TLS с SASL SCRAM-SHA-512.
   Его Kafka ACL разрешает запись, но не чтение клиентской истории.
3. Реплики Vector читают partitions одной consumer group. Они повторно проецируют
   безопасные поля и проверяют identity по защищённым Kubernetes ресурсам.
4. Фиксированный числовой маршрут передаёт запись через VMAuth в его tenant
   VictoriaLogs. AccountID/ProjectID из тела записи не управляют маршрутом.
5. Dashboard выполняет LogsQL query/hits через закрытый reader endpoint VMAuth.
   Роль logging.viewer открывает все клиентские логи выбранного проекта.

Неизвестная или запрещённая identity направляется в `gator-logs-unrouted`.
Клиентские роли не имеют к этому топику доступа. Это карантин для администратора,
а не автоматический повтор: после устранения причины записи можно вернуть в
исходный топик штатным Kafka consumer/producer с административными полномочиями.
Повторяйте только безопасные записи с подтверждённой identity; не меняйте offsets
основной группы ради replay.

## Установка платформы

Нужны Crossplane v2 с cluster-scoped Composition, стандартная
`function-go-templating:v0.13.2` и `function-auto-ready:v0.7.3`, VictoriaMetrics Operator с VLSingle API v1,
Strimzi operator 1.3.0, Ingress nginx, cert-manager, DNS/TLS и persistent storage.
Примените logging CRD из поставки Dashboard. Namespace каталога должен быть
закрыт от изменения клиентскими ролями.

Chart `gator-infrastructure/charts/logging` устанавливает data plane, Function,
XRD/Composition, admission protection и один LogAccessManager на backend.
Подготовьте values без списка проектов:

```yaml
host: logs.example.org
storage: 50Gi
storageClass: local-path
retention: 30d
credentialSecret: gator-logging-auth
backend: native
composition:
  enabled: true
  managerEnabled: true
  useRoutes: true
  catalogNamespace: gator-dashboard
  registry: gator-logging-registry
  routes: gator-logging-routes
  consumerConfig: gator-logging-consumers
kafka:
  enabled: true
  name: gator-logs
  version: 4.3.1
  replicas: 3
  storage: 10Gi
  advertisedHost: 192.0.2.10
  allowedProducerCIDRs: [192.0.2.20/32]
  topicPartitions: 6
  topicReplicas: 3
  topicMinISR: 2
  topicRetentionMs: 86400000
  topicRetentionBytes: 134217728
  consumersEnabled: true
  consumerReplicas: 2
  vectorImage: timberio/vector:0.52.0-debian
```

Внешний Kafka listener использует NodePort 32190 (bootstrap) и 32191–32193
(brokers). Сборщику нужны доступ ко всем адресам brokers, CA кластера и Secret
пользователя `gator-log-producers`. Разрешите только адреса доверенных сборщиков.
В production можно заменить listener согласно поддержанному Strimzi типу.

При первой установке создайте пустой ConfigMap `gator-logging-registry` с
`data: {registry.json: '{}'}` **до** создания хранилища. На существующем backend
восстанавливайте его из резервной копии; пустой реестр поверх истории недопустим.
Подготовьте Secret по примеру ниже. Установите Strimzi отдельно, затем chart
платформы в два этапа, чтобы дождаться регистрации нового XRD:

```sh
kubectl --context "$CONTEXT" create namespace logging
helm upgrade --install gator-kafka-operator strimzi-kafka-operator \
  --repo https://strimzi.io/charts/ --version 1.3.0 \
  --kube-context "$CONTEXT" -n logging --wait
helm upgrade --install gator-logging gator-infrastructure/charts/logging \
  --kube-context "$CONTEXT" -n logging -f logging-values.yaml \
  --set composition.managerEnabled=false --set composition.useRoutes=false \
  --set kafka.consumersEnabled=false --wait
kubectl --context "$CONTEXT" wait --for=condition=Established \
  crd/logaccessmanagers.logging.gatorstack.dev --timeout=120s
helm upgrade --install gator-logging gator-infrastructure/charts/logging \
  --kube-context "$CONTEXT" -n logging -f logging-values.yaml --wait
kubectl --context "$CONTEXT" get logaccessmanager native
kubectl --context "$CONTEXT" -n logging get kafka,kafkatopic,pods,pvc
kubectl --context "$CONTEXT" get logaccesses -A
```

Установка study автоматизирована `logging/deploy-study.py` из infrastructure.
Она проверяет кластер, сохраняет credentials и старые grant UID/tenant IDs,
передаёт grants под Composition и переключает RGW collector на Kafka.
Добавление следующего проекта не требует повторного запуска этого скрипта.

## Автоматические проектные grants

Один LogAccessManager читает живые Project с именем `project`, Namespace и
LogSource с `autoAccess: true` для своего backend. Сначала он резервирует ID в
долговечном реестре, затем создаёт LogAccess и native маршруты. Все источники
проекта используют один tenant. Grants не принадлежат отдельным заказам;
удаление последнего бакета не закрывает историю проекта.

Пересоздание Project или namespace получает новый ID. Старые ID и привязки
identity остаются tombstones и не переиспользуются. Consumers используют внутренний
путь `/ingest/tenants/<accountID>/0/insert/jsonline`, а VMAuth назначает fixed
AccountID/ProjectID. Исторический writer route сохраняет исходный tenant; запоздавший
consumer после recreation не направит старые данные в новый проект с тем же именем.
Reader маршруты выдаются только текущим проектам. Перед включением маршрута
Composition сохраняет UID владельца и значение внешней identity. Перенос этой
identity в другой проект блокируется; старые сообщения не становятся его логами.
Неоднозначные ownership данные требуют исправления администратором.

Registry обновляется только добавлением ключей; admission запрещает его очистку
и удаление. Удаление корневого LogAccessManager также запрещено, чтобы сборщик
мусора не удалил долговечные ресурсы. Для переноса backend сначала сделайте
согласованный backup хранилища, registry и grants, остановите запись, сохраните
UID/tenant mappings и отдельно отключите lifecycle policy административной
миграцией. Не удаляйте policy ради обычного Helm upgrade/uninstall.

## Gateway Dashboard

В namespace Dashboard создайте Secret с ключом `token` для reader. В values:

```yaml
logging:
  backends:
  - name: native
    url: http://vmauth-logs.logging.svc:8427
    existingSecret: gator-logging-reader
```

URL и credentials определяет установка. NetworkPolicy разрешает VictoriaLogs
только VMAuth, а VMAuth — Dashboard, доверенным потребителям и ingress controller.
Внешний HTTP ingress публикует только `/write/`; новые Kafka-сборщики используют
свой listener и не получают reader credential.

## Подключение нового продукта в его chart

Пример для будущего managed database. Его оператор должен реально создавать
защищённый DatabaseIdentity, а collector — передавать `cluster_uid` из metadata
оператора. Клиентский текст приложения не может задавать эту identity.

```yaml
apiVersion: logging.gatorstack.dev/v1alpha1
kind: LogSource
metadata:
  name: database-requests
  namespace: gator-dashboard
spec:
  autoAccess: true
  backendRef: {name: native}
  accessRef: {name: database-requests}
  filters: {source: managed-database}
  fields:
  - {name: _time, title: Время}
  - {name: _msg, title: Сообщение}
  - {name: level, title: Уровень}
  ingestion:
    kafkaTopic: gator-logs-database
    ownership:
      resource:
        apiVersion: database.example.org/v1alpha1
        kind: DatabaseIdentity
        namespace: database-system
      namespacePath: /spec/projectNamespace
      projectUIDPath: /spec/projectUID
      matchFields:
        cluster_uid: /status/clusterUID
```

Вместо `namespacePath` можно указать `namespaceUIDPath`; допускается ровно один
из них. JSON pointers читаются из объекта указанного GVK. `projectUIDPath` должен
совпадать с текущим Project UID. `matchFields` сравнивает поля Kafka JSON с
доверенными значениями этого объекта. GVK должен публиковать устойчивую внешнюю
identity; обычный изменяемый пользовательский label не является доказательством.

В этом же продуктовом chart поставьте Role/RoleBinding для ServiceAccount
`crossplane-system/crossplane`: только get/list/watch ownership GVK в системном
namespace продукта. При cluster-scoped ownership нужен ограниченный ClusterRole.
Не выдавайте Crossplane чтение продуктовых Secret ради поиска identity.

Продукт поставляет стандартный collector (например Vector/Fluent Bit), безопасную
нормализацию и TLS/SASL ссылку на producer Secret. Он пишет в объявленный топик;
Composition создаёт KafkaTopic с платформенными retention/partitions/replicas,
проектные grants и конфигурацию общих потребителей. Названия топиков разных
источников должны быть уникальны; `gator-logs-unrouted` зарезервирован.
Новый collector — конфигурация штатного агента, а не отдельный сервис маршрутизации.

Для отображения в explorer и карточке добавьте в ProductResource:

```yaml
spec:
  logging:
  - id: server
    sourceRef: {name: database-requests}
    matchFields:
      cluster_uid: /status/clusterUID
```

В `x-dashboard-detail.sections` страницы Detail:

```yaml
- title: Логи
  tab: logs
  renderer: resource-logs
  logRef: {name: server}
```

Объявите вкладку `logs` в `x-dashboard-detail.tabs`. Этот binding задаёт удобный
фильтр карточки; право explorer остаётся на все логи проекта. Ручной LogAccess и
список namespaces в chart нового продукта не нужны. После установки Source
подключаются и существующие проекты, в том числе без заказов.

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

### Масштабирование и доставка

Увеличивайте `kafka.consumerReplicas` в values и выполняйте Helm upgrade.
Члены группы `gator-logs-v2` перераспределяют partitions автоматически. Полезный
параллелизм ограничен числом partitions каждого топика; увеличение partitions
меняет распределение ключей, его выполняют планово. Потребители работают как stateless Deployment с ограниченными memory buffers:
Kafka offsets подтверждаются после HTTP delivery или записи в карантин.
Неподтверждённые записи перечитываются после restart/rebalance; локальных PVC
с недоставленными записями у остановленной реплики нет. Для SCRAM Kafka 4 нужен
Vector 0.52+; в 0.51 есть несовместимость handshake. Collector продолжает читать файл с сохранённых checkpoints.
VMAuth перечитывает маршруты каждые 5 секунд; Vector проверяет конфигурацию
через polling, чтобы видеть атомарные обновления Kubernetes ConfigMap.

Producer использует `acks=all`, topic min ISR, idempotent Kafka producer; consumers
подтверждают доставку в HTTP sink. Семантика — at-least-once: после сбоя возможны
дубликаты. Срок Kafka 24 часа и лимит bytes на partition ограничивают окно
восстановления; при большом потоке byte limit может сработать раньше суток.
VLSingle 30 дней — отдельная политика хранения принятых логов. Увеличивайте обе
ёмкости под измеренный поток и допустимую длительность недоступности.

Наблюдайте consumer lag штатными Kafka средствами, availability/ISR brokers,
заполнение Kafka PVC, `gator-logs-unrouted`, Vector errors/discards/buffer usage и
диск VictoriaLogs. Service `gator-log-consumers:9598` отдаёт native Vector metrics;
VMServiceScrape подключает их к платформенному мониторингу. Kafka exporter
и Service `gator-logs-kafka-metrics:9404` публикуют consumer lag. Повтор после карантина
выполняет администратор; автоматического drain карантина нет.

Три broker/controller pods на одном физическом узле не дают физическую HA.
Production требует независимых узлов, подходящего persistent storage и размещения
broker replicas по узлам/зонам. VLSingle также остаётся одиночным хранилищем;
Kafka сглаживает его простои только в пределах настроенной ёмкости очереди.

### Credentials и backup

Secret `gator-logging-auth` содержит отдельные случайные `read-token` и
`write-token`, а также `tokens.json` с теми же read/write значениями для installer.
Для первого этапа установки нужен `auth.yml` с deny-only маршрутом:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gator-logging-auth
  namespace: logging
type: Opaque
stringData:
  read-token: REPLACE_READER_CREDENTIAL
  write-token: REPLACE_WRITER_CREDENTIAL
  tokens.json: '{"read":"REPLACE_READER_CREDENTIAL","write":"REPLACE_WRITER_CREDENTIAL"}'
  auth.yml: |
    users:
    - bearer_token: REPLACE_READER_CREDENTIAL
      url_map:
      - src_paths: [/.__no_active_logging_projects__]
        url_prefix: http://127.0.0.1:1
    - bearer_token: REPLACE_WRITER_CREDENTIAL
      url_map:
      - src_paths: [/.__no_active_logging_projects__]
        url_prefix: http://127.0.0.1:1
```

Composition создаёт ConfigMap с `%{LOG_READ_TOKEN}` / `%{LOG_WRITE_TOKEN}`;
значения подставляет VMAuth из Secret environment. Reader допускает только
`/select/logsql/(query|hits)` для выделенных ID, writer — фиксированные project
paths. Произвольные tenant/admin endpoints закрыты. При ротации credentials
согласованно обновите Secrets Dashboard, VMAuth и consumers и перезапустите их.
Strimzi отдельно управляет Kafka CA и SASL credentials; collector получает только
producer credential и CA.

Храните согласованные резервные копии VictoriaLogs, registry и grants.
При потере registry восстановите исходную копию; Composition прекращает выдачу
новых ID вместо инициализации пустого реестра. Raw RGW файл и его rotation backups
доступны только root; их также нужно защищать. Не сбрасывайте checkpoints Vector
или offsets Kafka группы при повторном развёртывании.

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
