# Резервное копирование и восстановление

## Что сохранять

| Компонент | Что нужно для восстановления |
| --- | --- |
| Dashboard | Values, Product/ProductResource/ProductPage, Project, Role/RoleBinding, общие ClusterRole/ClusterRoleBinding, внешние схемы ConfigMap |
| Dex | Конфигурация, клиентские credentials, User/Group, credentials namespace, база на PVC |
| Биллинг | Ledger PostgreSQL, отдельная БД OpenMeter, ClickHouse, Kafka, Redis и их конфигурация |
| TLS | Внешние сертификаты/ключи или воспроизводимая конфигурация issuer и план ротации |

Сессии Dashboard восстанавливать не нужно: после перезапуска пользователи
входят заново. Само наличие PVC не является резервной копией.

## Организовать резервирование

Храните несекретную конфигурацию декларативно. Резервные копии базы и Secret
размещайте в защищённом хранилище вне обслуживаемых PVC. Установите периодичность,
срок хранения и контроль успешного восстановления согласно требованиям среды.
Текущие charts не настраивают полный внешний backup автоматически.

Не публикуйте выгрузки Secret или полные конфиги credentials в Git, документации
или запросе на поддержку.

## Восстановить Dashboard и Dex

1. Восстановите namespaces, CRD и нужные Secret из выбранной согласованной копии.
2. Восстановите базу Dex и его конфигурацию, проверьте issuer и TLS.
3. Установите charts со своими values, восстановите проекты, каталог и RBAC.
4. Проверьте вход, членство групп и разрешения на проекты.

Не создавайте пустую базу поверх существующего PVC. User с прежним именем
может получить новый UID при пересоздании: это влияет на локальную identity Dex.

## Восстановить окружение после потери кластера

Сначала определите, есть ли согласованная копия данных. Манифесты и Helm values
восстанавливают конфигурацию, но не возвращают содержимое дисков OpenStack,
базу Dex, историю действий или начисления. При отсутствии копии разворачивается
новое окружение с новой историей; прежние UID и сессии не сохраняются.

1. Подготовьте сеть узлов, Kubernetes и постоянное хранилище. Подключите VPN;
   для частных Floating IP нужны маршруты от клиента через VPN gateway к
   controller нужного региона и обратные маршруты к VPN-подсети.
   Закрепите маршруты в сетевой конфигурации ОС и проверьте их после повторной
   настройки интерфейса: разовая команда или WireGuard PostUp могут не
   восстановить маршрут при изменениях со стороны сетевой службы.
2. Проверьте явный Kubernetes-контекст и восстановите Ingress controller,
   cert-manager и CRD. Создайте namespaces до Secret и RoleBinding.
3. Восстановите провайдеры и облачные подключения. Старые UUID external networks,
   образов и flavor нельзя переносить в новое облако без проверки через его API.
   У каждого проекта должны быть собственные credentials и ProviderConfig.
4. Восстановите Dex, каталог и проекты, затем квоты, историю и биллинг.
   Для новой установки используйте `helm upgrade --install`; сценарий обновления,
   ожидающий существующие Secret или release, не заменяет первичную установку.
5. Проверьте реальные операции: вход и отказ в доступе, создание VM/сети/диска,
   связь с Floating IP через VPN, снимок и восстановление, начисление и историю.
   Статус Ready у Pod не подтверждает весь этот путь.

Если изменился домен, согласованно обновите DNS, TLS, Dex issuer, redirect URI
клиента Dashboard, доверие kube-apiserver и разрешённые origins встроенных
консолей. Для DNS-01 Cloudflare-токен должен иметь чтение зоны и изменение DNS
в нужной зоне; разрешение на управление самой зоной не даёт доступа к записям.
После выпуска сертификатов проверьте discovery Dex и новый вход пользователя.

## Ceph RGW как отдельный S3 backend

Ceph Object Gateway предоставляет S3 API поверх RADOS. Храните backend будущего
S3-продукта отдельно от служебного хранилища Cinder backups: у них разные
пользователи, жизненный цикл и требования к сохранности данных. Развёртывание
RGW само по себе не добавляет продукт, формы или биллинг S3 в Dashboard.

Для конфигурации backend задайте realm, zonegroup, zone и публичное имя S3 API.
У endpoint должны работать HTTPS и выбранный стиль адресации бакетов.
Virtual-host style требует wildcard DNS и сертификат для `*.s3.example.org`;
reverse proxy должен сохранять Host и путь запроса для проверки SigV4.
Для multipart uploads отключите буферизацию тела и задайте подходящий лимит
размера; не отключайте проверку сертификата в клиенте.

