# Продукты и страницы

Каталог настраивается объектами `Product` и `ProductPage` в namespace установки
Dashboard. Для устойчивой конфигурации используйте values отдельного продуктового chart.
Прямые манифесты также поддерживаются; один объект должен иметь одного владельца
конфигурации, чтобы Helm не отменял ручные изменения.

## Добавить продукт

Пример продукта с информационной страницей в `product-values.yaml`:

```yaml
catalog:
  products:
    - name: platform-info
      spec:
        name: Информация о платформе
        category: platform
        description: Правила работы и контакты поддержки
        badges:
          - title: New
            color: green
        menu:
          - name: platform-help
            title: Помощь
  pages:
    - name: platform-help
      spec:
        productRef:
          name: platform-info
        title: Помощь
        schema:
          inline:
            type: object
            x-dashboard-view: message
            description: По вопросам доступа обратитесь к администратору платформы.
```

Установите этот values-файл через отдельный продуктовый chart по
[инструкции поставки продуктов](product-packages.md). Затем откройте «Все сервисы» и найдите
«Информация о платформе». Обновите страницу браузера после изменения каталога.

Helm заменяет массивы целиком. При добавлении продукта сохраните в
`catalog.products` и `catalog.pages` все ранее нужные элементы.

## Настроить меню

`Product.spec.menu` задаёт порядок страниц. `name` — техническое имя ProductPage,
`title` — подпись. Страницы, не перечисленные в menu, тоже остаются видимыми.
`ProductPage.spec.group` помещает страницу в группу; без него она находится
в корне меню продукта.

`Product.spec.category` группирует продукты в каталоге. `logo` принимает HTTPS URL
или путь от корня сайта, например `/logos/database.svg`. При недоступном логотипе
показывается общая иконка. Допускается до восьми badges; цвета:
green, blue, purple, orange, red, gray.

## Выбрать тип страницы

| Схема | Результат |
| --- | --- |
| Обычная JSON Schema | Форма с проверкой данных |
| `x-dashboard-view: message` | Информационный текст |
| `x-dashboard-view: resources` | Список и необязательная карточка Kubernetes-ресурса |
| `x-dashboard-view: project-overview` | Главная проекта с карточками сервисов |
| `x-dashboard-view: iam` | Один из разделов IAM |

Обычная форма без resourceRef только проверяет данные. Форма с resourceRef и
view Create/Edit отправляет данные серверной операции ProductResource.

## Организовать один IaaS-сервис

Используйте один Product с именем `iaas`. Пункты меню этого сервиса —
«Виртуальные машины», «Диски», «Снимки», «SSH-ключи». Имена страниц лучше
задавать с префиксом сервиса: `iaas-instances`, `iaas-disks` и так далее,
поскольку ProductPage находятся в общем namespace каталога.

Для дальнейшего управления ресурсами используется ProductResource:
по одному описанию на instances/disks/snapshots/ssh-keys, по несколько страниц
на каждое описание. У каждой страницы собственная JSON Schema; формы операций
переиспользуют canonical schema операции. GVK, mappings и источники статуса
описываются один раз в ProductResource. Общий flavor-каталог может иметь своё
описание и использоваться в формах без отдельного пункта меню.

