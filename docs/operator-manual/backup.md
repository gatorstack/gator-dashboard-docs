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
