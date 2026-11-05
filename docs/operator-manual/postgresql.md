# Установка Managed PostgreSQL

Сервис поставляется отдельным chart `products/postgresql/chart` из комплекта
Gator Products. Он устанавливает категорию DBaaS, продукт, CRD, роли, внешнюю
интеграцию и подключения к квотам, биллингу, мониторингу и логированию.
Пересборка Dashboard не требуется.

## Предварительные условия

- Dashboard 0.26 или новее с ProductResource, radio-cards/object-array,
  inputBindings/ProjectItems, connection-secret, monitoring и logging GVK.
- Crossplane 2.x, stock provider-kubernetes 1.4.1 (namespaced Object) и namespaced provider-openstack; в каждом проекте настроен
  `ProviderConfig` с именем региона и проектным application credential Secret.
- VPC подсети имеют Ready, external ID и аннотацию
  `vpc.gatorstack.dev/zone`; несколько регионов имеют независимые настройки.
- Gator Quotas, Cost/OpenMeter и нативные VictoriaMetrics/VictoriaLogs с
  проектной изоляцией. Namespace проекта содержит `Project/project`.
- SSH/metric маршруты от служебных pod к host Floating IP и HTTPS-маршрут от
  хостов к ingress логирования. SSH host keys берутся из authenticated Nova
  console; `StrictHostKeyChecking` остаётся включённым.
- Registry Secret для закрытых образов существует в служебном namespace и
  namespace Crossplane. Credentials не включаются в product values.

## Values и установка

Пример `postgresql-values.yaml` для одного проекта и региона:

```yaml
systemNamespace: gator-postgresql-system
createSystemNamespace: false
projectNamespaces: [project-a]
controller:
  imagePullSecrets: [{name: registry-pull}]
ansible:
  install: true
  namespace: crossplane-system
  imagePullSecrets: [{name: registry-pull}]
profile:
  operatorCIDRs: [192.0.2.10/32]
  minimumClientPrefix: 8
  monitoringBackend: platform
  logIngestURL: https://postgresql-logs.example.org/postgresql/insert/jsonline
  regions:
    region-one:
      zones: [region-one-a, region-one-b, region-one-c]
      externalNetworkName: external-region-one
      imageID: REPLACE_WITH_UBUNTU_24_04_IMAGE_UUID
      sshUser: ubuntu
      flavors:
        small: {id: REPLACE_WITH_FLAVOR_UUID, vcpu: 2, memoryGiB: 2}
classes:
- {name: small, title: '2 vCPU · 2 GiB RAM', vcpu: 2, memoryGiB: 2}
logging:
  backend: native
  storageURL: http://vlsingle-customers.logging.svc:9428
  storageNamespace: logging
  ingressHost: postgresql-logs.example.org
  accountIDs: {project-a: 1001}
billing:
  enabled: true
  tariffPlan: postgresql
  activePlan: postgresql-plan
  startAt: '2026-11-01T00:00:00Z'
  tariffPlans:
  - name: postgresql-plan
    spec:
      key: postgresql
      displayName: PostgreSQL
      currency: RUB
      validFrom: '2026-11-01T00:00:00Z'
      rates:
      - {key: postgresql-cpu, price: '0.06', unit: core-minute}
      - {key: postgresql-ram, price: '0.012', unit: GiB-minute}
      - {key: postgresql-storage, price: '0.0003', unit: GiB-minute}
quotas:
  enabled: true
  clusters: '10'
  hosts: '30'
  vcpu: '120'
  memoryGiB: '120'
  storageGiB: '3000'
```

Приведённые цены — пример. Замените их, UUID, адреса, accountID и даты своим
профилем. accountID должен совпадать с `ProjectMonitoring/project`; также
должен существовать read route этого tenant в backend логирования.
Назначения `ProjectSubscription` и действующие планы неизменяемы: новый тариф
публикуется отдельной ревизией, с явно выбранной датой перехода.
При первом создании `startAt` должен находиться в будущем относительно часов
кластера; выберите дату после завершения установки. При повторных установках
сохраняйте исходную дату. Для разных проектов можно задать
`billing.startAtByNamespace`, не меняя уже созданные назначения.

