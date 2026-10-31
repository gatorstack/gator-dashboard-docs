# Gator Dex и OIDC

Gator Dex добавляет локальные учётные записи, группы и внешних провайдеров входа.
Его chart устанавливается отдельно. Ниже приведён полный вариант локального
входа с доменами `dex.example.org` и `dashboard.example.org`.

Используйте административный контекст `GATOR_CONTEXT` из
[руководства установки](installation.md). Нужны Ingress, TLS для обоих доменов
и доступ администратора для установки CRD Dex. Команды установки Dex выполняются из каталога
`gator-dex` полученного комплекта. Для этого примера используется образ
`ghcr.io/gatorstack/gator-dex:2.46.0-gator.5`.

## 1. Подготовьте клиент OIDC

Client secret Dashboard должен совпадать в Dex и Dashboard. Создайте его
локально и передайте в два Secret, не добавляя в публичный values-файл:

```sh
oc --context "$GATOR_CONTEXT" create namespace gator-dex
GATOR_SECRETS_DIR="$(mktemp -d)"
chmod 700 "$GATOR_SECRETS_DIR"
openssl rand -hex 32 | tr -d '\n' > "$GATOR_SECRETS_DIR/client-secret"
oc --context "$GATOR_CONTEXT" -n gator-dashboard create secret generic dashboard-oidc \
  --from-file=client-secret="$GATOR_SECRETS_DIR/client-secret"
oc --context "$GATOR_CONTEXT" -n gator-dex create secret generic gator-dex-client-credentials \
  --from-file=GATOR_DASHBOARD_CLIENT_SECRET="$GATOR_SECRETS_DIR/client-secret"
rm "$GATOR_SECRETS_DIR/client-secret"
rmdir "$GATOR_SECRETS_DIR"
```

Для существующей установки используйте её client secret; повторная генерация
без согласованного обновления обеих сторон нарушит вход.

Подготовьте TLS Secret Dex из вашего сертификата:

```sh
oc --context "$GATOR_CONTEXT" -n gator-dex create secret tls dex-tls \
  --cert=tls/dex.crt --key=tls/dex.key
```

Для приватного registry войдите в него интерактивно и создайте отдельный pull
Secret в namespace Dex. Не публикуйте полученный конфигурационный файл:

```sh
docker --config registry login ghcr.io
oc --context "$GATOR_CONTEXT" -n gator-dex create secret generic gator-registry \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=registry/config.json
```

## 2. Настройте Dex

Сохраните `dex-config.yaml`:

```yaml
issuer: https://dex.example.org
storage:
  type: kubernetes
  config:
    inCluster: true
    crdHandling: check
web:
  http: 0.0.0.0:5556
frontend:
  dir: /srv/dex/web
expiry:
  idTokens: 5m
  refreshTokens:
    absoluteLifetime: 24h
oauth2:
  skipApprovalScreen: true
  passwordConnector: local
  grantTypes: [authorization_code, refresh_token, password]
  responseTypes: [code]
kubernetesGroups:
  accountManagement: true
  localConnectorID: local
  mappingMethod: claim
  timeout: 10s
staticClients:
  - id: gator-dashboard
    name: Gator Dashboard
    secretEnv: GATOR_DASHBOARD_CLIENT_SECRET
    redirectURIs:
      - https://dashboard.example.org/auth/oidc/callback
connectors:
  - type: kubernetesLocal
    id: local
    name: Локальная учётная запись
    config:
      passwordNamespace: gator-dex-users
```

Сохраните `dex-values.yaml`:

```yaml
image:
  repository: ghcr.io/gatorstack/gator-dex
  tag: 2.46.0-gator.5
configSecretName: gator-dex-config
imagePullSecrets:
  - name: gator-registry
envFrom:
  - secretRef:
      name: gator-dex-client-credentials
localUsers:
  enabled: true
  passwordNamespace: gator-dex-users
rbac:
  kubernetesStorage: true
  accountManagement: true
persistence:
  enabled: false
ingress:
  enabled: true
  className: nginx
  host: dex.example.org
  tls:
    - secretName: dex-tls
      hosts: [dex.example.org]
```

Chart использует одну реплику. Runtime state, refresh-сессии и ключи подписи
сохраняются в namespaced CRD `dex.coreos.com/v1`; PVC для новой установки не нужен.
Runtime не создаёт CRD и имеет storage-права только в namespace Dex.

```sh
oc --context "$GATOR_CONTEXT" apply --server-side --field-manager=gator-dex-crds \
  --force-conflicts -f ./charts/gator-dex/crds/
helm upgrade --install gator-dex ./charts/gator-dex \
  --kube-context "$GATOR_CONTEXT" -n gator-dex \
  -f dex-values.yaml --set-file configFile=dex-config.yaml --wait
oc --context "$GATOR_CONTEXT" -n gator-dex rollout status deployment/gator-dex
curl --fail https://dex.example.org/.well-known/openid-configuration
```

## 3. Настройте доверие Kubernetes

Kubernetes API должен доверять issuer Dex, audience клиента и нужным claims.
Установка Dex сама не меняет конфигурацию kube-apiserver. Для кластера с поддержкой
`AuthenticationConfiguration` используйте:

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: AuthenticationConfiguration
jwt:
  - issuer:
      url: https://dex.example.org
      audiences: [gator-dashboard]
      audienceMatchPolicy: MatchAny
    claimMappings:
      username:
        claim: preferred_username
        prefix: "dex:"
      uid:
        expression: "'dex:' + claims.sub"
      groups:
        claim: groups
        prefix: "dex:"
