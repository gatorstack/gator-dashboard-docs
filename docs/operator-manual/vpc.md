# VPC: облачные сети и подсети

Продукт Virtual Private Cloud содержит два раздела: **Облачные сети** и
**Подсети**. Сеть объединяет адресные пространства проекта в одном регионе.
Подсеть имеет один IPv4 CIDR и принадлежит одной зоне этого региона. Одна
облачная сеть представлена штатным Crossplane `NetworkV2`, одна подсеть —
`SubnetV2` группы `networking.openstack.m.crossplane.io/v1alpha1`.

## Создать сеть

Откройте проект, выберите Virtual Private Cloud → Облачные сети → Создать.
Укажите имя, регион, необязательные описание и метки. Включённый параметр
**Создать подсети** создаёт по одной подсети в каждой настроенной зоне региона.
В карточке сети дождитесь статуса **Активна**: он учитывает сеть, маршрутизатор,
группу безопасности, подсети и подключения маршрутизатора.

Метки вводятся парами ключ/значение, а сохраняются как строки `key=value`
в native `spec.forProvider.tags`. Столбцы списка, поля карточки, формы и действия
задаются JSON Schema и привязками ProductResource; отдельного интерфейса для
конкретного провайдера в Dashboard нет.

Автоматические подсети создаются один раз. Их последующее переименование,
настройки DHCP/DNS и ручное удаление сохраняются. Контроллер не восстанавливает
удалённую автоматическую подсеть. Другую подсеть можно создать кнопкой
**Создать подсеть** в карточке сети либо из раздела Подсети.

## Создать и изменить подсеть

Выберите регион, зону и готовую облачную сеть этого проекта. Задайте имя,
IPv4 CIDR, DHCP, DNS-серверы и метки. Поставляемая форма принимает диапазоны
от /16 до /28. Диапазоны одной сети не должны пересекаться: Neutron проверяет
адресацию, а ошибка провайдера отображается в диагностике CR.

После создания можно изменить имя, описание, метки, DHCP и DNS-серверы.
CIDR, сеть, регион и зона фиксируются при создании. Для другого диапазона
создайте новую подсеть и перенесите нагрузки. Таблица показывает ID, описание,
IPv4 CIDR, состояние, зону, метки, сеть и регион.

Удаление подсети сначала отключает её от маршрутизатора. Занятую интерфейсами
подсеть Neutron не удалит. Удаление сети удаляет её пустые подсети, маршрутизатор
и группу безопасности; сначала удалите ВМ и интерфейсы этой сети. Finalizers
сохраняются до завершения зависимых операций. Не удаляйте их для обхода ошибки
занятого ресурса.

## Регион и зоны

Регион — подключение `ProviderConfig` к одному Keystone и его региональному
каталогу сервисов. Зоны — настоящие availability zones Nova/Cinder этого
подключения. Например, `ru-msk` содержит `ru-msk-1`, `ru-msk-2`, `ru-msk-3`,
а `ru-spb` — `ru-spb-1`, `ru-spb-2`, `ru-spb-3`.

Публичный справочник зон хранится в ConfigMap namespace каталога. Lookup выбирает
зоны по `data.region`, подсети — по ProviderConfig и аннотации зоны. Общий
справочник не содержит credentials. Отдельные подключения каждого проекта
должны быть ограничены собственным OpenStack project: фильтр формы не заменяет
изоляцию Neutron и Kubernetes RBAC.

## Настроить интеграцию

Нужны namespaced managed resources Crossplane, установленные Product/Resource/Page
манифесты VPC, существующие проекты и отдельные connection Secrets. Дополнительный
контроллер `iaas-vpc-adapter` включается в chart интеграции OpenStack:

```yaml
iaas:
  enabled: true
  clouds: [ru-msk, ru-spb]
  catalogNamespace: gator-iaas-catalog
  projectNamespaces: [my-project]
  catalogReaderSubjects:
    - kind: Group
      apiGroup: rbac.authorization.k8s.io
      name: platform-consumers
  vpc:
    enabled: true
    regions:
      ru-msk:
        region: ru-msk
        zones: [ru-msk-1, ru-msk-2, ru-msk-3]
        externalNetworkID: REPLACE_WITH_NEUTRON_EXTERNAL_NETWORK_UUID
        defaultCIDRs: [10.128.0.0/24, 10.129.0.0/24, 10.130.0.0/24]
        vpnCIDR: 10.66.66.0/24
        dnsServers: [1.1.1.1, 8.8.8.8]
      ru-spb:
        region: ru-spb
        zones: [ru-spb-1, ru-spb-2, ru-spb-3]
        externalNetworkID: REPLACE_WITH_SECOND_REGION_EXTERNAL_NETWORK_UUID
        defaultCIDRs: [10.132.0.0/24, 10.133.0.0/24, 10.134.0.0/24]
        vpnCIDR: 10.66.66.0/24
        dnsServers: [1.1.1.1, 8.8.8.8]
```

До установки замените externalNetworkID реальными UUID внешних сетей. Число
defaultCIDRs должно совпадать с числом зон. Это шаблон адресации отдельных
изолированных сетей; при организации связности между ними согласуйте
непересекающиеся диапазоны. Настройте ProviderConfig и Secret
`openstack-<region>` отдельно в каждом namespace проекта и в каталоге.
Значения credentials не передаются в Helm values.

