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

Установите [Gator Quotas](quotas.md), создайте ClusterQuotaTemplate с правилами
по нужным GVK, затем добавьте к namespace аннотацию:

```sh
oc --context "$GATOR_CONTEXT" annotate namespace team-a quotas.gatorstack.dev/use-quotas=true
oc --context "$GATOR_CONTEXT" -n team-a get quotas.quotas.gatorstack.dev
```

Контроллер копирует подходящие шаблоны и ставит quota-copied=true. Дождитесь
этого маркера перед созданием ресурсов. Последующие изменения шаблонов не
переписывают существующие Quota; лимиты проекта меняются явно администратором.
Home / Квоты показывает план/факт, резервы и остаток из Quota.status.
Права get/list/watch Quota выдаются проектным RoleBinding.

## Удаление проекта

Удаление объекта Project убирает проект из обнаружения консоли, но не удаляет
namespace и его ресурсы. Удаление namespace удаляет его namespaced-объекты.
Планируйте очистку нагрузок, PVC и резервных копий отдельно от удаления записи
проекта. История биллинга не удаляется вместе с исходным CR.
