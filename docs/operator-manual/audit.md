---
title: Установка Audit Trails
---

Аудит использует namespaced `AuditTrail` и стандартную Crossplane Composition.
На трейл создаются конфигурация маршрута, ConfigMap состояния, точный Role/RoleBinding
и, для S3, native `AccountAccessKey`. Общий runtime собирает доверенные события и
доставляет их отдельной Kafka consumer group для каждого UID трейла. Runtime не
создаёт инфраструктуру; её жизненным циклом управляет Composition.

## Предварительные условия

Нужны Crossplane v2, cert-manager, Strimzi, [проектное логирование](logging.md),
история консоли и S3 integration с `S3Bucket`/`S3User`. Для всех источников важны
синхронизация часов и сохранность UID проекта/namespace. Интеграция подключается
отдельными Helm releases; страницы добавляются к существующему продукту мониторинга.

Получите комплекты `gator-products` и `gator-infrastructure` из организации
[gatorstack](https://github.com/gatorstack). Примените CRD Dashboard и установите
логирование/историю по их руководствам. Namespace runtime должен быть закрыт от
изменений проектными пользователями.

Подготовьте в нём Secrets:

- `gator-audit-ingest`: независимые случайные ключи `kubernetes` и `s3` для источников;
- `gator-audit-log-writer`: ключ `token` с правом записи во внутренний VMAuth;
- registry pull Secret `gator-audit-pull`, если образ недоступен анонимно.

Передавайте значения через защищённый secret manager или локальный ввод. Не
включайте их в values, командную строку, ConfigMap или исходники. Chart создаёт
сертификаты внутреннего HTTPS, KafkaUser/ACL и KafkaTopic. Его Function без
зависимостей использует `skipDependencyResolution`, чтобы повторное использование
стандартного пакета другими интеграциями не создавало конфликт dependency graph.

Пример values для существующей Kafka:

```yaml
image: ghcr.io/gatorstack/gator-audit:0.1.14
credentialsSecret: gator-audit-ingest
kafka:
  cluster: gator-logs
  brokers: gator-logs-kafka-bootstrap.logging.svc:9093
  topic: gator-audit-events
  replicas: 3
  partitions: 6
  retentionMs: 86400000
  retentionBytes: 268435456
logging:
  url: http://vmauth-logs.logging.svc:8427
ingestHost: audit-ingest.example.org
clusterIssuer: letsencrypt-prod
collector:
  enabled: false
```

В каталоге полученного комплекта `gator-products` выполните:

```sh
helm upgrade --install gator-audit providers/audit/chart \
  --kubeconfig /secure/kubeconfig -n logging \
  -f audit-values.yaml --wait --timeout 10m
oc --kubeconfig /secure/kubeconfig wait --for=condition=Established \
  crd/audittrails.audit.gatorstack.dev --timeout=120s
helm dependency build products/audit/chart
helm upgrade --install gator-audit-catalog products/audit/chart \
  --kubeconfig /secure/kubeconfig -n gator-dashboard
```

Каталог создаёт LogSource с `autoAccess`; общий LogAccessManager подключает
проекты автоматически. Runtime закрепляет UID grant и числовой AccountID в состоянии
трейла до доставки. Он пишет в `/ingest/tenants/<AccountID>/0/insert/jsonline`,
проверяет Project/namespace UID и не переключается на новый grant с прежним именем.
Служебные Kafka и writer credentials остаются в namespace runtime. В проекте ему
разрешено читать только Secret выбранного TLS-подключения или ключа данного трейла.

## Источники

**Консоль.** Runtime читает HistoryRecord и экспортирует только безопасную
метаинформацию действия. После рестарта возможна повторная публикация записей
за последние сутки; стабильный event ID позволяет устранить повторы.

**Kubernetes.** Настройте нативный audit backend API server с уровнем `Metadata`,
пропуском `RequestReceived`, ограниченной ротацией и закрытым доступом к файлам.
Collector повторно проецирует только разрешённые поля. Не включайте Request/Response
для Secret ради этого продукта. В k3s study предусмотрен идемпотентный
`kubernetes/configure-audit.sh`; он проверяет hostname, добавляет audit-аргументы к
существующим и перезапускает k3s только при изменении конфигурации. Для других
кластеров используйте штатный механизм конфигурации API server.

Встроенный DaemonSet рассчитан на control-plane k3s: проверьте `auditPath`,
`dataPath` и node selector перед включением `collector.enabled`. Ему нужны
read-only audit files и собственный каталог дискового буфера; Kubernetes API token
ему не выдаётся. Для иных топологий установите Vector у штатного audit backend.

**S3.** Включите native RGW ops JSONL и отдельный Vector из
`providers/audit/collectors/rgw-vector.json`. Передайте bearer через окружение или
закрытый конфигурационный файл. Его HTTP sink ведёт в `/ingest/s3`; TLS обязателен.
Collector совместим с отдельным S3 access/error logging и использует независимые
буфер и checkpoint. Не заменяйте существующий продуктовый collector.

Tenant из квалифицированного RGW bucket сопоставляется с protected Account,
затем с живыми Project/namespace UID. Неизвестная принадлежность не экспортируется.
Для предотвращения циклов служебные PutObject выбранного writer в архивные префиксы исключаются
из S3 audit source и доставки; чтение и действия других пользователей сохраняются. Выделяйте эти префиксы только под аудит.

## Надёжность и эксплуатация

Приём HTTP 202 возвращается после Kafka acknowledgements от всех ISR. Источники
используют дисковый буфер и повторяют временные ошибки. Каждая consumer group
подтверждает offsets после успешной доставки; checkpoints записываются пакетно.
S3 использует детерминированный ключ объекта. Дубликаты в logging/SIEM возможны.

В примере Kafka хранит до суток либо до 256 MiB на partition, что наступит раньше;
это ограниченная очередь, а не бессрочная гарантия. Ротация исходных файлов и
локальный disk buffer тоже ограничены. Контролируйте consumer lag, ошибки Vector,
состояние Kafka, `status.delivery`, свободное место и задержку от event time до
доставки. Превышение retention может привести к потере ещё не доставленных событий.

Учебный runtime имеет одну реплику и стратегию Recreate. Его обновление временно
закрывает изменение AuditTrail через fail-closed admission и приём источников;
буферы повторяют доставку после готовности. Это не HA-поставка. Изменение количества
реплик требует учёта общего счётчика состояния; не масштабируйте его произвольно.
Kafka partitions позволяют распределять очередь, но runtime наращивайте по
измеренной нагрузке и с согласованной моделью статуса.

При `S3AccessDenied` проверьте права выбранного пользователя. При `AccessKeyPending`
проверьте native provider и Secret владельца. Замена UID бакета, пользователя,
LogAccess либо проекта требует явного исправления конфигурации; не обходите
защиту переносом старых Secret. Удаление трейла должно удалить native ключ;
проверьте завершение provider finalizer, прежде чем считать отзыв завершённым.

Для SIEM используйте [настройку Wazuh](wazuh.md). Успешная TCP запись сама по себе
не подтверждает правило/индексацию: выполните действие и найдите его `event_id`
в индексе приёмника.

Usage внешних S3User/S3Bucket не использует replayDeletion: удаление трейла не
должно повторять ранее отклонённое удаление родителя, включая dry-run попытку.
При нехватке проектной квоты ConfigMap/Role/Secret Composition остаётся неготовой;
проверьте диагностику и лимиты проекта, а не пересоздавайте выбранный бакет.