Из корня полученного комплекта Gator Products:

```sh
helm dependency build --skip-refresh products/postgresql/chart
helm upgrade --install gator-postgresql products/postgresql/chart \
  --kube-context my-cluster -n gator-dashboard \
  -f postgresql-values.yaml --wait --timeout 10m
```

Chart устанавливает стандартные go-templating/auto-ready functions и
provider-kubernetes. Если Kubernetes provider ещё не установлен, первый Helm
install выполните с `--set composition.createProviderConfig=false`, дождитесь
Established `clusterproviderconfigs.kubernetes.m.crossplane.io`, затем повторите
Helm upgrade со значением `composition.createProviderConfig=true`. Это позволяет
штатному package manager установить provider API до его использования.

Для уже установленного совместимого provider-kubernetes задайте
`composition.installKubernetes: false` и его runtime service account в
`composition.kubernetesServiceAccount`; chart выдаст этому аккаунту только права
моста PostgreSQL. Второй конкурирующий provider не устанавливайте.

При обновлении обычных CRD примените текущие CRD комплекта перед Helm upgrade: Helm не
обновляет содержимое `crds/` существующего release автоматически.

В примере служебный namespace и registry Secret подготовлены заранее, поэтому
`createSystemNamespace: false`. Если namespace должен создавать сам chart,
используйте значение по умолчанию `true`. Не переключайте его для namespace,
который уже принадлежит release. Создаваемый chart namespace помечен `keep`:
Helm uninstall сохраняет его с managed resources и дисками; работающие заказы
перед удалением установки нужно удалить через их GVK.

```sh
kubectl --context my-cluster apply --server-side \
  --field-manager=gator-postgresql-crds -f products/postgresql/chart/crds/
```

В `CostConfiguration.spec.pricing.families` добавьте семейство `postgresql` с
тремя rate keys из примера, сохраняя остальные семейства. Назначьте продукт
`postgresql` и единицы `vCPU·мин`/`ГиБ·мин`. Это подключает прайс и активный
тариф к общему пользовательскому разделу расходов; сам collector использует
установленные MeteringPolicy и ProjectSubscription.

## Проверка

```sh
kubectl --context my-cluster get providers.pkg.crossplane.io
kubectl --context my-cluster -n gator-postgresql-system get deployments
kubectl --context my-cluster -n project-a get networkv2s.networking.openstack.m.crossplane.io
kubectl --context my-cluster -n project-a get subnetv2s.networking.openstack.m.crossplane.io
kubectl --context my-cluster -n project-a get quota postgresql
kubectl --context my-cluster -n project-a get postgresqlclusters
```

Ansible provider должен быть Healthy, контроллер и log ingest — Ready.
Форма заказа получает регионы и зоны из профиля, флейворы — из общего native каталога.
Пользователь отдельно выбирает готовую сеть и подсеть каждого хоста; каталог
PostgreSQLPlacement остаётся для совместимости прежних заказов. После заказа проверьте SQL read/write,
метрики и серверное событие, а для Patroni — replication и switchover.

## Ответственность компонентов

`PostgreSQLCluster` — основной namespaced Crossplane XR. Chart содержит XRD и
Composition со стандартными `function-go-templating` и `function-auto-ready`.
Composition создаёт OpenStack MR, ProviderConfig, AnsibleRun и monitoring CR через
stock namespaced provider-kubernetes `Object`. Мост сохраняет native CR в protected
namespace и позволяет работать с cluster-scoped Ansible API. Между namespace не
создаются ownerReferences. `Usage` удерживает providers, порты, security groups и
закрытые credentials, пока не удалены их потребители.

