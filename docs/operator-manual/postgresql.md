# Установка Managed PostgreSQL

Сервис поставляется отдельным chart `products/postgresql/chart` из комплекта
Gator Products. Он устанавливает категорию DBaaS, продукт, CRD, роли, внешнюю
интеграцию и подключения к квотам, биллингу, мониторингу и логированию.
Пересборка Dashboard не требуется.

## Предварительные условия

- Dashboard с ProductResource, connection-secret, monitoring и logging GVK.
- Crossplane и namespaced provider-openstack; в каждом проекте настроен
  `ProviderConfig` с именем региона и проектным application credential Secret.
- VPC подсети имеют Ready, external ID и аннотацию
  `vpc.gatorstack.dev/zone`; несколько регионов имеют независимые настройки.
- Gator Quotas, Cost/OpenMeter и нативные VictoriaMetrics/VictoriaLogs с
  проектной изоляцией. Namespace проекта содержит `Project/project`.
- SSH/metric маршруты от служебных pod к host Floating IP и HTTPS-маршрут от
  хостов к ingress логирования. SSH host keys берутся из authenticated Nova
  console; `StrictHostKeyChecking` остаётся включённым.
- Registry Secret для закрытых образов существует в служебном namespace и
  namespace Crossplane. Credentials не включаются в product values.

## Values и установка

Пример `postgresql-values.yaml` для одного проекта и региона:

```yaml
systemNamespace: gator-postgresql-system
createSystemNamespace: false
projectNamespaces: [project-a]
controller:
  imagePullSecrets: [{name: registry-pull}]
ansible:
  install: true
  namespace: crossplane-system
  imagePullSecrets: [{name: registry-pull}]
profile:
  operatorCIDRs: [192.0.2.10/32]
  minimumClientPrefix: 8
  monitoringBackend: platform
  logIngestURL: https://postgresql-logs.example.org/postgresql/insert/jsonline
  regions:
    region-one:
      zones: [region-one-a, region-one-b, region-one-c]
      externalNetworkName: external-region-one
      imageID: REPLACE_WITH_UBUNTU_24_04_IMAGE_UUID
      sshUser: ubuntu
      flavors:
        small: {id: REPLACE_WITH_FLAVOR_UUID, vcpu: 2, memoryGiB: 2}
classes:
- {name: small, title: '2 vCPU · 2 GiB RAM', vcpu: 2, memoryGiB: 2}
logging:
  backend: native
  storageURL: http://vlsingle-customers.logging.svc:9428
  storageNamespace: logging
  ingressHost: postgresql-logs.example.org
  accountIDs: {project-a: 1001}
billing:
  enabled: true
  tariffPlan: postgresql
  activePlan: postgresql-plan
  startAt: '2026-11-01T00:00:00Z'
  tariffPlans:
  - name: postgresql-plan
    spec:
      key: postgresql
      displayName: PostgreSQL
      currency: RUB
      validFrom: '2026-11-01T00:00:00Z'
      rates:
      - {key: postgresql-cpu, price: '0.06', unit: core-minute}
      - {key: postgresql-ram, price: '0.012', unit: GiB-minute}
      - {key: postgresql-storage, price: '0.0003', unit: GiB-minute}
quotas:
  enabled: true
  clusters: '10'
  hosts: '30'
  vcpu: '120'
  memoryGiB: '120'
  storageGiB: '3000'
```

Приведённые цены — пример. Замените их, UUID, адреса, accountID и даты своим
профилем. accountID должен совпадать с `ProjectMonitoring/project`; также
должен существовать read route этого tenant в backend логирования.
Назначения `ProjectSubscription` и действующие планы неизменяемы: новый тариф
публикуется отдельной ревизией, с явно выбранной датой перехода.
При первом создании `startAt` должен находиться в будущем относительно часов
кластера; выберите дату после завершения установки. При повторных установках
сохраняйте исходную дату. Для разных проектов можно задать
`billing.startAtByNamespace`, не меняя уже созданные назначения.

Из корня полученного комплекта Gator Products:

```sh
helm dependency build --skip-refresh products/postgresql/chart
helm upgrade --install gator-postgresql products/postgresql/chart \
  --kube-context my-cluster -n gator-dashboard \
  -f postgresql-values.yaml --wait --timeout 10m
```

При обновлении CRD примените текущие CRD комплекта перед Helm upgrade: Helm не
обновляет содержимое `crds/` существующего release автоматически.

