---
title: Gator History — установка и хранение
---

[Gator History](https://github.com/gatorstack/gator-history) поставляется отдельным
оператором, репозиторием и Helm chart. Он хранит namespaced `HistoryRecord`
в API-группе `history.gatorstack.dev/v1alpha1` и удаляет истёкшие записи.
Внешняя БД не требуется. `HistoryPolicy` задаёт срок хранения.

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

В values Dashboard включите producer:

```yaml
history:
  enabled: true
  policyRef: dashboard
```

Обновите Dashboard своим Helm release. Установите оператор и политику раньше
включения producer: недоступность журнала блокирует запись ресурса до мутации.
Обновления CRD применяйте явно до Helm upgrade.

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

Producer имеет только create/update HistoryRecord и get выбранной HistoryPolicy.
Его ServiceAccount применяется исключительно к журналу: операции с рабочими
ресурсами используют токен пользователя. Оператор имеет get/list/delete
HistoryRecord и get/list HistoryPolicy. Secret ему недоступны.

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
получение Kubernetes audit и архивация перед TTL в текущей версии не реализованы.
Удаление оператора прекращает физическую очистку, поэтому сохраняйте worker
до завершения переноса истории.

При обновлении на поддержку Secret outputs сначала обновите CRD Gator History:
operation access должна быть разрешена до включения выдачи credentials.
Сбой записи intent блокирует чтение. Recorder сохраняет факт обращения и
identity основного CR; доступ к Secret выполняется с caller token.
