---
title: Gator History — установка и хранение
---

[Gator History](https://github.com/gatorstack/gator-history) поставляется отдельным
оператором, репозиторием и Helm chart. Он хранит namespaced `HistoryRecord`
в API-группе `history.gatorstack.dev/v1alpha1` и удаляет истёкшие записи.
Внешняя БД не требуется. `HistoryPolicy` задаёт срок хранения, capture-каталог
и декларативные критерии результата. Capture требует cert-manager.

## Установка

Получите репозиторий и выберите контекст кластера. Ниже контекст назван `study`;
подставьте свой. Проверьте адрес API перед установкой:

```sh
git clone https://github.com/gatorstack/gator-history.git
cd gator-history
kubectl --context study cluster-info
kubectl --context study apply --server-side -f charts/gator-history/crds/
helm upgrade --install gator-history charts/gator-history --kube-context study \
  --namespace gator-history --create-namespace --wait
kubectl --context study -n gator-history rollout status deployment/gator-history
kubectl --context study get historypolicy dashboard
```

По умолчанию chart создаёт политику:

```yaml
apiVersion: history.gatorstack.dev/v1alpha1
kind: HistoryPolicy
metadata:
  name: dashboard
spec:
  retentionDays: 30
```

После установки collector и проверки native audit включите режим Dashboard:

```yaml
history:
  enabled: true
  mode: Webhook
  policyRef: dashboard
```

Обновите Dashboard своим Helm release. Collector/TLS/политику установите раньше
переключения режима и проверьте прямой oc CRUD. Обновления CRD применяйте до Helm.
Для private GHCR настройте imagePullSecrets; ключ не включайте в values/Git.

## Подключение продукта

История проекта включается в `ProductPage.spec.schema.inline`:

```yaml
type: object
x-dashboard-view: activity-history
```

В `x-dashboard-detail` страницы ресурса добавьте вкладку и секцию:

```yaml
tabs:
- {id: overview, title: Обзор}
- {id: history, title: История}
sections:
- title: Параметры
  tab: overview
  renderer: fields
  paths: [/metadata/name]
- title: История действий
  tab: history
  renderer: activity-history
```

Отображаемые значения изменения описываются в `ProductResource.spec`:

```yaml
history:
  fields:
  - path: /spec/size
    title: Размер, GiB
    showValues: true
  - path: /spec/description
    title: Описание
    showValues: false
```

Разрешены точные JSON Pointers, до 32 полей. `showValues` по умолчанию false.
Значения сохраняются только для скаляров до 512 байт. Объекты и массивы не
копируются целиком. Не разрешайте секретные поля; пути паролей, токенов, Secret
и cloud-init дополнительно блокируются backend. Настройка относится к будущим
записям и не раскрывает прошлые значения задним числом.

## Доступ и жизненный цикл

Dashboard имеет get/create/update HistoryRecord для контекста Audit-ID и get выбранной HistoryPolicy.
Его ServiceAccount применяется исключительно к журналу: операции с рабочими
ресурсами используют токен пользователя. Оператор имеет get/list/create/update/delete
HistoryRecord, get/list HistoryPolicy/Project/ProductResource и get объявленных
целевых GVK. Secret ему недоступны через API; TLS-ключи монтируются в protected namespace.

Пользователю нужны чтение Project и get/list HistoryRecord в namespace проекта.
Это доступ ко всей истории данного проекта, включая IAM-действия, выполненные
из него. Общие роли Dashboard auditor/viewer/editor/owner получают это право
при `history.enabled`; собственные роли настраиваются отдельно:

```yaml
apiGroups: [history.gatorstack.dev]
resources: [historyrecords]
verbs: [get, list]
```

При создании фиксируется `expiresAt`. Оператор удаляет запись при наступлении
более ранней даты: `expiresAt` или `occurredAt + текущий retentionDays`.
Уменьшение срока затрагивает существующие записи; увеличение — новые.
Цикл очистки выполняется каждую минуту. UID/resourceVersion preconditions защищают
от удаления пересозданной записи. Несколько реплик безопасны. `ActionInvocation`
имеет другую задачу — идемпотентность — и этим оператором не очищается.

Политика ограничивает возраст, а не количество записей. Планируйте ёмкость etcd
по реальной частоте операций. Физическое освобождение места после удаления CR
определяется стандартным compaction/defragmentation кластера. Оператор их не запускает.

## Наблюдение и восстановление

```sh
kubectl --context study -n team-a get historyrecords
kubectl --context study -n gator-history logs deployment/gator-history
kubectl --context study -n gator-history port-forward service/gator-history 8080:8080
# В другом терминале:
curl --fail http://127.0.0.1:8080/readyz
curl --fail http://127.0.0.1:8080/metrics
```

Метрики: `gator_history_deleted_total`, `gator_history_cleanup_errors_total`,
`gator_history_last_success_timestamp_seconds`. Ready означает успешный последний
цикл очистки. Отсутствующая политика даёт ошибку и сохраняет записи; восстановите
политику под прежним именем. Истёкшее скрывается из UI даже при задержке очистки.

Резервирование — вместе с etcd либо экспорт CR до удаления. Экспорт в БД,
архивация перед TTL в текущей версии не реализованы.
Удаление оператора прекращает физическую очистку, поэтому сохраняйте worker
до завершения переноса истории.

При обновлении на поддержку Secret outputs сначала обновите CRD Gator History:
operation access должна быть разрешена до включения выдачи credentials.
Сбой записи intent блокирует чтение. Recorder сохраняет факт обращения и
identity основного CR; доступ к Secret выполняется с caller token.

## Kubernetes audit webhook и результат

В values оператора включите `capture.enabled: true`. Его TLS endpoint принимает
`audit.k8s.io/v1 EventList`; native kube-apiserver backend настраивается отдельно.
На control plane установите policy уровня **Metadata**, исключающую Secret body,
HistoryRecord и status updates, и kubeconfig webhook backend с server CA и
клиентским сертификатом `gator-history-audit-client`. Endpoint проверяет CA и CN
`gator-history-audit`. Не используйте admission как подтверждение записи API.

Пример capture-политики:

```yaml
apiVersion: history.gatorstack.dev/v1alpha1
kind: HistoryPolicy
metadata: {name: dashboard}
spec:
  retentionDays: 30
  capture:
    catalogNamespace: gator-dashboard
    controllerSubjects:
    - namespace: crossplane-system
      name: crossplane
    - namespace: crossplane-system
      namePrefix: provider-example-
    - namespace: product-system
      name: product-controller
    result:
      success:
      - {type: Ready, status: 'True'}
      - {type: Synced, status: 'True'}
      failure:
      - {type: Synced, status: 'False', reasons: [ReconcileError]}
      observedGenerationCondition: Synced
      ignorePaths: [/spec/crossplane]
      timeoutSeconds: 1800
```

`capture.result` применяется к изменяемым namespaced GVK каталога. Дополнительные
GVK задаются `capture.resources`: apiVersion/kind/plural/product/resource, fields
и отдельный result. Дополнительный объект без result завершается по ответу API.
Для отличающегося lifecycle существующего каталога задайте такую же GVK и точные
product/resource выбранного контракта в resources: эта полная привязка заменяет
каталожное правило, включая fields/result. Например, отчёту с единственным
Ready не нужно назначать общие условия Ready/Synced инфраструктурных CR.
В capture.readRules выдайте только get нужных GVK, без Secret.
При смене target.apiVersion/kind у ProductResource синхронно обновите readRules:
разрешение прежней API-группы не даёт чтения нового XR. Проверьте права оператора
на новые GVK до проверки результатов операций.

Catalog aliases одной сущности дают одну запись, ограничения значений объединяются консервативно;
неоднозначные selectors/result требуют исправления конфигурации.

Ошибка наблюдения ресурса или обновления одной записи не останавливает остальные
результаты. Проблемная запись не получает ложный успех и повторно проверяется
в следующих циклах; ошибка частичного цикла остаётся в логах оператора.

`success` — все условия, `failure` — любое из объявленных условий/причин.
Свежесть подтверждают observedGenerationCondition, observedGenerationPath либо
объявленный наблюдаемый эффект. `matches` сравнивает desiredPath с observedPath
и обязателен даже при Ready=True. ignorePaths исключает служебные spec-поля
Composition из сравнения; бизнес-поля исключать нельзя. Старый статус или
неподтверждённое поколение не становятся успехом. Timeout даёт Unknown без повтора.
Удаление ожидает исчезновения UID. Следующая принятая пользовательская мутация
даёт Superseded незавершённой операции того же UID. Late initialization и
метаданные контроллеров не вытесняют её; подтверждается текущее поколение ресурса.

## Пользовательские операции и контроллеры

`capture.controllerSubjects` задаёт только доверенные identities reconcile.
Элемент содержит либо точный `username`, либо `namespace` и один из `name`/
`namePrefix` ServiceAccount. Префикс нужен для версионируемых provider accounts;
ограничьте его конкретным семейством контроллера. Не объявляйте все ServiceAccount
или namespace клиентов контроллерами: kubectl/CI с собственным токеном должен
оставаться инициатором операции.

Основной журнал показывает `Operation`. `ControllerStep` сохраняет настоящего
исполнителя в `spec.actor` и API-код; он раскрывается во вкладке шагов связанной
операции. Связь определяется по тому же target UID или единственному владельцу
из ownerReferences в текущем проекте. При наличии controller ownerReference
используется он. Цепочка ограничена 16 уровнями. Неоднозначное владение,
отсутствующий UID, неизвестная цепочка или другой проект не дают связи.
Внутренние повторы и HTTP 409 остаются шагами и не заменяют lifecycle-итог.

Оператор автоматически классифицирует существующие записи, не меняя immutable
spec, автора или срок хранения. Для старых записей он читает владельца только
у ресурса с тем же UID. Если объект уже удалён и владелец ранее не сохранён,
связь не восстанавливается по совпадению имени. Несвязанные технические запросы
доступны администратору через Kubernetes HistoryRecord до обычного TTL.
Связь описывает согласование между пользовательскими операциями, а не
распределённый tracing. Чтение операции и её шагов требует caller get/list
HistoryRecord; сервисный токен Dashboard не повышает права пользователя.

Validating webhook sideEffects=None проецирует безопасный UID/generation/diff
в audit annotations, не изменяя ресурс. Проекция ограничена 8 KB; значения при
переполнении опускаются. failurePolicy=Ignore сохраняет доступность Kubernetes
при её отказе; Metadata event может прийти без diff/достаточной identity.
Dashboard дополняет ту же canonical запись по Audit-ID, не создавая второй CRUD.
Порядок доставки не влияет на происхождение: создание и удаление без diff также
получают контекст консоли. При обогащении сохраняется неизменяемый spec исходной
записи, включая явно пустые значения, и подтверждённый статус collector.
Повторная доставка одного запроса идемпотентна. Разные запросы с повторённым
клиентом Audit-ID различаются временем API server и identity; Audit-ID сам по
себе не является гарантированно уникальным. Маркер console-context появляется
только при обогащении из Dashboard. Подтверждённый код API и итог ресурса
хранятся раздельно.

Для восстановления кратких сбоев native webhook дополните дисковым relay:
`capture.relay.enabled: true`, auditPath/dataPath по вашему control plane.
Relay не имеет Kubernetes API token, использует client TLS, bounded очередь
256 MiB и checkpoint. Первый запуск читает новые события; ретроспективный
backfill не обещается. Следите за ротацией исходного Metadata log и переполнением
очереди. Потеря источника за пределами этих буферов не восстанавливается сама.

```sh
kubectl --context study -n gator-history logs daemonset/gator-history-relay
curl --fail http://127.0.0.1:8080/capture-metrics
```

Метрики capture: gator_history_audit_events_total, gator_history_audit_errors_total.
Ready включает первоначальную загрузку capture-конфигурации. После ротации
client certificate обновите kubeconfig API server и перезапустите его клиент,
а также relay. Установите отдельный мониторинг доставки и длительного InProgress.

Новые проекции admission содержат отпечатки spec и поколения до/после записи.
Оператор принимает результат только для непрерывной цепочки подтверждённых
переходов контроллеров. При задержке аудита ручного изменения или разрыве цепочки
операция остаётся «Выполняется», затем переходит в «Результат неизвестен» по
timeout. Совпавший после нескольких изменений spec без подтверждённого поколения
не считается доказательством. Для старых записей доступны только сохранённые
итоговые отпечатки подтверждённых запросов; полная цепочка задним числом не
восстанавливается.

Бюджет памяти задаётся `resources.requests/limits` и `goMemoryLimit` (GOMEMLIMIT).
По умолчанию chart использует лимит контейнера `256Mi` и soft limit Go `192MiB`.
Для большего журнала можно задать, например, `512Mi` и `384MiB`, оставляя запас
для runtime. Проверяйте working set и restarts после полной обработки истории: 30
дней ограничивают возраст записей, но не их количество.

Связывание и проверка свежести используют подтверждённое время API server
`status.apiReceivedAt`. Позднее обогащение из Dashboard не отцепляет шаги,
начавшиеся до записи контекста консоли. Неизменяемый spec при этом сохраняется.