```

Это файл конфигурации API server, а не ресурс для `oc apply`. Разместите его
там, где он доступен kube-apiserver, и подключите параметром
`--authentication-config`. Способ монтирования и перезапуска зависит от
дистрибутива. Не совмещайте его со старыми `--oidc-*` флагами.
Для управляемого кластера настройте соответствующее доверие способом провайдера.
API server должен иметь HTTPS-доступ к issuer и доверять его сертификату.

Prefix `dex:` должен совпадать с `iam.identityPrefix` Dashboard и именами
субъектов в RoleBinding. Дополнительный CLI-клиент требует отдельной регистрации
в Dex и добавления его audience в доверие Kubernetes.

## 4. Включите вход и IAM в Dashboard

Добавьте в основной `dashboard-values.yaml`:

```yaml
iam:
  enabled: true
  identityPrefix: "dex:"
  passwordNamespace: gator-dex-users
oidc:
  enabled: true
  issuer: https://dex.example.org
  clientID: gator-dashboard
  redirectURL: https://dashboard.example.org/auth/oidc/callback
  existingSecret: dashboard-oidc
```

Из каталога `gator-dashboard` повторите Helm upgrade с полным values-файлом:

```sh
helm upgrade --install gator-dashboard ./charts/gator-dashboard \
  --kube-context "$GATOR_CONTEXT" -n gator-dashboard \
  -f dashboard-values.yaml --wait
```

## 5. Создайте первого локального пользователя

Нужна утилита `htpasswd` с поддержкой bcrypt. Команда интерактивно спрашивает
пароль и передаёт хеш прямо в Kubernetes:

```sh
htpasswd -nBC 12 alice | \
  oc --context "$GATOR_CONTEXT" -n gator-dex-users create secret generic alice-htpasswd \
  --from-file=htpasswd=/dev/stdin
```

Создайте User:

```yaml
apiVersion: user.gatorstack.dev/v1alpha1
kind: User
metadata:
  name: alice
fullName: Alice
htpasswdSecretRef:
  name: alice-htpasswd
  key: htpasswd
```

Примените его и выдайте `dex:alice` роль в проекте по инструкции
[управления доступом](rbac.md). После этого проверьте вход в консоль, видимость
только назначенного проекта и отказ доступа к другому.
Для дальнейшего создания пользователей через IAM администратору нужны
отдельные права на User/Group и credentials namespace.

## Подключить внешний провайдер

Добавьте реальный коннектор в `connectors` Dex и передайте его credentials через
Secret/envFrom. Для OIDC-провайдера укажите issuer, clientID, clientSecret
и redirectURI `https://dex.example.org/callback`. Обновите Helm-конфигурацию Dex.
Кнопка провайдера появится в Dashboard с учётом разрешённых коннекторов клиента.

При первом внешнем входе Dex может создать User, но не назначает ему роли.
Локальные группы задаются через Group.users; группы upstream заменяются ими.
Не связывайте пользователей по совпадению email: identity использует ID
коннектора и неизменяемый ID провайдера.


## Самостоятельное редактирование профиля

`kubernetesGroups.accountManagement: true` включает API личного кабинета и
объявляет его в OIDC discovery. Соответствующее `rbac.accountManagement: true`
выдаёт сервису Dex право patch User. Пользователям это право не выдаётся:
Dex принимает только действующий refresh token вместе с credentials его
confidential клиента, сам сопоставляет User и разрешает изменить firstName,
lastName, email и phone. UID/resourceVersion защищают от замены учётной записи
и параллельной перезаписи. Заблокированный или удалённый User не продолжает вход.

Общие операции IAM и все ресурсные API консоли сохраняют native Kubernetes
RBAC и права вошедшего пользователя. Личный кабинет не позволяет менять группы,
идентичности, пароль, флаг блокировки или назначения ролей.

User-Agent клиента при входе сохраняется в `OfflineSessions.Refresh[].userAgent`,
до 1024 символов. Dashboard передаёт браузерный заголовок при обмене токенов;
ротация его сохраняет. Значение не добавляется в JWT и не влияет на RBAC.

Список активных сессий — безопасная проекция `RefreshToken` всех identities User.
Включённый режим сохраняет независимые входы одного клиента и поддерживает
старые OfflineSessions с ключами clientID. Отзыв удаляет выбранный refresh token;
консоль проверяет его существование перед новым запросом. Уже выданный JWT у
внешнего потребителя действует до exp: оставьте короткий idTokens lifetime.

## Переход с SQLite и резервное копирование

Перед сменой storage остановите изменения конфигурации и сохраните резервную
копию прежней базы/PVC принятым у вас защищённым способом. Для существующей
установки оставьте `persistence.enabled: true` на переходном этапе: прежний PVC
сохранится, хотя Kubernetes storage им не пользуется. Установите CRD, включите
storage RBAC, обновите конфигурацию через Helm и проверьте readiness/discovery.
Пользователям потребуется войти снова; автоматического переноса SQLite нет.
Старый PVC удаляют отдельно после проверки новой установки и решения об откате.

Для нового хранилища сохраняйте в защищённой резервной копии все ресурсы
`dex.coreos.com/v1` namespace Dex, User/Group и Secrets credentials. Содержимое
native Dex CRD включает refresh secrets, signing keys и данные коннекторов.
Не выдавайте их чтение обычным пользователям, не публикуйте дампы и не выводите
полные объекты в журналы. Настройки профиля получают только разрешённые поля.
После восстановления или обновления проверьте сохранение сессии при перезапуске
Dex и возможность отзыва одного входа при работающем втором входе.