В примере служебный namespace и registry Secret подготовлены заранее, поэтому
`createSystemNamespace: false`. Если namespace должен создавать сам chart,
используйте значение по умолчанию `true`. Не переключайте его для namespace,
который уже принадлежит release. Создаваемый chart namespace помечен `keep`:
Helm uninstall сохраняет его с managed resources и дисками; работающие заказы
перед удалением установки нужно удалить через их GVK.

```sh
kubectl --context my-cluster apply --server-side \
  --field-manager=gator-postgresql-crds -f products/postgresql/chart/crds/
```

В `CostConfiguration.spec.pricing.families` добавьте семейство `postgresql` с
тремя rate keys из примера, сохраняя остальные семейства. Назначьте продукт
`postgresql` и единицы `vCPU·мин`/`ГиБ·мин`. Это подключает прайс и активный
тариф к общему пользовательскому разделу расходов; сам collector использует
установленные MeteringPolicy и ProjectSubscription.

## Проверка

```sh
kubectl --context my-cluster get providers.pkg.crossplane.io
kubectl --context my-cluster -n gator-postgresql-system get deployments
kubectl --context my-cluster -n project-a get postgresqlplacements
kubectl --context my-cluster -n project-a get quota postgresql
kubectl --context my-cluster -n project-a get postgresqlclusters
```

Ansible provider должен быть Healthy, контроллер и log ingest — Ready.
Размещения появляются только для подходящих готовых подсетей включённых
проектов. Неоднозначное размещение нескольких подсетей в одной зоне не
подбирается автоматически для Patroni. После заказа проверьте SQL read/write,
метрики и серверное событие, а для Patroni — replication и switchover.

## Ответственность компонентов

`PostgreSQLCluster` — основной заказ. Контроллер создаёт native OpenStack MR
в protected namespace, используя исходный tenant проекта. Image/flavor profile
закрепляется в Secret при создании: изменение values относится к новым заказам
и не заменяет диски существующих кластеров.

Crossplane `AnsibleRun` выполняет закреплённую MIT-коллекцию Autobase. Пароли,
inventory и SSH private key передаются через Secret refs; `AnsibleRun.spec` не
содержит секретных значений. `ansible_no_log` включён. Операции и пользовательские
сущности имеют отдельные CR и run identities. Защита удаления и finalizers
удерживают заказ до очистки собственных ресурсов. Helm uninstall не является
способом удаления работающих заказов: сначала завершите их lifecycle.

Пакет provider-ansible v0.8.0 использует `upbound-system` для shard lease.
Chart создаёт этот namespace и Role для единственного lease, привязанную к
служебному аккаунту провайдера в `ansible.namespace`. Не устанавливайте второй
экземпляр того же провайдера с конкурирующим lease. Для уже установленного
совместимого провайдера используйте `ansible.install: false` и настройте runtime
с закреплённой коллекцией самостоятельно.

MetricSource и MetricOwnershipPolicy принадлежат сервису. VictoriaLogs ingest
использует отдельный write-only token кластера; VMAuth фиксирует tenant и UID
записи. Vector передаёт только разрешённые поля PostgreSQL JSON log. Запросы
логов повторно проверяют caller RBAC и identity основного CR.

Exporter устанавливается из upstream PostgreSQL exporter 0.20.1 с закреплённым
SHA-256. Системная служба использует local peer authentication и поддерживает
PostgreSQL 16–18; устаревший бинарный файл пакета Ubuntu не используется.
Для другой архитектуры администратор задаёт `profile.exporterArtifact` с
`url`, `sha256` и относительным путём `binary` внутри архива. Образы study и
артефакт по умолчанию рассчитаны на amd64. Vector 0.51.1 проверяет UTC timestamp
и удаление чувствительных полей встроенным тестом до запуска коллектора.

Роли `postgresql.auditor/viewer/editor/owner` управляют GVK сервиса через native
Kubernetes RBAC. Они не дают доступ к служебным MR, AnsibleRun, provisioning
credentials и SSH. Доступ к конкретному connection Secret задаётся созданной
в namespace проекта Role `postgresql-<идентификатор-заказа>` и явным RoleBinding.
Обычный `viewer` не получает автоматического чтения Secret.

В этой версии нет backup/PITR, resize и major upgrade. Для производственного
использования отдельно обеспечьте нужное хранение и проверку восстановления.
Логические зоны учебного OpenStack сами по себе не гарантируют физическую
независимость отказов.
