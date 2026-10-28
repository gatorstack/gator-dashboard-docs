# Справочник сущностей

Сущности Dashboard находятся в группе `dashboard.gatorstack.dev/v1alpha1`,
учётные записи — `user.gatorstack.dev/v1alpha1`, биллинг —
`cost.gatorstack.dev/v1alpha1`. Роли и назначения являются обычными объектами
`rbac.authorization.k8s.io/v1`.

## Project

**Область:** namespace проекта. **Имя:** только `project`.

| Поле | Назначение |
| --- | --- |
| `metadata.namespace` | Технический идентификатор проекта в URL |
| `spec.name` | Обязательное отображаемое название |
| `spec.description` | Описание проекта |

У одного namespace только один Project. Право get этого объекта определяет
видимость проекта. Пример создания: [проекты](../operator-manual/projects.md).

## Product

**Область:** namespace каталога Dashboard.

| Поле | Назначение |
| --- | --- |
| `metadata.name` | Идентификатор продукта и часть URL |
| `spec.name` | Отображаемое название |
| `spec.category` | Категория каталога |
| `spec.description` | Описание и текст для поиска |
| `spec.logo` | HTTPS URL или путь к логотипу от корня сайта |
| `spec.badges[]` | Метки с title/color, до восьми |
| `spec.menu[]` | Порядок страниц, поля name/title/description и необязательный icon |
| `spec.menu[].icon` | Иконка пункта страницы: путь от корня сайта, HTTPS URL или base64 data URI PNG/JPEG/WebP/SVG; до 16384 символов |
| `spec.navigation.overviewIcon` | Иконка автоматически создаваемого пункта «Обзор», тот же формат |
| `spec.projectCard.schema.inline` | Схема карточки сервиса на Home: JSON-объект либо JSON-строка |
| `spec.projectCard.schema.configMapRef` | Альтернатива inline: имя ConfigMap каталога и ключ схемы |

Product описывает интерфейс сервиса. Он не устанавливает оператор продукта,
не создаёт нагрузку и не выдаёт права на исходные ресурсы.

`menu[].name` связывает значок с `metadata.name` страницы ProductPage. Он
работает и для страниц внутри групп. Без иконки или при ошибке загрузки
показывается общий значок страницы. Изображение декоративно и не меняет
доступное имя ссылки. HTML/JavaScript не исполняются; HTTPS-запрос не передаёт Referer.

```yaml
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: Product
metadata:
  name: example-service
  namespace: gator-dashboard
spec:
  name: Example Service
  category: Infrastructure
  navigation:
    overviewIcon: https://static.example.org/icons/overview.svg
  menu:
    - name: example-resources
      title: Ресурсы
      icon: https://static.example.org/icons/resources.svg
```

В примере замените адреса изображений своими и добавьте ProductPage с именем
`example-resources`. Вместо внешнего URL можно встроить SVG как
`data:image/svg+xml;base64,...`, чтобы не размещать отдельные файлы.

