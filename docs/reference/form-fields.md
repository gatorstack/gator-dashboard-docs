# Поля конструктора JSON Schema

Внешний вид формы задают аннотации канонической JSON Schema в ProductResource.
Типы остаются стандартными: `string`, `integer`, `object`, `array`. Не используйте
`type: radio-cards` или `type: object-array`.

## Карточки выбора

```yaml
type: string
title: Конфигурация
enum: [single, distributed]
default: single
x-dashboard-widget: radio-cards
x-dashboard-enumLabels:
  single: Один узел
  distributed: Несколько узлов
x-dashboard-enumDescriptions:
  single: Для задач на одном узле.
  distributed: Для распределённого размещения.
```

Значение формы остаётся выбранной строкой enum. Поддерживаются также числовые
enum. Переключатель доступен с клавиатуры; пустой выбор не возникает повторным
нажатием выбранной карточки.

## Массив объектов

```yaml
type: array
title: Узлы
minItems: 1
maxItems: 3
x-dashboard-widget: object-array
x-dashboard-array:
  fields: [partition, weight]
  itemTitle: Узел
  addLabel: Добавить узел
  removeLabel: Удалить узел
items:
  type: object
  additionalProperties: false
  required: [partition, weight]
  properties:
    partition:
      type: string
      title: Раздел
      enum: [a, b, c]
    weight:
      type: integer
      title: Вес
      minimum: 0
      default: 0
```

На широком экране показана таблица, на узком — блоки строк. Поля внутри строк
используют обычные controls схемы, включая lookup. fields задаёт порядок;
неперечисленные свойства не теряются и выводятся после перечисленных.
Недостающие строки добавляются до minItems; при уменьшении maxItems лишние
заполненные строки сохраняются до явного удаления. Максимум редактора — 64 строки.

Активные ограничения могут задаваться через allOf и if/then/else. Условия
вычисляются относительно текущего объекта формы или строки, ссылки $defs и
definitions — относительно корневой канонической схемы. Ограничения отображения
не заменяют полную проверку исходной схемы при отправке.

## Зависимый каталог в строке

В поле с x-dashboard-lookup и встроенным x-dashboard-catalog задайте inputBindings:

```yaml
x-dashboard-lookup: models
x-dashboard-catalog:
  target:
    apiVersion: science.example.org/v1
    kind: Model
    scope: Namespaced
    namespacePolicy: CurrentProject
  inputBindings:
    scope:
      fromInput: /scope
    partition:
      fromItem: /partition
  matchFields:
    - fromInput: /scope
      path: /spec/scope
    - fromInput: /partition
      path: /spec/partition
  option:
    labelPath: /metadata/name
```

Замените пример GVK своим установленным API. Само поле остаётся object с
обязательными name/namespace/uid/resourceVersion. fromInput читает корень формы,
fromItem — текущую строку массива. Каждый alias содержит ровно один источник;
допускается до 32 aliases. Условия каталога и selectors читают полученный контекст.

В canonical операции требуется selection, например `/nodes/*/model`. Сервер
проверяет каждую pinned identity от имени caller и заново вычисляет контекст
конкретной строки. Переданный клиентом alias не позволяет обойти эту проверку.
Без inputBindings сохраняется прежний корневой контекст lookup.

## Проекция строк в основной ресурс

```yaml
selections:
  - inputPath: /nodes/*/model
    lookupRef: models
    mappings: []
mappings:
  - fromInput: /nodes
    toObject: /spec/nodes
    transform: ProjectItems
    itemFields:
      /source/name: /model/name
      /source/uid: /model/uid
      /weight: /weight
```

itemFields сопоставляет целевой JSON Pointer с исходным JSON Pointer внутри
строки. В результат попадают только перечисленные поля. Отсутствующий источник,
неверный pointer или пересекающиеся целевые пути вызывают ошибку. До проекции
проверяются selections. Пределы — 32 поля и 1024 элемента; преобразование
одинаково применяется к созданию ресурса и предварительной оценке.

Виджеты, bindings и проекция не создают зависимые Kubernetes-ресурсы. Их
согласование остаётся задачей Composition/контроллера основного GVK.
