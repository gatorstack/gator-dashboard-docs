---
title: Управляемые зависимые ресурсы
---

Продукт может создавать ресурсы других продуктов внутри своей Composition.
Например, заказ базы данных создаёт балансировщик, который отображается в общем
списке балансировщиков, но изменяется через заказ базы данных.

В списке такой ресурс отмечен «Управляется заказом». В карточке показана
постоянная плашка со ссылкой на родительский заказ, если пользователь имеет к
нему доступ. Просмотр состояния, мониторинга, истории и логов сохраняет обычные
права. Прямые формы изменения, действия, удаление и встроенная удалённая сессия
недоступны. Прямая ссылка на форму не обходит ограничение.

## Включить защиту в Composition

На composed ресурсе задайте строковую аннотацию:

```yaml
metadata:
  annotations:
    dashboard.gatorstack.dev/managed: "true"
```

По умолчанию владельцем считается единственный `controller: true` в
`metadata.ownerReferences`. Crossplane добавляет такую ссылку на родительский XR
автоматически. Укажите аннотацию именно на конечном ресурсе, который должен быть
защищён: аннотация на Object bridge сама по себе не распространяется на его manifest.

Полный пример Composition для заранее установленного namespaced API
`example.org/v1alpha1`, kind `ExampleOrder`, со свойством `spec.managed: boolean`:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: example-managed-dependencies
spec:
  compositeTypeRef:
    apiVersion: example.org/v1alpha1
    kind: ExampleOrder
  mode: Pipeline
  pipeline:
  - step: dependencies
    functionRef:
      name: function-go-templating
    input:
      apiVersion: gotemplating.fn.crossplane.io/v1beta1
      kind: GoTemplate
      source: Inline
      inline:
        template: |
          apiVersion: v1
          kind: ConfigMap
          metadata:
            annotations:
              gotemplating.fn.crossplane.io/composition-resource-name: configuration
              gotemplating.fn.crossplane.io/ready: 'True'
              dashboard.gatorstack.dev/managed: {{ .observed.composite.resource.spec.managed | toString | quote }}
          data:
            example: managed by the parent order
```

Замените `function-go-templating` на имя установленной stock function-go-templating.
Crossplane должен иметь RBAC на composed GVK. Применяйте Composition к выбранному
кластеру обычным способом, например `oc --context <context> apply -f composition.yaml`.

Для явного владельца, например при создании через Object bridge, добавьте
`managed-by` как JSON-строку. Подставляйте UID из наблюдаемого родительского XR:

```yaml
metadata:
  annotations:
    dashboard.gatorstack.dev/managed: "true"
    dashboard.gatorstack.dev/managed-by: >-
      {"apiVersion":"example.org/v1alpha1","kind":"ExampleOrder","name":"production","uid":"actual-parent-uid"}
```

Поля `apiVersion`, `kind`, `name`, `uid` обязательны. Необязательный `namespace`
должен совпадать с namespace зависимости. Ссылка не может указывать на сам ресурс.
Она задаёт сообщение и переход в Dashboard; сама по себе она не создаёт
ownerReference, каскадное удаление или Crossplane Usage.

## Настроить доверенные identities

Защита Kubernetes API включена по умолчанию вместе с TLS webhook. Нужен Kubernetes
1.30 или новее с `matchConditions`. Установочные values задают точные Kubernetes
usernames контроллеров и административные группы:

```yaml
webhook:
  enabled: true
managedResources:
  enabled: true
  controllerUsers:
  - system:serviceaccount:crossplane-system:crossplane
  - system:serviceaccount:crossplane-system:my-provider-kubernetes
  statusUsers:
  - system:serviceaccount:crossplane-system:my-provider
  cleanupUsers:
  - system:kube-controller-manager
  - system:serviceaccount:kube-system:generic-garbage-collector
  adminGroups:
  - system:masters
```

Используйте реальные, желательно стабильные имена SA из DeploymentRuntimeConfig.
Helm заменяет массивы целиком: сохраняйте остальные нужные identities.

`controllerUsers` могут создавать, изменять и удалять управляемый ресурс, включая
включение и снятие режима. `statusUsers` могут обновлять только status и
финалайзеры с серверными метаданными; spec, data, labels, annotations и owners
остаются защищены. Если provider устанавливает external-name или другие аннотации,
ему нужны права writer в `controllerUsers`, а не только `statusUsers`.
`cleanupUsers` дополнительно могут удалять зависимости при очистке родителя.
`adminGroups` дают явное административное исключение. Обычные editor/owner и
произвольные ServiceAccount исключения не получают. RBAC по-прежнему требуется.

Webhook проверяет CREATE, UPDATE и DELETE основного объекта, status и finalizers.
Снятие аннотации, JSON patch, server-side apply, force delete и dry-run проходят
те же проверки. Он читает discovery API и не требует прав читать Secret или
данные произвольных ресурсов. При недоступности webhook помеченные ресурсы
защищены правилом `failurePolicy: Fail`; непомеченные не вызывают этот webhook.

Контракт поддерживает namespaced API без иных изменяемых подресурсов. При
включении проверяется discovery: API с `scale` либо другим изменяемым подресурсом,
в котором нет аннотаций основного объекта, отклоняется. После изменения подресурсов
CRD пересмотрите применимость контракта до использования нового API.

## Вернуть обычное управление

Composition может установить `dashboard.gatorstack.dev/managed: "false"` или
убрать аннотацию. Сделать это может только настроенный writer или администратор.
Обычный пользователь не сможет снять защиту через Kubernetes API.

Значение false не отключает reconciliation и не удаляет ownerReferences.
Согласуйте Composition, политику сохранения и владельца, чтобы ручные изменения
не перезаписывались и удаление родителя имело ожидаемый результат. Дополнительного
финалайзера для этой защиты нет: завершение удаления выполняют действующие
контроллеры и garbage collector.

## Владелец недоступен

Dashboard разрешает ссылку через каталог GVK текущего проекта с токеном самого
пользователя и проверяет UID. Нужны ровно один подходящий ProductResource и одна
страница Detail. При отсутствии прав, удалении, пересоздании родителя или
неоднозначном каталоге показывается общая плашка без названия и ссылки.
Блокировка остаётся включённой; пересоздание заказа с тем же именем не передаёт
ему прежнюю зависимость.
