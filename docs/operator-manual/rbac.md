# Управление доступом

Gator использует Kubernetes RBAC. Учётная запись и членство в группе не выдают
права сами по себе. Для доступа к проекту назначьте Role/ClusterRole через
RoleBinding в namespace проекта.

## Выдать доступ пользователю

Пример: Alice может открыть проект `team-a` и читать его квоты:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: alice-auditor
  namespace: team-a
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: auditor
subjects:
  - kind: User
    apiGroup: rbac.authorization.k8s.io
    name: dex:alice
```

Для `viewer`, `editor` или `owner` меняется имя ClusterRole. Сверьте фактические
права по [таблице ролей](../reference/roles.md). IAM подключён как продукт: viewer читает Role/RoleBinding проекта,
editor меняет местные Role. Демонстрационные продукты без API прав не добавляют.

## Выдать доступ группе

Сначала задайте членство:

```yaml
apiVersion: user.gatorstack.dev/v1alpha1
kind: Group
metadata:
  name: developers
users: [alice, bob]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: developers-editor
  namespace: team-a
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: editor
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: dex:developers
```

Prefix в subject должен совпадать с настройкой kube-apiserver. Для ServiceAccount
используйте `kind: ServiceAccount`, имя и namespace без `apiGroup`.

## Кто может управлять IAM

| Задача | Какие права нужны дополнительно |
| --- | --- |
| Смотреть пользователей и группы | get/list/watch User/Group группы `user.gatorstack.dev` |
| Создавать и менять User/Group | create/update/delete соответствующих ресурсов |
| Создавать локального User | create User, create Secret в credentials namespace и возможность отката User при ошибке |
| Менять пароль | get User, get/update его Secret в credentials namespace |
| Смотреть каталог ClusterRole | get/list/watch ClusterRole на уровне кластера |
| Назначать роль | изменение binding и разрешение native Kubernetes на bind этой роли |

`owner` управляет проектными Role/RoleBinding и может назначать роли каталога.
Он не становится администратором общих User/Group. Чтение общего каталога
User/Group/ClusterRole сейчас выдаёт базовый authentificated всем вошедшим.
Если оператор отключил этот доступ, его выдают отдельно обычным ClusterRoleBinding;
при отсутствии списка техническое имя роли по-прежнему можно ввести вручную.

## Добавить роли реального продукта

Если установлен оператор продукта, добавьте его реальные API в основной values:

```yaml
rbac:
  roleCatalog:
    enabled: true
    group: Общие роли
    products:
      - name: postgresql
        group: DBaaS PostgreSQL
        rules:
          auditor:
            - apiGroups: [postgresql.example.org]
              resources: [clusters]
              verbs: [get, list, watch]
          viewer: []
          editor:
            - apiGroups: [postgresql.example.org]
              resources: [clusters]
              verbs: [create, update, patch, delete]
          owner: []
```

`postgresql.example.org/clusters` — условный API: замените его реальным GVR
оператора. Создаются `postgresql.auditor`, `.viewer`, `.editor`, `.owner`.
Каждый уровень включает предыдущие и право открытия Project. Общие роли
собирают права всех подключённых продуктов через Kubernetes aggregationRule.

Проверяйте, что разрешённый объект целиком пригоден для чтения аудитором:
Kubernetes RBAC не умеет скрывать отдельные поля spec/data.
Добавление Product в меню само по себе не добавляет продуктовых ролей.

## Проверить и отозвать доступ

```sh
oc --context "$GATOR_CONTEXT" auth can-i get projects.dashboard.gatorstack.dev/project \
  -n team-a --as=dex:alice
