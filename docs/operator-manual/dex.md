# Gator Dex и OIDC

Gator Dex добавляет локальные учётные записи, группы и внешних провайдеров входа.
Его chart устанавливается отдельно. Ниже приведён полный вариант локального
входа с доменами `dex.example.org` и `dashboard.example.org`.

Используйте административный контекст `GATOR_CONTEXT` из
[руководства установки](installation.md). Нужны Ingress, TLS для обоих доменов
и StorageClass для PVC Dex. Команды установки Dex выполняются из каталога
`gator-dex` полученного комплекта. Для этого примера используется образ
`valerahex/gator-dex:study-local-oidc-20261015`.

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

## 2. Настройте Dex

Сохраните `dex-config.yaml`:

```yaml
issuer: https://dex.example.org
storage:
  type: sqlite3
  config:
    file: /var/dex/dex.db
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
  repository: valerahex/gator-dex
  tag: study-local-oidc-20261015
configSecretName: gator-dex-config
envFrom:
  - secretRef:
      name: gator-dex-client-credentials
localUsers:
  enabled: true
  passwordNamespace: gator-dex-users
persistence:
  enabled: true
  size: 1Gi
  storageClass: ""
ingress:
  enabled: true
  className: nginx
  host: dex.example.org
  tls:
    - secretName: dex-tls
      hosts: [dex.example.org]
```

Пустой `storageClass` использует стандартный класс кластера. Укажите конкретный,
если стандартного нет. Текущий chart Dex использует одну реплику и SQLite на PVC.

```sh
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
