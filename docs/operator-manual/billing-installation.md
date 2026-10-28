# Установка биллинга

Gator Cost и OpenMeter устанавливаются отдельно от Dashboard. Эта инструкция
предназначена для администратора новой установки в одном кластере. Текущая
поставка использует namespaces `gator-cost` и `openmeter`; внутренние имена
сервисов и NetworkPolicy рассчитывают на эти имена.

Биллинг не подключает SSO Dashboard и пользовательский tenant-доступ.
Его UI открывается локальным port-forward. Внешние платежи сейчас не настроены.

## Требования

Нужны chart `charts/gator-cost` и `deploy/openmeter/chart` из комплекта Gator Cost,
Helm, административный `GATOR_CONTEXT` и StorageClass с достаточным местом.
По умолчанию требуются PVC: PostgreSQL 10 GiB, Kafka 10 GiB, ClickHouse 10 GiB,
Redis 1 GiB. Эти значения задают начальные размеры, а не гарантированный объём
долговременной истории. PostgreSQL и инфраструктура в текущих charts имеют
по одной реплике; полноценная HA-топология ими не создаётся.

Команды выполняются из каталога `gator-cost`. Не запускайте `make deploy`
как универсальный установщик другого кластера: текущие вспомогательные bootstrap
скрипты закреплены на учебном окружении. Ниже используется явная установка charts.

## 1. Подготовьте namespaces и credentials

```sh
oc --context "$GATOR_CONTEXT" create namespace gator-cost
oc --context "$GATOR_CONTEXT" create namespace openmeter
```

Для новой установки подготовьте защищённый каталог **вне Git** со следующими
файлами. Используйте случайные пароли/токены из вашего менеджера секретов;
значения в шаблонах заменяются до выполнения команд.

| Файл | Содержимое |
| --- | --- |
| `password` | Пароль PostgreSQL пользователя `gatorcost` |
| `readerPassword` | Отдельный пароль `gatorreader` |
| `dsn` | `postgres://gatorcost:PASSWORD@gator-cost-postgresql.gator-cost.svc:5432/gatorcost?sslmode=disable` |
| `readerDsn` | Такая же строка для пользователя `gatorreader` и его пароля |
| `token` | Случайный служебный API bearer для Gator Cost |
| `clickhousePassword` | Случайный пароль OpenMeter ClickHouse |

Пароли в DSN должны быть корректно URL-кодированы; случайные hex-пароли
не требуют дополнительного экранирования. Укажите путь защищённого каталога:

```sh
GATOR_BILLING_SECRETS='/secure/gator-billing'
oc --context "$GATOR_CONTEXT" -n gator-cost create secret generic gator-cost-postgresql \
  --from-file=password="$GATOR_BILLING_SECRETS/password" \
  --from-file=readerPassword="$GATOR_BILLING_SECRETS/readerPassword" \
  --from-file=dsn="$GATOR_BILLING_SECRETS/dsn" \
  --from-file=readerDsn="$GATOR_BILLING_SECRETS/readerDsn"
oc --context "$GATOR_CONTEXT" -n gator-cost create secret generic gator-cost-api-reader \
  --from-file=token="$GATOR_BILLING_SECRETS/token"
```

Namespace, Secret и ключи должны совпадать с конфигурацией ниже. Не заменяйте
credentials существующей БД такими командами: создание Secret не меняет пароль
в уже инициализированном PostgreSQL.

## 2. Настройте Gator Cost

Сохраните `cost-configuration.yaml`:

```yaml
apiVersion: cost.gatorstack.dev/v1alpha1
kind: CostConfiguration
metadata:
  name: default
spec:
  clusterID: main
  systemNamespace: gator-cost
  currency: RUB
  ledger:
    postgresql:
      connectionSecretRef: {name: gator-cost-postgresql, key: dsn}
      readerConnectionSecretRef: {name: gator-cost-postgresql, key: readerDsn}
    retention: KeepAll
  accounting:
    gapPolicy: LastKnown
    heartbeatInterval: 15s
    staleAfter: 45s
    maxEstimateAge: Unlimited
    conflictPolicy: Suspend
    initialObservation: StartNow
  reporting:
    api:
      url: http://gator-cost-api.gator-cost.svc:8080
      authTokenSecretRef: {name: gator-cost-api-reader, key: token}
    ui:
      currencySource: CostConfiguration
      showEstimates: true
      showCoverage: true
  evaluation:
    celCostLimit: 100000
  openMeter:
    enabled: true
    url: http://openmeter-api.openmeter.svc:8888
    workerInterval: 1s
    batchSize: 32
```

