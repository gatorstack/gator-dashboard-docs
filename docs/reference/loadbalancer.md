# L4 API

Группа: `loadbalancer.gatorstack.dev/v1alpha1`. Оба ресурса — namespaced XR;
CRD создаются Crossplane XRD, а не отдельным оператором продукта.

## NetworkLoadBalancer

| Поле spec | Значение |
| --- | --- |
| region | Имя проектного ProviderConfig; неизменяемо |
| type | External или Internal; неизменяемо |
| vipSubnet | Ссылка на SubnetV2; неизменяема |
| addressMode | Auto или Reserved; неизменяемо, используется для External |
| reservedAddress | Ссылка на свободный FloatingipV2 из общего Compute списка при Reserved |
| listeners | От 1 до 8 обработчиков |
| description | Описание до 2048 символов |
| tags | До 31 строковой метки |
| deletionProtection | Запрет удаления до явного отключения |

Ссылка содержит `name`, `namespace`, `uid`, `resourceVersion`; форма может
дополнительно передавать `revision` для проверки содержимого справочника.
В Kubernetes API Composition сверяет UID, namespace, регион и Ready.

Обработчик содержит `name`, `protocol` (TCP/UDP), `port`, `targetPort`,
`targetGroup` и `healthCheck`. Имена и пары protocol/port уникальны.
Порты находятся в диапазоне 1–65535; алгоритм ROUND_ROBIN.

`healthCheck`: имя, `type` (HTTP/TCP), `port`, `path`, `timeout`, `interval`,
`healthyThreshold`, `unhealthyThreshold`. Timeout 1–60 секунд, interval 2–300
секунд, timeout меньше interval. Пороги 1–10. HTTP использует GET и ожидает 200;
path начинается с `/`. Для TCP path сохраняется, но не используется.

`status` содержит phase, message, observedGeneration, внешний address,
внутренний vipAddress, externalID Octavia, provisioningStatus, operatingStatus,
checkedAt, listeners, members и условия Crossplane. Состояние отдельных членов
публикуется для каждой пары обработчик/адрес. Источник фактов — read-only
OpenStack observer; Compose обновляет status XR.

`phase` отражает результат настройки заказа:

| Значение | Статус в консоли | Значение |
| --- | --- | --- |
| Pending | Создаётся | Ресурсы или их изменения ещё согласуются |
| Ready | Активен | Конфигурация применена независимо от доступности целей |
| Error | Ошибка настройки | Ошибка provider или актуальный provisioningStatus=ERROR |

`operatingStatus` и `members[].status` — отдельная диагностика здоровья.
ERROR/OFFLINE/DEGRADED backend не меняют Ready на ошибку. Отсутствующее или
просроченное наблюдение отображается как UNKNOWN. Условия XR Ready и
observedGeneration относятся к применению текущей конфигурации.

## TargetGroup

| Поле spec | Значение |
| --- | --- |
| region | Регион; неизменяемо |
| targets | От 1 до 32 уникальных IPv4-адресов с `subnet` ссылкой |
| description, tags | Описание и метки |
| deletionProtection | Защита от удаления |

Каждый target содержит `address` и pinned ссылку `subnet`. Подсети должны
принадлежать тому же проекту и региону. `status.targets` содержит проверенные
address, subnetID, subnetName и subnetUID. Ready группы означает проверку ссылок
и адресации; сетевой health проверяется балансировщиком.

## Общие внешние адреса

L4 использует существующий
`networking.openstack.m.crossplane.io/v1alpha1 / FloatingipV2` из общего списка
Compute с label `iaas.gatorstack.dev/managed=true`. Отдельного address XR или
списка L4 нет. Автоматический адрес получает тот же label и виден в Compute.

Выбранный общий адрес должен исключать `LateInitialize` из managementPolicies
и быть отвязан от других интерфейсов. Ссылка и внешний адрес не передаются
другому владельцу. Association использует единый с VPC/Compute Kubernetes слот;
одновременное назначение одному адресу двух потребителей даёт конфликт ownership.
Удаление использующего XR снимает ассоциацию и сохраняет выбранный общий адрес.

Установка и сценарии: [руководство L4](../operator-manual/loadbalancer.md).


## Журнал состояний

При `logging.enabled=true` LogSource `loadbalancer` использует фиксированный
`gator_source=octavia-l4`. ProductResource связывает журнал с NetworkLoadBalancer
по `resource_uid=/metadata/uid`. События `load_balancer_state` и `target_state`
содержат `operating_status`, `provisioning_status`, `region`, `loadbalancer`,
`resource_uid`, `target_uid`, `_time`. Project UID служит маршрутизации ingestion;
он не принимается из браузера. Доступ — общая проектная роль `logging.viewer`.