Создавайте development identity с обычными S3 keys. Admin capabilities нужны
отдельному доверенному исполнителю управления пользователями и бакетами;
не выдавайте клиентам CephX admin keyring. Сохраняйте ключи в защищённом профиле
клиента или Secret и не включайте их в манифесты каталога.

На Ceph host проверьте:

```sh
sudo cephadm shell -- ceph -s
sudo cephadm shell -- ceph osd stat
sudo cephadm shell -- ceph orch ps --daemon-type rgw --refresh
sudo cephadm shell -- ceph df detail
```

Приёмка S3 включает PUT/GET/HEAD/LIST, range-запросы, multipart, versioning,
presigned URL и отказы anonymous/чужой identity. После перезагрузки проверьте
здоровье Ceph и SHA256 ранее записанного объекта через тот же HTTPS endpoint.
Профиль с несколькими OSD внутри одной VM подходит для разработки; копии на
одной VM не обеспечивают независимые failure domains. Репликация Ceph не
заменяет внешнюю резервную копию.

Официальные инструкции: [установка cephadm](https://docs.ceph.com/en/tentacle/cephadm/install/),
[развёртывание RGW](https://docs.ceph.com/en/tentacle/cephadm/services/rgw/).

### Просмотр бакетов через Ceph Dashboard

Ceph Dashboard работает как модуль `ceph-mgr` на Ceph host и подключается к RGW.
Его установка не требует запуска Ceph или отдельного UI workload в Kubernetes.
В меню **Object Gateway → Buckets** доступны список и параметры бакетов,
в **Users** — пользователи RGW. Это самостоятельная административная консоль
Ceph; роли и вход Gator Dashboard к ней не применяются.

Для лабораторного доступа только через VPN задайте приватный адрес Ceph host
и отдельный HTTP-порт. Замените пример адресом своей VM:

```sh
CEPH_DASHBOARD_ADDRESS=10.0.0.24
sudo cephadm shell -- ceph config set mgr mgr/dashboard/server_addr "$CEPH_DASHBOARD_ADDRESS"
sudo cephadm shell -- ceph config set mgr mgr/dashboard/server_port 8081
sudo cephadm shell -- ceph config set mgr mgr/dashboard/ssl false
sudo cephadm shell -- ceph mgr module enable dashboard
sudo cephadm shell -- ceph dashboard set-rgw-credentials
sudo cephadm shell -- ceph mgr services
```

Настройте учётную запись перед предоставлением доступа. По умолчанию Dashboard
использует HTTPS; для доступа вне изолированного VPN установите доверенный
сертификат и сохраните TLS включённым. Пример выше явно отключает TLS только
для лабораторного профиля. Не публикуйте HTTP Dashboard в интернет. Если модуль
был включён до изменения адреса или SSL, перезапустите только модуль Dashboard:

```sh
sudo cephadm shell -- ceph mgr module disable dashboard
sudo cephadm shell -- ceph mgr module enable dashboard
```

Подготовьте пароль в файле `/root/ceph-dashboard-password` на Ceph host с правами
0600. Учётную запись создают с явно выбранной ролью:

```sh
sudo cephadm shell --mount /root/ceph-dashboard-password:/run/dashboard-password \
  -- ceph dashboard ac-user-create admin -i /run/dashboard-password administrator
sudo rm /root/ceph-dashboard-password
```

Файл на host необходимо явно передать в container через `cephadm shell --mount`;
не передавайте пароль аргументом команды. Для просмотра можно назначить роль
`read-only`, для администрирования — `administrator`. Профиль входа храните
отдельно от Git и резервных копий с обычным доступом; JWT и значения S3 keys
не включайте в журналы. Проверяйте вход и загрузку списка бакетов, а также
доступность существующего S3 endpoint после включения UI.

Подробнее: [Ceph Dashboard](https://docs.ceph.com/en/tentacle/mgr/dashboard/).

## Восстановить биллинг

Остановите начисляющие collectors/workers и jobs. Восстановите согласованное
состояние ledger и OpenMeter, включая ACK/outbox и дедупликацию. До повторной
отправки сверьте, какие события уже приняты. Потеря Redis может убрать защиту
от дублей; восстановление только ledger PostgreSQL не восстанавливает всю систему.

История KeepAll требует контроля роста PVC. Kafka имеет ограниченный транспортный
retention и не заменяет долговременный архив истории потребления.

## Резервные копии дисков OpenStack

Резервное копирование Cinder — отдельный сервис инфраструктуры. Снимок диска
остаётся в storage backend, а cinder-backup с S3-драйвером выгружает данные в
объектное хранилище. Включение сервиса не добавляет автоматические расписания
или кнопки backup в Dashboard: для них нужен отдельный контракт и исполнитель.

Для Kolla настройте в globals.yml каждого региона:

```yaml
enable_cinder: "yes"
enable_cinder_backup: "yes"
cinder_backup_driver: s3
cinder_backup_s3_url: https://backup-s3.example.org:8333
cinder_backup_s3_bucket: cinder-ru-msk
cinder_backup_extra_volumes:
  - /etc/kolla/backup-ca.pem:/etc/ssl/certs/backup-ca.pem:ro
```

В другом регионе используйте отдельный бакет, например cinder-ru-spb, и
отдельную S3 identity с доступом только к нему. Ключи
`cinder_backup_s3_access_key` и `cinder_backup_s3_secret_key` задавайте через
защищённый Kolla passwords.yml или принятый механизм секретов; права файла —
0600. Не добавляйте их в globals.yml, values или каталог продукта.

В override Cinder cinder.conf включите проверку TLS:

```ini
[DEFAULT]
backup_s3_verify_ssl = true
backup_s3_ca_cert_file = /etc/ssl/certs/backup-ca.pem
```

S3-совместимым хранилищем может служить SeaweedFS на отдельном узле с постоянным
диском. Сохраняйте вместе данные volume, метаданные master/filer, конфигурацию
identity, TLS CA и ключи. S3 endpoint публикуйте через HTTPS; внутренние master,
volume и filer API не открывайте клиентам. Запретите анонимные операции и
проверьте отказ доступа identity одного региона к бакету другого.

После настройки проверьте сервис и выполните полный цикл с тестовым диском:

```sh
openstack --os-cloud region-admin volume service list
openstack --os-cloud region-admin volume backup create --name restore-check SOURCE_VOLUME_ID
openstack --os-cloud region-admin volume backup show BACKUP_ID
openstack --os-cloud region-admin volume create --size 1 --availability-zone ru-msk-1 restore-check
openstack --os-cloud region-admin volume backup restore BACKUP_ID RESTORED_VOLUME_ID
```

Исходный диск должен быть в согласованном состоянии. По возможности отключите
его от ВМ перед копированием. Дождитесь `available` у backup и восстановленного
диска, подключите **новый** диск и сравните записанные до копирования данные.
Наличие S3-объектов или статус available без чтения восстановленных данных не
доказывает пригодность копии. Удалите только тестовые ресурсы после проверки.

Отдельная VM защищает от удаления исходного Cinder volume и отказа его узла.
Один SeaweedFS-узел остаётся единственной точкой отказа; независимое резервирование
его данных и метаданных требуется для восстановления после потери этой VM или
всей площадки. Политику хранения и периодические проверки восстановления
настраивает оператор.

Для LVM с TGT отдельно проверяйте восстановление экспорта подключённых дисков
после перезапуска storage services. Постоянная конфигурация targets должна быть
доступна и Cinder, и tgtd; она содержит CHAP credentials и требует защиты.
Проверьте `iscsiadm -m session -P 1` внутри iscsid: соединения должны быть
`LOGGED IN`. Работающий API Cinder и статус ВМ ACTIVE не подтверждают доступность
её корневого диска.

Если после старта tgtd сохранённые exports не загрузились, оператор может
восстановить их командой `tgt-admin --execute` внутри контейнера tgtd после
проверки постоянной конфигурации и наличия backing devices. Настройте порядок
запуска или автоматическое восстановление при каждом рестарте tgtd и проверьте
его на отдельном тестовом диске: записать данные, перезапустить сервис, дождаться
возврата iSCSI и сравнить данные. При длительном отказе и ошибках I/O проверьте
файловую систему гостя; одна повторная привязка диска не устраняет её ошибки.

Параметры драйвера описаны в [документации Cinder S3](https://docs.openstack.org/cinder/2025.2/configuration/block-storage/backup/s3-backup-driver.html),
права S3 — в [SeaweedFS S3 Credentials](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials).
