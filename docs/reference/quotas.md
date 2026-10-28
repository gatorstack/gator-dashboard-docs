# API квот

Все CRD: `quotas.gatorstack.dev/v1alpha1`.

| Kind | Scope | Поля |
| --- | --- | --- |
| ClusterQuotaTemplate | Cluster | spec.namespaceSelector; spec.quotaSpec.rules |
| Quota | Namespaced | spec.rules; status — план/факт |
| QuotaLedger | Namespaced | spec.reservations; служебный CAS журнал |

В `rules` от 1 до 32 записей. Обязательны уникальное `name`, `apiVersion`,
`kind`, `expression`, `hard` (строка), `message`. Необязательный `selector` —
обычный Kubernetes LabelSelector по объекту. namespaceSelector шаблона использует
такой же формат. Правила объединяются через AND. Одна и та же ёмкость может
сознательно ограничиваться несколькими правилами; их hard не складываются.

```yaml
apiVersion: quotas.gatorstack.dev/v1alpha1
kind: Quota
metadata:
  name: compute
  namespace: project-a
spec:
  rules:
    - name: cpu
      apiVersion: platform.example.org/v1
      kind: VirtualMachine
      expression: sum(.spec.cpu.count)
      hard: '100'
      message: Превышен лимит CPU
    - name: replicas-cpu
      apiVersion: apps.example.org/v1
      kind: WorkerPool
      expression: sum(.spec.replicas * .spec.cpu)
      hard: '64'
      message: Превышен лимит CPU worker pools
```

Выражение применяется к каждому выбранному объекту, затем вклады складываются.
`count(.)` даёт 1 на объект. `sum(.spec.path)` читает числовое поле.
В произведении допустимы до 8 путей, длина выражения до 512. Поддерживаются
spec и простые пути metadata.labels/annotations; путь состоит из dot segments,
без массивов/экранирования ключей с точкой. Скрипты, CEL, jq, деление, includeWhen,
status и внешние lookup не поддерживаются. Это намеренно ограниченный язык,
валидируемый до применения политики.

Целые, decimal и строковые Kubernetes Quantity неотрицательны. Plain decimal
суммируется точно; Quantity использует семантику Kubernetes ParseQuantity
(включая нормализацию до nano precision). `500m` = 0.5 base unit CPU,
`512Mi` = 536870912 base units/bytes. Hard использует те же единицы: для памяти
можно написать `1Gi`, status покажет `1073741824`. `1024` как MiB — только если
само поле измеряется в MiB, тогда hard тоже задаётся в MiB. Не смешивайте единицы
разных полей. NaN/Infinity/negative/null/missing/object/boolean дают ошибку.

`status.hard/used/reserved/available/overage` — map string→decimal string по
имени правила. `observedGeneration`, `lastCalculatedTime`, conditions Ready
и OverLimit позволяют отличить текущий факт от последнего известного.
`available=max(0,hard-used-reserved)`, `overage=max(0,used+reserved-hard)`.
Status не является механизмом блокировки или обещанием остатка для preview.

Аннотации namespace:

| Аннотация | Действие |
| --- | --- |
| quotas.gatorstack.dev/use-quotas: 'true' | Включить copy-once |
| quotas.gatorstack.dev/quota-copied: 'true' | Копирование завершено; повтор не нужен |

Quota хранит template-uid/template-generation только как происхождение копии.
Удаление template не удаляет Quota; изменение template не переписывает её.
Quota, созданная вручную, действует независимо от namespace annotations.

Записи через другую served API version отклоняются для покрытого source GVR:
используйте apiVersion правила. Для field quota scale/Pod resize subresources
отклоняются; меняйте основной CR. Count-only квота допускает scale/resize.
Status subresource не перехватывается и не может использоваться в формуле.