Обычный composed `PostgreSQLRuntime` обслуживается адаптером только для подготовки
credentials, доверенного SSH inventory/playbooks и проверки SQL/exporter. Его
RBAC не разрешает запись инфраструктуры или AnsibleRun. Запросы SQL-сущностей
передаются родительской Composition через безопасные refs/hash в status.
Используется исходный tenant проекта. Image/flavor profile
закрепляется в Secret при создании: изменение values относится к новым заказам
и не заменяет диски существующих кластеров.

Crossplane `AnsibleRun` выполняет закреплённую MIT-коллекцию Autobase. Пароли,
inventory и SSH private key передаются через Secret refs; `AnsibleRun.spec` не
содержит секретных значений. `ansible_no_log` включён. Операции и пользовательские
сущности имеют отдельные CR и run identities. Защита удаления и finalizers
удерживают заказ до очистки собственных ресурсов. XRD, Composition и provider/function packages помечены Helm policy `keep`, чтобы
удаление release не удаляло API с работающими заказами. Helm uninstall не является
способом удаления работающих заказов: сначала завершите их lifecycle.

Пакет provider-ansible v0.8.0 использует `upbound-system` для shard lease.
Chart создаёт этот namespace и Role для единственного lease, привязанную к
служебному аккаунту провайдера в `ansible.namespace`. Не устанавливайте второй
экземпляр того же провайдера с конкурирующим lease. Для уже установленного
совместимого провайдера используйте `ansible.install: false` и настройте runtime
с закреплённой коллекцией самостоятельно.

MetricSource и MetricOwnershipPolicy принадлежат сервису. VictoriaLogs ingest
использует отдельный write-only token кластера; VMAuth фиксирует tenant и UID
записи. Vector передаёт только разрешённые поля PostgreSQL JSON log. Запросы
логов повторно проверяют caller RBAC и identity основного CR.

Карточка кластера получает графики через штатную секцию monitoring в ProductPage:
bindings читают metadata.uid и spec.region. PromQL выбирает cluster_uid и region,
а проектный gateway сохраняет tenant/RBAC-изоляцию. Нужны штатные права
monitoring.viewer; доступ к заказу сам по себе их не заменяет. Запросы выполняются
при открытой вкладке «Мониторинг», состояние условий находится в «Диагностике».

Exporter устанавливается из upstream PostgreSQL exporter 0.20.1 с закреплённым
SHA-256. Системная служба использует local peer authentication и поддерживает
PostgreSQL 16–18; устаревший бинарный файл пакета Ubuntu не используется.
Для другой архитектуры администратор задаёт `profile.exporterArtifact` с
`url`, `sha256` и относительным путём `binary` внутри архива. Образы study и
артефакт по умолчанию рассчитаны на amd64. Vector 0.51.1 проверяет UTC timestamp
и удаление чувствительных полей встроенным тестом до запуска коллектора.

Роли `postgresql.auditor/viewer/editor/owner` управляют GVK сервиса через native
Kubernetes RBAC. Они не дают доступ к служебным MR, AnsibleRun, provisioning
credentials и SSH. Доступ к конкретному connection Secret задаётся созданной
в namespace проекта Role `postgresql-<идентификатор-заказа>` и явным RoleBinding.
Обычный `viewer` не получает автоматического чтения Secret.

В этой версии нет backup/PITR, resize и major upgrade. Для производственного
использования отдельно обеспечьте нужное хранение и проверку восстановления.
Логические зоны учебного OpenStack сами по себе не гарантируют физическую
независимость отказов.


## Перенос существующего кластера

Переход с версии 0.1 выполняется над тем же заказом и GVK, без удаления CRD,
VM или дисков. Используйте включённый в комплект инструмент
`providers/postgresql/scripts/migrate-to-composition.py` с явными namespace,
именем, UID и защищённым файлом snapshot. Он не сохраняет Secret values или
содержимое БД; содержит только identity, спецификации и контрольные суммы.

