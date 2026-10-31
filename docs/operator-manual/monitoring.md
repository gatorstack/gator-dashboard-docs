# Мониторинг сервисов

VictoriaMetrics Operator предоставляет Kubernetes API для настройки компонентов
VictoriaMetrics и сбора метрик. Установленный оператор позволяет создавать
`VMStaticScrape` для внешних exporter endpoints. Для фактического сбора нужен
также `VMAgent`, а для хранения — VictoriaMetrics с настроенным `remoteWrite`.

Доступны отдельная установка оператора и комплект административного мониторинга:
VMCluster, VMAgent и Grafana с готовыми дашбордами для внешних libvirt/Ceph targets.
Автоматическое создание scrape при заказе PaaS и доступ потребителей проектов
к метрикам ещё не подключены. Графики в Dashboard этим не добавляются.

## Установка оператора

Нужны Helm, `oc`, административный контекст и работающий cert-manager.
Укажите контекст своего кластера:

```sh
GATOR_CONTEXT='my-cluster-admin'
oc --context "$GATOR_CONTEXT" whoami --show-server
oc --context "$GATOR_CONTEXT" get nodes
oc --context "$GATOR_CONTEXT" -n cert-manager rollout status deployment/cert-manager
```

Сохраните `vmoperator-values.yaml`:

```yaml
fullnameOverride: victoria-metrics-operator
replicaCount: 1
image:
  tag: v0.75.2
crds:
  enabled: true
  plain: false
  cleanup:
    enabled: false
operator:
  disable_prometheus_converter: true
watchNamespaces: []
rbac:
  aggregatedClusterRoles:
    enabled: false
admissionWebhooks:
  enabled: true
  policy: Fail
  certManager:
    enabled: true
serviceMonitor:
  enabled: false
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    memory: 512Mi
```

Установите согласованные версии chart и образа:

```sh
helm upgrade --install victoria-metrics-operator victoria-metrics-operator \
  --repo https://victoriametrics.github.io/helm-charts --version 0.68.2 \
  --kube-context "$GATOR_CONTEXT" --namespace monitoring --create-namespace \
  -f vmoperator-values.yaml --wait --timeout 5m
oc --context "$GATOR_CONTEXT" wait --for=condition=Established \
  crd/vmstaticscrapes.operator.victoriametrics.com --timeout=120s
oc --context "$GATOR_CONTEXT" -n monitoring wait --for=condition=Ready \
  certificate/victoria-metrics-operator-validation --timeout=120s
oc --context "$GATOR_CONTEXT" -n monitoring rollout status deployment/victoria-metrics-operator
```

Ожидается готовый Deployment, Established CRD и Ready сертификат. Оператор
наблюдает все namespaces. Права на VM API выдаются отдельно: профиль не расширяет
стандартные роли `view`/`admin`. Конвертер ресурсов Prometheus Operator отключён.