Укажите `navigation.visible: false` для карточек/форм, чтобы исключить их из меню.
Без этого поля страницы вне spec.menu также видны для совместимости. Не используйте отсутствие пункта menu как способ скрыть страницу
или ограничить доступ. Схема операции проверяется на сервере.
См. [поля ресурса](../reference/entities.md#productresource)
и [выбор конфигурации ВМ](resource-pages.md#выбор-flavor-на-форме).

## Хранить схему в ConfigMap

Вместо inline укажите:

```yaml
spec:
  productRef:
    name: platform-info
  title: Настройки
  schema:
    configMapRef:
      name: platform-form
      key: schema.json
```

ConfigMap должен находиться в namespace каталога. Саму конфигурацию можно
задать в `catalog.configMaps` продуктового chart:

```yaml
catalog:
  configMaps:
    - name: platform-form
      data:
        schema.json: |
          {"type":"object","properties":{"name":{"type":"string","title":"Название"}},"required":["name"]}
```

Если ConfigMap создаётся отдельно от Helm, перечислите его имя в
`catalog.schemaConfigMapNames`. Роль каталога даёт get только перечисленных
ConfigMap; list всех ConfigMap не требуется. Размер выбранной схемы — до 256 KiB.
В `schema` должен присутствовать ровно один источник: inline или configMapRef.

## Home и IAM

Home — необязательный пакет products/home/chart в gator-products. Он использует
обычные catalog.products/catalog.pages. При переопределении catalog.pages
сохраните весь желаемый список, включая квоты.

IAM включается `iam.enabled`. Его User/Group требуют CRD Gator Dex, а действия —
отдельных разрешений пользователя. Изменение каталога не выдаёт дополнительные
права к исходным ресурсам.

## Карточки сервисов на главной проекта

Карточка настраивается автором продукта в `Product.spec.projectCard.schema`.
Исходный список задаётся страницей ProductPage того же продукта. Это позволяет
добавлять сервисы и произвольные namespaced CRD без изменения кода Dashboard.
У исходного CRD должен быть установлен обслуживающий API; карточка сама его
не устанавливает.

Пример values добавляет сервис конфигураций. Сохраните в массивах остальные
нужные продукты, страницы и ConfigMap:

```yaml
catalog:
  products:
    - name: configuration
      spec:
        name: Конфигурации
        category: platform
        logo: /logos/database.svg
        menu:
          - {name: configuration-configmaps, title: Конфигурации}
        projectCard:
          schema:
            inline:
              type: object
              x-dashboard-view: project-card
              x-dashboard-card:
                rows:
                  - id: configmaps
                    title: Конфигурации
                    pageRef: {name: configuration-configmaps}
  pages:
    - name: configuration-configmaps
      spec:
        productRef: {name: configuration}
        title: Конфигурации
        schema:
          inline:
            type: object
            x-dashboard-view: resources
            x-dashboard-resource:
              apiVersion: v1
              kind: ConfigMap
              namespace: project
            x-dashboard-list:
              columns:
                - {title: Название, path: /metadata/name}
```

Установите обновлённые values через Helm по [инструкции установки](installation.md).
У пользователя должны быть доступ к Project, чтение Product/ProductPage и
`list/watch configmaps` в namespace проекта. Если там два ConfigMap,
на Home появится «Конфигурации» со строкой «2 Конфигурации». Нажатие строки
откроет список этих же объектов текущего проекта. Для другого типа объектов
укажите его apiVersion/kind в схеме страницы; строку карточки менять не нужно.

Добавляйте строки в `x-dashboard-card.rows`, чтобы показать несколько типов
объектов в одной карточке. Порядок строк совпадает с порядком массива.
Каждая строка имеет уникальный `id`, непустой `title` и `pageRef.name`.
Поддерживается 1–16 строк. Необязательный `title` корня схемы меняет заголовок
карточки; без него используется Product.spec.name. Логотип — Product.spec.logo.
Подпись строки выводится как задана, без автоматического склонения по числу.

Вместо inline можно вынести JSON в ConfigMap каталога:

```yaml
catalog:
  configMaps:
    - name: configuration-card
      data:
        card.json: |
          {
            "type": "object",
            "x-dashboard-view": "project-card",
            "x-dashboard-card": {
              "rows": [
                {"id":"configmaps","title":"Конфигурации","pageRef":{"name":"configuration-configmaps"}}
              ]
            }
          }
```

В существующем описании продукта замените `projectCard.schema.inline` на:

```yaml
projectCard:
  schema:
    configMapRef:
      name: configuration-card
      key: card.json
```

Нужен ровно один источник, до 256 KiB. Для ConfigMap вне Helm укажите имя
в `catalog.schemaConfigMapNames`, чтобы выдать ограниченное право get схемы.
Это не выдаёт доступ к ConfigMap исходного сервиса в проекте.

Home использует `x-dashboard-view: project-overview` по умолчанию. Если вы
переопределяли страницы пакета home, укажите этот режим в схеме home-overview и сохраните
другие страницы Home. Для существующей установки сначала обновите Product CRD
из поставляемого чарта по [порядку обновления](upgrading.md): Helm upgrade
самостоятельно не обновляет определения из crds.

Карточка видна, если хотя бы один доступный счётчик больше нуля. Нулевые строки
такой карточки сохраняются. Недоступные по RBAC источники скрываются; ошибки
схем и API показываются отдельно и не превращаются в нули. Счётчики следят
за Kubernetes watch, включая пустые источники. До 64 уникальных источников
на одну главную; одинаковые источники используют общую подписку внутри запроса.
Каталог и доступ перепроверяются при переподключении, не реже окончания
45-секундной сессии; после разрыва применяется задержка до 15 секунд.

Формы, сообщения, IAM-разделы и cluster-scoped объекты не являются источниками
счётчиков карточек. Для каждой строки нужна ресурсная страница текущего проекта.
Отдельные фильтры только для счётчика, внешние API, HTML и JavaScript в схеме
не поддерживаются. Нагрузка или пользовательский ресурс должны быть созданы
соответствующим сервисом: настройка карточки выполняет только чтение.

При создании ресурса generic `mappings` могут записать целую строковую карту
в `/metadata/labels` или `/metadata/annotations`. Сервер проверяет все ключи и
значения по правилам Kubernetes; для labels действуют ограничения значений меток.
После этого `labelMappings` задают обязательные метки из параметров операции.
При изменении существующего ресурса разрешены только явно объявленные отдельные
ключи metadata: целая карта не заменяется, чтобы не потерять метки контроллеров.

## Группированные показатели и региональная разбивка

Для списка показателей вместо обычной таблицы задайте `x-dashboard-list.metrics`.
Этот layout работает с любым GVK: структура данных определяется путями JSON
Pointer. Например, Quota хранит элементы в spec.rules, а факт/план — в status maps.
Фрагмент schema для такой структуры:

```yaml
type: object
x-dashboard-list:
  metrics:
    groupPath: /spec/group
    itemsPath: /spec/rules
    idPath: /name
    titlePath: /title
    metricPath: /metric
    scopePath: /scope
    unitPath: /unit
    usedPath: /status/used
    hardPath: /status/hard
    reservedPath: /status/reserved
    conditionsPath: /status/conditions
    conditionType: Ready
    observedGenerationPath: /status/observedGeneration
    nearPercent: 80
    nameTitle: Квота
    usageTitle: Использование
    searchPlaceholder: Название или ID квоты, группа
    scopeLabel: Регионы и зоны
  columns:
    - title: Имя
      path: /metadata/name
```

Обязательны groupPath, itemsPath, idPath, usedPath и hardPath. id/title/metric/
scope/unit читаются относительно элемента itemsPath, остальные пути — относительно
исходного CR. Карты hard/used/reserved индексируются по id. metric по умолчанию
равен id, scope без значения отображается как «Всего». Группировка metric не
смешивает разные CR или namespace. Общий показатель должен храниться отдельным
элементом; renderer не складывает пересекающиеся области и не конвертирует единицы.

Layout предоставляет поиск, фильтр областей, сортировку и сворачиваемые группы
с/без потребления. nearPercent задаёт порог «Почти закончились» (по умолчанию
80%, допустимо 1–100); индикатор учитывает резерв. conditionsPath требует
conditionType. При несовпадении observedGeneration с metadata.generation или
условии не True факт помечается неактуальным. Отсутствующий факт остаётся «—».
Фильтр области сохраняет общий показатель и показатели без региональной разбивки.

В этом layout selectable не поддерживается. Он не добавляет запросов увеличения,
прав изменения или нового backend API. Работают прежние discovery, watch и RBAC
пользователя. Настройка только JSON Schema не создаёт расчёт или enforcement:
источник обязан сам публиковать достоверные usage/limit maps.
