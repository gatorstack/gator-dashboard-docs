# Мониторинг сервисов

VictoriaMetrics Operator предоставляет Kubernetes API для настройки компонентов
VictoriaMetrics и сбора метрик. Установленный оператор позволяет создавать
`VMStaticScrape` для внешних exporter endpoints. Для фактического сбора нужен
также `VMAgent`, а для хранения — VictoriaMetrics с настроенным `remoteWrite`.

Доступны отдельная установка оператора и комплект административного мониторинга:
VMCluster, VMAgent и Grafana с готовыми дашбордами для внешних libvirt/Ceph targets.
Для потребителей доступен отдельный продукт со списком рядов метрик проекта и всеми лейблами.
Автоматическое создание scrape при заказе PaaS и графики в Dashboard пока не подключены.

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

## Изоляция проектов

Проектный контур использует отдельный VictoriaMetrics tenant для каждой пары
namespace UID и UID объекта Project. Tenant 0 остаётся административным. Метки
помогают проверить принадлежность, а доступ ограничивают серверная авторизация
и NetworkPolicy. Общая Grafana предназначена администраторам.

Интеграция `providers/monitoring/chart` из комплекта gator-products создаёт
неизменяемый `MetricsTenant` с именем `project` в каждом действующем проекте.
Она выделяет положительный accountID в ConfigMap `gator-metrics-registry`
namespace мониторинга. Старые записи и номера сохраняются после удаления
проекта. Сохраните registry в резервной копии вместе с VictoriaMetrics и
восстанавливайте его до запуска сборщика. Пустой registry поверх существующего
хранилища может нарушить соответствие tenant; не используйте его как ремонт.

### Проверка владельца

Для libvirt сборщик объединяет domain-серии с `libvirt_domain_info_meta` из
того же scrape. Пара region/project_uuid проверяется по фактическому проекту
Keystone, полученному с установленными application credentials. `project_name`
и tenant labels исходного экспортера не определяют доступ.

Для S3 каждый scrape заново читает bucket stats из RGW Admin Ops API. Владелец
Account ID связывается с namespace UID через служебный native Account CR
в namespace S3-провайдера. Эти Account CR и credentials должны оставаться
недоступны для изменения потребителям. В проект попадают размер, объекты,
индивидуальные квоты и native per-bucket counters собственных бакетов, в том
числе созданных S3-клиентом внутри этого аккаунта.

Смена владельца или повторное использование имени другим проектом помещает
бакет в карантин: старый counter cache не должен раскрыть новому владельцу
накопленную историю трафика. Такой перенос требует отдельной проверки
администратором, сброса старого cache и согласованного восстановления lineage.
Неизвестные владельцы, неоднозначные связи и общие OSD/PG/host/pool метрики
остаются в административном контуре. Ownership обновляется каждые 30 секунд;
через 90 секунд без успешного обновления проектный scrape прекращается.

### Установка проектного контура

Предварительно установите VMCluster `platform` и VMAgent административного
контура в `monitoring`, native Project и RGW Account API, а также провайдеры
OpenStack/S3. CNI должен применять NetworkPolicy. Проектные роли не должны
позволять менять NetworkPolicy, provider status, служебные credentials,
MetricsTenant или scrape-конфигурацию. Администраторы кластера и VPN доверены.

Используйте два разных случайных service token. При обновлениях сохраняйте
существующие Secret. Пример первоначального создания из защищённых файлов:

```sh
umask 077
openssl rand -hex 48 > scrape-token
openssl rand -hex 48 > data-token
oc --context "$GATOR_CONTEXT" -n monitoring create secret generic gator-project-metrics \
  --from-file=scrape-token --from-file=data-token
oc --context "$GATOR_CONTEXT" -n gator-dashboard create secret generic gator-data-project-metrics \
  --from-file=token=data-token
rm scrape-token data-token
```

В `monitoring` нужен Secret `rgw-bucket-stats` с ключами `access-key`, `secret-key`
и read-only RGW identity из раздела выше. Интеграция использует Admin Ops подпись
SigV2 по HTTPS; соответствующий режим должен поддерживаться RGW. В namespace
проектов должны существовать служебные Secret OpenStack, созданные provisioning:
поле `config` содержит auth_url, tenant_id, application_credential_id и
application_credential_secret. Их значения в схемы UI не передаются.

Сохраните `project-metrics.yaml`, заменив адреса своими:

