# Поставка продуктов

Консоль и продукты устанавливаются независимо. Единственный встроенный
специализированный продукт — IAM; его можно отключить. Новый облачный сервис
не требует добавления компонентов или проверок GVK в исходный код консоли.

## Репозитории компонентов

| Репозиторий gatorstack | Назначение |
| --- | --- |
| gator-dashboard | Консоль, generic API/CRD, IAM, chart установки |
| gator-products | Папка и chart каждого продукта, provider integrations |
| gator-dex | Dex с Kubernetes User/Group и локальной аутентификацией |
| gator-openstack-storage | Самостоятельный Cinder snapshot mini-оператор |
| gator-cost | Адаптер учёта CR и конфигурация биллинга |
| gator-openmeter | Зафиксированный форк OpenMeter с исправлением invoice simulation |
| gator-infrastructure | Terraform и сборка учебной инфраструктуры |

Документация публична; для получения исходников остальных компонентов нужен
доступ к соответствующим приватным репозиториям организации.

## Установить пакет

Сначала установите [консоль](installation.md). В каталоге `gator-products`
находятся работающие пакеты `products/home`, `products/iaas`, `products/vpc`.
Каждый имеет собственный `chart/` и values. Выполните из этого репозитория:

```sh
helm dependency build --skip-refresh products/home/chart
helm upgrade --install gator-product-home products/home/chart \
  --kube-context "$GATOR_CONTEXT" -n gator-dashboard --wait
helm dependency build --skip-refresh products/iaas/chart
helm upgrade --install gator-product-iaas products/iaas/chart \
  --kube-context "$GATOR_CONTEXT" -n gator-dashboard --wait
```

Namespace должен совпадать с namespace каталога консоли. Один объект каталога
не должен одновременно принадлежать нескольким Helm releases. Для обновления
существующей установки сохраните имена Product, страниц, ресурсов и release.
Удаление пакета каталога не удаляет ранее созданные инфраструктурные CR.

`providers/openstack/chart` поставляет подключения, каталоги и адаптер VPC.
Его установите по руководствам [IaaS](iaas.md) и [VPC](vpc.md). Оператор снимков
устанавливается из отдельного репозитория. Наличие JSON Schema не заменяет
установку соответствующего Crossplane provider или оператора.

## Настроить главную

Главной может стать любой продукт, независимо от его имени:

```yaml
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: Product
metadata:
  name: customer-portal
  namespace: gator-dashboard
spec:
  name: Портал компании
  category: platform
  navigation:
    projectHome: true
    defaultPageRef: {name: customer-overview}
    overview: false
  menu:
    - {name: customer-overview, title: Обзор}
---
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: ProductPage
metadata:
  name: customer-overview
  namespace: gator-dashboard
spec:
  productRef: {name: customer-portal}
  title: Обзор
  schema:
    inline:
      type: object
      x-dashboard-view: project-overview
```

Назначайте `projectHome` только одному продукту. Конфликт показывается как
ошибка конфигурации. Без назначенной главной открывается общий обзор проекта.
`overview: false` скрывает автоматически добавляемую страницу обзора продукта;
страницы из menu продолжают работать. Старые прямые ссылки на Product/Page
сохраняются.

## Создать собственный продукт

Добавьте `products/<service>/chart`. Chart подключает библиотеку
`charts/gator-product`; values содержат `catalog.products`, `catalog.resources`,
`catalog.pages`, при необходимости schema `catalog.configMaps` и `role` с
реальными Kubernetes API rules.

В ProductResource укажите target apiVersion/kind/scope, создание и изменение
с canonical inputSchema и mappings, нормализованные статусы/outputs, lookup,
relations и actions. В ProductPage задайте JSON Schema List/Detail/Create/Edit/
Action. Для каждой сущности используется один основной CR.

Продуктовые роли поставляются самим пакетом и агрегируются в общие роли
Kubernetes. `rbac.roleCatalog.bindableRoles` чарта консоли задаёт только список
внешних ClusterRole, которые разрешено назначать владельцам проектов; он не
заменяет правила доступа продукта.

Для изменения видимого каталога не нужны пересборка образа и ветки по GVK.
Новая функция облачного провайдера может потребовать его штатный managed
resource или отдельный оператор. Полный Gated/Operation runtime и резервации
квот не входят в текущий Direct runtime.

Объектное хранилище поставляется пакетом `products/s3/chart`: бакеты, учётки,
ключи и права на конкретные бакеты. Подготовка backend-подключений и границы
доступа находятся в `providers/radosgw/`. См. [установку S3](s3.md) и
[руководство пользователя](../user-guide/s3.md).
