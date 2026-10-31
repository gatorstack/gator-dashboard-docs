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

Проверьте conditions и observedGeneration, затем UI «Источники CR»,
«Минутный журнал» и «Потребление». Для 2 CPU за одну начатую минуту ожидается
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
Возраст оценки виден в UI. Отсутствующее поле, конфликт и отсутствие ставки
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