```yaml
dashboardNamespace: gator-dashboard
# Если registry образов требует входа, укажите существующий imagePullSecret.
imagePullSecrets: []
config:
  s3SystemNamespace: gator-s3-system
  inventoryMaxAge: 90
  vmselect: http://vmselect-platform.monitoring.svc:8481
  protectedExporterIPs: [10.0.0.10/32, 10.0.0.20/32]
  openstack:
    - region: cloud-1
      authURL: http://10.0.0.10:5000
      secretName: openstack-cloud-1
  libvirt:
    - name: compute-1
      region: cloud-1
      url: http://10.0.0.10:9177/metrics
  rgw:
    endpoint: https://s3.example.com
    region: us-east-1
    cluster: storage-1
    counters: [http://10.0.0.20:9926/metrics]
```

`protectedExporterIPs` перечисляет все внешние IP с общими экспортерами.
Проектные egress policies закрывают TCP 9100, 9177, 9283 и 9926 на этих адресах.
Остальные TCP-порты и UDP доступны. Политики backend ограничивают VictoriaMetrics,
VMAgent и общий bucket exporter доверенными monitoring pods; адаптер доступен
также pods Dashboard. Служебные workers биллинга могут читать административные
метрики. Пользовательские namespaces не должны добавлять обходные allow policies.

Из корня поставки gator-products выполните:

```sh
oc --context "$GATOR_CONTEXT" apply -f providers/monitoring/chart/crds/
helm upgrade --install gator-project-metrics providers/monitoring/chart \
  --kube-context "$GATOR_CONTEXT" -n monitoring -f project-metrics.yaml --wait
oc --context "$GATOR_CONTEXT" -n monitoring rollout status deployment/gator-project-metrics
oc --context "$GATOR_CONTEXT" get metricstenants -A
```

### Подключение продукта к консоли

Добавьте в существующие values Dashboard:

```yaml
dataLists:
  adapters:
    - name: project-metrics
      url: http://gator-project-metrics.monitoring.svc:8080
      existingSecret: gator-data-project-metrics
```

Обновите Dashboard обычной процедурой установки, сохранив остальные values.
Установите пакет каталога в тот же namespace:

```sh
helm dependency build --skip-refresh products/monitoring/chart
helm upgrade --install gator-product-monitoring products/monitoring/chart \
  --kube-context "$GATOR_CONTEXT" -n gator-dashboard --wait
```

Если каталог управляется umbrella release, добавьте зависимость туда. Не
устанавливайте отдельный release поверх уже принадлежащих umbrella объектов.
Пользователям назначьте `monitoring.viewer` через RoleBinding нужного проекта;
общие стандартные роли включают эти права посредством Kubernetes aggregation.
Роль позволяет только GET конкретного MetricsTenant и Project. Права на запись
и административную Grafana этим не выдаются.

Dashboard проверяет caller GET Project и binding. Затем служебный адаптер
повторно читает живые Namespace/Project/MetricsTenant, сверяет UID и registry
и выполняет фиксированный запрос рядов только из закреплённого numeric tenant.
Список содержит имя и весь набор лейблов; одинаковые имена с разными наборами
показываются отдельными строками. Browser не выбирает
accountID, PromQL или endpoint. Произвольные query/labels/metadata/export API
проектам не открываются. Контракт списка описан в [справочнике](../reference/data-list.md).

### Проверка и эксплуатация

В продукте **Мониторинг → Метрики** проверьте два проекта с разными ресурсами:
списки должны отражать только их ВМ и бакеты. Попытка запросить страницу чужого
проекта должна давать 403. Проверьте из временных pods каждого проекта, что
порты VictoriaMetrics, общего bucket exporter и внешних exporter IP недоступны,
а обычное подключение к Kubernetes/S3 работает. Проверьте отсутствие прав
менять binding, registry, Secret, provider status и создавать unmanaged scrapes.

При отсутствии метрик смотрите targets VMAgent `projects`, readiness и logs
`gator-project-metrics`, свежесть credentials и соответствие Account bootstrap
namespace UID. UP пустого libvirt scrape допустим: на compute может не быть
подтверждённых ВМ проекта. Для бакетов действует задержка RGW accounting;
traffic counters появляются после операций с объектами и сбрасываются при
restart/eviction. Ошибка источника показывается как ошибка, а не нулевое потребление.

Проектная история начинается при включении этой маршрутизации. Старая история
tenant 0 автоматически не копируется. Lifecycle PaaS StaticScrape и графики
внутри продукта добавляются отдельно.
