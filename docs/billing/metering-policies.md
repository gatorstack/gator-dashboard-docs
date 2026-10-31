# Политики измерения

`MeteringPolicy` и `MetricMeteringPolicy` имеют GVK
`cost.gatorstack.dev/v1alpha1`, Cluster scope. Политика выбирает исходные
ресурсы, а не создаёт их. GVR должен реально обслуживаться Kubernetes API;
ServiceAccount collector получает `get/list/watch` именно этого ресурса.

## Общие поля

| Поле `spec` | Обязательность / тип | Смысл |
| --- | --- | --- |
| `enabled` | Boolean, default `true` | Выключение прекращает новые измерения, история остаётся |
| `source` | Обязательный объект | Точный GVR и селекторы |
| `source.group` | Строка, обязательно; `''` для core | API group источника |
| `source.version` | Непустая строка, обязательно | Одна served версия ресурса |
| `source.resource` | Непустая строка, обязательно | REST plural, например `configmaps`, не Kind |
| `source.scope` | `Namespaced` / `Cluster`, обязательно | Реальный scope GVR |
| `source.namespaces` | Обязательно для Namespaced; запрещено для Cluster | Ровно один способ выбора namespaces |
| `source.namespaces.all` | Только `true` | Все доступные namespaces |
| `source.namespaces.names[]` | Непустой набор строк | Явный список |
| `source.namespaces.selector` | LabelSelector | Выбор по labels Namespace |
| `source.labelSelector` | LabelSelector, необязательно | Выбор самих ресурсов |
| `billableWhen` | Обязательная строка 1–4096 символов | CEL над единственной переменной `object`; результат true разрешает учёт |
| `dimensions` | Обязательный объект | `project`, `product`, `instance` |
| `tariffPlanRef.name` | Обязательно для native mode | **Ключ семейства**, совпадающий с `TariffPlan.spec.key` |
| `reporting` | Необязательно | Публичные metadata snapshots |

LabelSelector содержит `matchLabels` (map строк) и/или `matchExpressions[]`:
`key`, `operator` (`In`, `NotIn`, `Exists`, `DoesNotExist`), `values[]`.
Namespace selector проверяет labels namespace, resource selector — labels заказа.
Используйте одну версию одного ресурса в наборе политик.

### Dimensions и ValueSource

Все три измерения обязательны. У каждого ровно один источник:

| Поле ValueSource | Смысл |
| --- | --- |
| `value` | Непустая строковая константа |
| `fieldPath` | JSON Pointer к строке или числу исходного объекта |
| `fallbackFieldPath` | Необязательный второй Pointer, если основной путь отсутствует |

Fallback не заменяет существующий пустой или ошибочный scalar: он применяется
при ошибке чтения пути. Объект, массив и boolean не являются допустимыми dimensions.
JSON Pointer экранирует `/` как `~1`, `~` как `~0`; массив адресуется индексом.
Например: `/metadata/annotations/cost.gatorstack.dev~1cpu-rate-key`.

Для полной проектной детализации `project` задают через `/metadata/namespace`.
CR policy допускает Cluster source и явный project, но namespaced CostReport
связывает namespace и billing subject: это нужно учитывать при выборе источника.
Metric policy строго требует Namespaced source и именно этот project fieldPath.

### Reporting snapshots

| Поле | Смысл / предел |
| --- | --- |
| `reporting.orderTitlePath` | Pointer к необязательной публичной строке, до 256 символов |
| `reporting.tagsPath` | Pointer к map строк или массиву строк `key=value` |
| `reporting.excludeTagKeys[]` | Исключаемые точные ключи; до 64 элементов |
| `reporting.excludeTagPrefixes[]` | Исключаемые непустые префиксы; до 16 элементов |

Снимок содержит до 64 тегов, ключ ≤128, значение ≤256 символов. Отсутствующее
необязательное поле тегов означает пустой набор. Неверный тип/размер помечается
`Invalid`, без подстановки произвольных данных. Отсутствие `tagsPath` означает,
что снимок меток не собирался. Изменение тегов не переписывает прошлые события.
Не выбирайте credentials или весь spec в качестве публичных metadata.

## Доверие к источнику

