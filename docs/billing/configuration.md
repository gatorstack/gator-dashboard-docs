# CostConfiguration

GVK: `cost.gatorstack.dev/v1alpha1`, Kind `CostConfiguration`, Cluster scope,
resource `costconfigurations`. Контроллер читает только объект `default`.

В таблицах «обязательное» означает требование structural schema, если не
оговорено runtime-правило. Длительности используют формат Go duration: `15s`,
`30m`, `24h`. Decimal и денежные значения передаются строками.

## Режим и идентичность

| Поле `spec` | Тип / обязательность | Смысл |
| --- | --- | --- |
| `clusterID` | Непустая строка, обязательно | Стабильная идентичность кластера; выбирайте DNS-совместимое имя до 63 символов, оно используется также в labels |
| `systemNamespace` | Непустая строка, обязательно | Namespace checkpoints, Lease и служебных Secret refs; должен соответствовать namespace установки и RBAC |
| `currency` | `RUB`, обязательно | Единственная валюта текущего CRD |
| `storageMode` | `OpenMeter` / `LegacyPostgreSQL` | Для новой архитектуры явно `OpenMeter`; отсутствие поля включает legacy путь |
| `epoch` | Непустая строка | Обязателен в OpenMeter mode; отделяет native поток от архива, не меняется при upgrade |
| `cutoverAt` | RFC3339 datetime | Фиксируется миграцией; это не команда на повторную отправку |
| `openMeter` | Объект | В native mode требуется `enabled: true` |
| `openMeter.enabled` | Boolean, обязательно внутри объекта | Включение OpenMeter |
| `openMeter.url` | Непустая строка, обязательно | Базовый внутренний API URL без `/api/v1` |
| `openMeter.workerInterval` | Строка, schema default `1s` | Legacy настройка worker; native loop сейчас фиксирован на 1 секунду |
| `openMeter.batchSize` | Integer 1–1000, schema default 32 | Legacy настройка; native доставка обрабатывает до 64 pending на checkpoint за проход |

После перехода на OpenMeter CEL-валидация запрещает изменение режима, `epoch`,
`clusterID` и `systemNamespace`. Установленный `cutoverAt` также неизменяем.
`openMeter.enabled: true` само по себе не отключает старую БД: нужен `storageMode`.

## Наблюдение и вычисление

| Поле | Тип / default | Смысл |
| --- | --- | --- |
| `accounting` | Обязательный объект | Контракт наблюдений CR |
| `accounting.gapPolicy` | `LastKnown`, обязательно | Использовать последнее известное состояние при пропуске наблюдения |
| `accounting.heartbeatInterval` | Duration, default `15s` | Интервал контроля list/watch |
| `accounting.staleAfter` | Duration, default `45s` | Порог устаревания source health для оценки |
| `accounting.maxEstimateAge` | `Unlimited`, обязательно | Нет автоматического обнуления из-за возраста LastKnown |
| `accounting.conflictPolicy` | `Suspend`, обязательно | Спорные измерения при пересечении правил приостанавливаются |
| `accounting.initialObservation` | `StartNow`, обязательно | Уже существующий CR не получает расход до первого наблюдения |
| `evaluation.celCostLimit` | Integer 1–1 000 000, обязательно; default 100000 | Лимит вычисления CEL `billableWhen` |

LastKnown не восстанавливает промежуточные изменения, произошедшие во время
отсутствия наблюдений. Для метрик действуют отдельные `maxSampleAge/maxCatchUp`
из MetricMeteringPolicy; неизвестный участок не превращается в наблюдённый ноль.

## Источники метрик

`metrics[]` — необязательный список, уникальный по `name`. Если задан, он непустой.

| Поле элемента | Тип | Смысл |
| --- | --- | --- |
| `name` | Непустая строка, обязательно | Ключ для `MetricMeteringPolicy.dataSourceRef.name` |
| `url` | Непустая строка, обязательно | База Prometheus HTTP API, включая tenant path при необходимости |
| `bearerTokenSecretRef` | Secret reference | Необязательный bearer для чтения API |
| `bearerTokenSecretRef.namespace` | Строка | По умолчанию `systemNamespace` |
| `bearerTokenSecretRef.name` | Непустая строка, обязательно | Имя Secret |
| `bearerTokenSecretRef.key` | Непустая строка, обязательно | Ключ данных Secret |

