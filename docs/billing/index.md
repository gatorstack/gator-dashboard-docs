---
slug: /billing
title: Биллинг через GVK и OpenMeter
---

# Gator Cost: GVK и OpenMeter

Это руководство описывает биллинг на уровне Kubernetes API и OpenMeter.
Для его настройки и проверки достаточно `oc`/`kubectl` и API OpenMeter;
пользовательская консоль не требуется. Описана архитектура Gator Cost 0.8.

Gator Cost выбирает внешние ресурсы через GVK, получает количество из полей CR
или метрик, сохраняет курсор и доставляет CloudEvents. OpenMeter хранит историю,
агрегирует потребление, применяет цены и включённые объёмы, ведёт начисления.
Собственной базы `gatorcost` в этой архитектуре нет.

## Граница ответственности

| Задача | Исполнитель |
| --- | --- |
| Какие GVK, namespaces и объекты учитывать | `MeteringPolicy` / `MetricMeteringPolicy`, Gator Cost |
| Условие оплаты, количество, единицы и идентичность заказа | Gator Cost по CRD |
| Чтение Prometheus HTTP API, baseline, reset и интеграл gauge | Собственный адаптер метрик Gator Cost |
| Текущие сессии, точки, неподтверждённые события, единственный writer | `CollectorCheckpoint` и Kubernetes `Lease` |
| История потребления и принятых тарифов | OpenMeter events и ClickHouse |
| Назначение конкретного плана проекту | ProjectSubscription → OpenMeter Subscription |
| Native каталог тарифов | OpenMeter Plans / Features / Meters |
| Начисления, бесплатный месячный порог, округление | OpenMeter usage-based Charges и цены |
| Предварительная детализация | `CostReport`, OpenMeter aggregates/events и invoice simulation |
| Публикация принятых цен для проекта | `PriceList` |

Наши CRD относятся к Gator Cost, а не к Kubernetes operator OpenMeter.
Синхронизация использует API-примитивы OpenMeter.

Рабочий план проекта определяется native Subscription OpenMeter. Управление —
через [ProjectSubscription](subscriptions.md); OpenMeter сам согласует её Charges.
CRD сохраняют декларативную настройку, отдельной базы назначений Gator нет.
До явно установленной границы перехода сохраняется прежний способ выбора.

## Сущности Kubernetes

Все перечисленные custom resources принадлежат группе
`cost.gatorstack.dev`, версия `v1alpha1`. У всех есть `/status` subresource.

| Kind | Resource / scope | Кто создаёт | Назначение |
| --- | --- | --- | --- |
| `CostConfiguration` | `costconfigurations`, Cluster | Администратор | Одна конфигурация с именем `default` |
| `MeteringPolicy` | `meteringpolicies`, Cluster | Администратор | Поля/количество GVK → начатые минуты |
| `MetricMeteringPolicy` | `metricmeteringpolicies`, Cluster | Администратор | Метрики внешнего ресурса → измеренное потребление |
| `TariffPlan` | `tariffplans`, Cluster | Администратор тарифов | Глобальная версия полного семейства ставок |
| `ProjectTariffPlan` | `projecttariffplans`, Namespaced | Администратор тарифов | Полная проектная замена глобального плана |
| `ProjectSubscription` | `projectsubscriptions`, Namespaced | Администратор биллинга | Назначение конкретного плана проекту через OpenMeter |
| `CollectorCheckpoint` | `collectorcheckpoints`, Namespaced | Только контроллер | Текущее состояние и ограниченный pending |
| `PriceList` | `pricelists`, Namespaced | Только контроллер | Проекция принятой цены в проект |
| `CostReport` | `costreports`, Namespaced | Клиент с RBAC | Неизменяемый временный запрос детализации |
| `RateCard` | `ratecards`, Cluster | Только для сопровождения legacy | Архивный контракт, не источник цен native режима |

`Namespace` служит границей проектного отчёта. Сам биллинг не требует отдельного
GVK проекта. Исходный заказ — любой разрешённый политикой ресурс; провайдерский
контроллер создаёт и удаляет его отдельно от Gator Cost.

Дополнительно используются встроенные GVK:
`v1/Namespace` (граница проекта), `coordination.k8s.io/v1/Lease` (один writer),
`v1/Secret` (referenced credentials), стандартные RBAC и workloads. Это не новые
billing CRD. Source GVK провайдера определяется политикой и Kubernetes discovery.

REST collection для Cluster scope:
`/apis/cost.gatorstack.dev/v1alpha1/<resource>`.
Для Namespaced scope:
`/apis/cost.gatorstack.dev/v1alpha1/namespaces/<namespace>/<resource>`.

## Общая форма GVK

`apiVersion` и `kind` определяют схему; REST resource — отдельное plural имя.
`metadata.name` идентифицирует объект, `metadata.namespace` задаётся только для
Namespaced scope. `spec` — желаемое состояние, `/status` записывает контроллер.
`metadata.uid` назначает API server; то же имя после пересоздания имеет другой UID.
`generation` меняется при изменении spec, `status.observedGeneration` показывает,
какую версию обработал контроллер там, где это поле публикуется.
`resourceVersion` служит CAS/watch-курсором, а не временем или номером начисления.

Schema `status` допускает расширение. Наличие поля в status не означает,
что его можно использовать как настройку. Не изменяйте служебные snapshots
через ручной status patch вместо изменения административного spec.

## Термины

- **Продукт** — логический ID сервиса в `dimensions.product`. При использовании
  каталога Gator он совпадает с ID Product, например `iaas` для Compute.
- **Компонент** — позиция тарифа: `cpu-lab`, `cpu-baremetal`, `ram`, `s3-incoming`.
- **Заказ** — исходный ресурс с Kubernetes UID. Пересоздание того же имени даёт
  новую идентичность; исторический расход старого UID сохраняется.
- **Метки** — разрешённые публичные теги заказа, снятые при измерении.
- **Семейство** — стабильный `TariffPlan.spec.key`; версии семейства имеют разные
  имена/UID и периоды действия.
- **Измерение** — строка `meters[]` или `metrics[]` политики.
- **Количество** — core-minute, GB-hour, MB и т. п.; это ещё не денежная сумма.
- **Charge** — native финансовое начисление OpenMeter с периодом и ценой.

## Карта руководства

1. [Архитектура и потоки](architecture.md) — кто читает, пишет и хранит данные.
2. [CostConfiguration](configuration.md) — полный контракт конфигурации.
3. [Политики измерения](metering-policies.md) — все поля CRD, CEL и единицы.
4. [Тарифные планы](tariffs.md) — выбор, замещение, даты, бесплатный объём.
5. [Модель OpenMeter](openmeter.md) — native объекты, события и API.
6. [Состояние, цены и отчёты](state-and-reports.md) — служебные и проектные GVK.
7. [Полные примеры](examples.md) — CR, CPU-классы, S3, override и запрос отчёта.
8. [Эксплуатация и миграция](operations.md) — RBAC, диагностика и восстановление.

Для установки хранилищ и binary workloads используйте
[инструкцию установки](../operator-manual/billing-installation.md).
