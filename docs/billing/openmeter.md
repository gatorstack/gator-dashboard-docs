# Объекты и API OpenMeter

Gator Cost 0.8 интегрирован с self-hosted OpenMeter версии `v1.0.0-beta.236`.
Поставка использует совместимый API образ для invoice simulation; формулы цен
и денежное округление выполняются upstream OpenMeter. Не заменяйте отдельный
binary произвольной версией без проверки API/worker совместимости.

## Как сопоставляются модели

| Gator / Kubernetes | Примитив OpenMeter | Для чего |
| --- | --- | --- |
| Project / namespace из политики | Customer с subjectKey проекта | Изоляция usage и начислений |
| ProjectSubscription | Subscription на закреплённой версии Plan | Назначение проекта и календарный цикл |
| Принятый TariffPlan / ProjectTariffPlan | Опубликованная версия Plan и rate cards | Native каталог полного набора ставок |
| Класс и его учётный scope | Feature с meter/group filters | Выбрать нужное количество |
| CloudEvents потребления | Meter | Агрегация raw quantity |
| Unit цена | Unit price usage-based Charge | Оплата количества |
| Месячный включённый объём | Graduated price usage-based Charge | Нулевая первая ступень, далее unit цена |
| Предварительный расчёт | Invoice simulation | Деньги без новых финансовых записей |
| Финансовый документ | Invoice / realization OpenMeter | Отдельный цикл биллинга |

ProjectSubscription создаёт настоящую Subscription на конкретной версии Plan.
Даты и цены её фаз читаются из OpenMeter; billing worker создаёт и поддерживает
native Charges. Сборщик не создаёт отдельный Charge для subscription usage.
Подробнее: [назначения через CRD](subscriptions.md). Invoicing использует Sandbox;
автоматические внешние платежи и prepaid gating не подключены.

## Финансовые сущности

- **Customer** связывает usage subject проекта с финансовыми объектами.
- **BillingProfile** задаёт supplier, workflow, tax/invoicing/payment apps.
  В текущей поставке используется default профиль с Sandbox apps, tax выключен,
  автоматическое продвижение invoices выключено.
- **Charge** хранит feature, цену, service period и invoiceAt; его realizations
  отражают финансовый жизненный цикл.
- **Credits и ledger OpenMeter** включены в конфигурации upstream; создаваемые
  charges используют `settlement_mode: credit_then_invoice`. Политика Gator
  сама по себе не выдаёт кредитный grant и не управляет платежами.
- **Invoice** создаётся финансовым циклом OpenMeter. Разовый simulation response
  не является выпущенным invoice.

Эти сущности хранятся и обслуживаются OpenMeter; Kubernetes CRD не копирует их
второй финансовый ledger. Административные jobs advancement/collection в поставке
запускаются периодически; их состояние проверяется отдельно от collector.

## Meters

| Slug | Aggregation / value | Назначение |
| --- | --- | --- |
| `gc_history_v2` | SUM `$.quantity` | Полный raw объём, включая бесплатную часть и архив |
| `gc_history_billed_v2` | SUM `$.billed_quantity` | Сохранение исторического billable quantity при миграции |
| `gc_billing_v2` | SUM `$.quantity` | Количество для новых финансовых features |
| `gc_control_v2` | COUNT | Тарифные snapshots, issues и архивные metadata |

Usage meters принимают `type: gator.usage.v2`, control — `gator.control.v2`.
Группы: `snapshot`, `kind`, `route`, `epoch`, `tariff`, `product`.
Несколько агрегатов не означают несколько начислений: Feature рабочего Charge
ссылается на `gc_billing_v2` и собственный набор фильтров.

`snapshot` — сериализованная публичная идентичность и тарифный снимок, без
уникальных ID/времени/количества/RV конкретного события. Это позволяет агрегировать
минуты, сохраняя исторические теги, UID, подписи и цену.

## Features и scope начисления

После перехода рабочая Feature выбирает `kind=subscription_usage`, текущий epoch,
route и закреплённый tariff ID. Ключи начинаются с `gcs_`. События старого пути
с `kind=usage` и архива `kind=archive` не совпадают с новыми Features.

`route` выводится из `family + rate.key + unit`. Период Subscription — календарный
месяц UTC с общей месячной ступенью по проекту. Смена назначения с free tier
допускается на границе месяца; перезапуск и фильтр отчёта порог не обнуляют.