URL должен быть HTTP(S), без userinfo, query и fragment. Secret ref не выдаёт
RBAC автоматически: ServiceAccount нужен явный `get` соответствующего Secret.
Политика ссылается на уникальное имя источника, заказ не передаёт URL или PromQL.

## Публикация цен

`pricing` необязателен; без него PriceList не публикуются. Если задан, нужны
оба непустых списка `projects` и `families`.

| Поле | Обязательность | Смысл |
| --- | --- | --- |
| `pricing.projects[].namespace` | Обязательно, уникально, DNS label ≤63 | Namespace проектной витрины |
| `pricing.projects[].projectID` | Обязательно | Billing subject; для проектных отчётов используйте тот же namespace |
| `pricing.families[].key` | Обязательно, уникально | Семейство `TariffPlan.spec.key` |
| `pricing.families[].title` | Необязательно | Подпись семейства по умолчанию |
| `pricing.families[].rates[]` | Непустой список, уникально по key | Публичные подписи классов |
| `rates[].key` | Обязательно | Ключ ставки из полного плана |
| `rates[].product` | Обязательно | Логический ID продукта |
| `rates[].title` | Обязательно | Подпись класса |
| `rates[].unitTitle` | Необязательно | Отображаемая единица; не меняет pricing unit |

Эти метаданные не задают цены, объём или принадлежность фактического usage к
продукту. Цены берутся из принятых тарифов, `product` usage — из политики.
Поддерживайте согласованность двух настроек.

## Поля совместимости

Schema пока требует `reporting.api` и `reporting.ui`, даже в native mode.
Это совместимость формы конфигурации, а не отдельное хранилище или admin UI.

| Поле | Контракт / поведение |
| --- | --- |
| `reporting.api.url` | Обязательная строка; legacy API/proxy URL |
| `reporting.api.authTokenSecretRef` | Обязательный Secret reference (`namespace?`, `name`, `key`); native runtime не читает этот admin token |
| `reporting.ui.currencySource` | Обязательно `CostConfiguration` |
| `reporting.ui.showEstimates` | Обязательно `true` |
| `reporting.ui.showCoverage` | Обязательно `true` |
| `reporting.openCost.url` | Legacy OpenCost endpoint, native не используется |
| `reporting.openCost.adminTokenSecretRef` | Legacy Secret reference, native не используется |
| `reporting.openCost.refreshInterval` | Legacy duration, default `1m` |
| `ledger.postgresql.connectionSecretRef` | Legacy writer DSN reference, native не используется |
| `ledger.postgresql.readerConnectionSecretRef` | Legacy reader DSN reference, native не используется |
| `ledger.retention` | Legacy `KeepAll` |

У всех Secret refs одинаковые поля: `namespace` необязателен, `name/key` обязательны.
В OpenMeter mode `ledger` удаляют; мигратору до переключения нужен старый DSN ref.
Credential для HTTP прогноза — отдельный mounted Secret установки, не этот admin token.

## Status

`observedGeneration`, `conditions[]` (`type/status/reason/message/observedGeneration/
lastTransitionTime`), `message`, `clusterID`, `currency`, `watcherCount` показывают
результат конфигурации и наблюдений. Schema разрешает расширение status.
В сообщениях совместимости может встречаться слово Ledger; оно не доказывает,
что native runtime использует PostgreSQL Gator Cost.

## Схема установленного API

Для просмотра точной structural schema своего выпуска:

```sh
oc --context "$GATOR_CONTEXT" explain costconfiguration.spec --recursive
oc --context "$GATOR_CONTEXT" get crd costconfigurations.cost.gatorstack.dev \
  -o jsonpath='{.spec.versions[?(@.name=="v1alpha1")].schema.openAPIV3Schema.properties.spec}'
```

Для остальных Kind замените resource/имя CRD по [каталогу GVK](index.md#сущности-kubernetes).
Schema показывает admission-ограничения, runtime-ограничения приведены отдельно
в этом руководстве. Произвольные поля status не являются настраиваемым spec.
