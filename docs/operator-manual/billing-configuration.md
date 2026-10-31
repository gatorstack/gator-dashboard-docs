# Учёт ресурсов и тарифы

После [установки](billing-installation.md) задайте, какие ресурсы оплачиваются,
какие величины измеряются и по каким ставкам. Бизнес-конфигурация хранится
в CRD `cost.gatorstack.dev/v1alpha1`.

## 1. Создайте глобальный тариф

Пример цены CPU 0.05 RUB за core-minute. Значения учебные: замените их своими,
а дату начала — согласованной датой активации в UTC. До неё этот план не действует.

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: TariffPlan
metadata:
  name: standard-2027
spec:
  key: standard
  currency: RUB
  validFrom: "2027-01-01T00:00:00Z"
  rates:
    - key: cpu
      unit: core-minute
      price: "0.05"
```

`spec.key` — семейство планов. Правило ссылается на `standard`, а не на
metadata.name `standard-2027`. Последовательные планы одного семейства задают
расписание. Не допускайте перекрытия периодов; validUntil, если задан, исключён.

## 2. Настройте правило

Пример использует ConfigMap проекта `team-a` с меткой `billing: enabled`.
В реальной установке выберите нужный GVR через `oc api-resources` и выдайте
collector get/list/watch этого GVR в `sourcePermissions` Helm.

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: MeteringPolicy
metadata:
  name: team-a-cpu
spec:
  enabled: true
  source:
    group: ""
    version: v1
    resource: configmaps
    scope: Namespaced
    namespaces:
      names: [team-a]
    labelSelector:
      matchLabels:
        billing: enabled
  billableWhen: >-
    has(object.data) && has(object.data.state) && object.data.state == 'Running'
  dimensions:
    project: {value: team-a}
    product: {value: compute}
    instance: {fieldPath: /metadata/name}
  tariffPlanRef: {name: standard}
  meters:
    - id: cpu
      name: cpu
      chargeKey: cpu
      mode: Field
      unit: core
      quantity:
        fieldPath: /data/cpu
        format: Decimal
      priceRef: {key: cpu}
```

Все условия выборки действуют совместно. Namespace можно выбирать одним из
способов: names, all или selector по labels namespace. Glob-масок нет.
CEL-условие проверяет исходный объект и не обращается к другим CR или облачным API.

Источник для проверки:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: example-instance
  namespace: team-a
  labels:
    billing: enabled
data:
  state: Running
  cpu: "2"
```

Начисление начнётся при действующем тарифе и первом валидном наблюдении.
Замена Running на другое состояние завершает тарифицируемую сессию.
Начатая минута сохраняется; следующая уже не начисляется.

## 3. Примените и проверьте

Сохраните манифесты в отдельные файлы:

```sh
oc --context "$GATOR_CONTEXT" apply -f tariff.yaml -f metering-policy.yaml -f source.yaml
oc --context "$GATOR_CONTEXT" get tariffplans.cost.gatorstack.dev
oc --context "$GATOR_CONTEXT" get meteringpolicies.cost.gatorstack.dev
oc --context "$GATOR_CONTEXT" get meteringpolicies.cost.gatorstack.dev team-a-cpu -o yaml
```

Проверьте conditions и observedGeneration, затем CostReport текущего namespace
в Dashboard → Billing → Детализация. Для 2 CPU за одну начатую минуту ожидается
2 core-minute. Цена рассчитывается в OpenMeter по действующему плану.

## 4. Задайте проектную цену

Проектный план находится в namespace источника и указывает projectID из
dimensions. В примере оба значения относятся к `team-a`:

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: ProjectTariffPlan
metadata:
  name: team-a-special
  namespace: team-a
spec:
  projectID: team-a
  globalPlanRef: {name: standard}
  currency: RUB
  validFrom: "2027-02-01T00:00:00Z"
  validUntil: "2027-03-01T00:00:00Z"
  rates:
    - key: cpu
      unit: core-minute
      price: "0.03"
```

Проектный план заменяет глобальный целиком. Если глобальный план содержит CPU
и RAM, а проектный только CPU, RAM не наследуется и получает MissingRate.
После окончания override снова выбирается глобальный план.

## Другие измерения

Для количества CR используйте `mode: Count`, `unit: resource` без quantity,
с тарифом за `resource-minute`. Для полей Kubernetes Quantity используйте
`format: KubernetesQuantity` и явную нормализацию multiply/divide.
CPU 500m и RAM 8Gi не следует интерпретировать как простые Decimal-строки.

Несколько составляющих могут иметь общий name/unit и разные id/chargeKey,
например cpu-main + cpu-extra. Они суммируются, сохраняя вклад источников.
Два правила на один source/product/chargeKey конфликтуют; не создавайте разные
ключи для обхода диагностики, если это не намеренные отдельные составляющие.