oc --context "$GATOR_CONTEXT" auth can-i list quotas.quotas.gatorstack.dev -n team-a --as=dex:alice
oc --context "$GATOR_CONTEXT" -n team-a get rolebindings
```

Команды с `--as` требуют административного права impersonation и проверяют
прямую identity; группы таким способом добавляются отдельно через `--as-group`.
Это операторская проверка, Dashboard impersonation не использует.
Окончательно проверьте вход под целевым пользователем.

Для отзыва удалите нужный binding. Учтите другие bindings и группы: разрешения
складываются. При изменении Group.users уже выданные JWT действуют до exp.
Постоянная блокировка выполняется через `User.disabled: true`, а не только
удалением User, который внешний вход может создать заново.


## Общий каталог и проектные назначения

User, Group и ClusterRole общие для кластера. По умолчанию authentificated
выдаёт system:authenticated get/list/watch этих объектов. Сюда входят и
ServiceAccount. Чтение не даёт Project, изменения учётных записей или Secret data;
запросы Dashboard по-прежнему выполняются с пользовательским токеном.

Кнопки из карточек User/Group/Role создают только RoleBinding текущего проекта.
Объектами прав IAM остаются native Role/RoleBinding; у iam.auditor/viewer
чтение обоих ресурсов, у iam.editor дополнительно изменение Role,
у iam.owner — управление RoleBinding и bind каталога. Эти права не разрешают
изменять кластерные User/Group/ClusterRole и не открывают другие проекты.
Общие viewer/editor/owner включают соответствующие права IAM штатной агрегацией.
Конфигурация: iam.projectRoles.enabled. Дополнительные продукты в
Продуктовые ClusterRole поставляются отдельными пакетами и агрегируются с IAM.
Имена ролей для назначения укажите в rbac.roleCatalog.bindableRoles; их API rules
определяет продуктовый chart.

## Делегировать локальные пароли

iam.passwordRole.enabled создаёт native Role iam.passwords.editor в
namespace iam.passwordNamespace. В study она включена; автоматического binding нет.
Namespace должен быть установлен заранее. Правила get/create/update Secrets
действуют только в этом namespace и не входят в проектные роли IAM.
Такой администратор может менять пароли любых локальных учётных записей,
включая привилегированные. Выдавайте роль как отдельное доверенное полномочие:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: local-password-admin
  namespace: gator-dex-users
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: iam.passwords.editor
subjects:
  - kind: User
    apiGroup: rbac.authorization.k8s.io
    name: dex:password-admin
```

Это служебный binding credentials namespace, он не создаётся проектной кнопкой
назначения. Для работы через Dashboard нужен также доступ хотя бы к одному
Project, например отдельный RoleBinding auditor. Для создания локальных User дополнительно нужны кластерные права
create/delete User; одна роль паролей их не даёт.

## Общие справочники flavors и images

Доступ к справочнику назначается отдельно от прав проекта. Эти правила
применяются и к общим справочникам ProductResource/lookup.

Допустим, оператор установил namespaced CRD Flavor группы catalog.example.org
с plural flavors, а объекты хранятся в namespace infra-catalog. Группа
platform-consumers должна их читать. Namespace и эта CRD должны существовать;
для другого API замените apiGroups/resources на реальные значения discovery.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: shared-flavors-reader
rules:
  - apiGroups: [catalog.example.org]
    resources: [flavors]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: shared-flavors-readers
  namespace: infra-catalog
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: shared-flavors-reader
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: platform-consumers
```

Назначение открывает только flavors в infra-catalog. Оно не даёт права создавать
VM, менять flavor или читать Secret. Для заказа VM нужны отдельные права на
InstanceV2 в проекте, а для интерфейса — доступ к Project и конфигурации каталога.
Watch можно не выдавать, если обновление вариантов не использует watch.

Если установленная CRD Flavor действительно cluster-scoped, вместо RoleBinding
используйте ClusterRoleBinding на ту же ClusterRole:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: shared-cluster-flavors-readers
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: shared-flavors-reader
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: platform-consumers
```

Это альтернативы для разных scope установленной CRD. ClusterRoleBinding для
namespaced flavors даст доступ во всех namespaces, поэтому не используйте его
вместо RoleBinding только ради общего namespace. RoleBinding в namespace проекта
не выдаёт права на cluster-scoped объекты или на infra-catalog.

Label selector в форме фильтрует предложения, но не уменьшает выданные RBAC
права. Для разделения закрытых каталогов нужны отдельные namespaces/назначения
либо безопасные проекции. Права на изменение каталога выдавайте операторам,
права чтения — потребителям. Прямую запись запрещённых provider IDs ограничивает
admission/gate; ограничения формы сами по себе этого не обеспечивают.
См. [правила Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/).

## Чтение квот

Gator Quotas поставляет ClusterRole gator-quotas-viewer с get/list/watch Quota
в quotas.gatorstack.dev. Она агрегируется в общие роли Gator и native view.
RoleBinding ограничивает доступ выбранным namespace. Template, ledger и
изменение лимитов доступны только администраторам. Для legacy projectviewer
укажите чтение нового Quota в standardRoles установки консоли.
