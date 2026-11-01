---
title: Установка и эксплуатация мониторинга
---

Мониторинг входит в ядро Gator. Контроллер работает с общим GVK-контрактом и
создаёт штатные VMUser, VMStaticScrape и VMAgent. Продуктовые чарты поставляют
источники, правила владения и сервисные дашборды. Отдельной службы, знающей API
OpenStack или RGW ради привязки метрик, не требуется.

## Подготовка VictoriaMetrics

Установите совместимый VictoriaMetrics Operator, VMCluster и проектный
VMAgent/VMAuth. В комплекте исходников chart `gator-products/providers/monitoring/chart`
содержит общий проектный data plane. Его можно установить после оператора:

```sh
kubectl --context "$CONTEXT" create namespace monitoring
helm upgrade --install gator-project-metrics gator-products/providers/monitoring/chart \
  --kube-context "$CONTEXT" --namespace monitoring \
  --set dashboardNamespace=gator-dashboard \
  --set credentialNamespace=gator-monitoring-system --wait
```

Chart ожидает VMCluster `platform` в namespace `monitoring`. Общий агент пишет
в multitenant endpoint, а VMAuth выбирает только VMUser с label
`monitoring.gatorstack.dev/reader: projects`. Ни vmselect, ни vminsert не должны
быть открыты клиентам напрямую. Tenant 0 и административная Grafana отделены от
клиентского доступа.

Для **нового пустого хранилища** создайте durable registry один раз:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gator-metrics-registry
  namespace: monitoring
data:
  registry.json: '{"nextID":1001,"projects":{},"identityOwners":{}}'
```

При подключении существующего хранилища используйте его исходный registry.
Не сбрасывайте IDs, tombstones и привязки resource UID. Потеря registry требует
восстановления из резервной копии, а не создания пустой ConfigMap.

## Включение ядра

Примените CRD из chart Gator Dashboard отдельно: Helm не обновляет существующие
CRD при upgrade. Затем добавьте к values Dashboard:

```yaml
monitoring:
  enabled: true
  credentialNamespace: gator-monitoring-system
  backend:
    clusterRef: {name: platform, namespace: monitoring}
    agentRef: {name: projects, namespace: monitoring}
    authRef: {name: projects, namespace: monitoring}
    credentialNamespace: gator-monitoring-system
    registryRef: {name: gator-metrics-registry, namespace: monitoring}
    exportPolicy:
      maxPerProject: 4
      allowPrivateNetworks: false
      allowedHosts: []
```

```sh
kubectl --context "$CONTEXT" apply --server-side -f gator-dashboard/charts/gator-dashboard/crds/
helm upgrade --install gator-dashboard gator-dashboard/charts/gator-dashboard \
  --kube-context "$CONTEXT" --namespace gator-dashboard --create-namespace \
  --values values.yaml --wait