1. Выполните `snapshot`, при необходимости с `--seed-check`: инструмент снимет
   UID/native spec, ID и creation time VM/дисков, fingerprints БД и ролей,
   PostgreSQL system identifier и времена запуска postmaster. Seed добавляет
   отдельную проверочную таблицу из 100 строк.
2. Выполните `prepare`, затем остановите старый инфраструктурный writer.
   Заказ остаётся paused. Установите текущие CRD, XRD/Composition и новый
   artifact adapter обычным Helm upgrade.
3. Выполните `observe`, дождитесь наблюдения всех исходных target UID, запустите
   `verify`. На этом этапе мосты не имеют прав Create/Update/Delete.
4. Выполните `activate`, затем повторный `verify`. Для импортированных ресурсов
   включается управление без Create; неизменяемые AnsibleRun также не получают Update. Имена, UID
   и spec старых AnsibleRun сохраняются, bootstrap повторно не выполняется.

При несовпадении UID, спецификации или fingerprint остановите переход и сохраните
XR paused. Не удаляйте XR, XRD, native MR, pin ConfigMap или snapshot для retry.
Отсутствующий импортированный CR считается ошибкой и автоматически не создаётся.
Protected pin ConfigMap нужен на всём протяжении жизни импортированного заказа.
Доступ к нему и private Runtime/Object API предназначен администраторам и
Crossplane. Connection Secret/Role, LogAccess, Quota и назначение тарифа сохраняют
свою identity; служебные credentials остаются в защищённом namespace.


Повтор bootstrap сначала проверяет принадлежность существующей БД заказу по
scope/имени Patroni, пути данных и сохранённому superuser credential. Для
совпавшей работающей БД начальное развёртывание пропускается, интеграции
согласуются повторно. Чужой или частично настроенный data directory не
переинициализируется. Новые заказы включают версию trusted playbook в hash
запуска; импортированный заказ сохраняет старые hash/name/spec.


Удаление заказа через продукт использует Foreground propagation. Служебные
identity Kubernetes garbage collector включены в admission boundary, чтобы
системная очистка могла удалить composed Objects и их foreground finalizers.
Credential custodian проверяет отсутствие native потребителей по закреплённому
UID даже если XR уже отсутствует; Secret удаляются последними.

## Единый primary endpoint и управляемая инфраструктура

Для Patroni требуется установленный L4-продукт с API NetworkLoadBalancer и
TargetGroup, включёнными custom security groups и stock provider-ansible.
PostgreSQL Composition создаёт оба XR в namespace проекта, в том же регионе.
VIP размещается в первой выбранной подсети; внешний адрес выделяется автоматически.
Single-node балансировщик не заказывает.

TCP 5432 проходит без TLS termination. Health monitor обращается к HTTPS
`/primary` на private IP каждого хоста, порт 8008; только ответ 200 допускает
узел к новым подключениям. Клиентский REST listener не создаётся. При switchover
адрес сохраняется, но существующие сессии требуют reconnect. Настройте повтор
подключений и транзакций в приложениях.

Composition создаёт отдельную VIP SG с правилами TCP 5432 из allowedCIDRs заказа.
Backend SG разрешает 5432/8008 от этой SG, включая интерфейсы Amphora.
Остальные клиенты не получают доступ к Patroni API. Для нового VIP integration
AnsibleRun добавляет SAN к существующим PostgreSQL сертификатам, сохраняя CA и
private keys, затем вызывает pg_reload_conf(). Повторный bootstrap не нужен.
Готовность включает проверку сертификата через адрес балансировщика.

В IaaS публикуются Observe-only InstanceV2 существующих VM через проектный
ProviderConfig. Protected MR сохраняют управление облаком. Все представления,
балансировщик и целевая группа имеют managed-аннотацию и владельца PostgreSQLCluster.
Продуктовые роли определяют возможность чтения; мутации направляются к заказу.
В managedResources.controllerUsers установки Dashboard добавьте точную ServiceAccount
identity установленного provider-openstack: помимо status/finalizers, Upjet
сохраняет служебные аннотации наблюдаемого ресурса.
Пересмотрите её при смене package revision; wildcard доверие не требуется.

