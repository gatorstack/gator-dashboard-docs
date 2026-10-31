# Мониторинг сервисов

VictoriaMetrics Operator предоставляет Kubernetes API для настройки компонентов
VictoriaMetrics и сбора метрик. Установленный оператор позволяет создавать
`VMStaticScrape` для внешних exporter endpoints. Для фактического сбора нужен
также `VMAgent`, а для хранения — VictoriaMetrics с настроенным `remoteWrite`.

На начальном этапе устанавливаются оператор и CRD. Хранилище, сборщики,
автоматическое создание scrape при заказе PaaS и доступ пользователей к метрикам
подключаются отдельно. Установка оператора не добавляет графики в Dashboard.

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
этап обогащения. Установка экспортера на compute выполняется отдельно.

У RGW per-user/per-bucket operation counters включаются отдельно через
`rgw_user_counters_cache` и `rgw_bucket_counters_cache`; ceph-exporter читает
их из admin socket RGW. Cache eviction/restart может сбрасывать counters.
Общие показатели Ceph не дают достоверного разбиения нагрузки shared pool по
проектам. См. [метрики RGW](https://docs.ceph.com/en/tentacle/radosgw/metrics/).

Эта схема изоляции ещё не настроена. Перед выдачей доступа пользователям нужны
проверки двух проектов: запрет чтения чужих данных через query, labels, metadata
и export, подмены tenant при записи и обхода gateway. Серии с неопределённым
владельцем должны оставаться в контуре платформы.
