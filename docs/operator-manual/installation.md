# Установка

Руководство устанавливает Dashboard в один Kubernetes-кластер и создаёт первый
проект с доступом для ServiceAccount. Затем можно подключить
[Gator Dex](dex.md) для обычных пользователей и отдельно [биллинг](billing-installation.md).

## Перед началом

Потребуются:

- административный доступ к целевому кластеру через `oc` или `kubectl`;
- Helm и chart Gator Dashboard из поставки решения;
- доступ узлов к реестру с образом;
- Ingress controller, DNS-имя и TLS-сертификат для консоли;
- поддержка streaming initial events (WatchList) в Kubernetes API для карточек
  ресурсов и IAM; для всех страниц ресурсов нужны list/watch.

В командах ниже используется `oc`, который также работает с обычным Kubernetes.
Chart доступен в каталоге `gator-dashboard/charts/gator-dashboard`.
Публичный адрес Helm-репозитория в этой поставке не задан: команды используют
локальный chart из полученного комплекта, без сборки приложения.

Примеры используют namespace `gator-dashboard`, проект `team-a` и домен
`dashboard.example.org`. Замените домен, Ingress class и файлы сертификата своими.
Для примеров каталога ролей используется образ
`valerahex/gator-dashboard:0.2.0`.
При выборе другой поставки используйте согласованные версии chart и образа.

Консоль устанавливается без облачных продуктов. Пакеты каталога и provider runtime
ставятся отдельно: [Поставка продуктов](product-packages.md). IAM остаётся
опциональной встроенной подсистемой.

## 1. Проверьте кластер

```sh
oc config get-contexts
GATOR_CONTEXT='my-cluster-admin'
oc --context "$GATOR_CONTEXT" whoami --show-server
oc --context "$GATOR_CONTEXT" get nodes
oc --context "$GATOR_CONTEXT" get ingressclass
```

`my-cluster-admin` — имя контекста вашего kubeconfig. Все последующие команды
явно используют его и не переключают глобальный контекст.

## 2. Подготовьте namespace и внешний TLS

```sh
oc --context "$GATOR_CONTEXT" create namespace gator-dashboard
oc --context "$GATOR_CONTEXT" -n gator-dashboard create secret tls dashboard-tls \
  --cert=tls/dashboard.crt --key=tls/dashboard.key
```

Если namespace уже существует, пропустите его создание. Сертификат должен
соответствовать DNS-имени консоли. Вместо ручного Secret можно настроить выпуск
через cert-manager — [Ingress и TLS](ingress-tls.md).

## 3. Создайте файл настроек

Сохраните как `dashboard-values.yaml` рядом с полученным комплектом chart:

```yaml
image:
  repository: valerahex/gator-dashboard
  tag: 0.2.0
replicaCount: 1
cookieSecure: true
iam:
  enabled: false
oidc:
  enabled: false
ingress:
  enabled: true
  className: nginx
  host: dashboard.example.org
  tls:
    - secretName: dashboard-tls
      hosts: [dashboard.example.org]
webhook:
  enabled: true
  certManager:
    enabled: false
rbac:
  testAdmin: false
  authentificated:
    enabled: true
  roleCatalog:
    enabled: true
```

Это первый вход через ServiceAccount. IAM и OIDC включаются при подключении
Dex. Тестовый аккаунт с `cluster-admin` не создаётся. Внутренний сертификат webhook
в этом варианте создаёт Helm; его срок и продление описаны в [TLS](ingress-tls.md).

## 4. Установите Dashboard

Из каталога `gator-dashboard` выполните:

```sh
helm upgrade --install gator-dashboard ./charts/gator-dashboard \
  --kube-context "$GATOR_CONTEXT" \
  --namespace gator-dashboard \
  -f dashboard-values.yaml --wait --timeout 5m
```

Если файл values находится вне каталога `gator-dashboard`, укажите его путь.
При первой установке Helm устанавливает CRD автоматически.

Проверьте результат:

```sh
helm --kube-context "$GATOR_CONTEXT" -n gator-dashboard status gator-dashboard
oc --context "$GATOR_CONTEXT" -n gator-dashboard get deployment,pods,service,ingress
oc --context "$GATOR_CONTEXT" -n gator-dashboard rollout status deployment/gator-dashboard
curl --fail https://dashboard.example.org/healthz
```

Ожидается готовый Deployment и успешный HTTP-ответ `/healthz`. Проверка
`/healthz` подтверждает работу процесса; доступ к проекту проверяется следующим шагом.

## 5. Создайте первый проект и доступ

Сохраните как `first-project.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-a
---
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: Project
metadata:
  name: project
  namespace: team-a
spec:
  name: Команда A
  description: Первый проект
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: dashboard-reader
  namespace: team-a
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: dashboard-reader
  namespace: team-a
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: auditor
subjects:
  - kind: ServiceAccount
    name: dashboard-reader
    namespace: team-a
```

```sh
oc --context "$GATOR_CONTEXT" apply -f first-project.yaml
oc --context "$GATOR_CONTEXT" -n team-a create token dashboard-reader --duration=1h
```

Последняя команда выдаёт временный токен для ввода на странице входа.
Не добавляйте его в values или манифест. Откройте консоль, войдите с этим токеном
и убедитесь, что виден проект «Команда A» и открываются Home и Квоты.

## Дальнейшая настройка

- [Gator Dex и вход пользователей](dex.md).
- [Проекты и квоты](projects.md).
- [Назначение ролей](rbac.md).
- [Продукты и страницы](catalog.md).
- [Обновление установки](upgrading.md).

Несколько установок Dashboard в одном кластере требуют переиспользования общих
ClusterRole — [параметры Helm](../reference/helm-values.md).
