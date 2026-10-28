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


## Секции заказа и метки

Задайте `x-dashboard-form.layout: sections`, чтобы вывести группы с отдельными
заголовками и разделителями без общей карточки и повторного названия формы.
Порядок и состав определяет `groups`; поля, не попавшие в группы, сохраняются.
Например, общие сведения и расположение разделяются независимо от GVK:

```yaml
x-dashboard-form:
  layout: sections
  groups:
    - {title: Общая информация, fields: [name, description, tags]}
    - {title: Расположение, fields: [cloud, zone]}
```

Для массива строк `key=value` используйте `x-dashboard-widget: tag-map`.
Редактор добавляет плашки через «Добавить метку». Нажмите плашку для изменения,
крестик — для удаления. Ключи должны быть непустыми и уникальными; ограничения
значений, длины и количества задавайте стандартными `items`, `maxItems` и
`uniqueItems`. Значения хранятся в прежнем массиве, не преобразуются в object.
Некорректные исходные строки остаются видимыми и требуют исправления.

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
