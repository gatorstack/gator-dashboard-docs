# Установка и управление Gator Quotas

## Установка

Нужны Kubernetes 1.30+, Helm 3, CNI с исполнением NetworkPolicy, административный доступ для CRD/RBAC/webhook
и сетевой доступ API server к Service webhook на 443. По умолчанию используется
установленный cert-manager. Выберите кластер явно:

```sh
git clone https://github.com/gatorstack/gator-quotas.git
cd gator-quotas
oc --context YOUR_CONTEXT whoami --show-server
oc --context YOUR_CONTEXT apply --server-side -f charts/gator-quotas/crds/
```

Создайте `quota-values.yaml`. Источники перечисляются явно: компонент не получает
чтение всех ресурсов и Secrets. GVK разрешается discovery; RBAC использует GVR.

```yaml
replicas: 2
networkPolicy:
  apiServerCIDRs: ['192.0.2.10/32'] # замените source IP API server вашего кластера
sourceRBAC:
  - apiGroups: [platform.example.org]
    resources: [virtualmachines]
```

Сначала подготовьте работающий сервис и сертификат, затем включите admission.
Bootstrap с выключенным webhook используется только при первой установке:

```sh
helm upgrade --install gator-quotas charts/gator-quotas --kube-context YOUR_CONTEXT \
  -n gator-quotas --create-namespace -f quota-values.yaml \
  --set webhook.enabled=false --set-json 'templates=[]' --wait
oc --context YOUR_CONTEXT -n gator-quotas wait --for=condition=Ready \
  certificate/gator-quotas-tls --timeout=120s
helm upgrade gator-quotas charts/gator-quotas --kube-context YOUR_CONTEXT \
  -n gator-quotas -f quota-values.yaml --wait
oc --context YOUR_CONTEXT get validatingwebhookconfiguration gator-quotas
```

Проверьте непустой `webhooks[].clientConfig.caBundle` и endpoints Service до
включения квот проектам. При собственном TLS: `tls.certManager: false`,
`tls.existingSecret` с tls.crt/tls.key и `tls.caBundle` с base64 CA. Сертификат
содержит DNS `gator-quotas.gator-quotas.svc`; обновляйте сертификат и доверенную
CA согласованно. Процесс перечитывает TLS-файлы при handshake.

## Подключение namespace

