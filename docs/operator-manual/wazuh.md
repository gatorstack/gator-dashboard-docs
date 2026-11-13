---
title: Wazuh SIEM
---

# Wazuh SIEM

Wazuh — самостоятельная платформа анализа событий безопасности. Её можно
развернуть рядом с Gator для сбора событий серверов и подключаемых систем.
Установка содержит manager, indexer и Wazuh Dashboard. У консоли собственные
учётные записи: проектные роли Gator и вход через Dex на неё не распространяются.

## Предварительные условия

Нужны Kubernetes, Helm, `oc`, Python 3, Apache `htpasswd` с bcrypt, постоянный
StorageClass, ingress-nginx и cert-manager с настроенным ACME ClusterIssuer.
DNS-имя консоли должно вести на ingress. Для indexer необходим init container
с privileged permission: он устанавливает `vm.max_map_count=262144` на узле и
готовит права каталога данных. Init container manager поднимает
`fs.inotify.max_user_instances` минимум до 1024: лимит 128 может быть исчерпан
другими процессами root на общей ноде. Параметры `nodeSettings.vmMaxMapCount` и
`nodeSettings.inotifyMaxUserInstances` не уменьшают уже установленные большие
значения. Основные контейнеры не получают privileged mode или доступ к Kubernetes API.

Схема содержит одну реплику каждого компонента и не обеспечивает высокой
доступности. Локальные тома привязаны к одному узлу. Планируйте ресурсы с учётом
других приложений кластера и будущего объёма security-логов.

## Установка

Получите инфраструктурный комплект:

```sh
git clone https://github.com/gatorstack/gator-infrastructure.git
cd gator-infrastructure
```

Создайте `wazuh-values.yaml`, заменив домен и параметры своего кластера:

```yaml
imageTag: 4.14.9
storageClass: local-path
credentialsSecret: wazuh-credentials
internalUsersSecret: wazuh-indexer-users
indexer:
  storage: 30Gi
manager:
  storage: 10Gi
ingress:
  className: nginx
  host: wazuh.example.org
  clusterIssuer: letsencrypt-prod
```

Выберите кластер явно и выполните установку:

```sh
python3 scripts/deploy-wazuh.py \
  --kubeconfig /secure/kubeconfig \
  --expected-server https://kubernetes.example.org:6443 \
  --values wazuh-values.yaml
oc --kubeconfig /secure/kubeconfig -n wazuh get pods,pvc,certificate,ingress
```

Ожидаемый результат — три Ready pod, два Bound PVC и готовые сертификаты.
Откройте настроенный HTTPS-адрес. В лаборатории ERT это
`https://wazuh.ert.gatorstack.dev`; доступ требует VPN к ERT.

Скрипт создаёт случайные пароли до первого запуска компонентов и сохраняет их
в Secret `wazuh/wazuh-credentials`. Bcrypt-хеши находятся отдельно в
`wazuh/wazuh-indexer-users`. Демонстрационные учётки indexer не устанавливаются.
Helm хранит ссылки на Secret, а не пароли. Повторная установка сохраняет
credentials. Если данные уже есть, а credential Secret потерян, восстановите его.

Имя администратора — `admin`. Для передачи пароля используйте защищённый
локальный механизм. На macOS флаг `--copy-admin-password` при повторном запуске
той же команды копирует существующий пароль в буфер обмена без вывода значения.

## Подключение источников

Установка центральных компонентов сама по себе не начинает аудит серверов или
Kubernetes. Для серверов установите Wazuh agents и настройте источники событий;
для Kubernetes/OKD отдельно настройте сбор и доставку audit logs. Проверьте
правила обнаружения на событиях вашей среды.

Service `wazuh-manager` публикует внутри кластера TCP 1514 для событий агентов,
1515 для регистрации и 55000 для API. HTTPS ingress ведёт только в веб-консоль;
он не проксирует агентский протокол. Для удалённых агентов организуйте отдельный
сетевой доступ к 1514/1515 и используйте enrollment password из credential Secret.
API 55000 и indexer 9200 оставляйте во внутренней сети.