## Изменение цены и история

Не редактируйте принятую активную цену задним числом. Создайте следующий план
и согласуйте периоды. Удаление исходного ресурса или правила не удаляет историю.
Изменения внутри минуты влияют на следующую минуту; начало сессии не сбрасывается.

LastKnown продолжает последнее состояние как Estimated при потере наблюдений.
Отсутствующее поле, конфликт и отсутствие ставки
не превращаются в нулевое потребление.

## Названия компонентов и классы хранения

В meter можно задать displayName и displayUnit: они используются в детализации
заказа и не меняют единицы учёта. Вместо статического priceRef.key разрешён
priceRef.fieldPath — JSON Pointer к ключу ставки в самом исходном CR.

```yaml
meters:
  - id: storage
    name: disk
    chargeKey: storage
    mode: Field
    unit: GiB
    displayName: Хранение диска
    displayUnit: ГиБ
    quantity: {fieldPath: /spec/forProvider/size, format: Decimal}
    priceRef: {fieldPath: /spec/forProvider/volumeType}
```

Выберите ровно один из key/fieldPath. Динамический ключ требует tariffPlanRef.
Ставки должны содержать фактические имена классов выбранного облака. Неизвестный
класс даёт ошибку, а не цену по умолчанию. Каталог типов диска остаётся набором CR,
список типов не зашивается в консоль.

Пакеты IaaS/VPC предоставляют правила compute, boot disk, standalone disk,
snapshot и floating IP. В study используются согласованные учебные цены: CPU
0,05 ₽/core-minute, RAM 0,01 ₽/GiB-minute, IP 0,02 ₽/resource-minute;
HDD 0,0001, SSD 0,0002, NVME 0,0004 и снимок 0,0001 ₽/GiB-minute.
Это примеры, не коммерческий прайс. Существующие семейства тарифов не заменяются.

Правила измеряют поля CR. Установленный compute использует CPU/RAM, записанные
из проверенного Flavor при создании. Доступ на произвольное изменение этих полей
вне консоли должен ограничиваться вашим RBAC/admission. Это не телеметрия Nova.
Не включайте одновременно два источника одного boot volume: текущие Observe-only
зеркала загрузочных дисков исключены из отдельного учёта VolumeV3.

## Метки и названия заказов в детализации

Политика может явно выбрать публичные поля заказа для исторических снимков:

```yaml
reporting:
  orderTitlePath: /spec/forProvider/name
  tagsPath: /spec/forProvider/tags
```

`tagsPath` принимает карту строк или список `key=value`. Для метаданных дисков
можно выбрать `/spec/forProvider/metadata`, задать `excludeTagKeys: [description]`
и `excludeTagPrefixes: [gator_]`. Выбирайте только публичные теги заказа;
credentials и произвольные spec поля сюда не относятся. Отсутствующее поле
означает пустые теги; некорректные теги помечаются отдельно и не меняют цену.
Прошлые минуты не обогащаются текущими тегами задним числом.

## Публикация ценообразования в Dashboard

Установите актуальные CRD и controller Gator Cost с поддержкой `PriceList`,
а также продукт Billing. Контроллер публикует витрину каждые 15 секунд только
для явно настроенных субъектов и семейств. Цены берутся из принятых тарифных
снимков OpenMeter; записи ниже задают публичные подписи и Product ID.

Сохраните как `pricing.yaml` и примените к уже настроенному CostConfiguration:

```yaml
spec:
  pricing:
    projects:
      - namespace: project-a
        projectID: project-a
    families:
      - key: standard
        title: Базовый прайс-лист
        rates:
          - key: cpu
            product: iaas
            title: CPU
            unitTitle: vCPU·мин
          - key: ram
            product: iaas
            title: RAM
            unitTitle: ГиБ·мин
```

```sh
kubectl patch costconfiguration default --type merge --patch-file pricing.yaml
kubectl -n project-a get pricelists
```

`projectID` должен совпадать с измерением проекта в MeteringPolicy и
ProjectTariffPlan. `key` семейства — с TariffPlan.key / globalPlanRef.name.
`rates[].key` — с ключом ставки; `product` — ID установленного Product.
`unitTitle` описывает именно единицу принятой ставки, включая минуту; это
подпись, она не выполняет преобразование цены. Неописанные ставки сохраняются
с исходными ключом и единицей, в группе без продукта.

Billing auditor/viewer/editor/owner получают get/list/watch PriceList только в
namespace назначения роли. Права записи и `pricelists/status` им не выдаются.
Удаление namespace из экспорта убирает производную витрину этого проекта;
принятые тарифы и история начислений остаются. Состояние синхронизации проверяйте
по PriceList и журналу collector, не меняя его `status` вручную.

## Разделение CPU по классам конфигурации

