# Полные примеры настройки

Примеры относятся к новой/изолированной установке с Gator Cost, OpenMeter и
обновлёнными CRD. Задайте административный `GATOR_CONTEXT`. Для существующей
установки сохраните её clusterID/epoch/systemNamespace и добавляйте нужные
семейства/политики, а не заменяйте CostConfiguration целиком.

Цены здесь демонстрационные. `validFrom` первого плана замените своей UTC-датой
активации; принятый снимок не тарифицирует время до принятия. Будущие изменения
объявляйте заранее отдельными версиями.

## 1. Конфигурация

Сохраните как `cost-configuration.yaml`:

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: CostConfiguration
metadata:
  name: default
spec:
  clusterID: main
  systemNamespace: gator-cost
  currency: RUB
  storageMode: OpenMeter
  epoch: openmeter-1
  openMeter:
    enabled: true
    url: http://openmeter-api.openmeter.svc:8888
  accounting:
    gapPolicy: LastKnown
    heartbeatInterval: 15s
    staleAfter: 45s
    maxEstimateAge: Unlimited
    conflictPolicy: Suspend
    initialObservation: StartNow
  evaluation:
    celCostLimit: 100000
  reporting:
    api:
      url: http://gator-cost-api.gator-cost.svc:8080
      authTokenSecretRef: {name: legacy-api-reader, key: token}
    ui:
      currencySource: CostConfiguration
      showEstimates: true
      showCoverage: true
  metrics:
    - name: platform
      url: http://metrics.monitoring.svc:8481/select/0/prometheus
  pricing:
    projects:
      - {namespace: billing-lab, projectID: billing-lab}
    families:
      - key: compute-basic
        title: Compute
        rates:
          - {key: cpu-lab, product: iaas, title: 'CPU · lab', unitTitle: 'vCPU·мин'}
          - {key: cpu-baremetal, product: iaas, title: 'CPU · baremetal', unitTitle: 'vCPU·мин'}
          - {key: ram, product: iaas, title: RAM, unitTitle: 'ГиБ·мин'}
          - {key: public-ip, product: vpc, title: Публичный IP, unitTitle: 'IP·мин'}
      - key: s3-basic
        title: S3
        rates:
          - {key: s3-storage, product: s3, title: Хранение, unitTitle: 'ГБ·ч'}
          - {key: s3-incoming, product: s3, title: Входящий трафик, unitTitle: МБ}
          - {key: s3-outgoing, product: s3, title: Исходящий трафик, unitTitle: МБ}
```

`reporting.api.authTokenSecretRef` здесь — поле совместимости schema;
native runtime не читает этот legacy credential. Доступ к metrics bearer при
необходимости задаётся отдельным Secret ref. Адрес TSDB замените своим реальным
Prometheus-compatible endpoint.

## 2. Namespace и полный план Compute

Сохраните как `compute-plan.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: billing-lab
---
apiVersion: cost.gatorstack.dev/v1alpha1
kind: TariffPlan
metadata:
  name: compute-basic-initial
spec:
  key: compute-basic
  displayName: Базовые тарифы Compute
  currency: RUB
  validFrom: '2026-01-01T00:00:00Z'
  rates:
    - {key: cpu-lab, unit: core-minute, price: '0.05'}
    - {key: cpu-baremetal, unit: core-minute, price: '0.05'}
    - {key: ram, unit: GiB-minute, price: '0.01'}
    - {key: public-ip, unit: resource-minute, price: '0.02'}
```

## 3. Field policy с выбором CPU-класса

Для воспроизводимого примера внешний ресурс описан ConfigMap. Это не учёт
Kubernetes pod allocation: поля представляют заказ внешней услуги. В реальной
интеграции замените GVR и JSON Pointers полями своего провайдерского CR.

Сохраните как `compute-policy.yaml`:

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: MeteringPolicy
metadata:
  name: billing-example-compute
spec:
  enabled: true
  source:
    group: ''
    version: v1
    resource: configmaps
    scope: Namespaced
    namespaces: {names: [billing-lab]}
    labelSelector:
      matchLabels: {billing.example.org/type: external-compute}
  billableWhen: >-
    has(object.data) && has(object.data.state) &&
    object.data.state == 'Running' &&
    !has(object.metadata.deletionTimestamp)
  dimensions:
    project: {fieldPath: /metadata/namespace}
    product: {value: iaas}
    instance: {fieldPath: /metadata/uid}
  reporting:
    orderTitlePath: /data/title
    tagsPath: /metadata/labels
    excludeTagPrefixes: [billing.example.org/]
  tariffPlanRef: {name: compute-basic}
  meters:
    - id: cpu
      name: cpu
      chargeKey: cpu
      mode: Field
      unit: core
      displayName: CPU
      displayNamePath: /data/cpuTitle
      displayUnit: vCPU
      quantity: {fieldPath: /data/cpu, format: Decimal}
      priceRef: {fieldPath: /data/cpuClass}
    - id: ram
      name: ram
      chargeKey: ram
      mode: Field
      unit: GiB
      displayName: RAM
      displayUnit: ГиБ
      quantity:
        fieldPath: /data/ram
        format: KubernetesQuantity
        divide: '1073741824'
      priceRef: {key: ram}
```

