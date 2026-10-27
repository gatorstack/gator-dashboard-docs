# Предопределённые роли

Роли назначаются через RoleBinding в namespace проекта. Техническое имя
сохраняется в roleRef, читаемое — показывается в каталоге.

| Техническое имя | Название | Разрешения |
| --- | --- | --- |
| `auditor` | Аудитор | Открытие Project/project и get/list/watch ResourceQuota |
| `viewer` | Наблюдатель | Auditor плюс разрешения просмотра подключённых продуктов |
| `editor` | Редактор | Viewer плюс создание/изменение/удаление ресурсов продуктов |
| `owner` | Владелец | Editor плюс управление Role/RoleBinding проекта и bind ролей каталога |

Встроенный IAM включён через iam.projectRoles.enabled: viewer читает местные
Role/RoleBinding, editor дополнительно меняет Role. Название уровня не выдаёт произвольные права на Pod, VM или БД.

Owner не получает управление ClusterRole/ClusterRoleBinding, Secrets,
impersonation или escalate. Он не может назначить cluster-admin только за счёт
роли owner. Если продукт явно добавляет права, оценивайте объединённые rules.

## Продуктовые роли

Для подключённого продукта создаются имена
`<product>.auditor`, `<product>.viewer`, `<product>.editor`, `<product>.owner`.
Каждый уровень включает предыдущий и get Project/project. Точные добавочные
правила задаются в role.rules соответствующего продуктового chart.
`rbac.roleCatalog.bindableRoles` только разрешает назначение этих ролей владельцами проектов.

Общие роли агрегируют соответствующие права всех подключённых продуктов.
Продуктовая роль ограничивает доступ настроенным набором продукта.
Настройка: [управление доступом](../operator-manual/rbac.md).

## Базовый доступ authentificated

Точное имя — `authentificated`. По умолчанию этот набор назначается группе
`system:authenticated`, включая ServiceAccount:

- ClusterRole разрешает обнаружение namespace, SelfSubjectReview и
  get/list/watch общего каталога User/Group/ClusterRole;
- Role в namespace Dashboard разрешает чтение Product/ProductPage и
  перечисленных ConfigMap схем.

Он не выдаёт чтение Project или Secrets, изменение User/Group или управление RBAC. Доступ
к конкретному проекту назначается отдельно. Если базовый набор отключён,
оператор должен выдать права обнаружения и каталога выбранным субъектам сам.

## Совместимость

`projectviewer` сохраняет прежние права чтения Project и квот для существующих
назначений. Он находится в режиме «Все роли Kubernetes». Для новых назначений
используйте auditor.

Штатная Kubernetes роль `view` не заменяет автоматически auditor: её состав
определяет Kubernetes и подключённая агрегация, а чтение нашего Project CR
нужно проверить отдельно. `cluster-admin` — административная роль всего кластера,
она не назначается обычным пользователям автоматически.


## Роли IAM

| ClusterRole | Права в namespace назначения |
| --- | --- |
| iam.auditor | Get Project/project и get/list/watch местных Role/RoleBinding |
| iam.viewer | Те же права; отдельного слоя данных IAM пока нет |
| iam.editor | Дополнительно create/update/patch/delete Role |
| iam.owner | Дополнительно управление RoleBinding и bind каталога |

Общий каталог читается через authentificated. Проектные роли не изменяют общие
User/Group/ClusterRole: для этого нужны отдельные кластерные права администратора.

Служебная **Role iam.passwords.editor** находится только в namespace credentials,
не входит в эту четвёрку и не имеет автоматических назначений. Она разрешает
get/create/update Secrets в этом namespace. Настройка iam.passwordRole.enabled;
делегирование — отдельным RoleBinding в credentials namespace, как описано
в [руководстве оператора](../operator-manual/rbac.md#делегировать-локальные-пароли).