CRD в этом профиле являются Helm templates: обновляются вместе с release и
сохраняются при uninstall. Cleanup CR отключён. Перед сменой версии изучите
[инструкции обновления chart](https://docs.victoriametrics.com/helm/victoria-metrics-operator/)
и сохраните резервную копию конфигурации и данных хранилища, когда оно подключено.

## Внешний endpoint и PaaS

Внешний сервис должен предоставлять Prometheus endpoint сам либо через экспортер.
Обычный S3 endpoint обслуживает S3 API и не заменяет экспортер метрик.
Пример конфигурации для существующего namespace проекта `team-a`:

```yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMStaticScrape
metadata:
  name: database-metrics
  namespace: team-a
  labels:
    monitoring.gatorstack.dev/managed-by: platform
spec:
  jobName: database-metrics
  targetEndpoints:
    - targets:
        - database-exporter.example.org:9187
      path: /metrics
      scheme: https
      interval: 30s
      honorLabels: false
      labels:
        gator_project_uid: replace-with-namespace-uid
        gator_resource_uid: replace-with-order-uid
```

Замените адрес и идентификаторы. Endpoint должен быть доступен из сети сборщика.
Auth/TLS credentials подключайте через поддерживаемые поля с Secret refs.
Сохраните конфигурацию как `database-metrics.yaml` и проверьте перед созданием:

```sh
oc --context "$GATOR_CONTEXT" -n team-a apply --dry-run=server -f database-metrics.yaml
```

Для сбора будущий VMAgent должен выбирать namespace и labels этого CR через
`staticScrapeNamespaceSelector`/`staticScrapeSelector` и иметь рабочий
`remoteWrite`. Без него VMStaticScrape только хранит конфигурацию.
Подробности: [VMStaticScrape](https://docs.victoriametrics.com/operator/resources/vmstaticscrape/).

Целевой сценарий PaaS — integration управляет этим CR вместе с заказом и
закрепляет проектные labels по доверенному inventory. Автоматизация lifecycle
ещё не подключена. Право произвольно менять targets, credentials или relabeling
общего сборщика оставляйте администраторам платформы.


## Хранилище и административная Grafana

Комплект `gator-infrastructure/charts/monitoring` создаёт VMCluster/platform,
VMAgent/platform и ConfigMap с 13 штатными дашбордами; при bucketStats.enabled
добавляется четырнадцатый S3 · Бакеты. Grafana устанавливается
отдельным официальным chart. Сначала установите оператор по инструкции выше.
Потребуются RWO StorageClass, доступ сборщика к exporters и DNS/TLS для Grafana.

По умолчанию VMCluster хранит метрики 14 дней: одна реплика каждого компонента,
replicationFactor=1, PVC vmstorage 20Gi. Persistent queue VMAgent использует
отдельный PVC 2Gi и ограничена 1GB, scrape interval — 30s. Это конфигурация для
небольшого стенда; одна реплика и локальный диск не обеспечивают HA или backup.

Сохраните `monitoring-values.yaml`, заменив StorageClass и адреса:

```yaml
vmcluster:
  vmstorage:
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: your-rwo-class
vmagent:
  statefulStorage:
    volumeClaimTemplate:
      spec:
        storageClassName: your-rwo-class
staticScrapes:
  - name: libvirt-compute-a
    spec:
      jobName: prometheus-libvirt-exporter
      targetEndpoints:
        - targets: [compute-a.example.org:9177]
          honorLabels: false
          labels:
            region: region-a
            instance: compute-a
            hostname: compute-a
  - name: ceph-mgr
    spec:
      jobName: ceph
      targetEndpoints:
        - targets: [ceph-mgr.example.org:9283]
          labels:
            cluster: ceph-a
            instance: ceph-host-a
```

Chart добавляет выбирающую метку `monitoring.gatorstack.dev/collector: platform`.
Текущий VMAgent выбирает конфигурации только из namespace monitoring.
Добавьте аналогичные targets ceph-exporter:9926 и node-exporter:9100, если они
доступны. Согласуйте instance/hostname с metadata Ceph для host/device joins.

```sh
helm upgrade --install gator-monitoring ./gator-infrastructure/charts/monitoring \
  --kube-context "$GATOR_CONTEXT" -n monitoring \
  -f monitoring-values.yaml --wait --timeout 5m
oc --context "$GATOR_CONTEXT" -n monitoring wait \
  --for=jsonpath='{.status.updateStatus}'=operational \
  vmcluster/platform vmagent/platform --timeout=5m
```

Подготовьте защищённые файлы `/secure/grafana/admin-user` и
`/secure/grafana/admin-password`, затем создайте Secret без вывода значений:

```sh
oc --context "$GATOR_CONTEXT" -n monitoring create secret generic grafana-admin \
  --from-file=admin-user=/secure/grafana/admin-user \
  --from-file=admin-password=/secure/grafana/admin-password
```

Существующий Secret сохраняйте. Пароль администратора применяется при первой
инициализации базы Grafana; замена Secret не сбрасывает пароль в существующем PVC.
Резервируйте Secret и PVC вместе.

Сохраните `grafana-values.yaml`, заменив DNS, StorageClass и ClusterIssuer:

```yaml
fullnameOverride: grafana
image:
  tag: 13.3.0
admin:
  existingSecret: grafana-admin
  userKey: admin-user
  passwordKey: admin-password
persistence:
  enabled: true
  storageClassName: your-rwo-class
  size: 1Gi
initChownData:
  enabled: false
deploymentStrategy:
  type: Recreate
rbac:
  namespaced: true
ingress:
  enabled: true
  ingressClassName: nginx
  annotations:
    cert-manager.io/cluster-issuer: your-cluster-issuer
  hosts: [grafana.example.org]
  tls:
    - secretName: grafana-tls
      hosts: [grafana.example.org]
grafana.ini:
  server:
    root_url: https://grafana.example.org
  users:
    allow_sign_up: false
  auth.anonymous:
    enabled: false
datasources:
  datasources.yaml:
    apiVersion: 1
    datasources:
      - name: VictoriaMetrics
        uid: victoriametrics
        type: prometheus
        access: proxy
        url: http://vmselect-platform.monitoring.svc:8481/select/0/prometheus
        isDefault: true
        editable: false
        jsonData:
          httpMethod: POST
          timeInterval: 30s
sidecar:
  dashboards:
    enabled: true
    label: grafana_dashboard
    labelValue: "1"
    searchNamespace: monitoring
    resource: configmap
    folderAnnotation: grafana_folder
    provider:
      foldersFromFilesStructure: true
      allowUiUpdates: false
```

```sh
helm upgrade --install grafana grafana \
  --repo https://grafana-community.github.io/helm-charts --version 14.2.0 \
  --kube-context "$GATOR_CONTEXT" -n monitoring -f grafana-values.yaml \
  --wait --timeout 5m
oc --context "$GATOR_CONTEXT" -n monitoring wait \
  --for=condition=Ready certificate/grafana-tls --timeout=5m
oc --context "$GATOR_CONTEXT" -n monitoring rollout status deployment/grafana
curl --fail https://grafana.example.org/api/health
```

В Grafana должны появиться datasource VictoriaMetrics и папки:

- OpenStack: Libvirt Dashboard с выбором региона, проекта, compute и VM.
- Ceph: Cluster Advanced, Pools Overview/Details, OSD Overview/Device Details,
  Host Overview/Details, RGW Overview/Instance Detail; при bucketStats.enabled — S3 · Бакеты.
- VictoriaMetrics: Cluster, VMAgent, Operator.

Это community dashboard 12538 revision 1 и официальные dashboards Ceph 20.2.4 /
VictoriaMetrics 1.155.0. Их datasource назначается при поставке, старые panel
types переведены в современные, запросы согласованы с instance_name экспортера
и GET/PUT operation counters Tentacle. Provisioning управляется Helm; правки
из браузера перезаписываются поставкой.

Для CephFS, RBD и multisite дашборды не поставляются без соответствующих сервисов.
Панели необязательных возможностей, например HAProxy, bucket notifications,
stream aggregation или текущих PG recovery states, могут не иметь рядов.
Проверяйте наличие исходных метрик и состояние targets.

Метрики сейчас собраны в tenant 0 платформы. VMSelect/VMInsert доступны внутри
кластера; Grafana является административной консолью и показывает все проекты.
Фильтр проекта в дашборде не ограничивает права. Доступ потребителей проектов
требует отдельной реализации изоляции из следующего раздела.

## Трафик, размер и квоты бакетов S3

Дашборд **S3 · Бакеты** находится в папке Ceph, UID `ceph-rgw-buckets`.
Он добавляет выбор кластера, владельца (RGW UID/Account) и бакета, графики
GET/PUT трафика и операций, размер объектов, их количество и таблицу
индивидуальных квот. Он поставляется вместе с остальными dashboard ConfigMap.

Трафик берётся из нативных `ceph_rgw_op_per_bucket_*` counters ceph-exporter.
Включите bucket counters в контексте своего Ceph:

```sh
sudo cephadm shell -- ceph config set client.rgw rgw_bucket_counters_cache true
```

В Ceph 20.2.4 само хранилище counters создаётся при старте RGW, хотя настройка
объявлена runtime-updatable. Поэтому после первой активации нужен restart RGW.
При нескольких gateways выполняйте перезапуск по одному с проверкой S3.
При одном gateway возникает короткая пауза S3; cephadm требует явный
`--force` для остановки единственного RGW. Запланируйте это окно перед активацией.
При неизменном flag повторная установка мониторинга restart не требует.

Для размера, количества объектов и квот используется готовый
[RGW exporter](https://github.com/yeti890/rgw-exporter) через HTTPS Admin API.
Создайте отдельную identity с Admin Ops caps `buckets=read;usage=read`.
Например, на узле с административным доступом к Ceph:

```sh
umask 077
sudo cephadm shell -- radosgw-admin user create \
  --uid gator-rgw-metrics --display-name 'Bucket monitoring' \
  --caps 'buckets=read;usage=read' > /secure/rgw-metrics-user.json
jq -ej '.keys[0].access_key' /secure/rgw-metrics-user.json > /secure/rgw-access-key
jq -ej '.keys[0].secret_key' /secure/rgw-metrics-user.json > /secure/rgw-secret-key
```

Существующую identity и её ключи сохраняйте при повторной настройке. На машине
с административным Kubernetes-контекстом создайте Secret из защищённых файлов
без завершающего перевода строки:

```sh
oc --context "$GATOR_CONTEXT" -n monitoring create secret generic rgw-bucket-stats \
  --from-file=access-key=/secure/rgw-access-key \
  --from-file=secret-key=/secure/rgw-secret-key
```

Добавьте в `monitoring-values.yaml` и повторите установку gator-monitoring:

```yaml
bucketStats:
  enabled: true
  secretName: rgw-bucket-stats
  env:
    RGW_ENDPOINT: https://s3.example.org
    PUB_ENDPOINT: s3.example.org
    REGION: region-a
    CLUSTER_NAME: ceph-a
    LISTEN_IP: 0.0.0.0
    LISTEN_PORT: "9240"
    START_DELAY: "0"
    BUCKETS_COLLECTOR_INTERVAL: "60"
    USAGE_COLLECTOR_INTERVAL: "300"
    USERS_COLLECTOR_ENABLE: "false"
    RGW_CONNECTION_TIMEOUT: "15"
    INSECURE: "false"
```

Chart использует закреплённый digest образа, запускает exporter с Secret refs
и создаёт VMStaticScrape. `CLUSTER_NAME` должен совпадать с меткой `cluster`
нативных Ceph targets. Kubernetes API token контейнеру не монтируется.
TLS Admin API проверяется; его сертификат должен быть доверен контейнеру.

Проверьте rollout и сбор:

```sh
oc --context "$GATOR_CONTEXT" -n monitoring rollout status deployment/rgw-bucket-stats
oc --context "$GATOR_CONTEXT" -n monitoring get vmstaticscrape rgw-bucket-stats
oc --context "$GATOR_CONTEXT" -n monitoring logs deployment/rgw-bucket-stats --tail=20
```

| Показатель | Серия |
| --- | --- |
| Скачивание / загрузка | `ceph_rgw_op_per_bucket_get_obj_bytes` / `ceph_rgw_op_per_bucket_put_obj_bytes` |
| Логический размер объектов | `radosgw_usage_bucket_size` |
| Количество объектов | `radosgw_usage_bucket_objects` |
| Индивидуальная квота включена | `radosgw_usage_bucket_quota_enabled` |
| Лимит размера / объектов | `radosgw_usage_bucket_quota_size` / `radosgw_usage_bucket_quota_objects` |

`rate(...)` даёт байты/с, `increase(...)` — объём за выбранный период в пределах
собранной истории. Эти counters описывают байты объектов, не TCP/TLS overhead.
Cache eviction/restart может сбрасывать их; трафик до включения не восстанавливается.

Stats запрашиваются раз в 60 секунд, затем собираются VMAgent раз в 30 секунд.
Дополнительно действует асинхронная задержка учёта RGW. Экспортер кэширует последний
успешный ответ; состояние UP показывает доступность процесса, ошибки Admin API
нужно проверять в его logs.

Размер и объекты следуют `rgw.main` bucket stats; при versioning значения могут
отличаться от списка только текущих объектов. `size_actual` не представляет
физический расход всего Ceph с репликацией. Дашборд показывает логический размер.
В таблице квоты отключённый или отрицательный индивидуальный лимит отображается
как «Не задан». Суммарные account/user quotas учитываются отдельно;
наличие таких ограничений не определяется по одному bucket_quota.

## Планирование изоляции проектов

Рекомендуемая схема следующего этапа — VMCluster с отдельным tenant каждого
проекта и tenant платформы. Для namespace UID проекта выделяется устойчивый
уникальный числовой accountID. Доверенный сборщик назначает tenant при записи;
VMAuth или metrics gateway ограничивает чтение после проверки прав пользователя
на проект. Одного label selector в запросе недостаточно для контроля доступа.
Нативный VMAuth сам не синхронизирует Kubernetes RBAC и членство в проектах.
См. [multitenancy](https://docs.victoriametrics.com/cluster-victoriametrics/#multitenancy)
и [VMAuth](https://docs.victoriametrics.com/vmauth/).

| Источник | Как связать с проектом |
| --- | --- |
| Выделенный PaaS endpoint | Namespace UID и UID заказа известны создающей интеграции |
| Общий libvirt endpoint | Регион + OpenStack project/VM identity связываются с проектом платформы |
| Общий RGW endpoint | Backend + account/user/bucket identity связываются с владельцем |
| Общие OSD/PG/host/shared pool | Доступны администраторам; отдельного владельца проекта нет |

Для libvirt в выбранном
[vaishutin/libvirt-exporter](https://github.com/vaishutin/libvirt-exporter)
`project_name` и `instance_name` добавлены во все метрики доменов, включая CPU,
память, диски и сеть. `project_uuid` и UUID VM выдаются в
`libvirt_domain_info_meta`. Маршрутизация по имени требует проверенного mapping
с учётом региона, Keystone domain, переименований и повторного создания имён.
Для устойчивой изоляции предпочтительны UUID на каждой серии. Relabeling не
выполняет join между CPU/IO и info-метрикой; при необходимости нужен отдельный
этап обогащения. Экспортер запускается на каждом compute с read-only сокетом
libvirt и отдельным портом 9177; существующие Nova/VM не перезапускаются.

У RGW per-user/per-bucket operation counters включаются отдельно через
`rgw_user_counters_cache` и `rgw_bucket_counters_cache`; ceph-exporter читает
их из admin socket RGW. Cache eviction/restart может сбрасывать counters.
Общие показатели Ceph не дают достоверного разбиения нагрузки shared pool по
проектам. См. [метрики RGW](https://docs.ceph.com/en/tentacle/radosgw/metrics/).

Эта схема изоляции ещё не настроена. Перед выдачей доступа пользователям нужны
проверки двух проектов: запрет чтения чужих данных через query, labels, metadata
и export, подмены tenant при записи и обхода gateway. Серии с неопределённым
владельцем должны оставаться в контуре платформы.
