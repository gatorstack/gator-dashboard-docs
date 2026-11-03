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
| securityGroups | Необязательные pinned ссылки на 0–5 SecgroupV2 того же проекта/региона; редактируются |
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
внутренний vipAddress, externalID Octavia, metricsEndpoint, listeners,
members и условия Crossplane. `members` — конфигурация целей: listener,
address, port, protocol, id (UUID MemberV2), poolID. Health в status XR не
публикуется; старые operatingStatus/provisioningStatus/checkedAt очищаются.

| phase | Статус в консоли | Значение |
| --- | --- | --- |
| Pending | Создаётся | Конфигурация ещё согласуется |
| Ready | Активен | Конфигурация применена независимо от доступности целей |
| Error | Ошибка настройки | Ошибка согласования provider |

Табличная секция GVK запрашивает `octavia_member_status` через gateway проекта
и сопоставляет серии с members по UUID. Свежесть — до 90 секунд. Для TCP
показывается доступность, для UDP и отсутствующих метрик — **Нет данных**.
Отсутствие мониторинга не меняет статус заказа.

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


## Архив журналов состояний

При `logging.enabled=true` сохранён LogSource `loadbalancer` с фильтром
`gator_source=octavia-l4`. ProductResource связывает прежние записи с заказом
по `resource_uid=/metadata/uid`. Доступ — проектная роль `logging.viewer`.
Новые события состояния не записываются: актуальное здоровье читается из метрик.


`securityGroups` использует обычный формат ссылки name/namespace/uid/resourceVersion.
Дубли UID и служебные группы не допускаются. `status.securityGroups` содержит
выбранные name, uid, cloud id; `securityGroupsManaged` отмечает включённое ранее
декларативное применение SG и сохраняется после возврата к автоматическим правилам. Пустой список возвращает автоматические SG.
Выбранные SG защищены Usage, пока используются балансировщиком.

Применение использует native Octavia `vip_sg_ids`, а не одноимённое старое поле
Neutron VIP-порта provider-openstack. Stock AnsibleRun выполняется через Object
bridge; primary API остаётся одним NetworkLoadBalancer XR.