Сохраните как `external-instance.yaml` полный объект заказа:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: external-instance
  namespace: billing-lab
  labels:
    billing.example.org/type: external-compute
    environment: test
    team: platform
data:
  title: Внешняя тестовая ВМ
  state: Running
  cpu: '2'
  cpuClass: cpu-lab
  cpuTitle: 'CPU · lab'
  ram: 2Gi
```

Сохраните policy отдельно от заказа; примените сначала конфигурацию, namespace,
план и policy, затем заказ. В collector values необходим source RBAC:

```yaml
sourcePermissions:
  - apiGroups: ['']
    resources: [configmaps]
    verbs: [get, list, watch]
```

```sh
oc --context "$GATOR_CONTEXT" apply -f cost-configuration.yaml
oc --context "$GATOR_CONTEXT" apply -f compute-plan.yaml
oc --context "$GATOR_CONTEXT" apply -f compute-policy.yaml
oc --context "$GATOR_CONTEXT" apply -f external-instance.yaml
oc --context "$GATOR_CONTEXT" get tariffplan compute-basic-initial -o yaml
oc --context "$GATOR_CONTEXT" get meteringpolicy billing-example-compute -o yaml
```

За три начатые минуты 2 CPU дают 6 core-minute; при цене 0.05 это 0.30 RUB.
RAM считается отдельным компонентом. Поменяйте `data.cpuClass` на `cpu-baremetal`
и подпись на `CPU · baremetal`: новая цена выбирается без нового вида политики.
`data.state: Stopped` закрывает billable сессию; уже начатая минута сохраняется.

## 4. Count policy

Для ресурса, который оплачивается одной штукой за время, quantity не нужен:

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: MeteringPolicy
metadata:
  name: billing-example-address
spec:
  source:
    group: ''
    version: v1
    resource: configmaps
    scope: Namespaced
    namespaces: {names: [billing-lab]}
    labelSelector:
      matchLabels: {billing.example.org/type: external-address}
  billableWhen: has(object.data) && object.data.allocated == 'true'
  dimensions:
    project: {fieldPath: /metadata/namespace}
    product: {value: vpc}
    instance: {fieldPath: /metadata/uid}
  tariffPlanRef: {name: compute-basic}
  meters:
    - name: public-ip
      chargeKey: public-ip
      mode: Count
      unit: resource
      priceRef: {key: public-ip}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: external-address
  namespace: billing-lab
  labels:
    billing.example.org/type: external-address
data:
  allocated: 'true'
```

## 5. Проектный полный override

Применяйте отдельно, когда нужен проектный тариф. Показаны **все** позиции:

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: ProjectTariffPlan
metadata:
  name: compute-project-special
  namespace: billing-lab
spec:
  projectID: billing-lab
  globalPlanRef: {name: compute-basic}
  displayName: Проектные тарифы Compute
  currency: RUB
  validFrom: '2026-01-01T00:00:00Z'
  rates:
    - {key: cpu-lab, unit: core-minute, price: '0.04'}
    - {key: cpu-baremetal, unit: core-minute, price: '0.04'}
    - {key: ram, unit: GiB-minute, price: '0.008'}
    - {key: public-ip, unit: resource-minute, price: '0.02'}