Wazuh не получает автоматически данные из OpenObserve или клиентского
[логирования Gator](logging.md). Выбирайте источники и правила отправки отдельно.
Административная SIEM не предоставляет проектную изоляцию Gator.

## Приём CEF от Audit Trails

Включите внутренний TCP syslog listener и ограничьте допустимые IP источников:

```yaml
manager:
  syslog:
    enabled: true
    port: 5514
    allowedIPs: [10.42.0.0/16]
    gatorAudit: true
    allowedPeers:
    - namespaceSelector:
        matchLabels: {kubernetes.io/metadata.name: logging}
      podSelector:
        matchLabels: {app: gator-audit}
```

Замените Pod CIDR на свою сеть и примените values через установочный скрипт.
`gatorAudit` добавляет CEF decoder и правила 110100/110101 для Gator Audit.
NetworkPolicy дополнительно допускает syslog только от перечисленных peers;
Pod другого проекта не может подделать событие Gator через этот приёмник.
Для другого источника настройте отдельный peer/ipBlock. API manager доступен
Dashboard своего namespace, агентские порты сохраняют свой протокол авторизации.
Service manager публикует 5514 только внутри кластера; веб-ingress остаётся
адресом консоли. В AuditTrail выберите SIEM, хост
`wazuh-manager.wazuh.svc`, порт 5514, TCP и RFC3164. Для удалённого приёмника
организуйте отдельный защищённый сетевой маршрут; TLS-коннектору нужен приёмник
с поддержкой TLS.

Создайте ресурс в подключённом проекте и найдите событие в `wazuh-alerts-*` по
группе `gator_audit` и `data.audit.event_id`. Поля `audit.source`, `audit.event_type`,
`audit.project_uid`, `audit.actor`, `audit.outcome` позволяют проверить разбор.
Успешные события получают правило110100 уровня3, отказы —110101 уровня7.
Включение приёмника не заменяет проектные трейлы и выбор источников.

## Проверка и эксплуатация

```sh
python3 scripts/verify-wazuh.py \
  --kubeconfig /secure/kubeconfig \
  --expected-server https://kubernetes.example.org:6443
```

Проверка подтверждает доступность API, вход через HTTPS и доставку одного
синтетического SSH-события через manager в `wazuh-alerts-*`. Событие помечено
`wazuh-smoke` и остаётся доступным для расследования. Проверка не подтверждает
подключение реальных серверов или полноту правил обнаружения.

Manager сохраняет конфигурацию, ключи агентов, БД, alerts и Filebeat registry
в своём PVC; indexer хранит события и настройки веб-консоли в отдельном PVC.
При удалении StatefulSet PVC сохраняются. Не удаляйте их или Secret ради рестарта.
Настройте snapshots indexer и согласованные резервные копии manager и Secret.
Сохранение PVC не является резервным копированием.

## Хранение и ограничение объёма

По умолчанию сохраняются совпавшие alerts; архивирование всех исходных событий
отключено. Поставка автоматически ограничивает историю на двух уровнях:

| Данные | Срок | Объём |
|---|---|---|
| Закрытые alert-файлы manager | до 3 дней | до 2 ГиБ суммарно |
| Активный JSON alert-файл | ротация раз в час или по 100 МиБ | дополнительное место для активного файла и сжатия |
| Индексы событий indexer | до 7 дней | до 20 ГиБ суммарного store, включая реплики |

При превышении объёма старые данные удаляются раньше. Это верхний срок, а не
гарантия доступности всей истории за указанное число дней. Настройки values:

```yaml
retention:
  intervalSeconds: 60
manager:
  retention:
    days: 3
    maxBytes: 2147483648
    maxOutputSize: 100M
    rotateInterval: 1h
    plainTextAlerts: false
indexer:
  retention:
    days: 7
    maxBytes: 21474836480
    maxIndexGiB: 6
```

