# Метки и аннотации

## Роли IAM

| Ключ | Где | Значение |
| --- | --- | --- |
| `iam.gatorstack.dev/display-name` | Аннотация Role/ClusterRole | Читаемое название |
| `iam.gatorstack.dev/description` | Аннотация IAM-объекта | Описание |
| `iam.gatorstack.dev/role-group` | Аннотация ClusterRole | Группа предопределённого каталога |
| `iam.gatorstack.dev/standard-role` | Label ClusterRole со значением true | Включение в предопределённый каталог |
| `iam.gatorstack.dev/managed-role` | Label роли со значением true | Управляемая роль, изменение из UI запрещено |
| `iam.gatorstack.dev/aggregate-to-LEVEL` | Label составляющей ClusterRole | Участие в native aggregationRule общего уровня |

`LEVEL` — auditor, viewer, editor или owner. Значения labels — строки `"true"`.
Метки описывают отображение и управление каталогом; разрешения по-прежнему
задаются rules. Не переименовывайте metadata.name существующей роли ради
изменения отображаемого названия.

## Квоты

| Ключ | Где | Назначение |
| --- | --- | --- |
| quotas.gatorstack.dev/use-quotas | Аннотация Namespace, 'true' | Скопировать подходящие шаблоны |
| quotas.gatorstack.dev/quota-copied | Аннотация Namespace, 'true' | Копирование завершено; не повторять |
| quotas.gatorstack.dev/template-uid | Аннотация Quota | Происхождение копии |
| quotas.gatorstack.dev/template-generation | Аннотация Quota | Ревизия исходного шаблона при копировании |

Удаление quota-copied разрешает копирование новых шаблонов, сохраняя уже
созданные квоты. Изменение шаблона не перезаписывает проектные лимиты.
[Порядок настройки](../operator-manual/quotas.md).

## Метки учёта

У MeteringPolicy нет обязательной общей метки для всех продуктов. Правило
может выбирать объект по любым labels и извлекать project/instance через
указанные JSON Pointer. Например, `billing: enabled` — условие выбранного
в документации примера, а не автоматическое включение биллинга платформы.

Для пути к ключу с `/` используйте `~1`, например
`/metadata/labels/cost.gatorstack.dev~1project`.