В projectCard указывается ровно один источник схемы, до 256 KiB. Схема:
`type: object`, `x-dashboard-view: project-card`, `x-dashboard-card.rows`.
Необязательный `title` заменяет название только на карточке; логотип берётся
из Product. От 1 до 16 строк содержат уникальный DNS label `id` до 63 символов,
непустой `title` до 128 символов и `pageRef.name`. Страница должна принадлежать
этому Product и иметь `x-dashboard-view: resources` с namespaced источником
текущего проекта. Подписи выводятся буквально, без автоматического склонения.
Пример настройки: [каталог](../operator-manual/catalog.md#карточки-сервисов-на-главной-проекта).

## ProductPage

**Область:** тот же namespace каталога.

| Поле | Назначение |
| --- | --- |
| `metadata.name` | Идентификатор страницы и часть URL |
| `spec.productRef.name` | Имя Product |
| `spec.title` | Название пункта меню |
| `spec.group` | Необязательная группа меню |
| `spec.schema.inline` | JSON Schema в объекте или JSON-строке |
| `spec.schema.configMapRef` | Имя ConfigMap и ключ схемы |

Ровно один источник schema, до 256 KiB. ConfigMap находится в namespace
каталога. Режим страницы задаётся расширением `x-dashboard-view`.
Примеры: [каталог](../operator-manual/catalog.md),
[страницы ресурсов](../operator-manual/resource-pages.md).

### Страницы ProductResource

Поля ниже задают несколько страниц одного типа ресурса. После обновления
проверьте, что установлены соответствующие CRD из комплекта.

| Поле | Назначение |
| --- | --- |
| `spec.resourceRef.name` | ProductResource того же продукта в namespace каталога |
| `spec.view` | List, Detail, Create, Edit или Action |
| `spec.action` | ID действия ресурса, только для Action |
| `spec.navigation.visible` | Показывать страницу в меню; false для форм и карточек |
| `spec.schema.resourceSchemaRef.operation` | Переиспользовать входную schema операции ресурса |

List/Create не требуют существующего экземпляра; Detail/Edit/Action открываются
для конкретного объекта. Карточки и формы связываются явными переходами списка.
Отсутствие страницы в меню не отменяет проверку прав на её открытие и действия.
Inline/configMapRef/resourceSchemaRef — взаимоисключающие источники schema.
Для mutation-форм используется общий источник со схемой серверной операции.

## ProductResource

**Область:** namespace каталога. Группа/версия — `dashboard.gatorstack.dev/v1alpha1`.

| Поле | Назначение |
| --- | --- |
| `spec.productRef.name` | Сервис, например iaas |
| `spec.target` | Ровно один apiVersion/kind, scope и namespace policy |
| `spec.access.mode: ReadOnly` | Просмотр справочника без операций изменения через Gator |
| `spec.selector` | Обязательный фильтр объектов этого описания ресурса |
| `spec.create.inputSchema` | Canonical JSON Schema заказа, inline либо configMapRef |
| `spec.create.template`, `mappings` | Базовый CR и перенос полей заказа |
| `spec.create.nameFromInput` | До 8 строковых JSON pointers input, формирующих стабильное имя в проекте и ProductResource |
| `spec.delete.title`, `confirmation` | Подпись обычного DELETE и текст подтверждения |
| `spec.relations` | Именованные связи: pageRef на List того же продукта/проекта, selectorBindings и matchFields из исходника |
| `spec.lookups` | Именованные источники вариантов: resourceRef, labelSelector, подписи |
| `spec.create.selections` | Проверка выбранных ссылок и mapping полей выбранного объекта |
| `spec.edit`, `delete`, `actions` | Контракты изменения, удаления и действий |
| `spec.actions[].executor` | UpdateResource либо CreateResource; без executor — legacy static patch |
| `spec.actions[].inputSchema` | Canonical JSON Schema параметров действия |
| `spec.actions[].targetResourceRef` | ProductResource для связанного create того же продукта |
| `spec.actions[].sourceMappings` | fromObject/toInput: доверенный input целевого create |
| `spec.actions[].initialMappings` | fromObject/toInput: редактируемые начальные значения формы |
| `spec.actions[].resultPageRef` | Detail-страница целевого ресурса после принятия запроса |
| `spec.lookups.*.matchFields` | path/fromInput: проверка соответствия полей источника контексту |
| `spec.create.selections[].minimums` | inputPath/fromSelected: числовая нижняя граница из проверенного выбора |
| `mappings[].transform: String` | Преобразование выбранного числа в строковое поле, например metadata |
| `spec.edit.contextMappings` | fromObject/toInput: доверенный контекст из существующего CR |
| `spec.edit.preconditions`, `spec.actions[].preconditions` | path/values/message, необязательные whenChanged пути spec |
| `spec.lookups.*.conditions` | Доступность варианта: path/values/message, conditionType для именованного condition |
| `spec.outputs` | Именованные пути к результатам основного CR |
| `spec.execution.mode` | Direct; Gated блокируется до подключения runtime |

Для namespaced target выбирается `namespacePolicy: CurrentProject` либо
`namespacePolicy: Fixed` с фиксированным `namespace`. Для `scope: Cluster`
namespace и namespacePolicy отсутствуют. Фактический scope определяется CRD;
смена поля в ProductResource не меняет область Kubernetes-ресурса.

Один Product/iaas содержит описания iaas-instances, iaas-disks,
iaas-snapshots, iaas-ssh-keys, iaas-disk-attachments и при необходимости read-only iaas-flavors.
ProductResource — описание типа, не дополнительный CR на каждый экземпляр VM.
Удаление конфигурации каталога не означает удаление управляемой инфраструктуры.
Операции создают целевой CR с правами пользователя. Generic CEL state, расширенные relations,
Operation runtime и quota/billing gate остаются следующими этапами. Текущий
исполнитель отклоняет неизвестные поля контракта; Gated и quotaBindingRef не
превращаются в бесконтрольный Direct. Действия поддерживают canonical schema, параметризованный update и создание
связанного CR через целевой create. См. [действия](../operator-manual/resource-actions.md)
и [IaaS](../operator-manual/iaas.md).

## Нативное подключение диска OpenStack

`VolumeAttachV2.compute.openstack.m.crossplane.io/v1alpha1` — штатный managed resource
provider-openstack. `spec.forProvider.instanceId/volumeId` содержат внешние UUID,
`providerConfigRef` выбирает namespaced подключение. Имена/UID источников для
консоли хранятся в metadata через mappings. `status.atProvider.device` и conditions
показывают результат. DELETE этого CR выполняет detach; VM и VolumeV3 сохраняются.
Multiattach выключен в поставляемом контракте IaaS.

## ActionInvocation

Namespaced CR dashboard.gatorstack.dev/v1alpha1. Неизменяемый spec содержит
fingerprint, principal, продукт/ресурс/действие, source UID/name/version. Полный
input и токены не сохраняются. status.phase: Executing, Applied, Rejected;
resultName/resultUID/resultKind/resultAPIVersion указывают принятый результат.
Служит сохраняемой защитой от повторов HTTP-запроса. Не является workflow
или свидетельством готовности внешней инфраструктуры. Автоматического TTL нет.

## VolumeSnapshot интеграции OpenStack

Namespaced CR storage.gatorstack.dev/v1alpha1 отдельного мини-оператора
gator-openstack-storage. Это расширение интеграции, не штатный CR Crossplane.
spec.providerConfigRef задаёт подключение; forProvider содержит name, description,
metadata, volumeId и volumeRef.name/uid. Подключение и источник неизменяемы.
status.phase, observedGeneration, conditions и atProvider отражают Cinder.
creationAttempted и finalizer защищают восстановление после неопределённого POST.
См. [эксплуатацию снимков](../operator-manual/iaas.md#типы-дисков-и-снимки).

## User

**Область:** кластер. Поля находятся на верхнем уровне, **без spec**.

| Поле | Назначение |
| --- | --- |
| `metadata.name` | Локальное техническое имя, например alice |
| `fullName` | Полное имя |
| `identities[]` | Внешние identities вида connector-id:immutable-user-id |
| `disabled` | Запрет новых токенов/refresh |
| `htpasswdSecretRef.name` | Имя Secret локального пароля |
| `htpasswdSecretRef.key` | Ключ, по умолчанию htpasswd |

Локальный User создаётся заранее. Namespace credentials задаёт оператор Dex,
а не сам User. Пароль хранится только как bcrypt в Secret. Внешний User может
создаваться при первом входе. Совпадение email не объединяет identities.

## Group

**Область:** кластер. Поле `users[]` на верхнем уровне содержит имена User.
Вложенных групп нет. Group не создаёт RoleBinding. При выдаче JWT Dex
пересчитывает группы, а Kubernetes добавляет настроенный prefix.

## Role и ClusterRole

`rules[]` содержит apiGroups, resources, verbs и при необходимости resourceNames.
Role действует внутри namespace; ClusterRole может повторно использоваться
проектными RoleBinding. ClusterRole поддерживает также nonResourceURLs.
Название роли не назначает разрешения: их определяют фактические rules.

Агрегируемую ClusterRole заполняет контроллер Kubernetes по aggregationRule.
Не редактируйте вручную её вычисленные rules. Каталог Gator и уровни:
[справочник ролей](roles.md).

## RoleBinding и ClusterRoleBinding

| Поле | Назначение |
| --- | --- |
| `roleRef` | apiGroup, kind и name назначаемой роли |
| `subjects[]` | User, Group или ServiceAccount |
| `metadata.namespace` | Область назначения RoleBinding |

RoleBinding ссылается на Role того же namespace либо ClusterRole.
ClusterRoleBinding — только на ClusterRole. roleRef после создания неизменяем.

## ResourceQuota

**Область:** namespace проекта. `spec.hard` задаёт лимиты, `status.hard` и
`status.used` заполняет Kubernetes. Для Home / Квоты используется один ключ
objectCount на квоту. `metadata.annotations.title` задаёт читаемое название.

## CostConfiguration

**Область:** кластер. **Имя:** singleton `default`.
Задаёт стабильный clusterID, systemNamespace, RUB, SecretRef базы и служебного
API, политику LastKnown/KeepAll и подключение OpenMeter. Бизнес-источники
и цены задаются отдельными сущностями. Пример:
[установка биллинга](../operator-manual/billing-installation.md).

## MeteringPolicy

**Область:** кластер.

| Поле spec | Назначение |
| --- | --- |
| `enabled` | Включение правила |
| `source` | Точный GVR, scope, namespaces и labelSelector |
| `billableWhen` | CEL-условие тарифицируемости |
| `dimensions` | project/product/instance: константы или JSON Pointer |
| `tariffPlanRef.name` | Ключ семейства глобального плана |
| `meters[]` | id/name/chargeKey, Field или Count, единица, поле и priceRef |

CEL видит исходный объект, не выполняет lookup. Отсутствующие значения не
считаются нулём. Рабочие примеры: [учёт и тарифы](../operator-manual/billing-configuration.md).

## TariffPlan и ProjectTariffPlan

| Поле spec | TariffPlan | ProjectTariffPlan |
| --- | --- | --- |
| Область | Кластер | Namespace источника |
| Семейство | key | globalPlanRef.name |
| Проект | Глобальный | projectID |
| Валюта | currency: RUB | currency: RUB |
| Период | validFrom, необязательный validUntil | То же |
| Цены | rates: key/unit/price | Полный заменяющий набор rates |

Время RFC3339, конец периода исключён, decimal-цены передаются строками.
Отсутствующая позиция проектного плана не наследуется. Принятая активная
история цен не переписывается. RateCard относится к архиву прежней модели;
для нового минутного учёта применяются TariffPlan и ProjectTariffPlan.

Параметры формы в canonical JSON Schema: `x-dashboard-form.presentation: dialog`,
`sourcePageRef`, `sourceTab`, `submitLabel`; без `presentation: dialog` форма
остаётся отдельной страницей. `sourcePageRef` — Detail того же ProductResource.
Секция `related-resources` поддерживает `actions: [{title, pageRef: {name}}]`.
Текст пустого lookup можно задать через `x-dashboard-empty-text` на поле.

`x-dashboard-widget: tag-map` применяется к массиву строк: форма показывает
пары ключ/значение и сериализует их как `key=value`. Ограничения ключей и значений
задаются `items.pattern`, длиной и `maxItems` исходной JSON Schema. Для объектного
словаря используется обычный widget `key-value`.

Колонка `resource-link` дополнительно принимает `link.pageRef`, `link.namePath`,
`link.uidPath`: переход к связанному ресурсу того же продукта и проекта с его UID.
JSON-список relation возвращает `items: []`, когда подключений нет.

В `x-dashboard-form` параметры `contextFields: ResourceField[]` выводят сведения
об исходнике без добавления в input. `successNavigation: source` (по умолчанию)
возвращает в исходную карточку, `result` открывает проверенный `resultPageRef`
с UID результата. Отмена всегда возвращает в `sourcePageRef`.

## Навигация Product

`spec.navigation.projectHome: true` назначает продукт главной проекта.
`defaultPageRef: {name: page-name}` выбирает начальную ProductPage.
`overview: false` скрывает автоматически добавляемый пункт обзора продукта.
Имена продукта и страницы произвольные. Несколько projectHome дают ошибку,
отсутствие настройки открывает общий обзор ресурсов проекта.

## BillingBinding

Namespaced-объект каталога для предварительной стоимости Create-форм.
Связывается через ProductResource.billingBindingRef; [полный справочник](billing-binding.md).
