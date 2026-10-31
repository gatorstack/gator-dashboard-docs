# Страницы Kubernetes-ресурсов

Страница ресурсов показывает namespaced-объекты выбранного проекта.
Ниже — полный пример дополнительной страницы квот продукта Home.

```yaml
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: ProductPage
metadata:
  name: project-quota-list
  namespace: gator-dashboard
spec:
  productRef:
    name: home
  title: Квоты объектов
  schema:
    inline:
      type: object
      x-dashboard-view: resources
      x-dashboard-resource:
        apiVersion: v1
        kind: ResourceQuota
        namespace: project
      x-dashboard-list:
        sortable: true
        columns:
          - title: Квота
            width: 65
            path: /metadata/annotations/title
            fallbackPath: /metadata/name
            renderer: text
          - title: Использование
            width: 35
            renderer: quantity-map
            usedPath: /status/used
            hardPath: /status/hard
            progress: true
            showKeys: false
```

Примените манифест, перезагрузите каталог и откройте страницу в проекте.
Если объект управляется Helm, перенесите его spec в `catalog.pages` вместо
параллельного управления тем же объектом.

## Источник данных

Указывайте точный `apiVersion` и `kind`. Для core API используется `v1`,
для CR — группа/версия оператора. Namespace страницы всегда берётся из проекта
через `namespace: project`. Cluster-scoped ресурсы и subresources этим режимом
не поддерживаются.

Пользователю нужны get Project, чтение Product/ProductPage и схемы, а также
list/watch исходного kind. Для карточки объекта нужны get/watch. Сама схема
не выдаёт разрешений.

## Пути к полям

Используется JSON Pointer относительно объекта:

| Значение | Путь |
| --- | --- |
| Техническое имя | `/metadata/name` |
| Аннотация title | `/metadata/annotations/title` |
| Метка example.org/team | `/metadata/labels/example.org~1team` |
| Лимит count/configmaps | `/status/hard/count~1configmaps` |

В ключе `/` экранируется как `~1`, `~` — как `~0`. Отсутствующее поле отображается
как `—`; `fallbackPath` используется при отсутствующем или пустом основном значении.

## Колонки и карточки

| Renderer | Назначение |
| --- | --- |
| `text` | Текстовое поле или JSON |
| `resource-link` | Ссылка на карточку, если она настроена |
| `datetime` | Дата в часовом поясе браузера |
| `quantity-usage` | Использование и лимит одного значения |
| `quantity-map` | Использование и лимиты карты значений |

Для карточки добавьте в схему:

```yaml
x-dashboard-detail:
  sections:
    - title: Основные сведения
      renderer: fields
      paths: [/metadata/name, /metadata/namespace]
```

Для условий контроллера используйте секцию `renderer: conditions` с
`path: /status/conditions`. Необязательная карта labels сопоставляет condition
Type понятному названию (например, Ready: Готовность). Она показывает статус,
reason и message отдельными полями, без вывода всего JSON conditions.
Подписи обычных полей задаются title в properties JSON Schema.

Таблица должна содержать 1–32 колонки; карточка — 1–32 секции. В секции fields
допустимо 1–64 пути. Если detail отсутствует, страница остаётся списком.

## Автоматическое обновление

Объекты обновляются через Kubernetes watch. Ingress/reverse proxy должен
передавать поток без буферизации и не обрывать его раньше обычного цикла
переподключения. Потеря соединения восстанавливается автоматически.
Изменение самой схемы или каталога требует перезагрузки страницы браузера.

Legacy страницы с x-dashboard-resource предназначены для просмотра. Для
создания, изменения и удаления подключите ProductResource и страницы с resourceRef.
См. [пакет IaaS](iaas.md).

## Несколько страниц одного ресурса

Для ресурса instances сервиса iaas используются страницы:

| Страница | Назначение | В меню |
| --- | --- | --- |
| iaas-instances | List: таблица VM | Да |
| iaas-instances-detail | Detail: карточка конкретной VM | Нет |
| iaas-instances-create | Create: заказ новой VM | Нет |
| iaas-instances-edit | Edit: изменение разрешённых параметров VM | Нет |
| iaas-instances-start / stop | Action: запуск / остановка | Нет |

Все они ссылаются на один ProductResource/iaas-instances. Страницы не дублируют
target GVK и правила создания. Переходы и кнопки выбирают страницу явно, передавая
проверенную identity объекта. Вкладки «Основное», «Диски», «События» могут
оставаться внутри schema одной Detail-страницы. Пользовательские права
проверяются и при прямом открытии адреса страницы.

