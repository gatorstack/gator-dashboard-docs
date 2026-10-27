# Обновление

## Переход к отдельным пакетам продуктов

Chart консоли 0.2 не содержит `catalog.products/pages/resources`, Home и
OpenStack runtime. Их поставляют отдельные [пакеты](product-packages.md).
Обычный upgrade прежнего монолитного release новым chart удалит его старые
объекты каталога, если их нет в новом manifest. Сначала перенесите конфигурацию.

Для сохранения ownership соберите umbrella chart с зависимостями консоли и
нужных продуктов и обновите им прежний release. Сохраните namespace и имена
Product, ProductResource, ProductPage, schema ConfigMap и ClusterRole. Values
консоли поместите под ключ зависимости `gator-dashboard`; catalog/role rules —
в соответствующие продуктовые зависимости. Проверьте Helm render до установки.
Такой способ сохраняет владельца объектов и не требует пересоздания заказов.

Для новой установки можно использовать отдельный release каждого продукта.
Не устанавливайте его поверх объектов, которыми владеет старый release:
сначала выполните контролируемую миграцию ownership. Смена CRD, release или
каталога не является основанием удалить пользовательские инфраструктурные CR.

## Подготовить обновление

Сохраните полный используемый values-файл и перечень внешних Secret/сертификатов.
Выберите chart и образ одной поставки. Проверьте изменения CRD и совместимость
настроек входа, ролей и схем страниц.

Не используйте настройки чужого окружения вместо своих: домены, issuer,
namespace credentials и назначения доступа относятся к вашей установке.
Массивы Helm заменяются целиком — сохраните весь каталог, меню и список ролей.

## Обновить CRD

Helm не обновляет уже установленные CRD из каталога `crds/`. Если схемы изменились,
из полученного комплекта Dashboard выполните:

```sh
oc --context "$GATOR_CONTEXT" apply -f charts/gator-dashboard/crds/
```

Для Dex и Cost используйте соответствующие каталоги их поставки. Перед
применением проверьте совместимость схемы с существующими объектами.

## Обновить release

Из каталога Dashboard:

```sh
helm upgrade --install gator-dashboard ./charts/gator-dashboard \
  --kube-context "$GATOR_CONTEXT" -n gator-dashboard \
  -f dashboard-values.yaml --wait --timeout 5m
helm --kube-context "$GATOR_CONTEXT" -n gator-dashboard history gator-dashboard
oc --context "$GATOR_CONTEXT" -n gator-dashboard rollout status deployment/gator-dashboard
```

После перезапуска Dashboard существующие сессии завершаются. Пользователям
нужно войти заново. Для внешних Secret Dex обновите их и выполните rollout,
если изменение не меняет checksum конфигурации Pod.

## Проверить результат

Проверьте HTTPS, вход, один разрешённый и один запрещённый проект, каталог,
квоты и изменённые разделы. Для IAM — список ролей и назначение/отзыв тестового
доступа. Проверьте готовность Pod и фактически запущенный образ, а не только
успешное завершение Helm.

## Откат

Выберите предыдущую ревизию из `helm history` и выполните:

```sh
helm --kube-context "$GATOR_CONTEXT" -n gator-dashboard rollback gator-dashboard REVISION --wait
```

Замените `REVISION` выбранным номером. Откат release не откатывает автоматически
CRD, внешние Secret и данные. Для Dex необходима совместимость его базы.
Для Cost возврат к writer версии 0.1 после перехода на минутный OpenMeter-учёт
требует отдельной миграции и не является обычным Helm rollback.