Применяйте значения тем же `deploy-wazuh.py`, сохраняя credential Secrets и PVC.
JSON alerts остаются включены для Filebeat. Дублирующий `alerts.log` отключён;
при переходе со старой установки init container удаляет прежнюю активную ссылку
на этот plaintext-файл до старта manager. Нативная ротация Wazuh ограничивает
размер активных файлов. Отдельный sidecar каждые 60 секунд удаляет старейшие
закрытые alerts по возрасту и объёму; активные файлы и только что завершённые
ротации защищены. Конфигурация, ключи агентов, БД, feed уязвимостей и очереди
manager не входят в этот бюджет и не очищаются.

Для indexer устанавливается штатная ISM policy `gator-wazuh-events-retention`.
Она применяется к новым и существующим индексам событий без другой ISM policy:
удаление по возрасту 7 дней либо при 6 ГиБ primary shards отдельного индекса.
Sidecar дополнительно проверяет **сумму** store всех индексов событий и удаляет
старейшие целиком через HTTPS API. Это охватывает alerts, archives, monitoring
и statistics; security database, настройки Dashboard и state inventory сохраняются.
Существующая чужая ISM policy не заменяется, но общий бюджет событий продолжает
действовать.

Если текущий дневной индекс один превышает общий бюджет, он тоже удаляется;
новые события создадут его заново. Размер проверяется периодически, поэтому
кратковременное превышение возможно. Translog, merge, служебные индексы, активные
файлы и БД manager требуют дополнительного места. Это политики удаления, а не
filesystem quota: `requests.storage` у local-path **не ограничивает** фактический
объём. Оставляйте запас на диске и контролируйте его свободное место.

Проверяйте работу очистки и последнее успешное выполнение:

```sh
oc --kubeconfig /secure/kubeconfig -n wazuh logs wazuh-manager-0 -c retention --tail=5
oc --kubeconfig /secure/kubeconfig -n wazuh logs wazuh-indexer-0 -c retention --tail=5
oc --kubeconfig /secure/kubeconfig -n wazuh get pods,pvc
```

У manager и indexer ожидается по два Ready контейнера. Журналы очистки содержат
счётчики байтов и имена удалённых индексов. `retention_failed` требует проверки
доступа к alert-каталогу, TLS/API indexer и ISM; при отсутствии успешной очистки
три интервала sidecar становится NotReady. Ему не выдаются Kubernetes API token
или privileged mode. Не удаляйте каталоги shard на диске для обхода ошибки API.

Механизмы ротации описаны в [Wazuh global configuration](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/global.html)
и [Wazuh index lifecycle management](https://documentation.wazuh.com/current/user-manual/wazuh-indexer-cluster/index-lifecycle-management.html).

cert-manager продлевает сертификат ingress и внутренние сертификаты. После
обновления внутренних leaf-сертификатов перезапустите соответствующие workloads,
чтобы процессы загрузили новые файлы. Сохраняйте CA Secret при восстановлении.
API manager использует штатный собственный сертификат в постоянном томе.

Если исходящие TLS-соединения manager к CTI зависают на handshake, проверьте
их отдельно от доступа браузера к консоли. Для подтверждённого ограничения
большого ClientHello в ERT профиль задаёт
`manager.opensslGroups: X25519:P-256:P-384`. Настройка сохраняет TLS 1.3 и
проверку сертификатов; в других сетях она по умолчанию не задана.
`manager.caBundle` указывает встроенному runtime системный CA bundle образа.
Проверка установки также обращается к текущему каталогу базы уязвимостей Wazuh.

Для смены паролей следуйте
[процедуре Wazuh](https://documentation.wazuh.com/current/user-manual/user-administration/password-management.html),
согласованно обновите Kubernetes Secrets и перезапустите потребителей. Изменение
Secret само по себе не меняет пароль в security database indexer или manager API.
