# PostgreSQL GVK

Группа `postgresql.gatorstack.dev/v1alpha1`, все объекты namespaced.

| Kind | Назначение | Изменение |
| --- | --- | --- |
| PostgreSQLCluster | Заказ single-node либо Patroni | Создание, защита удаления и метки |
| PostgreSQLUser | Роль PostgreSQL, сгенерированный пароль и лимит подключений | Создание/удаление; connectionLimit через API |
| PostgreSQLDatabase | База данных и владелец в выбранном кластере | Создание/удаление |
| PostgreSQLOperation | Однократные restart и switchover | Создание/удаление записи |
| PostgreSQLPlacement | Прежний каталог готовых размещений; новая форма его не использует | Только контроллер |
| PostgreSQLClass | Класс ресурсов с vCPU/RAM | Только установочный Helm chart |

`PostgreSQLCluster.spec` содержит общие `region`, `topology`, `replicas`,
`version`, `resources.class/vcpu/memoryGiB`, необязательный `resources.flavorID`, `storageGiB`, `storageType`,
`allowedCIDRs`, `maxConnections`, `deletionProtection` и `tags`.

Новый ручной заказ задаёт `networkRef.name/uid` и `hosts[]`:

| Поле хоста | Значение |
| --- | --- |
| `zone` | Зона выбранного региона |
| `subnet.name/uid` | Закреплённая identity проектной подсети |
| `publicAccess` | Разрешить PostgreSQL через внешний адрес хоста с учётом клиентских CIDR |
| `primaryPriority` | Целое 0–100; больший приоритет предпочитается среди допустимых кандидатов |

Single-node требует `replicas: 1` и один хост; Patroni — `replicas: 3` и три
хоста с разными зонами и UID подсетей. Все подсети принадлежат выбранной сети,
региону и проекту. Контроллер повторно проверяет реальные исходные CR до создания
инфраструктуры. Набор хостов и модель размещения неизменяемы после создания.

Legacy-заказы со `subnets[].name/uid` продолжают работать без миграции. Одновременно
задавать `hosts` и `subnets` запрещено. Новые параметры не добавляются в прежние
заказы автоматически. Форма предлагает опубликованные готовые FlavorV2 выбранного
региона из общего каталога. В resources.flavorID попадает реальный ID выбранного
флейвора, vcpu/memoryGiB берутся из его характеристик, а class определяется
профилем установки. Эти поля неизменяемы. Для kubectl-заказа class, ID и количества
должны соответствовать одному разрешённому региональному флейвору; прежние
заказы без flavorID сохраняют закреплённый профиль.

Другие заказные CR ссылаются на кластер через `spec.clusterRef.name/uid`.
`PostgreSQLUser.spec.name` и `PostgreSQLDatabase.spec.name` — имена объектов
внутри PostgreSQL. Database дополнительно содержит `owner`; User —
`connectionLimit`. Operation содержит `type: restart|switchover`.

Status содержит `observedGeneration`, `conditions`, `phase` и безопасное
`message`. У кластера также есть `namespaceUID`, `projectUID`, `hosts[]`,
`configuredHash`, `connectionSecretRef.name` и `endpoint.address`,
`endpoint.port` и UID-pinned `endpoint.loadBalancerRef`. У пользователя — собственный
`connectionSecretRef.name`. Пароли и приватные ключи отсутствуют в spec/status.

`PostgreSQLPlacement.spec` объявляет title/description, region, topology,
replicas и pinned subnets; `PostgreSQLClass.spec` — title и resources.
Их чтение не разрешает менять размещение или ресурсы существующего заказа.

Квоты считают количество CR и суммы `replicas`, `replicas * resources.vcpu`,
`replicas * resources.memoryGiB`, `replicas * storageGiB`. MeteringPolicy имеет
раздельные условия single-node/Patroni и множители 1/3. Цены и назначения
задаются TariffPlan/ProjectSubscription; underlying VM не учитываются как
отдельный Compute-заказ проекта.


Начиная с 0.2 `PostgreSQLCluster` — namespaced XR Crossplane с enforced Composition
`gator-postgresql`. `spec.crossplane` содержит служебные binding/resource references
и не является пользовательской настройкой PostgreSQL. `PostgreSQLRuntime` —
обычный private composed CR с UID-bound `clusterRef`, plan/artifact refs и health
conditions; продуктовые роли не предоставляют к нему доступ. Namespaced Object
мосты и Usage описывают инфраструктуру и порядок её удаления. Служебные пароли,
SSH private keys и cloud credentials не входят в их manifests/status.

Для Patroni Composition также создаёт NetworkLoadBalancer и TargetGroup группы
`loadbalancer.gatorstack.dev/v1alpha1`. Обработчик TCP 5432 использует HTTPS
`/primary:8008`, expected 200, interval 5 с, timeout 3 с, thresholds 2.
VIP — первая выбранная подсеть, внешний адрес — Auto. Оба ресурса и проектные
Observe-only InstanceV2 имеют `dashboard.gatorstack.dev/managed: "true"` и
controller ownerReference на заказ. Управление облачными VM/дисками остаётся у
protected MR. InstanceV2-проекции имеют `managementPolicies: [Observe]`,
политику удаления без Delete и точную external identity; их метка
`postgresql.gatorstack.dev/inventory` защищена admission и исключается из
Compute-квот окружения. MeteringPolicy Compute исключает Observe-only ресурсы.
