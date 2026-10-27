# Устранение неполадок

Начните с целевого кластера и состояния компонентов:

```sh
oc --context "$GATOR_CONTEXT" whoami --show-server
oc --context "$GATOR_CONTEXT" -n gator-dashboard get pods,events
oc --context "$GATOR_CONTEXT" -n gator-dex get pods,events
```

## Пользователь вошёл, но проектов нет

Проверьте наличие `Project/project` в namespace и RoleBinding пользователя
или его группы. Базовый `authentificated` даёт обнаружение namespace и каталог,
но не чтение Project. Учётная запись и Group сами не назначают роли.

```sh
oc --context "$GATOR_CONTEXT" -n team-a get projects.dashboard.gatorstack.dev project
oc --context "$GATOR_CONTEXT" -n team-a get rolebindings
```

Сравните subject с реальной identity: обычно `dex:alice` или `dex:developers`.
Если изменилось членство группы, дождитесь обновления токена или войдите заново.

## Вход по паролю не работает

Проверьте, что User существует, не disabled и ссылается на ожидаемый Secret.
Проверьте совпадение credentials namespace в Dex и Dashboard. Нужен bcrypt,
plaintext в htpasswd не принимается. Проверяйте наличие ключа и права Dex,
не выводя содержимое Secret.

```sh
oc --context "$GATOR_CONTEXT" get users.user.gatorstack.dev alice
oc --context "$GATOR_CONTEXT" -n gator-dex-users get secret alice-htpasswd
oc --context "$GATOR_CONTEXT" -n gator-dex logs deployment/gator-dex --tail=100
```

## Провайдер принимает вход, а консоль отказывает

Сверьте issuer, audience/clientID, client secret и точный redirectURL.
Kube-apiserver должен доверять Dex и быть способен загрузить discovery/JWKS.
Проверьте DNS/TLS с его стороны. Сертификат, которому доверяет браузер,
не обязательно уже входит в доверие API server.

## После входа снова появляется страница входа

Проверьте HTTPS и `cookieSecure`. Secure-cookie не отправляется по HTTP.
Также сессию завершает перезапуск Dashboard. Несколько реплик без общего
хранилища/привязки сессий могут приводить к потере сессии между запросами.
Текущая рекомендуемая конфигурация использует одну реплику.

## Не открывается список ролей

Нужно отдельное право list/watch ClusterRole. Роль owner проекта не включает
его автоматически. Можно указать техническое имя роли вручную; возможность bind
всё равно проверит Kubernetes. Не расширяйте права backend ради обхода отказа.

## Не видна страница или ошибка схемы

Проверьте namespace каталога, ProductPage.productRef, единственный источник
schema, наличие нужного ключа ConfigMap и право get на этот ConfigMap.
После изменения каталога/схемы перезагрузите страницу браузера.

403 означает отказ доступа, 404 — отсутствующий объект/страницу/источник,
409 при сохранении IAM — конфликт изменения: откройте свежую карточку и повторите.
422 — неверные поля объекта. Пустая таблица без ошибки означает отсутствие
объектов в доступном списке.

## Объекты не обновляются или карточка не открывается

Проверьте list/watch ресурса, get/watch для карточки и поддержку WatchList
API server. Проверьте буферизацию и timeout прокси. Схемы не обновляются
тем же потоком, что объекты: изменение схемы требует перезагрузки.

## Webhook блокирует создание Project

Если имя отличается от `project`, отказ ожидаем. Для корректного имени
проверьте Ready Dashboard, Service webhook, срок сертификата и доверие caBundle.
Восстановите webhook и сертификаты; не отключайте проверку уникальности как
обычный способ устранения проблемы.

## Нет расходов или данные Estimated

Проверьте состояние [правила учёта и тарифа](billing-configuration.md),
источник, CEL-условие, поля, статус доставки OpenMeter и заполнение PVC.
Estimated означает пропуск наблюдений, а не подтверждённое нулевое потребление.

Для подробного анализа используйте логи компонентов, имеющийся мониторинг
и OpenObserve. Перед передачей диагностических материалов удалите credentials,
токены, DSN и тела Secret.