Установите собственный namespaced CRD, выдайте контроллеру sourceRBAC, затем
примените шаблон и namespace из [примера в репозитории Gator Quotas](https://github.com/gatorstack/gator-quotas/blob/main/examples/quota.yaml), заменив GVK.

```sh
oc --context YOUR_CONTEXT apply -f quota-template.yaml
oc --context YOUR_CONTEXT label namespace project-a platform.example.org/quota-profile=standard
oc --context YOUR_CONTEXT annotate namespace project-a quotas.gatorstack.dev/use-quotas=true
oc --context YOUR_CONTEXT get namespace project-a -o jsonpath='{.metadata.annotations}'
oc --context YOUR_CONTEXT -n project-a get quotas.quotas.gatorstack.dev -o yaml
```

Пока копирование не завершено, записи в namespace блокируются. Исключения
bootstrap: только ServiceAccount/default и `kube-root-ca.crt` ConfigMap. Создание Quota/ledger
проходит отдельный маршрут и не вызывает рекурсию. У namespace уже могут быть
ресурсы: первое измерение включает их все; превышение не удаляет их.

Контроллер создаёт Quota с именем шаблона и аннотацией template-uid. Он выставляет
quota-copied=true только после всех подходящих шаблонов. Сбой/рестарт продолжает
копирование. Чужая Quota с тем же именем даёт коллизию; ничего не перезаписывается.
Если подходящих шаблонов нет, копирование завершается с пустым набором.

**Copy-once не является синхронизацией.** Изменение шаблона не меняет существующие
Quota. Изменяйте проектные квоты явно. Для добавленных шаблонов удалите маркер:

```sh
oc --context YOUR_CONTEXT annotate namespace project-a quotas.gatorstack.dev/quota-copied-
```

Существующие копии при этом сохраняются, включая локальные изменения лимитов.
Для полной замены копии остановите запись, сохраните её конфигурацию, разберите
резервы и удалите только нужную Quota перед повторным копированием. Новый UID
шаблона после удаления/пересоздания не считается прежним владельцем копии.
Снятие use-quotas не выключает уже созданные квоты.

## Изменение лимитов и правил

### Квота ConfigMap

Для подсчёта ConfigMap выдайте `sourceRBAC` чтение `configmaps` в core API group:

```yaml
sourceRBAC:
  - apiGroups: ['']
    resources: [configmaps]
```

Следующий `configmap-template.yaml` создаёт шаблон и namespace
`quota-configmaps-demo` с лимитами 4 объекта и 8 ключей. После установки версии
0.2.0 или новее сохраните манифест:

```yaml
# Apply the template before enabling copy-once on the namespace.
apiVersion: quotas.gatorstack.dev/v1alpha1
kind: ClusterQuotaTemplate
metadata:
  name: configmap-capacity
spec:
  namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: quota-configmaps-demo
  quotaSpec:
    rules:
      - name: configmaps
        apiVersion: v1
        kind: ConfigMap
        expression: count(.)
        hard: '4'
        message: Превышен лимит количества ConfigMap в namespace
      - name: keys
        apiVersion: v1
        kind: ConfigMap
        expression: sum(count(.data) + count(.binaryData))
        hard: '8'
        message: Превышен лимит суммарного количества ключей ConfigMap в namespace
---
apiVersion: v1
kind: Namespace
metadata:
  name: quota-configmaps-demo
  annotations:
    quotas.gatorstack.dev/use-quotas: 'true'
```

Примените его и дождитесь копирования:

```sh
oc --context YOUR_CONTEXT apply -f configmap-template.yaml
oc --context YOUR_CONTEXT wait namespace/quota-configmaps-demo \
  --for=jsonpath='{.metadata.annotations.quotas\.gatorstack\.dev/quota-copied}'=true --timeout=120s
oc --context YOUR_CONTEXT -n quota-configmaps-demo get quota configmap-capacity -o yaml
```

Стандартный `kube-root-ca.crt` входит в оба лимита: обычно начальный факт 1/4
объекта и 1/8 ключа. Число ключей не ограничивает размер значений в байтах.
Лимиты применяются к namespace, без переноса остатка между namespace.
При обновлении с 0.1 остановите записи и дождитесь пустых QuotaLedger перед
сменой версии: 0.2 расширяет digest подтверждения на поля вне spec. Не удаляйте
неизвестные резервы; сначала разберите их по процедуре восстановления ниже.

### Региональные правила и обновление

Перед настройкой регионов установите runtime 0.3 или новее и обновите CRD.
Helm не обновляет CRD автоматически. Для CRD, принадлежащих этой установке:

```sh
oc --context YOUR_CONTEXT apply --server-side --field-manager=gator-quotas-crds \
  --force-conflicts -f charts/gator-quotas/crds/
```

Это передаёт владение схемой от первоначальной установки Helm менеджеру CRD.
Сначала завершите rollout всех admission replicas, сохранив прежние шаблоны,
и только потом применяйте шаблоны с новыми полями. Старый webhook не понимает
новый контракт. Перед изменением действующих правил остановите writers и
дождитесь пустого ledger; неизвестные резервы не удаляйте.

Для иконки группы обновите runtime и CRD до 0.3.1 или новее, задайте
spec.groupIcon (например, /logos/compute.svg) в Quota и quotaSpec шаблона.
Существующие копии измените явно: copy-once не переносит правки шаблона.
Одинаковое название группы должно использовать одинаковую иконку.

Задайте spec.group и общий metric у правил из [справочника региональных правил](../reference/quotas.md#группа-показатель-и-региональные-выражения).
Для InstanceV2 можно фильтровать .spec.forProvider.region; для ConfigMap —
.metadata.labels.region. Условия where выполняются перед expression; они
объединяются AND с selector. scope сам по себе не выбирает объекты.

Сохраняйте отдельное общее правило без where: оно учитывает и объекты без
регионального поля. Отсутствующее поле не совпадает с In; если поле обязательно
для продукта или пользователь не должен менять принадлежность, защитите это
отдельной схемой/admission продукта. Региональную принадлежность нельзя считать
доверенной только потому, что она подписана scope.

Проверяйте переходы между областями через UPDATE: полный регион назначения
должен отклонять перенос, после успешного переноса уменьшается факт исходного
региона и увеличивается факт назначения. Общий вклад при неизменной ёмкости
сохраняется. where-правила блокируют scale/resize, даже если expression=count(.).
Изменения status или состояния внешнего облака без изменения учитываемого CR
не проверяются; это квота объявленной ёмкости.

Copy-once остаётся прежним: изменение ClusterQuotaTemplate не меняет уже
созданные Quota. Обновите их явно, сохранив индивидуальные hard и стабильные
name правил. Новые региональные правила добавляйте с уникальными name;
факт появится под этими ключами status после успешной сверки.

Имя Quota в Kubernetes неизменяемо. Для переименования создайте новую Quota
с прежним spec и происхождением нового шаблона, дождитесь Ready и пустого
ledger, затем удалите прежнюю. Так прежние лимиты продолжают действовать
до готовности замены. Например, имя compute даёт технический ID compute.vcpu.

### Обновление действующей квоты

Лимит находится в `Quota.spec.rules[].hard`, сообщение — в `message`.
После изменения `status.observedGeneration` должен совпасть с generation,
`Ready=True`. Снижение hard ниже факта даёт OverLimit=True и available=0;
существующие объекты продолжают работать. Неизвестные запросы старой ревизии
блокируют расчёт до разбора, включая изменение только лимита. Перед изменением
правил остановите новые заказы и дождитесь пустого ledger.

Квота ограничивает **объявленные поля**, например CPU из нормализованного spec.
Если caller способен записать неверные характеристики выбранного cloud flavor,
формула не доказывает реальную ёмкость VM. Защитите такой контракт admission
продукта/оператором или считайте доверенные поля. Внешние lookup/проверка flavor
не входят в язык выражений. Производные поля из status не допускаются: status
может меняться через subresource вне данного admission.

## RBAC и Dashboard

`gator-quotas-viewer` читает только Quota и агрегируется в native `view` и
роли Gator auditor/viewer/editor/owner. Привязывайте роль через **RoleBinding
namespace**, чтобы не открыть все проекты. Template, ledger и изменение квот
не выдаются проектным ролям. Для совместимого `projectviewer` добавьте те же
get/list/watch Quota в его декларативную конфигурацию установки Dashboard.

Home package Gator Products использует обычный ProductResource с target
`quotas.gatorstack.dev/v1alpha1/Quota`, scope Namespaced/CurrentProject и
access ReadOnly. List/Detail ProductPage читают status.hard/used/reserved/available
через JSON Schema. API запросы и watch выполняются с токеном пользователя.
Установка webhook не требует отдельного API в ядре Dashboard.

## Наблюдение и восстановление

```sh
oc --context YOUR_CONTEXT -n gator-quotas get deployment,pods,service,certificate
oc --context YOUR_CONTEXT -n gator-quotas logs deployment/gator-quotas --tail=100
oc --context YOUR_CONTEXT -n project-a get quota compute -o yaml
oc --context YOUR_CONTEXT -n project-a get quotaledger admission -o yaml
```

Проверяйте probes, Ready=False, возраст lastCalculatedTime, reserved и overage.
Сверка запускается с интервалом 5 секунд после предыдущего цикла; до 8 namespaces
обрабатываются параллельно. Один фоновый controller выбирается через Lease,
все replicas обслуживают admission и согласуют резервы через CAS. Admission
читает API напрямую.
403 на LIST исправляется sourceRBAC; отсутствующий GVK — установкой CRD/правкой
apiVersion/kind; отсутствующее поле — исправлением данных/формулы. Последний
успешный факт при ошибке сохраняется. Readiness процесса проверяет доступ к API;
готовность отдельной квоты проверяйте по её status.conditions.

Webhook использует `failurePolicy: Fail` и `sideEffects: NoneOnDryRun`.
При недоступности webhook блокируются CREATE/UPDATE всех перехватываемых
namespaced ресурсов, в том числе namespace без квот. DELETE проходит отдельный наблюдающий webhook с failurePolicy=Ignore:
он всегда разрешает удаление и снимает только подтверждённый резерв текущей
ревизии. Объект по-прежнему входит в used до фактического исчезновения.
По умолчанию исключены kube-system/kube-public/kube-node-lease и namespace
самого компонента. Не размещайте защищаемые проекты в этих namespaces.

Сервер хранит только request UID, target UID/GVR/name, digest, ревизию правил
и положительные дельты. Если следующий webhook отклонил запрос или ответ потерян,
резерв может остаться без CR. Он не истекает по таймеру. Обычная сверка убирает
резерв только после наблюдения соответствующего UID и содержимого объекта.

Чтобы снять зависший резерв: остановите writers namespace, сопоставьте requestID,
target UID/name и createdAt с audit log API server, убедитесь, что исходный запрос
завершился и больше не может записаться. Сохраните журнал в защищённое хранилище.
Только после доказательства отмены удалите соответствующий элемент
`QuotaLedger.spec.reservations` через `oc edit quotaledger admission`.
Не очищайте весь ledger и не делайте это по одному лишь возрасту записи.
После исправления дождитесь Ready и корректного плана/факта перед открытием записи.

## Обновление, backup и удаление

Обновляйте CRD через server-side apply, затем chart обычным helm upgrade --wait.
Helm сам не обновляет существующие CRD из crds/. Не выключайте webhook во время
обычного upgrade; оставляйте минимум одну работающую replica. Для больших
кластеров измерьте задержку LIST/CAS на своей нагрузке. Текущие границы:
32 правила на Quota, 10000 объектов на source GVR, 2000 pending на namespace,
лимит размера одного Kubernetes CR также ограничивает ledger. Ошибка/переполнение
закрывает новые запросы; это не гарантия производительности при 10k объектов.

Сохраняйте templates, quotas, ledgers, значения Helm и TLS CA/ключи в подходящем
защищённом backup. Восстанавливайте их до разрешения новых заказов; статус можно
пересчитать, неразобранные резервы терять нельзя. После восстановления сверяйте
target UID и фактические CR. При удалении сначала остановите writers, затем
осознанно отключите webhook/удалите release. CRD/проектные Quota Helm сохраняет;
без webhook они не ограничивают запись. Удаление CRD уничтожает их данные.

## Подресурсы и версии API

Для quota по полям scale/Pod resize запрещены: обновляйте основной объект,
чтобы webhook видел полный spec. Count-only правила допускают эти операции.
Status не перехватывается. Если GVK имеет несколько served versions, используйте
apiVersion, объявленную в правиле: другая версия того же source GVR отклоняется,
а не пропускает квоту. Для миграции версии остановите writers, дождитесь пустых
резервов и обновите все правила этого ресурса согласованно.

## Доступ к admission endpoint

AdmissionReview не является подписанным документом. Запросам к webhook должен
иметь доступ только доверенный control plane. Chart включает NetworkPolicy,
разрешающую порт 9443 из kube-system и настроенных networkPolicy.apiServerCIDRs;
обычные Pod проектов доступа не получают. Нужен CNI, который реально исполняет
NetworkPolicy. Укажите source CIDRs API server до включения webhook, учитывая
SNAT и топологию control plane. Трафик от локального узла и hostNetwork относится
к доверенной инфраструктуре: не выдавайте tenant права создавать hostNetwork/
privileged Pod или менять политики сети namespace компонента.

Не публикуйте Service через Ingress/NodePort. Если платформенная сеть не может
обеспечить изоляцию, настройте аутентифицированный транспорт API server к webhook
перед использованием hard quota; выключенная/неисполняемая NetworkPolicy сама
по себе не аутентифицирует AdmissionReview. Проверьте, что API server продолжает
создавать разрешённые ресурсы, а обычный Pod проекта не может установить TCP
соединение с Service webhook на 443.

Семантика исполнения сетевых правил описана в [документации Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/).