В продукте Compute класс определяется доверенным FlavorV2 в selection-мэппингах
создания и изменения заказа. `valueMap` использует канонические JSON-ключи:
для строки `lab.small` ключ в YAML записывается как `'"lab.small"'`. Ключ ставки
и публичная подпись сохраняются в Kubernetes-аннотациях:
`cost.gatorstack.dev/cpu-rate-key` и `cost.gatorstack.dev/cpu-title`.
Клиент не передаёт цену; оба поля вычисляет сервер из выбранного каталога.

CPU meter использует `priceRef.fieldPath` к первой аннотации и `displayNamePath`
ко второй. Проекция BillingBinding должна разрешать оба пути. `displayNamePath`
меняет только подпись; он не выбирает цену. Неизвестный flavor отклоняется,
отсутствующий ключ ставки не подменяется бесплатным CPU. Для новых flavors
добавляйте явное соответствие классу в create и edit.

При разделении существующего ключа `cpu` сохраняйте тарифную историю:

1. Создайте будущий переходный план со старым и новыми ключами. Закройте старый
   план по той же UTC-границе и дождитесь принятия обеих конфигураций.
2. После начала переходного плана классифицируйте существующие заказы по
   проверенным cloud/flavor ID. Меняйте только Kubernetes-аннотации; CPU/RAM,
   flavor ID, диски и состояние работающих ВМ сохраняются.
3. Подключите динамический выбор ставки и подписи, обновите прогноз и каталог
   цен. Убедитесь, что у MeteringPolicy нет invalidMeters и conflicts.
4. Назначьте будущую общую границу окончания переходного и начала окончательного
   плана. В окончательном плане оставьте `cpu-lab`, `cpu-baremetal` и все прочие
   необходимые ставки. Исторический `cpu` сохраняется в прежних планах.

У всех планов семейства сохраняйте согласованные единицы и непересекающиеся
периоды. Проектные override заменяют весь набор: при их наличии новые ключи
нужно включить и в соответствующие проектные планы. Исходные minute snapshots
не переименовываются и не пересчитываются.

## Потребление из метрик

Gator Cost 0.6 поддерживает `MetricMeteringPolicy`. Сначала установите обновлённые
CRD и collector, затем подключите источник метрик и политики. Уже работающие
`MeteringPolicy` продолжают учитывать CR-сессии по прежним правилам.

Источник должен предоставлять Prometheus HTTP API. Укажите его базовый URL,
включая путь tenant, в административном CostConfiguration:

```yaml
spec:
  metrics:
    - name: platform
      url: http://metrics.monitoring.svc:8481/select/0/prometheus
      # Если API требует bearer, добавьте ссылку:
      # bearerTokenSecretRef:
      #   namespace: gator-cost
      #   name: metrics-reader
      #   key: token
```

Credential хранится в Secret. Выдайте ServiceAccount collector только `get`
этого Secret в его namespace. Ссылка сама по себе не даёт Kubernetes RBAC.
Не помещайте ключ в URL, labels, заказ или публичные метаданные.

Пример политики хранения бакетов Ceph RGW:

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: MetricMeteringPolicy
metadata:
  name: bucket-storage
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
    namespaces: {names: [project-a]}
    labelSelector:
      matchLabels: {s3.gatorstack.dev/managed: 'true'}
  billableWhen: >-
    has(object.status) && has(object.status.atProvider) &&
    has(object.status.atProvider.id) && object.status.atProvider.id != '' &&
    has(object.status.atProvider.owner) && !has(object.metadata.deletionTimestamp)
  dimensions:
    project: {fieldPath: /metadata/namespace}
    product: {value: s3}
    instance: {fieldPath: /metadata/uid}
  reporting:
    orderTitlePath: /metadata/annotations/s3.gatorstack.dev~1title
    tagsPath: /spec/forProvider/tags
  tariffPlanRef: {name: s3}
  metrics:
    - id: storage
      name: storage
      displayName: Хранение S3
      mode: GaugeIntegral
      unit: GB-hour
      divide: '1000000000'
      timeUnit: 1h
      priceRef: {key: storage}
      selector:
        metric: radosgw_usage_bucket_size
        labels:
          cluster: {value: storage-cluster}
          bucket: {fieldPath: /status/atProvider/bucket}
          uid: {fieldPath: /status/atProvider/owner}