Политика учитывает выбранное поле; она не доказывает его соответствие реальному
облачному ресурсу. В рабочей интеграции выбирайте контроллерские status/facts
или проверенные admission/adapter поля. Произвольная редактируемая заказчиком
аннотация не становится фактом выделенных CPU только из-за ссылки в policy.
Провайдер отвечает за соответствие заказа облаку, биллинг — за измерение
объявленного контракта. ConfigMap ниже используется только как воспроизводимая
модель внешнего ресурса.

## MeteringPolicy: Field и Count

Resource: `meteringpolicies`. `meters` — обязательный непустой atomic список:
обновление заменяет список целиком.

| Поле `meters[]` | Обязательность / default | Смысл |
| --- | --- | --- |
| `id` | Необязательно, fallback на `name` | Уникальный ID измерения внутри политики |
| `name` | Обязательно | Логическое имя meter |
| `chargeKey` | Обязательно в CRD | Ключ конфликтов для одного UID и продукта |
| `mode` | `Field` / `Count`, обязательно | Поле количества либо один ресурс |
| `unit` | Обязательно | **Базовая единица**, например `core`, `GiB`; Count требует `resource` |
| `displayName` | Необязательно, ≤256 | Подпись компонента |
| `displayNamePath` | Необязательный JSON Pointer | Публичная динамическая строка; fallback на displayName |
| `displayUnit` | Необязательно, ≤64 | Подпись количества, не pricing unit |
| `quantity` | Обязательно для Field, запрещено для Count | Правило нормализации |
| `quantity.fieldPath` | Обязательно | Pointer к количеству |
| `quantity.format` | `Decimal` / `KubernetesQuantity`, обязательно | Decimal или значения вроде `8Gi`, `500m` |
| `quantity.multiply` | Строка, default `'1'` | Положительный множитель |
| `quantity.divide` | Строка, default `'1'` | Положительный делитель |
| `priceRef.key` | Один из key/fieldPath | Статический ключ ставки |
| `priceRef.fieldPath` | Один из key/fieldPath | Pointer к динамическому классу; требует tariffPlanRef |

В native mode к базовой `unit` добавляется `-minute`: `core` → `core-minute`.
В TariffPlan должна находиться именно полная единица. Не задавайте
`unit: core-minute` в MeteringPolicy: она стала бы `core-minute-minute`.
Count даёт `1 resource-minute` за начатую минуту.

Field нормализуется как `исходное количество × multiply / divide`. Например,
`8Gi` с KubernetesQuantity и divide `1073741824` даёт 8 при базовой единице GiB.
Количество неотрицательное; факторы строго положительные. Отсутствующее поле
не заменяется нулём. `priceRef.fieldPath` выбирает класс из самого CR, без lookup.

### Минута сессии

Сессия начинается при первом наблюдаемом billable состоянии. Каждая начатая
минута учитывается целиком: 20 секунд → одна, 60 секунд → одна, 61 → две минуты.
Границы привязаны к началу сессии, а не к круглым минутам UTC. Количество и
ставка фиксируются на начало минуты. Изменение количества/класса не сбрасывает
начало уже активной сессии. Остановка не возвращает начатую минуту.

Два правила на одинаковый resource UID + product + chargeKey дают Conflict;
спорное измерение приостанавливается. Разные chargeKey разрешены для намеренно
разных составляющих, например CPU и RAM. `includedQuantity` предназначен для
измеряемых метрик: CR minute usage с таким тарифом отклоняется.

`rateCardRef.name` остаётся в schema как альтернатива tariffPlanRef, но относится
к legacy. Native OpenMeter mode требует tariffPlanRef; эти ссылки взаимоисключающие.

### Status

`observedGeneration`, `conditions[type=Ready]`, `message`,
`acceptedPolicyRevision`, `matchedResources`, `billableMeters`, `invalidMeters`,
`conflicts`. Типовые причины: `Watching`, `Disabled`, `SourceUnavailable`,
`InvalidResource`, `Conflict`. Некорректная новая версия может оставить в работе
последнюю принятую конфигурацию; проверяйте observedGeneration и condition,
а не только успешный `oc apply`.

## MetricMeteringPolicy: GaugeIntegral и CounterDelta

Resource: `metricmeteringpolicies`. Общие source/dimensions/reporting/CEL поля
имеют тот же смысл, но runtime требует `source.scope: Namespaced` и
`dimensions.project.fieldPath: /metadata/namespace`, без константы project.
Вместо `meters` используется непустой `metrics`, уникальный по `id`.