`clusterID` должен быть стабильным уникальным именем вашего кластера.
Сохраните `cost-values.yaml`, заменив StorageClass на свой:

```yaml
image:
  repository: valerahex/gator-cost
  tag: 20261028-01
postgres:
  storageClass: your-storage-class
  storageSize: 10Gi
collector:
  replicas: 1
workers:
  replicas: 2
sourcePermissions:
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get, list, watch]
```

Пример разрешает чтение ConfigMap для первого правила учёта. Для реального CR
замените/добавьте его точный GVR. Права на Secret для источников учёта не нужны.

```sh
oc --context "$GATOR_CONTEXT" apply -f charts/gator-cost/crds/
oc --context "$GATOR_CONTEXT" apply -f cost-configuration.yaml
helm upgrade --install gator-cost ./charts/gator-cost \
  --kube-context "$GATOR_CONTEXT" -n gator-cost \
  -f cost-values.yaml --wait --timeout 8m
```

До готовности OpenMeter журнал доставки может показывать его недоступность.

## 3. Подготовьте БД OpenMeter

OpenMeter использует отдельную базу и отдельного пользователя на том же PostgreSQL.
В защищённом каталоге подготовьте `openmeter-role.sql`, заменив пароль:

```sql
CREATE ROLE gatoropenmeter LOGIN PASSWORD 'REPLACE_WITH_PRIVATE_PASSWORD';
CREATE DATABASE openmeter OWNER gatoropenmeter;
```

Выполните один раз для новой установки:

```sh
oc --context "$GATOR_CONTEXT" -n gator-cost exec -i gator-cost-postgresql-0 -- \
  psql -X -q -v ON_ERROR_STOP=1 -U gatorcost -d postgres \
  < "$GATOR_BILLING_SECRETS/openmeter-role.sql"
```

## 4. Настройте OpenMeter

В том же защищённом каталоге подготовьте `openmeter-config.yaml`.
Замените три значения `REPLACE_...`: пароль ClickHouse, пароль PostgreSQL
и случайный portal token secret. Пароли должны совпадать с созданными выше.

```yaml
environment: self-hosted
ingest:
  kafka:
    broker: openmeter-kafka:9092
    brokerAddressFamily: v4
    socketKeepAliveEnable: true
    topicMetadataRefreshInterval: 10s
aggregation:
  clickhouse:
    address: openmeter-clickhouse:9000
    username: openmeter
    password: REPLACE_WITH_CLICKHOUSE_PASSWORD
    database: openmeter
sink:
  minCommitCount: 1000
  maxCommitWait: 1s
  namespaceRefetch: 1s
  namespaceRefetchTimeout: 1s
  kafka:
    brokers: openmeter-kafka:9092
    brokerAddressFamily: v4
    socketKeepAliveEnable: true
    topicMetadataRefreshInterval: 10s
  dedupe:
    enabled: true
    driver: redis
    config:
      address: openmeter-redis:6379
      database: 0
      expiration: 768h
postgres:
  url: postgres://gatoropenmeter:REPLACE_WITH_POSTGRES_PASSWORD@gator-cost-postgresql.gator-cost.svc:5432/openmeter?sslmode=disable
  autoMigrate: migration
credits:
  enabled: true
  enableCreditThenInvoice: true
unitConfig:
  enabled: true
portal:
  enabled: true
  tokenSecret: REPLACE_WITH_RANDOM_PORTAL_SECRET
notification:
  enabled: true
meters: []
```