```sh
helm upgrade --install gator-openstack providers/openstack/chart \
  --kubeconfig "$KUBECONFIG" -n crossplane-system \
  -f openstack-values.yaml --wait
oc --kubeconfig "$KUBECONFIG" -n gator-iaas-catalog get deployment iaas-vpc-adapter
oc --kubeconfig "$KUBECONFIG" -n my-project get networkv2s,subnetv2s,routerv2s,routerinterfacev2s
```

Адаптер обращается только к Kubernetes API и создаёт штатные Network/Subnet/
Router/RouterInterface/Secgroup/SecgroupRule/Port managed resources. Он не читает
connection Secrets и не вызывает OpenStack API. За внешний lifecycle отвечает
Crossplane. Роли адаптера ограничены перечисленными namespace проектов.

Пользовательские роли `vpc.viewer` читают NetworkV2/SubnetV2 проекта, а
`vpc.editor` разрешает их создание, изменение и удаление. Назначения выполняются
обычными RoleBinding. Чтение справочника зон назначается отдельно ролью каталога.

## Интерфейсы ВМ и публичные адреса

В форме IaaS выберите регион, зону и готовую подсеть VPC. Контракт создания
записывает InstanceV2 с UID подсети и начальной паузой Crossplane. Адаптер
проверяет проект, регион, зону и UID, создаёт PortV2 с группой безопасности
сети и затем атомарно снимает начальную паузу, подставляя portRef. Повторный
проход не создаёт другой порт; последующая ручная пауза оператора сохраняется.

На вкладке Сеть откройте интерфейс и нажмите **Добавить публичный IP**.
Доступны только опубликованные провайдерские сети того же региона. Действие
создаёт штатный FloatingipV2 в проекте; адрес отображается после наблюдаемого
назначения порту. В карточке адреса можно отвязать его, назначить другому
свободному интерфейсу проекта или освободить. Внутренний адрес не подставляется
вместо отсутствующего публичного.

Сам адрес хранится в FloatingipV2, а связь с портом — в зависимом штатном
FloatingipAssociateV2. Адаптер закрепляет UID выбранного PortV2 и владельца
связи. Отвязка удаляет только связь и ждёт подтверждения Neutron; адрес остаётся
выделенным. Состояния «Назначается» и «Отвязывается» означают выполнение операции,
а не её завершение. После удаления или замены порта адаптер не переключает
адрес на одноимённый новый ресурс.

В шаблоне FloatingipV2 задаются `managementPolicies: [Create, Observe, Update, Delete]`
без LateInitialize; `spec.forProvider.portId` и `fixedIp` не задаются. Иначе поздняя
инициализация может перенести наблюдаемую привязку в основной CR и заставить
его восстанавливать удалённую связь. Желаемый порт задаётся аннотациями
`vpc.gatorstack.dev/port-name`, `port-uid`, `port-id`, `port-title` через
проверенный lookup. JSON-действия изменяют эти поля; адаптер управляет связью.

Маршруты к provider pool должны существовать на WireGuard gateway и у клиентов
VPN; обратные маршруты и security groups должны разрешать этот трафик. Один
FloatingipV2 не создаёт маршрутизацию за пределами Neutron автоматически.
По умолчанию адаптер добавляет доступ внутри группы безопасности сети и
входящий доступ из настроенного vpnCIDR. Публичный доступ из интернета требует
отдельного решения оператора.

Форма и сервер повторно проверяют выбранные CR как пользователя. Для чтения
интерфейсов нужны get/list/watch PortV2, для управления адресом — соответствующие
права на FloatingipV2. Эти права входят в роли IaaS поставляемого каталога.

## Диагностика

Во вкладке Диагностика доступны Crossplane conditions и сообщение адаптера.
При долгом Provisioning проверьте состояния RouterInterface и port, наличие
ProviderConfig в namespace заказа и работоспособность Crossplane. Начальная
пауза ВМ ожидаема до готовности порта; ошибка UID подсети означает её удаление
или замену, а не повод привязать заказ к новому одноимённому объекту.

```sh
oc --kubeconfig "$KUBECONFIG" -n gator-iaas-catalog logs deployment/iaas-vpc-adapter --tail=100
oc --kubeconfig "$KUBECONFIG" -n my-project get portv2s.networking.openstack.m.crossplane.io
oc --kubeconfig "$KUBECONFIG" -n my-project get floatingipv2s.networking.openstack.m.crossplane.io
oc --kubeconfig "$KUBECONFIG" -n my-project get floatingipassociatev2s.networking.openstack.m.crossplane.io
```

IPv6, пользовательские таблицы маршрутизации, NAT gateways как отдельная услуга,
балансировщики, межсетевые соединения и редактирование security groups не входят в этот пакет
страниц. Их подключают отдельными контрактами GVK, источниками и действиями.
Наличие Octavia в подключённом OpenStack само по себе не добавляет продукт
балансировщиков в консоль: для него нужен собственный пакет каталога.
