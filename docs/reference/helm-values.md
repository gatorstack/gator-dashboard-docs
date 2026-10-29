# Параметры Helm

Эта страница описывает настройки установки, которые обычно меняет администратор.
Файл values должен сохранять все настройки вашей среды. Учётные данные
передавайте через Secret, а не в открытом файле.

## Dashboard

| Параметр | Назначение / исходное значение chart |
| --- | --- |
| `image.repository`, `image.tag` | Образ; выбирайте явно образ своей поставки |
| `imagePullSecrets` | Имена Secret доступа к приватному реестру |
| `replicaCount` | 1; сессии находятся в памяти реплики |
| `cookieSecure` | true; для публичной консоли нужен HTTPS |
| `service.port` | 8080 |
| `ingress.enabled` | false |
| `ingress.className`, `host`, `tls`, `annotations` | Контроллер, DNS, сертификаты и настройки прокси |
| `webhook.enabled` | true; проверка Project |
| `webhook.certManager.enabled` | false; включите для автоматического leaf-продления |
| `webhook.tls.existingSecret`, `caBundle` | Внешний сертификат webhook и CA |
| `iam.enabled` | true; User/Group требуют установленного Gator Dex |
| `iam.identityPrefix` | dex:; должен совпадать с kube-apiserver |
| `iam.passwordNamespace` | gator-dex-users |
| `oidc.enabled` | false |
| `oidc.issuer`, `clientID`, `redirectURL` | Параметры OIDC клиента |
| `oidc.existingSecret` | Secret в namespace Dashboard, ключ client-secret |
| `catalog.schemaConfigMapNames` | Разрешённые для чтения schema ConfigMap |
| `rbac.authentificated.enabled` | true; общие базовые права |
| `rbac.authentificated.subjects` | По умолчанию system:authenticated |
| `rbac.roleCatalog.enabled` | true; auditor/viewer/editor/owner |
| `rbac.roleCatalog.bindableRoles` | Имена внешних ClusterRole, которые разрешено bind владельцам проектов |
| `rbac.standardRoles` | Дополнительные ClusterRole; включает legacy projectviewer |
| `rbac.projectBindings` | Назначения проектного доступа через Helm |
| `rbac.clusterRoleBindings` | Явные назначения на уровне кластера |
| `rbac.testAdmin` | false; при true создаёт тестовый SA с cluster-admin |
| `resources` | CPU/memory requests и limits |

Продуктовые catalog/products/pages/resources и роли находятся в отдельных
продуктовых чартах. Helm заменяет их массивы целиком.

## Несколько установок в одном кластере

Общие ClusterRole имеют фиксированные имена. Для второй установки отключите
создание общих объектов:

```yaml
rbac:
  roleCatalog:
    enabled: false
  standardRoles: []
  authentificated:
    enabled: false
```

Общие роли первой установки остаются. Доступ к каталогу второй установки
назначьте отдельным RoleBinding на её `<release>-catalog-reader` в её namespace.
Проверьте права на ConfigMap схем второй установки.

## Gator Dex

| Параметр | Назначение |
| --- | --- |
| `image.repository`, `image.tag` | Совместимый образ Gator Dex |
| `configSecretName` | Secret с ключом config.yaml |
| `configFile` | Конфигурация через --set-file; chart создаёт Secret |
| `envFrom` | Secret с клиентскими и provider credentials |
| `localUsers.enabled` | Создание credentials namespace и прав Dex на get Secret |
| `localUsers.passwordNamespace` | Namespace локальных паролей |
| `rbac.autoCreateUsers` | Создание User при первом внешнем входе |
| `persistence.enabled`, `size`, `storageClass` | PVC SQLite, по умолчанию 1 GiB |
| `ingress.*` | HTTPS публикация issuer |

Содержимое issuer/connectors/clients настраивается в конфигурации Dex, а не
отдельными значениями chart. Пример: [Gator Dex](../operator-manual/dex.md).

## Gator Cost и OpenMeter

| Chart / параметр | Назначение |
| --- | --- |
| Cost: `image.*`, `ui.image` | Образы collector/workers и UI |
| Cost: `postgres.storageClass`, `storageSize` | PVC ledger PostgreSQL |
| Cost: `sourcePermissions` | Read-only доступ к выбранным GVR |
| Cost: `collector.replicas` | Один collector |
| Cost: `workers.replicas` | Независимое число minute workers |
| OpenMeter: `storageClass` | Класс PVC Kafka, ClickHouse и Redis |
| OpenMeter: `openmeter.configSecret` | Secret полной конфигурации upstream |
| OpenMeter: `openmeter.apiImage`, `image` | Совместимые API и workers из поставки |

Тарифы и выбор ресурсов задаются через CRD, а не через значения chart:
[настройка учёта](../operator-manual/billing-configuration.md).

## Прогноз заказа

| Chart / поле | Назначение |
| --- | --- |
| Dashboard `billing.enabled` | Подключить серверный адаптер прогноза |
| Dashboard `billing.adapterName`, `adapterURL` | Имя подключения и доверенный внутренний HTTP(S) URL |
| Dashboard `billing.existingSecret` | Secret в namespace Dashboard, ключ token |
| Cost `estimate.enabled`, `estimate.existingSecret` | Включить отдельную авторизацию /v2/estimate; Secret с ключом token |
| Продукты `billing.enabled` | Установить BillingBinding, MeteringPolicy и привязки ресурсов |
| Продукты `billing.projectNamespaces` | Явный список namespace источников для установленных правил |
| OpenMeter `clickhouse.resources`, `clickhouse.maxServerMemoryUsage` | Лимиты Pod и внутренний бюджет ClickHouse; настройте под объём истории |

Бизнес-правила описывает [BillingBinding](billing-binding.md). Secret адаптера
отдельный от административного bearer Cost; он не открывает административный API.

## История действий

`history.enabled` включает producer Dashboard (по умолчанию false).
`history.policyRef` выбирает HistoryPolicy (по умолчанию dashboard).
Оператор и его chart устанавливаются отдельно; параметры описаны в
[руководстве Gator History](../operator-manual/history.md).