Старые отдельные Charges сохраняются для истории: unit — сутки UTC с tariff ID,
included — месяц с общим route. Их unique_reference_id защищает повторное создание
при replay старого pending. В API v3 пагинация — **page[number] / page[size]**.

Не завязывайте внешние интеграции на вычисленные hash-ключи. Используйте metadata,
labels, customer subject, native IDs и GVK source UID/revision.

## Каталог и реальное начисление

Plan публикует полный набор ставок, metadata связывают его с исходным UID,
revision и family. ProjectSubscription закрепляет native plan ID/version.
При переходе в середине месяца Plan может содержать bootstrap-фазу с остатком
включённого объёма, затем обычную фазу со следующего UTC-месяца. Остаток записан
в metadata native Plan; это не второй накопительный ledger.

Например, при уже использованных 10 MB первая фаза имеет unit цену 1 RUB/MB,
следующая — полные 10 MB бесплатно. Цены за единицу не prorate-ятся.

Native Plan active означает публикацию каталога; активность назначения определяется
Subscription. PriceList.Active после subscriptionsFrom отражает фактическое
назначение проекта. Другой действующий каталог может иметь phase=Available.

## CloudEvent потребления

Пример показывает основные поля wire-контракта; фактические ID/route/feature
вычисляет контроллер. `data.record` содержит полный публичный billing snapshot.

```json
{
  "specversion": "1.0",
  "id": "stable-usage-id",
  "source": "gatorcost://main/included",
  "type": "gator.usage.v2",
  "subject": "project-a",
  "time": "2026-11-01T12:00:00Z",
  "data": {
    "quantity": "6",
    "billed_quantity": "6",
    "kind": "subscription_usage",
    "epoch": "openmeter-1",
    "route": "derived-route",
    "tariff": "immutable-selection-id",
    "product": "s3",
    "snapshot": "serialized public billing snapshot",
    "record": {
      "id": "stable-usage-id",
      "kind": "usage",
      "at": "2026-11-01T12:00:00Z",
      "quantity": "6",
      "quality": "Observed",
      "route": "derived-route"
    }
  }
}
```

Это иллюстрация, не шаблон для ручного начисления в рабочий subject. Для сквозного
теста изменяют исходный CR или выполняют реальные операции в отдельном тестовом
проекте. В [примерах](examples.md) показан такой путь через GVK.

### Потоки и поля

| Source suffix | Содержимое |
| --- | --- |
| `/usage` | Новое обычное unit usage |
| `/included` | Полное новое usage с месячным порогом |
| `/archive` | Импортированная история, `kind=archive`, без новых начислений |
| `/control` | Принятие/отзыв плана, issues, архивные metadata |

Subject usage — проект. Служебные snapshots без проекта используют отдельный
customer/subject `gator-control`. Исторический старый event type/source и его
финансовые записи при миграции не изменяются.

`data.record` содержит: ID, kind, at/end, state, immutable selection (`rate`),
quantity, исторический billedQuantity при наличии, quality, counterReset,
признак legacy, reason, native price, periodStart/periodEnd, route, feature,
plan/retired snapshots или архивный JSON. Полный исходный spec CR не сохраняется.

`state` содержит source GVR, namespace, resource name, UID, RV, policy UID/revision,
product/project/instance, meter/measurement/chargeKey, unit/rateKey, количество и
публичные metadata. В отчётах используются точные `record.at` и исторические
snapshots; округлённое время агрегата не заменяет исходную границу измерения.

В новых событиях billed_quantity равен raw quantity. Бесплатная часть не
вычитается сборщиком. В архиве raw и billed могут различаться: это сохраняет
прежние суммы без повторного rating уже выпущенных начислений.

## Две формы graduated price

API v1 catalog/simulation и v3 charges используют разные JSON формы. При 10 MB:

```json
{
  "type": "tiered",
  "mode": "graduated",
  "tiers": [
    {"upToAmount": "10", "unitPrice": {"type": "unit", "amount": "0"}, "flatPrice": null},
    {"unitPrice": {"type": "unit", "amount": "1"}, "flatPrice": null}
  ]
}
```

Эквивалент для v3 Charge:

```json
{
  "type": "graduated",
  "tiers": [
    {"up_to_amount": "10", "unit_price": {"type": "unit", "amount": "0"}},
    {"unit_price": {"type": "unit", "amount": "1"}}
  ]
}
```

