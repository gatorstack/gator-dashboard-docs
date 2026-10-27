# Проекты и квоты

Проект состоит из namespace и объекта `Project` с фиксированным именем `project`.
Создание проекта через веб-интерфейс пока не предусмотрено. Создайте манифест
и примените его с административным контекстом:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-a
---
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: Project
metadata:
  name: project
  namespace: team-a
spec:
  name: Команда A
  description: Сервисы команды A
```

```sh
oc --context "$GATOR_CONTEXT" apply -f project.yaml
oc --context "$GATOR_CONTEXT" -n team-a get projects.dashboard.gatorstack.dev
```

Изменяйте отображаемое название в `spec.name`. Не переименовывайте объект:
CRD и webhook требуют `metadata.name: project`. Другой Project в этом namespace
создать нельзя. Доступ выдаётся отдельным [RoleBinding](rbac.md).

## Настроить квоту

Пример лимита на 20 ConfigMap:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: configmaps-count
  namespace: team-a
  annotations:
    title: Конфигурации проекта
spec:
  hard:
    count/configmaps: "20"
```

```sh
oc --context "$GATOR_CONTEXT" apply -f quota.yaml
oc --context "$GATOR_CONTEXT" -n team-a get resourcequota
```

Используйте отдельную квоту на каждый kind. Текущая страница Home / Квоты
настроена на objectCount с одним count-ключом в квоте.

| Ресурс | Ключ |
| --- | --- |
| ConfigMap | `count/configmaps` |
| Pod | `count/pods` |
| Service | `count/services` |
| PVC | `count/persistentvolumeclaims` |
| CR | `count/<plural>.<api-group>` |

Пользователям нужны get/list/watch ResourceQuota. В общих ролях Gator
эти права есть уже на уровне `auditor`. Поле использования заполняет Kubernetes.

## Удаление проекта

Удаление объекта Project убирает проект из обнаружения консоли, но не удаляет
namespace и его ресурсы. Удаление namespace удаляет его namespaced-объекты.
Планируйте очистку нагрузок, PVC и резервных копий отдельно от удаления записи
проекта. История биллинга не удаляется вместе с исходным CR.
