# API квот

Все CRD: `quotas.gatorstack.dev/v1alpha1`.

| Kind | Scope | Поля |
| --- | --- | --- |
| ClusterQuotaTemplate | Cluster | spec.namespaceSelector; spec.quotaSpec.rules |
| Quota | Namespaced | spec.rules; status — план/факт |
| QuotaLedger | Namespaced | spec.reservations; служебный CAS журнал |

В `rules` от 1 до 32 записей. Обязательны уникальное `name`, `apiVersion`,
`kind`, `expression`, `hard` (строка), `message`. Необязательный `selector` —
обычный Kubernetes LabelSelector по объекту. namespaceSelector шаблона использует
такой же формат. Правила объединяются через AND. Одна и та же ёмкость может
сознательно ограничиваться несколькими правилами; их hard не складываются.

```yaml
apiVersion: quotas.gatorstack.dev/v1alpha1
kind: Quota
metadata:
  name: compute
  namespace: project-a
spec:
  rules:
    - name: cpu
      apiVersion: platform.example.org/v1
      kind: VirtualMachine
      expression: sum(.spec.cpu.count)
      hard: '100'
      message: Превышен лимит CPU
    - name: replicas-cpu
      apiVersion: apps.example.org/v1
      kind: WorkerPool
      expression: sum(.spec.replicas * .spec.cpu)
      hard: '64'
      message: Превышен лимит CPU worker pools
```

Выражение применяется к каждому выбранному объекту, затем вклады складываются.
`count(.)` даёт 1 на объект. `sum(.spec.path)` читает числовое поле.
`sum(count(.data) + count(.binaryData))` суммирует количество ключей двух map.
`count(path)` внутри sum считает ключи map или элементы массива. Отсутствующая
или null коллекция даёт 0; scalar и путь через scalar дают ошибку. Значения
ключей не влияют на количество; подсчёт не рекурсивный. Пустая строка — тоже ключ.

Внутри sum допустимы `+` и `*`; умножение выполняется первым. Максимум 8
слагаемых, 8 множителей на слагаемое, 32 операнда и 512 символов. Пути могут
читать поля вне spec, например data/binaryData. Из metadata доступны только
labels/annotations. Путь состоит из dot segments, без индексов массива и
экранирования ключей с точкой. Скрипты, CEL, jq, деление, скобки группировки,
includeWhen, status/apiVersion/kind и внешние lookup не поддерживаются.
Это намеренно ограниченный язык, валидируемый до применения политики.

Целые, decimal и строковые Kubernetes Quantity неотрицательны. Plain decimal
суммируется точно; Quantity использует семантику Kubernetes ParseQuantity
(включая нормализацию до nano precision). `500m` = 0.5 base unit CPU,
`512Mi` = 536870912 base units/bytes. Hard использует те же единицы: для памяти
можно написать `1Gi`, status покажет `1073741824`. `1024` как MiB — только если
само поле измеряется в MiB, тогда hard тоже задаётся в MiB. Не смешивайте единицы
разных полей. Для числовых операндов NaN/Infinity/negative/null/missing/object/
boolean дают ошибку; нулевое значение отсутствующей коллекции разрешено только
для явного `count(path)`.

`status.hard/used/reserved/available/overage` — map string→decimal string по
имени правила. `observedGeneration`, `lastCalculatedTime`, conditions Ready
и OverLimit позволяют отличить текущий факт от последнего известного.
`available=max(0,hard-used-reserved)`, `overage=max(0,used+reserved-hard)`.
Status не является механизмом блокировки или обещанием остатка для preview.

Аннотации namespace:

| Аннотация | Действие |
| --- | --- |
| quotas.gatorstack.dev/use-quotas: 'true' | Включить copy-once |
| quotas.gatorstack.dev/quota-copied: 'true' | Копирование завершено; повтор не нужен |

Quota хранит template-uid/template-generation только как происхождение копии.
Удаление template не удаляет Quota; изменение template не переписывает её.
Quota, созданная вручную, действует независимо от namespace annotations.