Конверсию выполняет адаптер. Не копируйте v1 price прямо в v3 body.

## Чтение API

Откройте административный port-forward в отдельном терминале:

```sh
oc --context "$GATOR_CONTEXT" -n openmeter port-forward \
  svc/openmeter-api 19088:8888 --address=127.0.0.1
```

```sh
curl -fsS 'http://127.0.0.1:19088/api/v1/meters'
curl -fsS 'http://127.0.0.1:19088/api/v1/features?pageSize=100'
curl -fsS 'http://127.0.0.1:19088/api/v1/plans?pageSize=100'
curl -fsS 'http://127.0.0.1:19088/api/v1/customers?pageSize=100'
```

Cursor API событий v2: максимум 100 записей за страницу; продолжайте по
`nextCursor`. Диапазон времени задаётся через `$and`, потому что один узел
фильтра допускает только один оператор:

```sh
curl -fsS --get 'http://127.0.0.1:19088/api/v2/events' \
  --data-urlencode 'limit=100' \
  --data-urlencode 'filter={"type":{"$eq":"gator.usage.v2"},"subject":{"$eq":"project-a"},"time":{"$and":[{"$gte":"2026-11-01T00:00:00Z"},{"$lt":"2026-11-02T00:00:00Z"}]}}'
```

Для charge используйте реальный native customer ID из ответа Customers:

```sh
curl -fsS --get "http://127.0.0.1:19088/api/v3/openmeter/customers/$CUSTOMER_ID/charges" \
  --data-urlencode 'page[number]=1' --data-urlencode 'page[size]=100' \
  --data-urlencode 'expand=real_time_usage'
```

`usage`, `price`, `totals.realtime` позволяют сверить полный измеренный объём
и цену. Соблюдайте native pagination всех list API. Прямое редактирование таблиц
PostgreSQL/ClickHouse не является поддержанным способом настройки Gator Cost.

## Необязательный HTTP прогноз Gator Cost

`POST /v2/estimate` доступен при установленном отдельном forecast credential.
Это служебный API для доверенного клиента, не административный bearer OpenMeter
и не пользовательская Kubernetes аутентификация. Он применяет MeteringPolicy
к переданной публичной проекции и вызывает native invoice simulation.

| Поле запроса | Контракт |
| --- | --- |
| `namespace` | DNS label проекта; должен совпадать с object.metadata.namespace |
| `source` | `group/version/resource` исходного GVR |
| `object` | Публичная проекция черновика с полями, нужными CEL/dimensions/quantity |
| `policyNames` | 1–16 имён совместимых активных MeteringPolicy |
| `minutes` | 1–44640 минут |

Тело ≤256 KiB; допускается до 64 входных измерений. Нужны unit тарифы: прогноз будущего
неизвестного трафика с месячным лимитом этим endpoint не выполняется. Будущие
заранее принятые версии тарифа учитываются на своём интервале.

Пример `estimate.json` для ConfigMap policy из руководства:

```json
{
  "namespace": "billing-lab",
  "source": {"group": "", "version": "v1", "resource": "configmaps"},
  "object": {
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": {
      "name": "forecast",
      "namespace": "billing-lab",
      "uid": "forecast",
      "labels": {"billing.example.org/type": "external-compute"}
    },
    "data": {
      "state": "Running",
      "cpu": "2",
      "cpuClass": "cpu-lab",
      "cpuTitle": "CPU · lab",
      "ram": "2Gi"
    }
  },
  "policyNames": ["billing-example-compute"],
  "minutes": 60
}
```

После внутреннего port-forward Gator Cost API вызов можно выполнить так;
защищённый файл header содержит Authorization для forecast credential:

```sh
curl -fsS 'http://127.0.0.1:19080/v2/estimate' \
  --header @/secure/billing/estimate-header \
  --header 'Content-Type: application/json' --data-binary @estimate.json
```

Ответ содержит `ready/engine/currency/asOf/minutes/totalCost` и `lines[]`.
Строка содержит `id/title/quantityUnit/priceKey/meter/unit/quantity/usage/price/cost`,
`tariffID/tariffName/tariffScope`. Прогноз не создаёт CR заказа, usage, charge или
invoice. Текущий доступ пользователя к namespace и право заказать услугу должен
проверить доверенный вызывающий клиент; сам service credential не является tenant RBAC.