Параметризованные действия и создание связанных CR описаны в
[руководстве действий](resource-actions.md).

## Встроенные сессии

Секция `remote-session` открывает временный интерактивный интерфейс ресурса,
например VNC, внутри карточки. Она не создаёт дополнительный инфраструктурный CR.
Пример секции в `x-dashboard-detail.sections`:

```yaml
- title: Консоль
  tab: console
  renderer: remote-session
  session:
    id: console
    adapterRef:
      name: remote-access
    parameters:
      protocol: vnc
      type: novnc
```

Добавьте вкладку `id: console` в `x-dashboard-detail.tabs`. `id` сессии уникален
в пределах страницы. `parameters` — фиксированные параметры адаптера;
`preconditions` проверяют поля текущего CR тем же контрактом, что действия.

Оператор установки подключает сервис отдельно от схемы страницы:

```yaml
resourceSessions:
  adapters:
  - name: remote-access
    url: http://remote-access.integrations.svc:8080
    existingSecret: remote-access-credential # ключ token
    allowedOrigins:
    - https://console.example.org
```

Создайте credential Secret в namespace Dashboard и смонтируйте тот же credential
в адаптер. URL сервиса и разрешённые origins задаёт оператор; пользователь не
может передать произвольный endpoint в запросе. Используйте отдельный origin
для встраиваемого интерфейса, HTTPS и WebSocket. Не передавайте credential в Git.

При выборе вкладки Dashboard проверяет доступ к проекту/каталогу, читает основной
CR с правами пользователя, сверяет UID/selector и выполняет SelfSubjectAccessReview
для verb `connect` на конкретное имя/GVR/namespace. Схема не выдаёт разрешение.
Только после проверки адаптер получает POST `/v1/sessions` с `target`
(apiVersion, kind, namespace, name, uid), `parameters` и сервисным Bearer credential.
Пользовательский Kubernetes token, spec CR и Secret ему не пересылаются.

Ответ адаптера: `url` и `expiresAt` в RFC3339, срок от текущего времени до часа.
Адрес должен принадлежать HTTPS origin из allowlist, без userinfo и fragment.
Redirects адаптера не выполняются. URL возвращается с no-store и не записывается
в CR или историю действий. Iframe использует sandbox и no-referrer. При закрытой
вкладке сессия не запрашивается; переподключение получает новый адрес.

## Общий справочник

Namespace заказа и namespace справочника независимы. Например, VM создаётся
в проекте demo, а flavor читается из infra-catalog. В ProductResource каталога
задаётся один из вариантов:

| Размещение | Настройка target |
| --- | --- |
| В проекте | scope: Namespaced, namespacePolicy: CurrentProject |
| В общем namespace | scope: Namespaced, namespacePolicy: Fixed, namespace: infra-catalog |
| Кластерное | scope: Cluster, без namespace/namespacePolicy |