Записи через другую served API version отклоняются для покрытого source GVR:
используйте apiVersion правила. Для field quota scale/Pod resize subresources
отклоняются; меняйте основной CR. Count-only квота допускает scale/resize.
Status subresource не перехватывается и не может использоваться в формуле.

## Группа, показатель и региональные выражения

| Поле | Значение |
| --- | --- |
| spec.group | Название группы в списке, до 128 символов |
| rules[].title | Название показателя, до 256 символов |
| rules[].metric | Общий ID строки UI; по умолчанию name, до 63 символов |
| rules[].scope | Подпись региона/зоны; пустая означает «Всего», до 128 символов |
| rules[].unit | Единица отображения, до 32 символов; не конвертирует числа |
| rules[].where | До 8 AND условий по полям источника; AND с selector |

Все поля необязательны, прежние manifests совместимы. Правила одного metric
должны иметь одинаковые title и unit, а scope не должен повторяться. Объединение
происходит внутри одного Quota; разные Quota не смешиваются даже при одинаковом
metric. Каждый name остаётся независимым ключом status и атомарного резервирования.

Пример правил для v1/ConfigMap (общий предел и два региональных):

```yaml
apiVersion: quotas.gatorstack.dev/v1alpha1
kind: Quota
metadata:
  name: regional-configmaps
  namespace: project-a
spec:
  group: Kubernetes
  rules:
    - name: total
      metric: configmaps
      title: Количество ConfigMap
      unit: шт.
      apiVersion: v1
      kind: ConfigMap
      expression: count(.)
      hard: '10'
      message: Превышен общий лимит ConfigMap
    - name: msk
      metric: configmaps
      title: Количество ConfigMap
      unit: шт.
      scope: ru-msk
      apiVersion: v1
      kind: ConfigMap
      where:
        - path: .metadata.labels.region
          operator: In
          values: [ru-msk]
      expression: count(.)
      hard: '6'
      message: Превышен лимит ConfigMap в ru-msk
    - name: spb
      metric: configmaps
      title: Количество ConfigMap
      unit: шт.
      scope: ru-spb
      apiVersion: v1
      kind: ConfigMap
      where:
        - path: .metadata.labels.region
          operator: In
          values: [ru-spb]
      expression: count(.)
      hard: '4'
      message: Превышен лимит ConfigMap в ru-spb
```

scope — подпись, фильтрацию выполняет where. Каждое правило может использовать
собственные GVK, expression, hard и selector. Общий лимит считается отдельным
выражением без where; UI не складывает пересекающиеся scopes. Для CPU замените
GVK на установленный ресурс и expression на sum нужного числового поля.
В ClusterQuotaTemplate этот же spec находится в spec.quotaSpec.

### Условия where

| operator | Семантика | values |
| --- | --- | --- |
| In | Скалярное значение совпадает хотя бы с одним | 1–32 строки |
| NotIn | Скалярное значение не совпадает ни с одним | 1–32 строки |
| Exists | Поле присутствует и не null | Не задаются |
| DoesNotExist | Поле отсутствует или null | Не задаются |

Пути имеют те же ограничения, что выражения: status и server-owned metadata
недоступны, индексы массивов и ключи с точками не поддерживаются. Числа и boolean
сравниваются в строковом представлении; Quantity не нормализуется для where.
Каждая строка values — до 256 символов. In на missing/null даёт false, NotIn —
true. Для In/NotIn map/array или путь через scalar дают Invalid, не false.
Несколько условий и selector объединяются AND. Дизъюнкция значений одного
поля задаётся несколькими values.

UPDATE проверяет oldObject и новый объект: изменение поля where переносит
вклад между лимитами. Положительный delta резервируется атомарно для всех правил,
уменьшение освобождает ёмкость после записи. Каждый UPDATE основного CR проходит
webhook независимо от caller. Status subresource не участвует в учёте.