kubectl --context "$CONTEXT" get monitoringbackends
kubectl --context "$CONTEXT" get projectmonitorings -A
```

В этой версии поддерживается один MonitoringBackend. Контроллер раз в 10 секунд
находит живые Project/project, выделяет accountID и создаёт ProjectMonitoring с
владельцем Project UID. Registry не удаляется вместе с проектом. Пересозданный
проект получает новый tenant, даже если имя namespace осталось прежним.

Дополнительные права на исходные GVK задаются администратором в
`monitoring.sourcePermissions`. Доступ к системным credentials не выдаётся
клиентским ролям. Роли monitoring.auditor/viewer читают мониторинг, editor/owner
также управляют экспортами в консоли и проектными MonitoringDashboard напрямую
через Kubernetes API. В консоли нет создания, копирования или редактирования
дашбордов: публикуйте CR через Helm, GitOps либо Kubernetes API. Общие роли
собираются штатной Kubernetes aggregation.

## Продуктовые интеграции

Установите MetricSource, MetricOwnershipPolicy и MonitoringDashboard рядом с
манифестами продукта. [Справочник](../reference/monitoring.md) содержит полный
пример. Labels ресурсов не являются авторизацией: только администраторы должны
изменять исходные identity resources и кластерные правила.

Compute сопоставляет `project_uuid` и `region` с административной конфигурацией
проекта OpenStack. S3 использует native RGW Account в system namespace: immutable
namespace/Project UID связываются с отдельным RGW tenant. Stats определяют владельца
по AccountID, bucket counters — по tenant. Общие Ceph/OSD/pool показатели клиентам
не маршрутизируются. Lifecycle облачных ресурсов остаётся в интеграции продукта.

Прямой доступ из проектов к общим host exporters необходимо закрыть. Поле backend
`sourceNetworkPolicy` принимает `ipBlocks` и список TCP `ports`, которые нельзя
скрейпить из проектных pod. Остальной egress сохраняется. Дополнительно ограничьте
host-network exporters firewall и закройте административные VM endpoints. Не
выдавайте клиентам право менять системные NetworkPolicy или запускать hostNetwork
pods; такие права обходят сетевую границу по определению Kubernetes.

## Экспорт и credentials

MetricExport создаёт отдельный VMAgent в credential namespace. Его source всегда
указывает на `/federate` собственного VMAuth tenant. Дополнительный фильтр оставляет
только namespaceUID/ProjectUID текущего проекта. Credentials неизменяемы и привязаны fingerprint к конфигурации remoteWrite.
Смена URL, авторизации или других параметров подключения требует нового полного
набора ключей; переключение enabled и интервала может сохранить прежнюю ссылку.
Прямая правка GVK не позволяет перенаправить сохранённые секреты.
Native remote_write поддерживает
Basic/Bearer/OAuth2/TLS Secret refs. Ссылки на чужие Secrets и файловые пути
отклоняются; в UI значения передаются отдельно от CR.

По умолчанию выделяется PVC 1Gi, очередь ограничена 128MB, 2 remote-write queues,
память агента — 192Mi. Backend `exportStorageClass` задаёт storage class; без него
используется default. Больше не используемые версии credentials удаляются после пятиминутной паузы
для завершения записи CR. Включённый, но ошибочный экспорт останавливается. При удалении
экспорта удаляются управляемые credentials и очередь. Выключение останавливает
агент и удаляет его очередь; исходные credentials сохраняются для включения.

Общая default-deny policy сохраняет изоляцию при удалении отдельных агентов.
VMAuth выбирает пользователей только из защищённого credential namespace.
NetworkPolicy агента разрешает только DNS, собственный VMAuth и IP/порты проверенных
получателя и OAuth token URL. Поэтому DNS rebinding не открывает внутренние API.
Разрешение частного получателя задаётся `exportPolicy.allowedHosts` либо явным
`allowPrivateNetworks`. Изменение DNS может временно приостановить доставку до
следующей сверки. Настройка AWS-аутентификации через metadata/STS требует отдельной
разрешённой сетевой и workload-identity конфигурации; доступ к metadata по умолчанию
закрыт.

## Диагностика и резервирование

Проверяйте Ready/observedGeneration у backend, ProjectMonitoring, MetricSource и
MetricOwnershipPolicy; у MetricExport — phase, conditions и native VMAgent status.
Неверная или пересекающаяся identity закрывает source. Не исправляйте это назначением
tenant по умолчанию. Переезд ресурса между проектами — отдельная управляемая
миграция, а не изменение label.

Сохраняйте резервные копии registry, CR и VM storage. Проверка после upgrade:
готовность контроллера, число matched identities, native scrape targets, запросы
двух пользователей с разными проектами, отсутствие cross-project данных и
доставка на собственный тестовый remote_write receiver. `Running` у экспорта
подтверждает готовность агента; ошибки и backlog получателя проверяются метриками
native vmagent. Приёмочные данные и credentials не публикуйте в каталоге.