```sh
oc --context "$GATOR_CONTEXT" -n openmeter create secret generic gator-openmeter-runtime \
  --from-file=clickhousePassword="$GATOR_BILLING_SECRETS/clickhousePassword"
oc --context "$GATOR_CONTEXT" -n openmeter create secret generic gator-openmeter-config \
  --from-file=config.yaml="$GATOR_BILLING_SECRETS/openmeter-config.yaml"
```

В несекретном `openmeter-values.yaml` достаточно выбрать StorageClass:

```yaml
storageClass: your-storage-class
```

```sh
helm upgrade --install gator-openmeter ./deploy/openmeter/chart \
  --kube-context "$GATOR_CONTEXT" -n openmeter \
  -f openmeter-values.yaml --wait --timeout 10m
```

Chart закрепляет совместимые образы API/workers и инфраструктуры OpenMeter.
Не заменяйте один из них произвольным latest без проверки всей поставки.

## 5. Проверьте и откройте UI

```sh
oc --context "$GATOR_CONTEXT" -n gator-cost get pods,pvc
oc --context "$GATOR_CONTEXT" -n openmeter get pods,pvc,cronjobs
oc --context "$GATOR_CONTEXT" -n gator-cost port-forward \
  svc/gator-cost-ui 19090:9090 --address=127.0.0.1
```

Откройте http://127.0.0.1:19090/. Проверьте состояние источников, OpenMeter
и доставки, затем подключите [первый тариф и правило](billing-configuration.md).
После изменения Pod port-forward нужно запустить заново.

Сохраните credentials в защищённом менеджере, а временные файлы удалите согласно
процессу вашей организации. Настройте [резервное копирование](backup.md) всех
хранилищ. Самостоятельный UI не следует публиковать как пользовательский портал:
SSO и разграничение доступа в нём пока отсутствуют.

## Подключите стоимость заказа к Dashboard

Создайте в namespaces gator-cost и Dashboard Secret `gator-billing-estimator`
с одинаковым случайным token. Используйте отдельный файл estimate-token в вашем
защищённом каталоге. Административный API token для этого не подходит.

```sh
oc --context "$GATOR_CONTEXT" -n gator-cost create secret generic gator-billing-estimator \
  --from-file=token="$GATOR_BILLING_SECRETS/estimate-token"
oc --context "$GATOR_CONTEXT" -n gator-dashboard create secret generic gator-billing-estimator \
  --from-file=token="$GATOR_BILLING_SECRETS/estimate-token"
```

Добавьте в values Gator Cost и примените его chart:

```yaml
estimate:
  enabled: true
  existingSecret: gator-billing-estimator
```

Добавьте в values отдельного chart Dashboard и примените chart:

```yaml
billing:
  enabled: true
  adapterName: default
  adapterURL: http://gator-cost-api.gator-cost.svc:8080
  existingSecret: gator-billing-estimator
```

Перед upgrade обновите CRD из комплекта: Helm не обновляет существующие CRD
автоматически. Для пакетов IaaS/VPC включите billing.enabled, укажите собственные
billing.projectNamespaces, проверьте family tariffPlanRef и установите свои ставки.
Collector должен иметь read-only sourcePermissions на каждый GVR этих правил.
Продуктовые пакеты сами не предоставляют цены для вашего облака.

Для произвольного продукта создайте [BillingBinding](../reference/billing-binding.md)
и MeteringPolicy. Убедитесь, что пользователь видит каталог и может создавать
целевой CR. Откройте Create-форму и сравните компоненты с принятым тарифом.
Прогноз не требует публикации административного Cost UI. URL адаптера задаёт
оператор, перенаправления HTTP запрещены; секрет не попадает в браузер.

Следите за Ready и памятью ClickHouse, состоянием sink worker, Kafka backlog и
возрастом outbox. Готовность API OpenMeter сама по себе не гарантирует доступность
агрегации. Увеличение лимитов не заменяет планирование ёмкости и backup.

Для небольшого и среднего потока используйте sink.minCommitCount: 1000 и
maxCommitWait: 1s: пакетная запись уменьшает количество вставок и служебных
логов ClickHouse. После изменения конфигурационного Secret перезапустите sink.
При восстановлении дождитесь обработки consumer lag; не сбрасывайте offsets.
