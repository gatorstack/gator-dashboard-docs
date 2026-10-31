# Установка биллинга

Gator Cost 0.7 — сборщик и контроллеры CRD. История потребления, тарифные снимки,
бесплатные объёмы и начисления находятся в OpenMeter. Отдельной базы `gatorcost`
нет. Dashboard показывает детализацию и прайс-листы через обычный вход и RBAC.
Самостоятельный admin UI прежней версии не устанавливается.

Эта инструкция предназначена для новой установки. Для существующей базы
сначала выполните [перенос истории](#перенос-существующей-истории).

## Требования

Нужны Helm, `oc`, административный `GATOR_CONTEXT`, charts `charts/gator-cost`
и `deploy/openmeter/chart` из комплекта поставки, образы совместимого выпуска
и StorageClass. Типовой размер PVC: PostgreSQL OpenMeter 10 GiB, Kafka 10 GiB,
ClickHouse 10 GiB, Redis 1 GiB. Это начальные размеры, не предел роста истории.
Текущие charts имеют по одной реплике хранилищ; HA автоматически не создаётся.

Команды выполняются из каталога комплекта Gator Cost. Вспомогательные скрипты
учебного стенда не являются установщиком произвольного кластера.

## Подготовьте namespaces и credentials

```sh
oc --context "$GATOR_CONTEXT" create namespace gator-cost
oc --context "$GATOR_CONTEXT" create namespace openmeter
```

Подготовьте защищённый каталог вне Git с файлами `password` (случайный пароль
администратора PostgreSQL), `clickhousePassword`, `token` (служебный credential)
и `openmeter-role.sql`. В SQL задайте отдельный пароль роли OpenMeter:

```sql
CREATE ROLE gatoropenmeter LOGIN PASSWORD 'REPLACE_WITH_PRIVATE_PASSWORD';
CREATE DATABASE openmeter OWNER gatoropenmeter;
```

```sh
GATOR_BILLING_SECRETS='/secure/gator-billing'
oc --context "$GATOR_CONTEXT" -n gator-cost create secret generic gator-cost-postgresql \
  --from-file=password="$GATOR_BILLING_SECRETS/password"
oc --context "$GATOR_CONTEXT" -n gator-cost create secret generic gator-cost-api-reader \
  --from-file=token="$GATOR_BILLING_SECRETS/token"
oc --context "$GATOR_CONTEXT" -n openmeter create secret generic gator-openmeter-runtime \
  --from-file=clickhousePassword="$GATOR_BILLING_SECRETS/clickhousePassword"
```

Gator Cost не требует собственного DSN и reader-пользователя. Историческое имя
PostgreSQL Service сохранено для совместимости; сервер принадлежит OpenMeter.
Не меняйте Secret существующей БД без согласованной ротации её пароля.

## Установите OpenMeter

Сохраните в защищённом каталоге `openmeter-config.yaml`, заменив три значения
`REPLACE_...`. Пароль роли должен совпадать с `openmeter-role.sql`.

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
oc --context "$GATOR_CONTEXT" -n openmeter create secret generic gator-openmeter-config \
  --from-file=config.yaml="$GATOR_BILLING_SECRETS/openmeter-config.yaml"
```

Сохраните несекретный `openmeter-values.yaml`:

```yaml
storageClass: your-storage-class
postgresql:
  enabled: true
  namespace: gator-cost
  secretName: gator-cost-postgresql
  storageClass: your-storage-class
  storageSize: 10Gi
```

Сначала создайте workloads, дождитесь PostgreSQL и подготовьте его базу.
API OpenMeter сможет завершить запуск после создания роли и БД:

```sh
helm upgrade --install gator-openmeter ./deploy/openmeter/chart \
  --kube-context "$GATOR_CONTEXT" -n openmeter -f openmeter-values.yaml
oc --context "$GATOR_CONTEXT" -n gator-cost wait pod/gator-cost-postgresql-0 \
  --for=condition=Ready --timeout=5m
oc --context "$GATOR_CONTEXT" -n gator-cost exec -i gator-cost-postgresql-0 -- \
  psql -X -q -v ON_ERROR_STOP=1 -U gatorcost -d postgres \
  < "$GATOR_BILLING_SECRETS/openmeter-role.sql"
oc --context "$GATOR_CONTEXT" -n openmeter rollout status deployment/openmeter-api --timeout=5m
oc --context "$GATOR_CONTEXT" -n openmeter rollout status deployment/openmeter-sink-worker --timeout=5m
```

Создание роли/БД выполняется один раз на новой установке. Chart закрепляет
совместимые API/workers: не заменяйте один образ произвольным latest.

## Установите сборщик и CRD

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
  storageMode: OpenMeter
  epoch: openmeter-1
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
  evaluation: {celCostLimit: 100000}
  openMeter:
    enabled: true
    url: http://openmeter-api.openmeter.svc:8888
    workerInterval: 1s
    batchSize: 32
```

`clusterID` и `epoch` должны оставаться неизменными при обновлениях и восстановлении.
`epoch` отделяет новый поток от импортированного архива. Не меняйте его для replay.

Сохраните `cost-values.yaml`. Для приватного образа заранее подготовьте Secret
`registry-reader` типа `kubernetes.io/dockerconfigjson` с правом чтения образа:

```yaml
image:
  repository: ghcr.io/gatorstack/gator-cost
  tag: RELEASE_TAG
imagePullSecrets:
  - name: registry-reader
postgres: {enabled: false}
ui: {enabled: false}
collector: {replicas: 1}
workers: {replicas: 0}
sourcePermissions:
  - apiGroups: ['']
    resources: [configmaps]
    verbs: [get, list, watch]
```

Замените `RELEASE_TAG` тегом выбранного выпуска. Укажите точные GVR нужных
источников вместо примерного ConfigMap; права на Secret источников не нужны.

```sh
oc --context "$GATOR_CONTEXT" apply -f charts/gator-cost/crds/
oc --context "$GATOR_CONTEXT" apply -f cost-configuration.yaml
helm upgrade --install gator-cost ./charts/gator-cost \
  --kube-context "$GATOR_CONTEXT" -n gator-cost \
  -f cost-values.yaml --wait --timeout 8m
oc --context "$GATOR_CONTEXT" -n gator-cost get pods,collectorcheckpoints,leases
oc --context "$GATOR_CONTEXT" -n openmeter get pods,pvc,cronjobs
```

CollectorCheckpoint содержит текущие сессии, последние точки и очередь ещё не
подтверждённых событий. Он не хранит оплаченную историю. Не выдавайте tenant
доступ к служебному namespace и не редактируйте checkpoints вручную.

Подключите [первый тариф и правило](billing-configuration.md), затем проверьте
CostReport/PriceList нужного namespace в продукте Billing. Следите за DataReady,
возрастом pending, Kafka lag, sink, Redis dedupe и свободным местом ClickHouse.
При заполнении ограниченной очереди сборщик останавливает продвижение курсора.
События повторяются с тем же ID; после потери Redis или разрыва больше 31 дня
нужна сверка перед replay. Настройте [резервное копирование](backup.md).

## Перенос существующей истории

Переход с отдельной базы Gator Cost выполняется в окно обслуживания:

1. Остановите старый collector и admin UI; дайте workers доставить весь outbox,
   затем остановите workers. Сохраните защищённые pg_dump баз `gatorcost` и
   `openmeter`, конфигурацию OpenMeter и снимки остальных хранилищ.
2. Установите новые CRD и RBAC. Запустите бинарный мигратор с прежним
   CostConfiguration и ссылками на SQL Secret: `-mode=migrate-native -epoch=...`.
   Он переносит архив отдельным потоком без начислений, сравнивает payload/hash,
   количество записей и суммы каждого проекта. Подтверждение — checkpoint
   kind=migration со `status.migration.verified: true`.
3. Сохраните PostgreSQL Service/StatefulSet/PVC при удалении из Cost release
   (`helm.sh/resource-policy: keep` в его установленном manifest), затем передайте
   те же объекты в OpenMeter release. Не пересоздавайте сервер с пустым PVC.
4. Переключите CostConfiguration на `storageMode: OpenMeter`, тот же `epoch` и
   сохранённый `cutoverAt`; удалите `ledger`. Установите native collector с
   отключёнными postgres/UI/workers. Мигратор сохраняет следующие минуты сессий,
   metric cursors и остаток бесплатного объёма первого месяца.
5. Сверьте архив и отчёты, проверьте загрузку/скачивание S3 до и после бесплатного
   порога, проект с уже израсходованным порогом, restart и повторную доставку.
6. Только после сверки и отсутствия SQL клиентов удалите **базу `gatorcost`** и
   её DSN/reader credential. База `openmeter`, общий сервер и PVC сохраняются.

Повторный запуск мигратора после verified marker не сбрасывает текущее состояние.
Не запускайте старые workers после переключения. Бесплатный остаток первого
частичного UTC-месяца хранится в metadata native customer; его цена не выдаёт
ранее использованный объём заново. Следующий месяц использует полный лимит.

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
Прогноз использует внутренний HTTP adapter Cost. URL адаптера задаёт
оператор, перенаправления HTTP запрещены; секрет не попадает в браузер.

## Подключить детализацию Dashboard

Обновите CRD Cost из установленного комплекта до версии с `CostReport` и
обновите Cost chart. Затем из комплекта Gator Products установите Billing
в тот же namespace каталога, где установлен Dashboard:

```sh
helm dependency build products/billing/chart
helm upgrade --install gator-billing products/billing/chart \
  --kube-context "$GATOR_CONTEXT" --namespace gator-dashboard
```

В существующей umbrella-установке подключите этот chart как зависимость её
release; не создавайте второй release поверх уже принадлежащих ей объектов.
Обновите Dashboard до версии с общим report renderer. Убедитесь, что политики
учёта используют ID реальных Product в `dimensions.product`.

Назначьте нужным пользователям или группам `billing.viewer` через RoleBinding
в namespace проекта. Добавьте billing-роли в каталог разрешённых назначений
вашей установки. Обычного права читать Project недостаточно для CostReport.
Контроллер Cost должен читать/удалять CostReport и изменять их status; доступ к
исходным GVR нужен для проверки существования заказов.