Compute MeteringPolicy исключает ровно managementPolicies=[Observe]. В правилах
Compute-квоты InstanceV2 задайте selector matchExpressions с ключом
postgresql.gatorstack.dev/inventory и operator DoesNotExist. Продуктовая admission
policy запрещает клиенту выставить эту метку для обхода квот и требует для
помеченных ресурсов Observe-only без Create/Update/Delete и managed-аннотацию. Размеры PostgreSQL
по-прежнему учитывает квота и тариф основного заказа.

Usage сохраняет хосты, целевую группу и SG до завершения удаления LB. При временной
потере наблюдения UID или адресов Composition останавливает согласование,
сохраняя прежние зависимости. Не удаляйте native CR вручную для восстановления.

VIP SG дополнительно разрешает доверенные operatorCIDRs профиля установки:
служебный runtime проверяет TLS endpoint из этих сетей. Клиентские allowedCIDRs
не дают доступа к REST API.


## Ручная конфигурация хостов

Новая форма создаёт один PostgreSQLCluster с networkRef и hosts[]. Отдельный
placement CR при заказе не создаётся. Поле «Флейвор» читает native FlavorV2 из
namespace `flavorCatalog.namespace` (по умолчанию `gator-iaas-catalog`). Этот
namespace и общий каталог IaaS должны существовать до установки продукта.
Доступны только объекты с published=true, меткой cloud выбранного региона,
Ready=True и реальным ID из `profile.regions.<region>.flavors`. Установочный
chart выдаёт авторизованным пользователям только get/list/watch FlavorV2 этого
каталога. Credentials в нём не хранятся.

Количества в `classes` и региональном профиле должны совпадать; один ID нельзя
сопоставить разным классам. Несогласованный профиль отвергается при рендере chart.
Server-side selection переносит наблюдаемые vcpus, ram и ID в заказ и закрепляет
ревизию содержимого флейвора. Перед первым планом Runtime проверяет количества
в Nova; существующий закреплённый план не перевыбирает флейвор при обновлении
каталога. Регион и зона не могут подменить provider credentials.

Пользовательские роли PostgreSQL получают только чтение project-scoped
NetworkV2/SubnetV2 для выбора зависимостей. Server-side selections проверяют
namespace, UID, ревизию, готовность, регион, сеть и зону строки. Проверки
выполняются и для оценки стоимости; caller credentials не заменяются учёткой backend.

Для хоста с publicAccess=false Composition выделяет служебный внешний адрес
без полной ассоциации с портом и создаёт стандартные Neutron PortforwardingV2
только для SSH 22 и метрик 9187. Security groups ограничивают эти подключения
операторскими CIDR. Порт 5432 не получает port forwarding и доступен через
приватный адрес. Регион должен поддерживать floating IP port forwarding;
служебная маршрутизация и права штатного OpenStack provider остаются prerequisites.
Для publicAccess=true применяется обычная ассоциация floating IP; клиентские
CIDR разрешают PostgreSQL. Patroni LB сохраняет отдельный управляемый endpoint.

primaryPriority 0–100 преобразуется в Patroni failover_priority 1–101, чтобы 0
в интерфейсе сохранял обычную допустимость кандидата. Локальные tags загружаются
через SIGHUP Patroni, без рестарта PostgreSQL. Приоритет не отменяет WAL,
репликационные и health-ограничения Patroni; см. [upstream-описание tags](https://patroni.readthedocs.io/en/latest/yaml_configuration.html#tags).

При обновлении существующие spec.subnets, VM/volume IDs, SSH/TLS credentials и
configuration hash сохраняются. Новый hosts-формат не применяется к ним
автоматически. До и после обновления сверяйте UID XR/зависимостей, облачные ID,
идентификатор PostgreSQL, контрольные данные и время запуска postmaster.