```

Имена метрик и labels зависят от установленного экспортера. Проверьте их до
включения политики. Collector должен иметь get/list/watch исходных Bucket и
namespace; адрес TSDB должен быть доступен из его Pod. `product` — ID Product
каталога. Проект определяется namespace заказа; labels метрик его не подменяют.

Для входящего трафика используйте `CounterDelta`, `unit: MB`,
`divide: '1000000'`, метрику `ceph_rgw_op_per_bucket_put_obj_bytes`; для исходящего —
`ceph_rgw_op_per_bucket_get_obj_bytes`. `timeUnit` для counter не задаётся.
Selector каждого направления содержит bucket и cluster. Добавьте `ownership`
с тем же selector размера, что в примере выше: он подтверждает bucket+owner+cluster
перед чтением трафика. Каждый meter имеет отдельные id/name/priceRef.key.

Ставки соответствующего семейства TariffPlan:

```yaml
rates:
  - {key: storage, unit: GB-hour, price: '0.01'}
  - key: incoming
    unit: MB
    price: '1'
    includedQuantity: '10'
    includedPeriod: MONTH
  - key: outgoing
    unit: MB
    price: '1'
    includedQuantity: '10'
    includedPeriod: MONTH
```

Добавьте их в новый полный план с будущим `validFrom`, `currency: RUB` и нужным
`key`. Для проектных override необходим полный набор ставок. `includedQuantity`
применяется к измеряемому потреблению: 10 MB каждого направления на проект,
суммарно по его бакетам, за календарный месяц UTC. Новая ревизия плана, удаление
бакета или перезапуск collector не обновляют лимит. Изменение названия ключа
создаёт другую позицию; не используйте переименование для обычной смены цены.

GB и MB — десятичные единицы; дробные части учитываются без округления вверх.
Gauge интегрируется удержанием последнего наблюдения до следующего scrape,
по фактической длительности, без правила целой начатой минуты. Трафик относится
к правой границе sample-интервала. В детализации класса показывается полный измеренный объём, включая
бесплатную часть. Деньги рассчитывает native graduated price OpenMeter;
бесплатные единицы не вычитаются сборщиком.

Первое накопленное значение counter становится baseline и не тарифицируется
задним числом. Новая исходная серия тоже начинает с baseline. Перед приёмочным
тестом создайте небольшую операцию и дождитесь наблюдения счётчика; затем
передавайте тестовый объём. Reset обрабатывается отдельно по каждой серии.
Scrape, cache eviction и restart RGW могут потерять промежуточный трафик;
метрики не заменяют полный журнал S3-запросов. Пропуск длиннее maxSampleAge
помечается и начинает новый baseline без начисления за неизвестный участок.

Проверьте `kubectl get metricmeteringpolicies`: Ready означает принятую конфигурацию
и доступный GVK заказов; DataReady и invalidMeters показывают полноту измерений.
Пустой бакет без counters может ожидать baseline, не блокируя установку. Проверьте
затем CostReport/PriceList текущего проекта. Missing/stale/partial/неоднозначная
ownership дают диагностику, а не бесплатную услугу. При недоступности TSDB
collector повторяет запросы с durable checkpoint в пределах maxCatchUp;
retention TSDB должна быть длиннее этого окна. Для более длинного разрыва
сначала выполните сверку источника; не удаляйте checkpoints/историю ради replay.

## Хранение и бесплатный объём в OpenMeter

В native режиме CostConfiguration использует `storageMode: OpenMeter` и стабильный
`epoch`, без ledger DSN. CollectorCheckpoint хранит текущие сессии, последние
точки серий и ограниченную очередь неподтверждённых событий. История, принятые
тарифы и диагностика сохраняются событиями OpenMeter, ClickHouse хранит их
агрегаты. PostgreSQL самого OpenMeter хранит каталог и финансовые сущности.

`includedQuantity` транслируется в native graduated price месячного charge:
первые N единиц стоят ноль, остальные — по указанной цене. Период общий для
project+family+rateKey+unit. Фильтры отчёта применяются после распределения
месячной стоимости, поэтому просмотр отдельного бакета или метки не выдаёт
включённый объём повторно. Смену цены с includedPeriod планируйте на границу
UTC-месяца: изменение внутри существующего charge отклоняется.

При миграции сохраняется остаток лимита первого частичного месяца; повторный
запуск/обновление не обнуляет расход. Месячный отчёт использует агрегаты
OpenMeter, точные границы неполных минут и трафик — raw events. Большой запрос
сверх лимита завершается ошибкой; выберите более короткий период.

TariffPlan/ProjectTariffPlan синхронизируются в Plans/Features/Meters OpenMeter.
Назначение проекта управляется ProjectSubscription и создаёт native Subscription.
Начиная с CostConfiguration.subscriptionsFrom рабочий план определяется её фазой,
а Charges поддерживает OpenMeter. Исторический выбор до границы сохраняется.
Полный контракт: [ProjectSubscription](../billing/subscriptions.md).

Адаптер метрик входит в Gator Cost: он читает стандартный Prometheus HTTP API
и формирует CloudEvents по MetricMeteringPolicy. Отдельный штатный collector
OpenMeter в этой поставке не используется. Datasource может быть VictoriaMetrics
или другой совместимый сервер; цены и включённый порог применяет OpenMeter.

Полный контракт CRD и сценарии без консоли: [GVK и OpenMeter](../billing/index.md).
