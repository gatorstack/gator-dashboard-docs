# Список данных адаптера

`x-dashboard-view: data-list` показывает табличные данные именованного адаптера.
Он применяется, когда данные хранятся вне Kubernetes; строки не копируются в CR.
Пример страницы для установленного продукта мониторинга:

```yaml
apiVersion: dashboard.gatorstack.dev/v1alpha1
kind: ProductPage
metadata:
  name: monitoring-metrics
  namespace: gator-dashboard
spec:
  productRef: {name: monitoring}
  title: Метрики проекта
  schema:
    inline:
      type: object
      x-dashboard-view: data-list
      x-dashboard-data-list:
        adapterRef: {name: project-metrics}
        resourceRef: {name: monitoring-tenant}
        resourceName: project
        operation: metric-series
        columns:
          - {key: name, title: Метрика}
          - {key: labels, title: Лейблы}
```

`resourceRef` ссылается на ProductResource того же продукта. Его target должен
быть Namespaced с `namespacePolicy: CurrentProject`. `resourceName` выбирает
фиксированный CR, проверяемый caller GET. `operation` — фиксированное имя
операции адаптера. Browser не задаёт operation, URL, headers или tenant ID.
Параметры запроса endpoint списка не принимает.

Адаптер настраивается в `dataLists.adapters`. Backend передаёт POST `/v1/data`
с service Bearer token и JSON `operation`, `namespaceUID`, `target`.
Target содержит `apiVersion`, `kind`, `namespace`, `name`, `uid`; содержимое CR
и caller credential не передаются. Адаптер обязан повторно проверить identity
и ограничить доступ к своему хранилищу. Успешный ответ содержит `items`, например строку с полями `name` и `labels`.
Адаптер мониторинга возвращает полный набор лейблов текстом; разные наборы
остаются отдельными строками.

Допускается 1–16 колонок с уникальными identifier `key` и `title`. Только
объявленные scalar значения (строка, число, boolean, null) передаются браузеру.
Лимит — 10000 строк и 1 MiB, timeout20s; redirects и вложенные объекты запрещены.
Ошибка адаптера не раскрывает upstream body. UI даёт поиск, обновление и polling30s;
ошибка очищает строки, переключение проекта создаёт новый список.
