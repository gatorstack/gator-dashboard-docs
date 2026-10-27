# Действия над ресурсами

Действие описывается в `ProductResource.spec.actions`. Его форма использует
canonical JSON Schema того же действия; `ProductPage` связывает форму и кнопку.
Dashboard работает с указанным GVK и Kubernetes RBAC пользователя. Для нового
оператора не нужен отдельный компонент интерфейса.

## Изменить существующий CR

Например, добавьте в `spec.actions` ресурса дисков:

```yaml
- id: expand
  title: Увеличить размер
  executor: UpdateResource
  inputSchema:
    inline:
      type: object
      additionalProperties: false
      required: [size]
      properties:
        size: {type: integer, title: 'Новый размер, GiB', minimum: 1, maximum: 1000}
  strategy: GrowOnly
  mappings:
    - {fromInput: /size, toObject: /spec/forProvider/size}
  mutablePaths: [/spec/forProvider/size]
  preconditions:
    - path: /status/conditions
      conditionType: Ready
      values: ['True']
      message: Дождитесь готовности диска.
  resultPageRef: {name: iaas-disks-detail}
```

Сервер проверяет схему, исходный UID/resourceVersion и состояние, переносит
значение только в разрешённый путь. `GrowOnly` запрещает уменьшение числовых
полей, изменяемых mappings этой операции. Поля вне mappings сохраняются.

Для действия без параметров задайте объект с пустыми `properties` и
`additionalProperties: false`. Статический `patch` меняет только перечисленные
`mutablePaths`. Так запуск и остановка VM записывают `spec.forProvider.powerState`.
Разрешены пути внутри `spec` и отдельные строковые `metadata.labels` или
`metadata.annotations` с экранированным ключом JSON Pointer, например
`/metadata/annotations/example.org~1desired-state`. Целые карты metadata,
имя, namespace, UID, ownerReferences, finalizers и status действием не меняются.
Legacy actions без executor сохраняют прежнее поведение фиксированного patch;
для сохраняемой защиты от повторов укажите executor явно.

## Создать связанный CR

Для снимка из карточки диска действие использует другой ProductResource:

```yaml
- id: snapshot
  title: Создать снимок
  executor: CreateResource
  inputSchema:
    inline:
      type: object
      additionalProperties: false
      required: [name]
      properties:
        name:
          type: string
          title: Имя
          minLength: 1
          maxLength: 63
          pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
  targetResourceRef: {name: iaas-snapshots}
  sourceMappings:
    - {fromObject: /spec/providerConfigRef/name, toInput: /cloud}
    - {fromObject: /metadata/name, toInput: /volume/name}
    - {fromObject: /metadata/namespace, toInput: /volume/namespace}
    - {fromObject: /metadata/uid, toInput: /volume/uid}
    - {fromObject: /metadata/resourceVersion, toInput: /volume/resourceVersion}
  resultPageRef: {name: iaas-snapshots-detail}
```

Целевой `ProductResource/iaas-snapshots` должен иметь canonical create schema,
принимающую `name`, `cloud` и `volume`, и selection исходного диска. Действие
добавляет доверенные поля из прочитанного объекта и выполняет обычный create
целевого контракта: валидацию, lookup, selectors, scope и права. Пользователь
не может подменить cloud или исходный UID через форму. Для добавления описания
и меток объявите их в обеих canonical schemas и mappings целевого create.

Первая версия создаёт связанный CR в текущем проекте, в том же Product. Нужны
`get` исходника, `get/create` цели, чтение обоих контрактов и справочников.
Режим Gated и quotaBindingRef не обходятся через действие. Снимок имеет собственный
CR и сохраняется после удаления исходного диска; ownerReference на исходник
автоматически не добавляется.

`contextMappings` задаёт неизменяемые параметры формы из текущего CR:
`{fromObject: /spec/providerConfigRef/name, toInput: /cloud}`. Сервер проверяет
их при отправке. `initialMappings` имеет такой же формат, но только заполняет
редактируемые начальные значения, например размер диска из снимка. Сам по себе
initialMapping не является ограничением; минимальный размер должен проверяться
целевым контрактом.

## Подключить страницу и кнопку

```yaml
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: ProductPage
metadata:
  name: iaas-disks-snapshot
  namespace: gator-dashboard
spec:
  productRef: {name: iaas}
  resourceRef: {name: iaas-disks}
  title: Создать снимок диска
  view: Action
  action: snapshot
  navigation: {visible: false}
  schema:
    resourceSchemaRef: {operation: snapshot}
```

В schema карточки диска:

```yaml
x-dashboard-links:
  actions:
    - title: Создать снимок
      pageRef: {name: iaas-disks-snapshot}
```

После успешной записи `resultPageRef` открывает Detail-страницу результата с его
UID. Для UpdateResource это тот же ресурс; для CreateResource — созданный.
Страница результата должна принадлежать целевому ресурсу того же продукта.

## Повторы и неопределённый исход

Для executors клиент передаёт `requestId` вместе с параметрами, UID и
resourceVersion исходника. Интерфейс сохраняет ID подтверждения и хеш параметров
в sessionStorage до успешного ответа, включая перезагрузку страницы. Значения
параметров и токен в эту запись не сохраняются.

Сервер создаёт namespaced `ActionInvocation` с неизменяемым fingerprint контракта,
параметров и исходного UID. Полный input и credentials в нём не хранятся.
Состояния:

| Phase | Значение |
| --- | --- |
| Executing | Запись отправляется или её исход требует проверки |
| Applied | Kubernetes API принял изменение; UID результата сохранён |
| Rejected | Попытка достоверно отклонена до записи; можно подтвердить новый запрос |

Для нового CR используется детерминированное имя. Display name из формы
остаётся в поле, заданном mappings; Kubernetes metadata.name может отличаться.
Повтор с тем же requestId возвращает тот же UID. Изменённые параметры/контракт
с тем же ID отвергаются. Удалённый результат не создаётся заново тем же запросом.
Для update применяются resourceVersion и marker invocation в annotations.

После сетевой ошибки повторяйте **тот же** requestId. Если запись могла уйти,
но подтверждение и объект результата недоступны, сервер блокирует новую запись
этого запроса. Это защита от дублей, а не обещание исполнения при любом сбое.
Администратор проверяет invocation, marker и внешний объект перед восстановлением.
Не удаляйте invocation для автоматического «повтора»: так теряется доказательство
предыдущей попытки. Срок хранения записей должен покрывать допустимый срок повторов;
автоматическая очистка по умолчанию не включена.

```sh
oc --kubeconfig "$KUBECONFIG" -n my-project get actioninvocations
oc --kubeconfig "$KUBECONFIG" -n my-project get actioninvocation <name> -o yaml
```

Нужны `get/create` actioninvocations и `update` actioninvocations/status в проекте.
Общие editor/owner и продуктовые IaaS-роли поставляемого пакета включают эти
разрешения. Удаление invocation пользователю не требуется. Backend не использует
свои административные права для исполнения.

Applied не означает готовность VM, диска или снимка. Фактическое завершение и
ошибки берутся из status целевого CR. Этот механизм не заменяет workflow runtime,
approval, reservations квот или полный журнал облачных операций.

## Стабильное имя связанного ресурса

По умолчанию CreateResource резервирует имя на invocation. Если нужен один слот
на выбранную identity независимо от requestId, в целевом `create` задайте
`nameFromInput: [/disk/uid]`. Hash включает проект, ProductResource и target GVK.
Все указанные поля должны быть непустыми строками. Canonical schema, selections,
scope и RBAC всё равно проверяются до POST. Ключ выбирают по проверенной identity,
а не по редактируемой подписи. Это предотвращает создание двух attachment CR
для диска даже при разных подтверждениях. Слот сохраняется до удаления CR,
включая время работы finalizer. Существующий чужой invocation не усыновляется.
После удаления новое подтверждение может занять слот с новым UID; старый Applied
receipt не переносится на новый ресурс. Эта гарантия относится к создаваемым
через данный контракт CR, а не к произвольной прямой записи native API.

При создании mappings/selections могут писать в фиксированные ключи
`/metadata/labels/<escaped-key>` и `/metadata/annotations/<escaped-key>`. Значения —
строки; labels дополнительно проверяются по синтаксису Kubernetes. UID, namespace,
ownerReferences и status через mappings не меняются. Например, UID выбранного
ресурса можно сохранить в label для серверной relation, а имя — в annotation.

### Действие в модальном окне

Для коротких операций форму можно открыть поверх карточки исходного ресурса.
Настройка находится в canonical `inputSchema.inline` действия:

```yaml
x-dashboard-form:
  presentation: dialog
  sourcePageRef:
    name: iaas-instances-detail
  sourceTab: disks
  submitLabel: Подключить
```

`sourcePageRef` указывает Detail-страницу того же ProductResource. Пользователь
видит название исходника и параметры JSON Schema. «Отменить» и крестик возвращают
его в исходную вкладку без записи CR. Кнопка «Назад» браузера не открывает
отменённое окно повторно. После подтверждения открывается эта же
вкладка; состояние операции поступает через watch. Страница результата,
заданная `resultPageRef`, используется также модальными действиями с
`x-dashboard-form.successNavigation: result`. Например, создание снимка открывает
карточку нового снимка с его UID; отмена по-прежнему возвращает к исходному диску. Прямая ссылка на модальное действие также поддерживается.

Во время запроса повторное подтверждение блокируется. При конфликте версии
сохраняется ввод, а данные источника и каталоги перечитываются. Пользователь
проверяет актуальный выбор и повторяет действие. Неизвестный результат по-прежнему
проверяется по сохранённой ActionInvocation; повторный запрос не создаёт дубликат.

`x-dashboard-form.contextFields` показывает сведения из исходного объекта:

```yaml
x-dashboard-form:
  presentation: dialog
  sourcePageRef:
    name: iaas-disks-detail
  sourceTab: overview
  submitLabel: Расширить диск
  contextFields:
    - title: Облако
      path: /spec/providerConfigRef/name
    - title: Текущий размер
      path: /status/atProvider/size
      fallbackPath: /spec/forProvider/size
      suffix: ' GiB'
```

Это поля только для просмотра, с тем же форматом ResourceField, что в карточке.
Они не отправляются как параметры действия и не влияют на повтор запроса после
изменения ресурса. Для подтверждения без параметров используйте обычную JSON
Schema `type: object`, `properties: {}`; все ограничения исполнения остаются
в preconditions серверного контракта.

После подтверждения карточка показывает уведомление «Запрос принят». Это
подтверждение записи CR; завершения дождитесь в статусе. Уведомление можно закрыть,
после перезагрузки страницы оно не появляется повторно.
