---
title: Crossplane provider для Ceph RGW
---

Провайдер `gatorstack/provider-radosgw` управляет внешним Ceph Object Gateway
через Kubernetes CRD. Он сгенерирован Upjet из `fitbeard/radosgw` 1.9.0 и
использует Terraform Plugin Framework внутри контроллера. Terraform CLI,
Ceph, RGW и отдельные workload для бакетов в Kubernetes не требуются.

Доступны 29 видов ресурсов в двух API scope: namespaced для новых установок
и cluster-scoped для совместимости. Они покрывают RGW пользователей, ключи,
аккаунты, IAM users/groups/roles/policies, квоты, capabilities, Swift subusers,
OIDC providers, бакеты и их настройки, SNS topics и notifications.
Data sources Terraform не превращаются в CRUD-сущности. Для чтения существующего
объекта используйте Managed Resource с `managementPolicies: [Observe]`.

Сам провайдер не добавляет S3-продукт, формы, тарифы или биллинг в Gator Dashboard.
Продукт можно подключать отдельно после установки реальных API через
ProductResource/ProductPage. DNS, сертификаты и домен бакета этот провайдер
не обслуживает; HTTPS должен предоставлять существующий RGW endpoint.

## Требования

Нужны Crossplane 2.4+, доступный из контроллера RGW endpoint и подходящие S3/IAM
или Admin Ops credentials. Полный набор рассчитан на Ceph Tentacle 20;
account IAM требует Squid 19 или новее. Поддержка отдельных функций зависит
от версии и конфигурации Ceph. Учитывайте также ограничения upstream provider.

