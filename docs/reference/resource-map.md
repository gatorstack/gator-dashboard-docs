# Карта ресурсов

`x-dashboard-view: resource-map` строит карту произвольных GVK по существующим
List ProductPage. Типы ресурсов и связи задаются JSON Schema; отдельный
компонент для продукта не нужен. Пользователь должен иметь list/watch целевых
ресурсов. Источник с запретом доступа показывает ошибку, сохраняя доступные узлы.

Пример страницы для установленного пакета VPC:

```yaml
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: ProductPage
metadata:
  name: customer-network-map
  namespace: gator-dashboard
spec:
  productRef: {name: vpc}
  title: Карта сети
  schema:
    inline:
      type: object
      x-dashboard-view: resource-map
      x-dashboard-map:
        sources:
          - id: networks
            title: Сети
            pageRef: {name: vpc-networks}
            detailPageRef: {name: vpc-networks-detail}
            titlePath: /spec/forProvider/name
            regionPath: /spec/providerConfigRef/name
          - id: subnets
            title: Подсети
            pageRef: {name: vpc-subnets}
            detailPageRef: {name: vpc-subnets-detail}
            titlePath: /spec/forProvider/name
            subtitlePath: /spec/forProvider/cidr
            regionPath: /spec/providerConfigRef/name
            zonePath: /metadata/annotations/vpc.gatorstack.dev~1zone
            parent:
              source: networks
              path: /metadata/annotations/vpc.gatorstack.dev~1network-uid
```

| Поле источника | Назначение |
| --- | --- |
| `id` | Уникальный DNS label типа узлов |
| `title` | Заголовок столбца |
| `pageRef.name` | List страница с resourceRef того же продукта |
| `detailPageRef.name` | Необязательная Detail страница того же ProductResource |
| `titlePath` | Обязательный JSON Pointer заголовка узла |
| `subtitlePath` | Необязательная подпись |
| `regionPath`, `zonePath` | Поля размещения; регионы формируют фильтр |
| `parent.source` | ID другого источника этой карты |
| `parent.path` | Поле текущего узла с UID родительского CR |

Допускаются 1–12 источников. Карта использует namespace текущего проекта,
обычные API списка/watch и UID объектов. Произвольные URL и межпродуктовые
источники не принимаются. Поиск и регион фильтруют видимые узлы; связи видны
между оставшимися узлами. Выбор узла раскрывает переход к карточке и связанные
узлы. На карту выводятся первые 200 объектов типа, с явным сообщением об этом
ограничении; исходные списки не обрезаются картой.