Scope должен совпадать с установленной CRD. Для справочника выбирается ReadOnly;
read не даёт права изменять flavor или создавать VM. Права чтения выдаются
отдельно в области справочника, как описано в [RBAC](rbac.md#общие-справочники-flavors-и-images).

## Выбор flavor на форме

Оператор описывает lookup flavors в ProductResource виртуальных машин. Он
ссылается на ProductResource каталога и содержит обязательный labelSelector.
Например, выбирать опубликованные flavors региона RegionOne с class general
или compute. Поле формы ссылается на lookup по имени. Фрагмент конфигурации ProductResource:

```yaml
lookups:
  flavors:
    resourceRef: {name: iaas-flavors}
    labelSelector:
      matchLabels:
        catalog.example.org/region: RegionOne
      matchExpressions:
        - key: catalog.example.org/class
          operator: In
          values: [general, compute]
    option:
      labelPath: /spec/displayName
```

В JSON Schema поле flavor получает `x-dashboard-lookup: flavors`. Вариант
выбора хранит identity объекта: name, namespace (для namespaced), UID и
resourceVersion. Общая schema формы и операции хранится в одном ConfigMap
либо страница использует schema.resourceSchemaRef, ссылаясь на операцию ресурса.
Сама schema не выдаёт права на чтение справочника.

При отправке формы сервер повторно читает выбранный flavor как пользователь,
проверяет селекторы и версию, затем переносит provider ID из доверенного поля
каталога в CR виртуальной машины. Поле пути настраивается: для собственного
каталога это может быть spec.providerID, для provider CR — соответствующий
путь его API. Присланные браузером provider ID и CPU/RAM не используются как
доверенный источник. Учёт характеристик в квотах требует подключённого quota controller.

Фильтр самого ресурса, фильтр lookup и поиск пользователя пересекаются.
Поиск не расширяет допустимый набор. Если варианты зависят от региона,
смена региона сбрасывает выбор flavor. Изменившийся или удалённый flavor
требует повторного выбора; сервер не подставляет другой автоматически.
«Нет вариантов», «Нет прав» и «Каталог недоступен» показываются раздельно.

Label selector не является границей Kubernetes RBAC. Пользователь с list в общем
namespace может читать и другие объекты того же GVR напрямую. Для конфиденциальных
каталогов используйте отдельные namespaces с отдельными назначениями или
безопасные проекции каталога. Запрет использования flavor вне разрешённого набора
при прямой записи CR должен также обеспечиваться admission/gate пакета.

## Пересозданный ресурс

Ссылки новых страниц ProductResource закрепляют UID объекта. Если контроллер
или другой пользователь удалил объект и создал новый с тем же именем, старая
ссылка не переключается на новую сущность: вернитесь к списку и выберите её
повторно. Изменение и удаление дополнительно проверяют resourceVersion.

## Карточка с вкладками

Страницы продукта используют общую шапку с отдельной подложкой: над содержимым
расположены хлебные крошки, заголовок и доступные действия. В списке здесь
появляется кнопка создания, если она настроена. В карточке заголовком становится
имя ресурса, рядом выводится статус, ниже — идентификаторы, действия и вкладки.
На узком экране кнопки переносятся, а вкладки прокручиваются горизонтально.
Такое оформление применяется автоматически, менять манифесты для него не нужно.

Вкладки и представление полей настраиваются внутри JSON Schema. Например,
для произвольного CR с именем в spec.displayName, состоянием в status.phase
и сетевыми адресами в status.endpoints:

```yaml
x-dashboard-detail:
  header:
    titlePath: /spec/displayName
    status:
      path: /status/phase
      renderer: badge
      labels: {Available: Работает, Pending: Создаётся, Failed: Ошибка}
    identifiers:
      - {title: ID, path: /status/id, copyable: true}
  tabs:
    - {id: overview, title: Обзор}
    - {id: network, title: Сеть}
  sections:
    - title: Основное
      tab: overview
      renderer: fields
      fields:
        - {title: Имя, path: /spec/displayName, fallbackPath: /metadata/name}
        - {title: Создан, path: /metadata/creationTimestamp, renderer: datetime}
        - {title: Метки, path: /spec/tags, renderer: tags}
    - title: Адреса
      tab: network
      renderer: table
      path: /status/endpoints
      columns:
        - {title: Адрес, path: /address, copyable: true}
        - {title: Порт, path: /port}
```

Эти параметры подходят любому GVK с такими полями: название типа ресурса
не выбирает специальный компонент интерфейса. Вкладка сохраняется в параметре
tab адреса вместе с UID. Каждая секция должна ссылаться на объявленный ID вкладки.
Старые sections с paths без tabs продолжают работать.

Для fields доступны text, datetime, badge, tags, map и code. В колонках списка
также поддерживаются tags/map и minWidth (40–800 px), чтобы широкая таблица
прокручивалась в своей области. conditionType выбирает named condition из массива
по type, независимо от порядка, и отображает его status.
 labels переводит
значения, prefix/suffix добавляет единицу или текст, copyable включает копирование.
code только показывает текст: команда не выполняется. table читает массив из
path; пути columns относительны к его строке. Значения выводятся как текст,
без исполнения HTML или JavaScript.

## Группы формы и условия изменения

Группы располагают существующие свойства без изменения валидации JSON Schema:

```yaml
type: object
x-dashboard-form:
  groups:
    - {title: Основное, fields: [name, description]}
    - {title: Размещение, fields: [region]}
properties:
  name: {type: string, title: Имя}
  description: {type: string, title: Описание, x-dashboard-widget: textarea}
  region: {type: string, title: Регион, enum: [region-a, region-b]}
```

Свойства вне groups остаются видимыми. Объект с additionalProperties.type:
string отображается редактором пар ключ/значение; пустые и повторяющиеся ключи
отклоняются. Сложные схемы сохраняют JSON-редактор.

В ProductResource.edit можно задать contextMappings: значения из текущего CR
попадут в input формы, а сервер отклонит их подмену. Preconditions проверяют
текущее состояние до записи. Например, изменение /spec/size разрешено только
при status.phase=Stopped:

```yaml
edit:
  contextMappings:
    - {fromObject: /spec/region, toInput: /region}
  preconditions:
    - path: /status/phase
      values: [Stopped]
      whenChanged: [/spec/size]
      message: Сначала остановите ресурс.
```

Это дополнение к inputSchema, mappings, selections и mutablePaths операции.
whenChanged содержит пути spec; без него условие проверяется всегда.
В lookups.conditions применяется тот же path/values/message; conditionType
выбирает именованное условие из массива conditions независимо от его порядка.
Условия фильтруют варианты и повторно проверяются при отправке формы.
Они не заменяют Kubernetes RBAC или admission при прямой записи CR.

## Связанные ресурсы

Секция `renderer: related-resources` с `relationRef` показывает обычную таблицу
другого ProductResource. Страница источника должна быть Detail, источник и цель —
namespaced CurrentProject. Определение `spec.relations` хранится в ProductResource
источника; `pageRef` указывает на List того же продукта. Внешние namespace/GVK/URL
из браузера не принимаются. Сервер читает источник с его UID и строит фильтры сам.

Например, к `spec` описания VM добавляется:

```yaml
relations:
  attachments:
    pageRef: {name: iaas-disk-attachments}
    selectorBindings:
      - {fromObject: /metadata/uid, label: iaas.gatorstack.dev/instance-uid}
    matchFields:
      - {fromObject: /metadata/uid, path: /metadata/labels/iaas.gatorstack.dev~1instance-uid}
      - {fromObject: /spec/providerConfigRef/name, path: /spec/providerConfigRef/name}
      - {fromObject: /status/atProvider/id, path: /spec/forProvider/instanceId}
```

В `x-dashboard-detail.sections` соответствующей Detail-страницы добавляется:

```yaml
- title: Подключения дисков
  renderer: related-resources
  relationRef: attachments
  tab: disks
  emptyText: Управляемых подключений нет.
```

`tab` должен существовать в tabs страницы; для карточки без вкладок поле опускают.
Подписи, колонки и переход в карточку берутся из проверенной List schema цели.
Имена и UID записываются в labels/annotations при создании через mappings. Поля
matchFields сравниваются с фактическим CR; одного label для соответствия cloud/ID
недостаточно. Объект вне связи не попадает в snapshot/watch. При изменении поля
он исчезает из таблицы, при удалении — также; переподключение читает новый snapshot.
Схемы расширяются только на один уровень, вложенное рекурсивное раскрытие не выполняется.
Чтение и watch сохраняют Kubernetes RBAC пользователя и отменяются при уходе со страницы.

У `delete` ProductResource можно задать `title` и `confirmation`: например,
«Отключить диск» для удаления VolumeAttachV2. Это меняет подпись и подтверждение
обычного DELETE с UID/resourceVersion, не вводит HTTP-вызов облачного API из UI.

В секции `related-resources` можно задать кнопки действий:

```yaml
actions:
  - title: Подключить диск
    pageRef:
      name: iaas-instances-attach-disk
```

Кнопка открывает Action-страницу для текущего исходника с его UID. Если целевой
ресурс связи допускает удаление, строка таблицы показывает кнопку из
`delete.title`. Подтверждение называет объект и показывает `delete.confirmation`;
ошибки отображаются в этом же окне. После принятия запроса строка остаётся до
завершения finalizer и обновляется через watch. Перед удалением консоль получает
актуальную версию того же UID и отправляет UID/resourceVersion preconditions.

Чтобы имя в связанной таблице открывало карточку исходного ресурса, задайте
`link` у колонки `resource-link`:

```yaml
title: Диск
path: /metadata/annotations/iaas.gatorstack.dev~1disk-name
renderer: resource-link
link:
  pageRef:
    name: iaas-disks-detail
  namePath: /metadata/annotations/iaas.gatorstack.dev~1disk-resource
  uidPath: /metadata/labels/iaas.gatorstack.dev~1disk-uid
```

Переход остаётся внутри текущего продукта и проекта, передаёт UID и снова
проверяется обычным API страницы. Если имя или UID отсутствуют, выводится текст
без ссылки. Без `link` колонка открывает обычную карточку самого объекта строки.


## Связь с массивом значений

В `ProductResource.spec.relations.<id>.matchFields` параметр
`operator: Contains` проверяет вхождение значения исходного CR в массив поля
целевого CR. Например, ID группы может входить в `spec.securityGroupIds` порта.
Без operator используется точное сравнение; `Equal` задаёт его явно. Все
условия связи объединяются через AND, включая регион и прочие ограничения.
Selector и relation не заменяют Kubernetes RBAC текущего пользователя.

Общий вид карты ресурсов описан в [справочнике](../reference/resource-map.md).

## Подписи вариантов в форме

`x-dashboard-enumLabels` задаёт читаемые подписи для значений `enum` поля.
Сохранённое значение и серверная проверка JSON Schema остаются прежними:

```yaml
type: string
title: Направление
enum: [ingress, egress]
x-dashboard-enumLabels:
  ingress: Входящий
  egress: Исходящий
```

Для каталожных ресурсов используйте lookup по GVK. Подписи enum предназначены
для фиксированных значений протокола, а не для подмены списка ресурсов.

## Каталог карточек из JSON Schema

Поле с `x-dashboard-widget: catalog` выбирает один Kubernetes CR и показывает
его название, иконку, группу, вариант и описание. Источник и пути отображения
описываются прямо в канонической схеме операции. Например:

```yaml
image:
  type: object
  title: Образ
  x-dashboard-widget: catalog
  x-dashboard-lookup: images
  x-dashboard-dependsOn: [cloud]
  x-dashboard-catalog:
    target:
      apiVersion: images.openstack.m.crossplane.io/v1alpha1
      kind: ImageV2
      scope: Namespaced
      namespacePolicy: Fixed
      namespace: infra-catalog
    labelSelector:
      matchLabels:
        catalog.example.org/published: "true"
    selectorBindings:
      - {label: catalog.example.org/cloud, fromInput: /cloud}
    option:
      labelPath: /metadata/annotations/catalog.example.org~1title
      descriptionPath: /metadata/annotations/catalog.example.org~1description
      iconPath: /metadata/annotations/catalog.example.org~1icon
      groupPath: /metadata/annotations/catalog.example.org~1family
      variantPath: /metadata/annotations/catalog.example.org~1version
  additionalProperties: false
  required: [name, namespace, uid, resourceVersion]
  properties:
    name: {type: string, minLength: 1}
    namespace: {type: string, minLength: 1}
    uid: {type: string, minLength: 1}
    resourceVersion: {type: string, minLength: 1}
```

Поменяйте GVK и пути для любого другого каталога: моделей, баз данных, тарифов
или шаблонов. Для cluster-scoped GVK укажите `scope: Cluster`, уберите namespace
и namespacePolicy, а также свойство namespace из identity. Для ресурсов проекта
используйте `namespacePolicy: CurrentProject` без фиксированного namespace.
Discovery проверяет фактический scope и поддерживаемые операции.

Вместо `target` можно указать `resourceRef: {name: catalog-resource}` для уже
настроенного ProductResource. Два источника одновременно запрещены. ID lookup
должен быть уникален: не дублируйте его другой конфигурацией в `spec.lookups`.
Старые `spec.lookups` продолжают работать. В `create.selections` укажите тот же
`lookupRef: images` и mappings из выбранного CR в создаваемый ресурс.

`option` принимает JSON Pointer на строки, включая аннотации с экранированием
`/` как `~1`. Только эти значения и identity уходят в браузер. Без labelPath
или при отсутствии поля используется metadata.name; без иконки — нейтральный
значок. Иконка — относительный путь, HTTPS URL или base64 data URI изображения
PNG/JPEG/WebP/SVG. HTML и JavaScript не исполняются; для HTTPS не передаётся Referer.
Одинаковые группы объединяют варианты в разделе каталога. Каждый вариант
выбирает конкретный CR, а не строку из enum. Поиск по названию, описанию,
группе и варианту находится внутри раскрытого каталога.
Высота раскрытого каталога подстраивается под доступное место на экране.
Длинный список карточек прокручивается внутри, а строка поиска остаётся видимой,
в том числе на мобильном устройстве. Дополнительная настройка схемы не требуется.

Источник читается с правами пользователя. Сервер повторно проверяет namespace,
UID, выбранную ревизию, labelSelector, selectorBindings и conditions при заказе
и предбиллинге. Клиент не может передать другой GVK или дополнительные поля CR.
Метки фильтрации не заменяют Kubernetes RBAC.

Для справочников с частой синхронизацией задайте в lookup (в `spec.lookups`
или `x-dashboard-catalog`) `revisionPolicy: Content`. В identity JSON Schema
добавьте `revision: {type: string, minLength: 1}` рядом с `resourceVersion`.
Сервер вернёт оба поля: Kubernetes resourceVersion и хеш используемых данных.
Хеш включает поля оформления option, selectors, matchFields, mappings из выбранного
объекта и minimums всех операций ProductResource, а также условия доступности.
Для conditions с conditionType сравнивается status этого типа; служебное
lastTransitionTime не влияет на заказ. Если timestamp явно используется в mapping
или option, он тоже участвует в проверке.

Перед заказом сервер перечитывает CR. Изменение UID, области доступа, публикации,
используемых параметров или условий отклоняет выбор. Хеш не даёт дополнительных
прав и не заменяет RBAC. Отсутствующий или неверный revision возвращает конфликт.
Без revisionPolicy либо при `ResourceVersion` сохраняется строгое сравнение всей
версии CR. Проверки версии редактируемого или удаляемого основного ресурса не меняются.

При конфликте создания форма сохраняет введённые поля и обновляет каталоги.
Проверьте выбранные варианты и стоимость, затем нажмите «Создать» повторно.
Автоматически повторный заказ не отправляется.

В действии `CreateResource` ID lookup в форме может отличаться от ID в целевом
ProductResource. Связь определяется полем inputPath целевой selection: форма
сохраняет свой источник, оформление и фильтры, а ревизия вычисляется по каноническому
контракту создаваемого ресурса. Источники должны указывать на одинаковый GVK,
scope и namespace policy. Это позволяет задавать отдельные окна подключения из
разных карточек и сохранять общий контракт создаваемой связи.



## Секции заказа и метки

Название формы задавайте в `ProductPage.spec.title` явно: «Создать бакет»,
«Изменить бакет», «Создать сеть». Указывайте действие и конкретный ресурс,
а не название списка после двоеточия. Это же название используется в хлебных
крошках; заголовок списка задаётся независимо. Dashboard не склоняет названия
ресурсов и не содержит словаря продуктовых форм.

Полноэкранные формы создания, редактирования и отдельные страницы действий
используют единое оформление: секции с заголовками и разделителями, без внешней
карточки и повторного названия формы. Настройка `layout: sections` больше не
нужна; старые схемы с ней совместимы.

Состав, порядок и названия секций задавайте в `x-dashboard-form.groups`, порядок
полей — в `groups[].fields`. Каждое поле текущего каталога должно входить ровно
в одну секцию. Для сторонних схем сохраняется совместимость: поля вне групп
показываются после них; без групп форма выводит единый блок полей. Описание
корневой схемы отображается один раз.

Вложенные схемы и формы с `presentation: dialog` остаются компактными, даже
если внутри их схемы сохранился `layout: sections`. Формат данных, validation,
lookup и привязки к GVK от оформления не зависят.

```yaml
x-dashboard-form:
  groups:
    - {title: Общая информация, fields: [name, description, tags]}
    - {title: Расположение, fields: [cloud, zone]}
```

Для меток всех продуктов используйте `x-dashboard-widget: tag-map`. Редактор
добавляет плашки через «Добавить метку» и открывает ключ/значение во всплывающем
окне. Нажмите плашку для изменения или переименования ключа, крестик — для удаления.
Ключи должны быть непустыми и уникальными. Поддерживаются два формата хранения:

```yaml
# JSON-словарь сохраняется словарём, например {environment: production}.
type: object
title: Метки
x-dashboard-widget: tag-map
additionalProperties: {type: string, maxLength: 255}
maxProperties: 32
default: {}
```

Для массива задайте `type: array`, `items: {type: string}` и тот же widget;
данные сохранятся массивом строк `key=value`. Лимиты ключей/значений задавайте
исходной JSON Schema: `propertyNames`, `additionalProperties`, `maxProperties`
для словаря; `items`, `maxItems`, `uniqueItems` для массива. Ограничения должны
соответствовать целевому API. Без `maxProperties` словарь не получает скрытого
ограничения количества меток. Некорректные исходные значения остаются видимыми
и требуют исправления. Пустая строка значения сохраняется.

Widget применяется одинаково в create/edit, действиях и вложенных схемах.
Непомеченные словари остаются обычным редактором пар ключ/значение.

Все обычные lookup также ищут внутри раскрытого списка. Там же находятся
пустое состояние, ошибка, повтор загрузки и следующая порция вариантов.
Поиск не сбрасывает выбранную identity; изменение зависимого поля сбрасывает.

Если справочник изменился, «Обновить данные и расчёт» обновляет версии всех
выбранных CR и сохраняет остальные поля формы. Объект с другим UID автоматически
не подставляется: удалённый вариант нужно выбрать заново.

## Иконка перед значением колонки

Добавьте `iconPath` в колонку списка. Это JSON Pointer к изображению в том же
CR; `iconAltPath` задаёт путь к его текстовой подписи. Например:

```yaml
x-dashboard-list:
  sortable: true
  columns:
    - title: Имя
      path: /spec/displayName
      fallbackPath: /metadata/name
      renderer: resource-link
      iconPath: /metadata/annotations/display.example.org~1icon
      iconAltPath: /metadata/annotations/display.example.org~1source-name
```

Иконка располагается перед значением; ссылка с UID, дополнительная строка и
сортировка работают как прежде. Допустимы относительные пути, HTTPS и base64
изображения PNG/JPEG/WebP/SVG — как у каталога выбора. HTML и JavaScript не
исполняются; HTTPS не передаёт Referer. Для пустого, недопустимого или
недоступного изображения показывается нейтральный значок. Без `iconPath`
колонка сохраняет прежний вид.

Чтобы показать образ, шаблон или другой выбранный источник, скопируйте его
иконку в основной CR через `create.selections[].mappings`. Источником остаётся
доверенный GVK: сервер повторно читает выбранный объект и проверяет UID,
resourceVersion и селекторы. Например, mapping:

```yaml
- fromSelected: /metadata/annotations/catalog.example.org~1icon
  toObject: /metadata/annotations/display.example.org~1icon
```

Иконка хранится как снимок выбранного источника. Поэтому смена оформления или
удаление записи каталога не меняют обозначение ранее созданного ресурса.

## Выдача данных из connection Secret

В ProductResource объявите Secret output. Namespace берётся из основного CR;
caller должен иметь get этого Secret, а ownerReference Secret должен указывать
на точные apiVersion/kind/name/UID основного CR:

```yaml
outputs:
  - id: credentials
    secretRef:
      namePath: /spec/writeConnectionSecretToRef/name
      fields:
        - id: access_key_id
          key: aws_access_key_id
          title: Access key ID
        - id: secret_access_key
          key: aws_secret_access_key
          title: Secret access key
```

В JSON Schema Detail добавьте секцию. Конкретные Secret keys и пути остаются
в манифесте продукта, renderer подходит любому установленному GVK:

```yaml
x-dashboard-detail:
  sections:
    - title: Данные подключения
      renderer: connection-secret
      outputRef:
        name: credentials
```

Чтение выполняется явно через POST
`resources/<name>/outputs/<output-id>/reveal` с UID основного CR. Вход не содержит
произвольных Secret name/namespace/keys. Обычные list/detail не получают Secret
values. Ответ имеет no-store, а UI очищает значения при закрытии Dialog.
История access/reveal содержит actor и identity CR, без содержимого Secret.
Подробный пример применения: [S3-продукт](s3.md).

## Завершающие mappings

`ResourceOperation.finalMappings` берут fromObject из сформированного CR после
обычных mappings, selections и назначения metadata.name/namespace. Они могут
писать spec и разрешённые labels/annotations, но не менять identity/status/owners.
Для edit каждый целевой путь явно включается в mutablePaths. Изменение формата
не расширяет права caller и не позволяет выбирать произвольный ProviderConfig.

`JSONString` сериализует типизированное значение; `ParseJSON` разбирает JSON
строку до 64 KiB. Строковые prefix/suffix и prefixFromObject позволяют составить
внешнее имя из доверенного каталога. Эти преобразования полезны для API, где
политика передаётся JSON строкой, и для стабильных имён выходных Secret.

## Техническое имя над заголовком

С версии 0.12.0 `x-dashboard-detail.header.namePath` задаёт необязательный
JSON Pointer к строке над названием ресурса:

```yaml
x-dashboard-detail:
  header:
    namePath: /metadata/name
    titlePath: /metadata/annotations/example.org~1title
  sections:
    - title: Основное
      renderer: fields
      paths: [/metadata/namespace]
```

Имя выводится небольшим текстом приглушённого цвета и переносится на узком
экране. `titlePath` продолжает задавать заголовок и хлебные крошки. Если значение
namePath отсутствует или не строка, строка имени скрыта. Identifier с тем же
path повторно не выводится. Остальные identifiers, например внешний ID,
сохраняются. Возврат к списку выполняется через крошки или меню продукта.

Крошка карточки использует `x-dashboard-links.listPageRef`, если он объявлен.
Для IAM сохраняется выбранная область project/cluster.


### Приоритет ошибок в состоянии ресурса

Для колонок, полей и `header.status`, читающих массив conditions, можно задать
`conditionRules`. Первое совпавшее правило определяет отображаемое значение;
без совпадений используется обычный `conditionType`. Пример:

```yaml
path: /status/conditions
renderer: badge
conditionType: Ready
conditionRules:
- type: LastAsyncOperation
  status: 'False'
  messageContains: 'BucketAlreadyExists:'
  value: Конфликт имени
- type: LastAsyncOperation
  status: 'False'
  value: Ошибка
labels:
  'True': Готово
  'False': Подготовка
```

`type` и `status` обязательны. Дополнительный `reason` сравнивается точно,
`messageContains` ищет буквальную подстроку с учётом регистра в том же condition.
`value` задаёт подпись для renderer; полный текст ошибки можно оставить в
секции `conditions` на вкладке диагностики. Эти правила только отображают
состояние и не меняют объект Kubernetes.

При конфликте имени форма сообщает, что ресурс уже существует в текущем
проекте. Введённые значения и сообщение сохраняются при правках и обновлении
каталогов выбора. Повторная отправка или сброс очищают прошлую ошибку.


### Данные доступа связанных ресурсов во вкладке

Секция `related-resources` может выводить Secret outputs связанных объектов
прямо на странице. Привязка остаётся декларативной:

```yaml
title: Подключения
tab: connections
renderer: related-resources
relationRef: connections
outputRef:
  name: credentials
  presentation: inline
  visibleFields:
  - client_id
fields:
- title: Состояние
  path: /status/phase
```

`outputRef.name` выбирает объявленный Secret output целевого ProductResource.
Relation должна ссылаться на List-страницу с переходом к Detail того же ресурса.
Для каждой связанной записи выводится отдельная карточка; `fields` читаются
относительно этой записи. Новые renderer или знания конкретного GVK не нужны.

`presentation: inline` читает данные при открытии секции вкладки; по умолчанию
остаётся прежний режим с кнопкой и Dialog. `visibleFields` содержит ID полей
output, показываемых открыто. Остальные поля маскированы, их можно показать
или скопировать. Те же параметры доступны обычной секции `connection-secret`.

Все запросы проходят существующий POST выдачи с caller RBAC, проверкой UID и
владельца Secret, allowlist полей и аудитом без значений. Данные не включаются
в list/detail, URL или хранилище браузера; при уходе со вкладки запрос отменяется
и значения очищаются. Ещё не готовый Secret ограниченно опрашивается повторно;
при отказе RBAC показывается ошибка без полей.

## Создание связанных CR из одной формы

`ProductResource.create.afterCreate` запускает объявленные CreateResource actions
после записи основного CR. Каждый шаг содержит `actionId`, `inputMappings`
(fromInput/toInput) и необязательные `whenAny` — условия над входом формы.
Требуются стабильный nameFromInput, namespaced CurrentProject targets и обычные
права caller на каждую операцию. Рекурсия запрещена, шагов не больше четырёх.
Для зависимых настроек задавайте waitFor над основным CR и waitTimeoutSeconds
(до 45 секунд). Ожидание не принимает замену UID; при неготовности форма покажет
частичный результат. Связанные настройки S3 требуют Ready/Synced бакета.
Связанный ресурс проходит собственную canonical schema, lookup и RBAC.

Форма хранит requestId и хеш входа, без значений полей. Повтор одного подтверждения
продолжает только собственную операцию. При частичном успехе основной CR
сохраняется: пользователь видит ошибку и ссылку на него. Отклонённый связанный
шаг можно подтвердить повторно; неизвестный исход не отправляется заново без
проверки durable ActionInvocation. Это принятие Kubernetes CR, а не ожидание
готовности внешнего сервиса. Удаление связанных CR определяется их контрактами.

Mappings поддерживают valueMap с ключами в виде JSON исходного скаляра
(например, строка `true` для boolean true) и FilterNonEmpty с itemPath для отбора
элементов массива по непустому вложенному полю. Они не содержат встроенных
S3/GVK-путей. Дополнительные widgets JSON Schema: radio для enum, switch для
boolean, byte-size для числа байтов с x-dashboard-units (title/multiplier).
`x-dashboard-visible-when: {path: /enabled, value: true}` скрывает поле без потери
его значения. Группа может задать showTitle: false и separator: false, например
для поля имени перед основными секциями.
