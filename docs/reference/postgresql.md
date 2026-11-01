# PostgreSQL GVK

Группа `postgresql.gatorstack.dev/v1alpha1`, все объекты namespaced.

| Kind | Назначение | Изменение |
| --- | --- | --- |
| PostgreSQLCluster | Заказ single-node либо Patroni | Создание, защита удаления и метки |
| PostgreSQLUser | Роль PostgreSQL, сгенерированный пароль и лимит подключений | Создание/удаление; connectionLimit через API |
| PostgreSQLDatabase | База данных и владелец в выбранном кластере | Создание/удаление |
| PostgreSQLOperation | Однократные restart и switchover | Создание/удаление записи |
| PostgreSQLPlacement | Готовый вариант сети/подсетей, регион и зоны | Только контроллер |
| PostgreSQLClass | Класс ресурсов с vCPU/RAM | Только установочный Helm chart |

`PostgreSQLCluster.spec` содержит `region`, `topology`, `replicas`, `version`,
`resources.class/vcpu/memoryGiB`, `subnets[].name/uid`, `storageGiB`, `storageType`,
`allowedCIDRs`, `maxConnections`, `deletionProtection` и `tags`.
Single-node требует `replicas: 1` и одну подсеть; Patroni — `replicas: 3` и
три подсети одной сети, в разных зонах одного региона. Контроллер повторно
проверяет UID, проект, region и zone исходных CR перед созданием инфраструктуры.

Другие заказные CR ссылаются на кластер через `spec.clusterRef.name/uid`.
`PostgreSQLUser.spec.name` и `PostgreSQLDatabase.spec.name` — имена объектов
внутри PostgreSQL. Database дополнительно содержит `owner`; User —
`connectionLimit`. Operation содержит `type: restart|switchover`.

Status содержит `observedGeneration`, `conditions`, `phase` и безопасное
`message`. У кластера также есть `namespaceUID`, `projectUID`, `hosts[]`,
`configuredHash`, `connectionSecretRef.name`. У пользователя — собственный
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