Поставка находится в приватной организации GatorStack. Нужен доступ к
[репозиторию провайдера](https://github.com/gatorstack/provider-radosgw)
и правом чтения его GHCR-пакета. Установку выполняет администратор кластера.
Используйте явный контекст и проверьте целевой API server перед изменениями.

## Установка

Подготовьте защищённый Docker config после `docker login ghcr.io` с токеном,
имеющим `read:packages`, и создайте pull Secret без вывода его содержимого:

```sh
kubectl --context YOUR_CONTEXT -n crossplane-system create secret generic provider-radosgw-pull \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/secure/docker/config.json
```

Примените manifest с точной версией пакета из поставки. Для приватного registry
pull Secret задаётся и package manager, и runtime:

```yaml
apiVersion: pkg.crossplane.io/v1beta1
kind: DeploymentRuntimeConfig
metadata:
  name: provider-radosgw
spec:
  deploymentTemplate:
    spec:
      selector: {}
      template:
        spec:
          imagePullSecrets:
            - name: provider-radosgw-pull
          containers:
            - name: package-runtime
              args: [--poll=1m]
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-radosgw
spec:
  package: ghcr.io/gatorstack/provider-radosgw:v0.1.0-rc.15
  packagePullSecrets:
    - name: provider-radosgw-pull
  runtimeConfigRef:
    name: provider-radosgw
  revisionHistoryLimit: 2
```

```sh
kubectl --context YOUR_CONTEXT wait --for=condition=Healthy provider.pkg.crossplane.io/provider-radosgw --timeout=180s
kubectl --context YOUR_CONTEXT get managedresourcedefinitions.apiextensions.crossplane.io
```

Activation policy Crossplane должна разрешать нужные группы `*.radosgw.m.crossplane.io`
и, при использовании legacy API, `*.radosgw.crossplane.io`. Наличие Healthy Provider
подтверждает готовность пакета, а подключение к Ceph проверяется первым Managed Resource.

## Подключение и первый бакет

Создайте namespace `rgw-demo`. Подготовьте файл `credentials.json` вне Git с
правами 0600 и полями `endpoint`, `access_key`, `secret_key`. Endpoint указывает
на ваш S3 API, например `https://rgw.example.com`. Не добавляйте реальные ключи
в YAML, историю shell или журналы CI.

```sh
kubectl --context YOUR_CONTEXT create namespace rgw-demo
kubectl --context YOUR_CONTEXT -n rgw-demo create secret generic rgw-credentials \
  --from-file=credentials=/secure/path/credentials.json
```

```yaml
apiVersion: radosgw.m.crossplane.io/v1beta1
kind: ProviderConfig
metadata:
  name: s3
  namespace: rgw-demo
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: rgw-demo
      name: rgw-credentials
      key: credentials
---
apiVersion: s3.radosgw.m.crossplane.io/v1alpha1
kind: Bucket
metadata:
  name: application-data
  namespace: rgw-demo
spec:
  forProvider:
    bucket: replace-with-unique-application-data
    versioning: enabled
    forceDestroy: false
  providerConfigRef:
    kind: ProviderConfig
    name: s3
---
apiVersion: s3.radosgw.m.crossplane.io/v1alpha1
kind: BucketCorsConfiguration
metadata:
  name: application-cors
  namespace: rgw-demo
spec:
  forProvider:
    bucketRef:
      name: application-data
    corsRule:
      - allowedMethods: [GET]
        allowedOrigins: [https://app.example.com]
        maxAgeSeconds: 300
  providerConfigRef:
    kind: ProviderConfig
    name: s3
```

Дождитесь `Ready=True` и `Synced=True`, затем проверьте бакет через S3 API
или Ceph Dashboard. `bucketRef` берёт S3-имя из родительского CR: внутренний
RGW bucket ID может отличаться от имени бакета.

## Учетные записи и границы доступа

Namespaced ProviderConfig использует Secret из namespace Managed Resource.
ClusterProviderConfig позволяет администратору явно выбрать namespace Secret;
ссылка на него требует `providerConfigRef.kind: ClusterProviderConfig`.
Legacy cluster-scoped CR используют отдельный `radosgw.crossplane.io/v1beta1`
ProviderConfig. Эти три типа конфигурации не взаимозаменяемы.

Admin Ops capabilities имеют права на весь RGW. Kubernetes namespace не
ограничивает полномочия административного ключа. Ограничивайте через RBAC
и admission доступ к административным CR, выбору ProviderConfig, Secret и
ссылкам между namespace. Обычные S3 credentials могут управлять своими бакетами;
создание RGW пользователей и аккаунтов требует административных capabilities.

Для account IAM сначала создайте Account и его root User административным
соединением, затем AccessKey и отдельный ProviderConfig с ключами account root.
AccountUser, группы, membership, inline policies и managed-policy attachments
управляются через IAM API аккаунта без административных прав на весь RGW.

Для управляемых AccessKey и AccountAccessKey обязательно задайте
`writeConnectionSecretToRef`: этот Secret хранит состояние сгенерированного ключа.
AccessKey и AccountAccessKey записывают `aws_access_key_id` и
`aws_secret_access_key` в `writeConnectionSecretToRef`. Для namespaced CR
Secret находится в его namespace. Секрет IAM access key возвращается при создании:
сохраняйте connection Secret при перезапуске, переносе и импорте.

Например, для уже существующего User CR `application-user` и административного
ProviderConfig `rgw-admin` в namespace `rgw-demo`:

```yaml
apiVersion: iam.radosgw.m.crossplane.io/v1alpha1
kind: AccessKey
metadata:
  name: application-key
  namespace: rgw-demo
spec:
  forProvider:
    userIdRef:
      name: application-user
  providerConfigRef:
    kind: ProviderConfig
    name: rgw-admin
  writeConnectionSecretToRef:
    name: application-s3
```

После успешного reconcile появится Secret `rgw-demo/application-s3` с полями
`aws_access_key_id` и `aws_secret_access_key`. Для account IAM аналогично
используйте AccountAccessKey с ProviderConfig нужного аккаунта. Создание User
само по себе не заменяет CR ключа и его connection Secret.

После перезапуска провайдер подгружает чувствительные поля из connection Secret.
Если состояние существующего ключа утрачено и его нельзя восстановить из входных
Secret references, reconciliation завершается ошибкой. Новый ключ автоматически
не выпускается; восстановите connection Secret из защищённой резервной копии.
Значения не публикуются в обычных spec/status полях CR. Доступ к Secret выдаётся
через Kubernetes RBAC; base64 не является шифрованием, защита etcd и backup
настраивается отдельно.

## Эксплуатация и удаление

Контроллер периодически читает внешнее состояние и исправляет drift.
Изменения в Ceph Dashboard могут быть возвращены к желаемому состоянию CR.
Не назначайте два контроллера владельцами одной настройки. BucketPolicy,
BucketACL, CORS, lifecycle и notifications — отдельные CR, удаляющие свою
настройку, а не родительский бакет.

Сначала удаляйте дочерние конфигурации и attachments, затем бакеты/пользователей/
группы/роли, после них аккаунт. `forceDestroy: false` защищает непустой бакет:
ошибка удаления оставляет finalizer. Очистите данные явно либо заранее разрешите
force deletion только для уничтожаемых данных. Object Lock может дополнительно
запретить удаление. Включённый versioning можно приостановить, но нельзя вернуть
в исходное состояние off.

Импорт начинайте с `managementPolicies: [Observe]`, задавая фактический
`crossplane.io/external-name` и обязательные lookup-поля в `forProvider`.
Upjet не вызывает Terraform CLI import. Проверьте наблюдаемый объект прежде,
чем разрешить Update/Delete. Ошибки авторизации не означают отсутствие объекта.

При обновлении закрепляйте проверенную версию или digest, сохраняйте manifests
и connection Secrets, проверяйте изменения CRD и не запускайте две активные
ревизии провайдера для одного API. Полные контракты и дополнительные примеры
находятся в [справочнике провайдера](https://github.com/gatorstack/provider-radosgw/blob/main/docs/api-reference.md).


## HOT/COLD и placement бакетов

RGW storage classes задают размещение данных объектов, а placement target
выбирает набор пулов для бакета. Оператор Ceph настраивает их на backend до
использования в CR. Например, логические HOT/COLD могут использовать разные
пулы на одних OSD; физические уровни требуют соответствующих носителей и
CRUSH rules. Общая ёмкость и отказоустойчивость от названия класса не меняются.

Для логических классов создайте data pools с принятой в кластере репликацией
и CRUSH rule, добавьте HOT/COLD в placement target zonegroup, затем свяжите
каждый класс с data pool в зоне:

```sh
radosgw-admin zonegroup placement add --rgw-zonegroup ZONEGROUP \
  --placement-id default-placement --storage-class HOT
radosgw-admin zone placement add --rgw-zone ZONE \
  --placement-id default-placement --storage-class HOT --data-pool HOT_DATA_POOL
radosgw-admin zonegroup placement add --rgw-zonegroup ZONEGROUP \
  --placement-id default-placement --storage-class COLD
radosgw-admin zone placement add --rgw-zone ZONE \
  --placement-id default-placement --storage-class COLD --data-pool COLD_DATA_POOL
radosgw-admin period update --rgw-realm REALM --commit
```

Placement targets `hot`/`cold` можно связать с соответствующими STANDARD data
pools; index и multipart metadata pools задаются отдельно. Прежний
`default-placement` и его STANDARD pool сохраняйте для существующих бакетов.
Смена конфигурации классов сама по себе не переносит старые объекты.

Новый бакет выбирает target через `LocationConstraint: ZONEGROUP_API_NAME:hot`
или `:cold`. Placement бакета закрепляется при создании. Объект выбирает класс
заголовком `X-Amz-Storage-Class`; copy или S3 lifecycle transition могут менять
класс уже записанных данных. Например, с клиентом, поддерживающим произвольные
RGW class names, и credentials из защищённого AWS profile/environment:

```python
import boto3

s3 = boto3.client("s3", endpoint_url="https://rgw.example.com", region_name="REGION")
s3.create_bucket(
    Bucket="replace-with-unique-hot-bucket",
    CreateBucketConfiguration={"LocationConstraint": "ZONEGROUP_API_NAME:hot"},
)
s3.put_object(
    Bucket="replace-with-unique-hot-bucket", Key="archive", Body=b"example",
    StorageClass="COLD",
)
```

Имена HOT/COLD чувствительны к регистру. Некоторые AWS-клиенты допускают только
AWS class names; проверьте используемый клиент перед выдачей услуги.

В текущем upstream Bucket CR нет поля LocationConstraint. Через User CR можно
задать `forProvider.defaultPlacement: hot` или `cold`, затем использовать credentials этого пользователя в
ProviderConfig для создания бакетов. Для выбора placement у каждого отдельного
бакета через один ProviderConfig потребуется расширение upstream API; такого
поля в опубликованном CRD сейчас нет.

`defaultStorageClass` присутствует только в `status.atProvider` как наблюдаемое
значение. В `spec.forProvider` такого поля нет; не добавляйте его в manifest.

Подробнее: [Ceph placement и storage classes](https://docs.ceph.com/en/tentacle/radosgw/placement/).

Для account-owned бакетов текущий upstream некорректно передаёт account owner
как `uid` при установке индивидуальной `bucketQuota`: на Ceph Tentacle это
возвращает `NoSuchKey`. Не задавайте это необязательное поле таким бакетам.
Квоты обычных user-owned бакетов и квоты аккаунта — отдельные операции.

## Безопасность первого наблюдения

Новый CR без `crossplane.io/external-name` сначала проходит Create upstream API.
Read по параметрам spec не используется как неявный импорт. Это общее правило
для всех 29 видов в обоих scope. Для Bucket S3 API проверяет владельца: занятое
другим аккаунтом имя даёт BucketAlreadyExists в conditions, без ложного Ready.

Для намеренного импорта оператор задаёт внешний ID и managementPolicies: [Observe].
При восстановлении существующих CR сохраняйте external-name и connection Secret.
Идентификатор позволяет продолжить Read; оператор должен отдельно проверить
владение и соответствие подключения. Глобальные Admin Ops permissions остаются
глобальными. Политики, CORS и другие настройки сохраняют штатную upsert-семантику
Create и проверки доступа backend; один внешний объект управляется одним CR.

Ошибка Create не считается подтверждением владения: частичное Terraform state
не превращается в external-name. Это также защищает IAM-пользователей, группы
и роли при EntityAlreadyExists. Если сервер создал объект, но затем вернул
ошибку, проверьте фактический результат и выполните явный import только после
подтверждения принадлежности. Настройки вроде CORS/policies используют
авторизованный Create/upsert; один CR должен владеть одной такой конфигурацией.

Перезапуск уже готовых ресурсов отличается от остановки Pod во время Create.
RGW может успеть создать генерируемый ключ до сохранения его внешнего ID и
connection Secret. После такого прерывания возможен ключ без управляющего CR;
повторный Create может выпустить ещё один ключ. Перед обновлением контроллера
дождитесь завершения текущих операций. При неопределённом результате проверьте
backend и Secret, подтвердите владельца и восстановите управление либо удалите
только подтверждённый остаток. Автоматический подхват по имени здесь небезопасен.