```

Для запланированной смены задайте будущие validFrom/validUntil без пересечения.
Не применяйте две проектные версии с одинаковым активным периодом.

## 6. S3: хранение и два направления трафика

Нужны реальные native Bucket GVK, exporter с указанными метриками, trusted
provider connection и RBAC collector на Bucket. Сам биллинг их не устанавливает.
В namespace billing-lab должны существовать управляемые бакеты с полями
`status.atProvider.bucket/owner/id`. Замените имя backend label `storage-cluster`
реальным значением своего экспортера.

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: TariffPlan
metadata:
  name: s3-basic-initial
spec:
  key: s3-basic
  displayName: Тарифы S3
  currency: RUB
  validFrom: '2026-01-01T00:00:00Z'
  rates:
    - {key: s3-storage, unit: GB-hour, price: '0.01'}
    - key: s3-incoming
      unit: MB
      price: '1'
      includedQuantity: '10'
      includedPeriod: MONTH
    - key: s3-outgoing
      unit: MB
      price: '1'
      includedQuantity: '10'
      includedPeriod: MONTH
---
apiVersion: cost.gatorstack.dev/v1alpha1
kind: MetricMeteringPolicy
metadata:
  name: billing-example-s3
spec:
  dataSourceRef: {name: platform}
  interval: 30s
  delay: 60s
  maxSampleAge: 120s
  maxCatchUp: 24h
  source:
    group: s3.radosgw.m.crossplane.io
    version: v1alpha1
    resource: buckets
    scope: Namespaced
    namespaces: {names: [billing-lab]}
    labelSelector:
      matchLabels: {s3.gatorstack.dev/managed: 'true'}
  billableWhen: >-
    has(object.status) && has(object.status.atProvider) &&
    has(object.status.atProvider.id) && object.status.atProvider.id != '' &&
    has(object.status.atProvider.owner) &&
    !has(object.metadata.deletionTimestamp)
  dimensions:
    project: {fieldPath: /metadata/namespace}
    product: {value: s3}
    instance: {fieldPath: /metadata/uid}
  reporting:
    orderTitlePath: /metadata/annotations/s3.gatorstack.dev~1title
    tagsPath: /spec/forProvider/tags
  tariffPlanRef: {name: s3-basic}
  metrics:
    - id: storage
      name: s3-storage
      displayName: Хранение S3
      mode: GaugeIntegral
      unit: GB-hour
      divide: '1000000000'
      timeUnit: 1h
      priceRef: {key: s3-storage}
      selector:
        metric: radosgw_usage_bucket_size
        labels:
          cluster: {value: storage-cluster}
          bucket: {fieldPath: /status/atProvider/bucket}
          uid: {fieldPath: /status/atProvider/owner}
    - id: incoming
      name: s3-incoming
      displayName: Входящий трафик S3
      mode: CounterDelta
      unit: MB
      divide: '1000000'
      priceRef: {key: s3-incoming}
      selector:
        metric: ceph_rgw_op_per_bucket_put_obj_bytes
        labels:
          cluster: {value: storage-cluster}
          bucket: {fieldPath: /status/atProvider/bucket}
      ownership:
        metric: radosgw_usage_bucket_size
        labels:
          cluster: {value: storage-cluster}
          bucket: {fieldPath: /status/atProvider/bucket}
          uid: {fieldPath: /status/atProvider/owner}
    - id: outgoing
      name: s3-outgoing
      displayName: Исходящий трафик S3
      mode: CounterDelta
      unit: MB
      divide: '1000000'
      priceRef: {key: s3-outgoing}
      selector:
        metric: ceph_rgw_op_per_bucket_get_obj_bytes
        labels:
          cluster: {value: storage-cluster}
          bucket: {fieldPath: /status/atProvider/bucket}
      ownership:
        metric: radosgw_usage_bucket_size
        labels:
          cluster: {value: storage-cluster}
          bucket: {fieldPath: /status/atProvider/bucket}
          uid: {fieldPath: /status/atProvider/owner}
```

Дополните sourcePermissions этим GVR, сохранив ConfigMap RBAC предыдущего примера:

```yaml
sourcePermissions:
  - apiGroups: [s3.radosgw.m.crossplane.io]
    resources: [buckets]
    verbs: [get, list, watch]
```

Прежде чем загружать основной тестовый объём, выполните маленький PUT/GET и
дождитесь baseline всех нужных raw series в checkpoints. Затем загрузите
6 MB в один тестовый бакет и 8 MB во второй, скачайте их и дождитесь измерений.
Ожидается суммарно около 14 MB каждого направления, по 4 RUB за каждое:
первые 10 MB общие для проекта, а не отдельные на каждый бакет.

ГБ/МБ здесь десятичные: 10^9 / 10^6 bytes. Проверяйте реальное определение
счётчика экспортера: он может считать байты иначе, чем размер клиентского файла.
Суммы сравнивают с измеренным quantity, не исправляют samples вручную.
Очищайте только собственные тестовые объекты/бакеты и проверяйте их отсутствие.

## Запрос детализации

Сохраните как `report.yaml`, выбрав прошедший диапазон своего теста:

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: CostReport
metadata:
  name: usage-by-component
  namespace: billing-lab
spec:
  start: '2026-10-01T00:00:00Z'
  end: '2026-10-02T00:00:00Z'
  resolution: HOUR
  groupBy: component
  product: s3
  page: 1
  pageSize: 25
```

```sh
oc --context "$GATOR_CONTEXT" apply -f report.yaml
oc --context "$GATOR_CONTEXT" -n billing-lab wait \
  costreport/usage-by-component --for=condition=Ready --timeout=180s
oc --context "$GATOR_CONTEXT" -n billing-lab get \
  costreport/usage-by-component -o jsonpath='{.status.result}'
oc --context "$GATOR_CONTEXT" -n billing-lab get pricelists
```

Для другого окна создайте CR с новым именем. Для заказа добавьте `orderUID`;
для тега — `tagKey/tagValue`. Общий месячный лимит не пересчитывается заново
для выбранного фильтра. Запрос не создаёт начислений.
