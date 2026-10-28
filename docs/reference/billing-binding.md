# BillingBinding: стоимость заказа

`dashboard.gatorstack.dev/v1alpha1`, Namespaced. Объект находится в namespace
каталога и подключается через `ProductResource.spec.billingBindingRef.name`.
Он связывает форму создания с правилами учёта Gator Cost. Цена, извлечение
величин и названия компонентов задаются манифестами, без изменений консоли.

```yaml
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: BillingBinding
metadata:
  name: database-price
  namespace: gator-dashboard
spec:
  adapterRef: {name: default}
  policyNames: [database-capacity]
  requiredInputs: [/size]
  projectionPaths:
    - /spec/capacity
    - /spec/storageClass
  assumedStatus:
    phase: Ready
  statusMappings: []
  assumptions: Ресурс работает непрерывно. Резервные копии оплачиваются отдельно.
```

В `ProductResource` добавьте:

```yaml
spec:
  billingBindingRef: {name: database-price}
```

| Поле | Значение |
| --- | --- |
| `adapterRef.name` | Имя технического подключения из Helm Dashboard |
| `policyNames` | 1–16 имён активных MeteringPolicy того же GVR |
| `requiredInputs` | JSON Pointer к параметрам формы, необходимым для цены |
| `projectionPaths` | 1–64 разрешённых пути из подготовленного CR; только они передаются адаптеру |
| `assumedStatus` | Предполагаемое будущее состояние для CEL-условий учёта |
| `statusMappings` | Перенос проверенного поля будущего CR в предполагаемый status; пары fromObject/toObject, назначение только /status/... |
| `assumptions` | Явные условия расчёта для пользователя |

Консоль собирает черновик теми же schema/mappings/selections, что используются
при создании. Выбранные объекты повторно читаются с проверкой UID, версии,
проекта, selector и зависимостей. Вычисленные CPU/RAM можно брать из выбранного
каталожного CR. Клиент не передаёт доверенную готовую величину напрямую.
Корневые required-поля формы, не необходимые для цены, могут отсутствовать;
предоставленные значения продолжают проходить валидацию. Пустые строки
не включаются в частичный черновик.

Не включайте в projectionPaths cloud-init, credentials, ключи и весь spec.
Метаданные namespace/uid и GVK задаёт сервер. Предполагаемый status используется
только в прогнозе и не записывается в Kubernetes.

Расчёт поддерживает Create и Action с executor CreateResource: например,
стоимость снимка из выбранного диска. Для действия проверяется исходный UID,
контекст берётся из текущего CR. Остальные действия не получают прогноз автоматически.
Сейчас поддерживаются Namespaced-ресурсы с namespacePolicy CurrentProject,
где billing dimension project совпадает с namespace. Отдельная модель BillingAccount
и привязка к стабильному UID проекта этим механизмом не создаются.

## HTTP-контракт

Dashboard принимает POST `/api/projects/:project/products/:product/pages/:page/estimate`.
Для связанного создания — `/api/projects/:project/products/:product/pages/:page/resources/:name/estimate`.
Тело: `{"input":{...},"minutes":60}`; для действия в input обязателен uid источника.
Нужны обычная сессия Dashboard, CSRF header и create-разрешение на целевой CR.
Чтение каталога и выбранных ресурсов выполняется с правами пользователя.

Технический адаптер принимает POST `/v2/estimate` с отдельным bearer:

```json
{
  "namespace": "team-a",
  "source": {"group": "example.org", "version": "v1", "resource": "databases"},
  "object": {
    "apiVersion": "example.org/v1", "kind": "Database",
    "metadata": {"name": "estimate", "namespace": "team-a", "uid": "estimate"},
    "spec": {"capacity": "4", "storageClass": "fast"},
    "status": {"phase": "Ready"}
  },
  "policyNames": ["database-capacity"],
  "minutes": 60
}
```

Ответ содержит ready, currency, asOf, minutes, totalCost и lines. У каждой строки:
id, title, meter, quantity, quantityUnit, unit, priceKey, price, usage, cost,
tariffID, tariffName, tariffScope. Decimal-значения передаются строками.
Период — 1–44640 минут. Ожидающий выбора ответ Dashboard: ready=false/message;
ошибки источника, полномочий и тарифа не превращаются в бесплатный заказ.

Адаптер использует те же MeteringPolicy и принятые снимки TariffPlan, что и учёт.
Известные границы тарифов в выбранном периоде учитываются отдельными строками.
Деньги рассчитывает штатная invoice simulation OpenMeter. Прогноз не создаёт
исходный CR, ActionInvocation, usage event, charge или invoice. Служебный customer
проекта и billing profile могут быть подготовлены автоматически. Прогноз не
фиксирует цену, не резервирует средства и не блокирует заказ по балансу.
