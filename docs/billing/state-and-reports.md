# CollectorCheckpoint, PriceList и CostReport

Эти GVK принадлежат `cost.gatorstack.dev/v1alpha1`, Namespaced scope.
Checkpoint — служебное состояние; PriceList — производная проекция; CostReport —
клиентский запрос. Они имеют разные права записи и разный жизненный цикл.

## CollectorCheckpoint

Resource `collectorcheckpoints`, размещение — только `systemNamespace`.
Создаёт и меняет контроллер. У `spec` два обязательных поля:

| Поле | Смысл |
| --- | --- |
| `key` | Служебный ключ ресурса/stream/configuration |
| `kind` | `resource`, `metric`, `source`, `policy`, `control`, `issue`, `migration` |

`spec` неизменяем. Имя и labels вычисляет контроллер; не создавайте checkpoint
вручную для подключения нового meter. Подключение задаётся политикой.

Status schema расширяемая. Текущий контракт:

| Поле `status` | Содержимое |
| --- | --- |
| `kind`, `key` | Идентичность записи |
| `source`, `resourceVersion` | Последний источник и RV |
| `order` | Текущая публичная идентичность metric-заказа |
| `sessions` | Map series key → `id/start/next/state` активных CR-сессий |
| `points` | Map raw series key → `at/value` последней точки |
| `pending` | Ограниченный список неподтверждённых billing/control records |
| `policy` | Последняя принятая policy-конфигурация |
| `health` | `source/lastSeen/connected/error/resourceVersion` |
| `plans` | Последние принятые конфигурации планов по UID для проверки изменений |
| `migration` | Проверенный одноразовый marker миграции |

Формат pending record описан в [wire-контракте](openmeter.md#cloudevent-потребления).
`migration` содержит cutoverAt, sourceHash, archiveCount, baselineCosts, verified,
verifiedAt, activeResources, metricStreams. Это контрольная сумма/граница переноса,
не ещё одна история потребления.

Status ограничен 650 KB, pending — 256 событиями на объект. После доставки записи
удаляются; пустые issue и закрытые resource checkpoints очищаются. Metric cursors
могут оставаться после удаления заказа. Поэтому checkpoint — не отчёт и не ledger.

Не выдавайте tenant read/write к служебным checkpoints и Lease. Их удаление
может сбросить baseline, следующий интервал или очередь доставки. Простое
восстановление старого checkpoint без сверки OpenMeter может повторить события.

## PriceList

Resource `pricelists`. Контроллер создаёт его в namespaces из `pricing.projects`
по принятым snapshots. Клиентам достаточно `get/list/watch`.

| Поле `spec` | Контракт |
| --- | --- |
| `sourceUID` | Обязательный UID исходного tariff CR |
| `revision` | Обязательная версия принятого снимка |

Оба поля неизменяемы. В status:

| Поле | Смысл |
| --- | --- |
| `sourceUID`, `revision`, `sourceName` | Источник и версия |
| `title`, `family`, `scope` | Подпись, семейство, `Global` / `Project` |
| `phase` | `Scheduled`, `Active`, `Overridden`, `Expired`, `Withdrawn`, `Conflict` |
| `currency`, `validFrom`, `validUntil` | Цена действует в этих границах; конец может учитывать отзыв |
| `rates[]` | `key/product/title/unit/price/includedQuantity/includedPeriod/conditions` |
| `contentHash`, `updatedAt` | Контроль версии производной проекции |
| `conditions` | Ready/Published и время обновления |

`Overridden` — глобальный план сейчас заменён проектным. `Withdrawn` — будущая
версия отозвана до старта. `Conflict` — несколько подходящих активных версий.
Если `unitTitle` настроен, `rates.unit` является публичной подписью единицы;
для программного выбора ставки используйте исходный TariffPlan unit.

Удаление PriceList не изменяет тариф: контроллер восстановит проекцию, пока
сохраняется её экспорт. Удаление экспорта не удаляет принятую историю OpenMeter.

## CostReport

Resource `costreports`. Namespace запроса — billing subject. Спецификация
неизменяема: для другого фильтра/страницы создают новый CR. Контроллер удаляет
запрос через час после creationTimestamp; исходная история остаётся.

| Поле `spec` | Контракт |
| --- | --- |
| `start`, `end` | Обязательные RFC3339 datetime, диапазон `[start,end)`, не больше 31 дня |
| `resolution` | `DAY` по умолчанию или `HOUR` |
| `groupBy` | `product` по умолчанию; также `component`, `tag`, `order` |
| `product` | Необязательный ID продукта, ≤128 символов |
| `component` | Необязательный ключ класса, ≤128 |
| `tagKey` | Необязательный ключ метки, ≤128 |
| `tagValue` | Необязательное значение, ≤256; требует tagKey |
| `orderUID` | Необязательный UID, ≤128 |
| `page` | Integer 1–10000, default 1 |
| `pageSize` | Integer 1–100, default 25 |

Период должен быть прошедшим; runtime допускает минутный запас для рассинхронизации
часов. Выбор произвольного чужого projectID в spec не предусмотрен.

### Status и result

`status.phase`: `Ready` / `Failed`; `observedGeneration`, `asOf`, `expiresAt`,
`conditions[type=Ready]`. При временной недоступности расчёт повторяется.
Ошибка `CalculationUnavailable` не означает нулевую стоимость.

| Поле `status.result` | Содержимое |
| --- | --- |
| `currency`, `asOf`, `start`, `end` | Валюта и границы снимка |
| `totalCost`, `estimatedCost` | Decimal-строки денег OpenMeter |
| `rows[]` | Полная строка группировки на выбранной странице |
| `series[]`, `points[]` | Ряды и временные точки всего результата |
| `tagKeys`, `products`, `components` | Доступные ключи/разрезы |
| `totalRows`, `page`, `pageSize` | Пагинация |
| `pendingMinutes` | Есть ещё не доставленная часть |
| `issueCount` | Ошибки/неполнота измерения |
| `legacyTagMinutes`, `invalidTagMinutes` | Признаки ограничений исторических меток |
| `complete` | Нет issue и pending в результате |

Строка `rows[]`: `id/key/title`, `product/component/unit/usage/price`,
`cost/estimatedCost`, `orders`, `orderUID/orderName/source/exists`.
`usage` — количество, `cost` — деньги. Разные единицы не суммируются в одну.
`exists` относится к текущему наличию того же UID и не удаляет старый расход.

`series[]` содержит `id/title/product/cost`. `points[]` содержит `time` и map
`values: seriesID → decimal cost`. Итог и график учитывают все страницы;
восемь крупнейших групп могут дополняться «Остальным».

Отчёт читает агрегаты OpenMeter для unit usage, точные краевые минуты — raw API.
Месячный трафик распределяется из общих upstream totals до фильтров.
Ограничения: 12 000 агрегатов, до 100 000 raw событий трафика, время расчёта
до двух минут. Превышение даёт ошибку, а не частичный денежный итог.

Пример GVK-запроса и проверки Ready: [полные примеры](examples.md#запрос-детализации).