| Поле `spec` | Default / runtime предел | Смысл |
| --- | --- | --- |
| `dataSourceRef.name` | Обязательно | Имя из CostConfiguration.metrics |
| `interval` | `30s`; 5s–1h | Период опроса |
| `delay` | `60s`; 0–1h | Насколько конец чтения отстаёт от now |
| `maxSampleAge` | `120s`; 1s–1h | Допустимый возраст/gap samples и ownership witness |
| `maxCatchUp` | `24h`; 1m–7d | Максимальное окно восстановления из TSDB |

| Поле `metrics[]` | Обязательность | Смысл |
| --- | --- | --- |
| `id`, `name` | Обязательны; id уникален | Идентичность измерения |
| `displayName` | Необязательно, ≤256 | Публичная подпись |
| `mode` | Обязательно | `GaugeIntegral` / `CounterDelta` |
| `unit` | Обязательно | **Полная** единица: `GB-hour`, `MB`, без добавления minute |
| `divide` | Обязательная положительная decimal строка | Коэффициент нормализации samples |
| `timeUnit` | Обязательно только для gauge | Положительная duration, например `1h` |
| `priceRef.key` | Обязательно | Статический ключ ставки, dynamic fieldPath здесь не поддержан |
| `selector.metric` | Обязательно | Имя `[a-zA-Z_:][a-zA-Z0-9_:]*` |
| `selector.labels` | Обязательно, 1–32 labels | Map exact equality label → ValueSource |
| `ownership` | Необязательно | Независимый selector с теми же `metric/labels` полями |

В labels ValueSource доступны `value`, `fieldPath`, `fallbackFieldPath` из
заказа. Сборщик безопасно формирует exact selector, не принимает произвольный
PromQL из CR заказа. Используется `/api/v1/query` с range-vector selector,
а не `increase()`/`rate()` с экстраполяцией. Ответ обязан быть полной matrix.

### Формулы количества

- Gauge: `previousValue × (nextTime − previousTime) / timeUnit / divide`.
  Левое значение удерживается до следующего sample; интервал разделяется на
  границах тарифов. Правило начатой минуты к gauge не применяется.
- Counter: `(nextValue − previousValue) / divide`. Если значение уменьшилось,
  принимается `nextValue / divide` и в событии ставится `counterReset: true`.
  Delta относится к правой границе интервала.

Каждый raw label set имеет собственный baseline/курсор. Первая точка не
тарифицируется как lifetime consumption. Новый label set тоже начинает baseline.
Изменение конфигурации meter/query/datasource может создать новый stream;
оно не обнуляет уже использованный месячный порог в OpenMeter.

Gauge должен однозначно определять ряд. Counter может суммировать корректно
разделённые исходные серии, каждая считается отдельно до суммирования. Ownership
требует свежего уникального witness: например, bucket+owner+backend из gauge
перед чтением traffic, где owner отсутствует. Это защищает соответствие метрики
доверенному заказу, не заменяет namespace проверкой labels TSDB.

### Пропуски и пределы

При NaN, infinity, отрицательных значениях, missing/stale/partial/warnings,
неоднозначном witness или gap больше maxSampleAge появляется issue. Неизвестный
участок не начисляется; новый baseline позволяет продолжить последующие данные.
TSDB retention должен превышать maxCatchUp. Удаление заказа прекращает новые
опросы, не удаляя сохранённые usage.

Сетевые запросы: до 4 одновременно, timeout 10s, ответ ≤8 MiB, до 64 серий.
За опрос политика выбирает до 500 заказов; превышение даёт ошибку. Redirects
не принимаются. Коллизии нескольких политик на один заказ/metric id приостанавливают
спорное измерение.

### Status

`observedGeneration`, `collectedMeters`, `invalidMeters`, `lastCollectionTime`,
`conditions[]` с двумя типами:

- `Ready` — конфигурация принята и GVK заказов доступен.
- `DataReady` — полнота текущих измерений; idle bucket без counters может ждать
  baseline при Ready=True и DataReady=False.

Причина `CollectionPending` и сообщение объясняют missing/baseline/stale/identity
ошибку. Это не сообщение о бесплатной услуге и не повод удалять checkpoint.
