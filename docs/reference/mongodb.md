# API Managed MongoDB

API group `mongodb.gatorstack.dev/v1alpha1`, все ресурсы namespaced.

| Kind | Назначение |
| --- | --- |
| MongoDBCluster | Основной namespaced Crossplane XR заказа |
| MongoDBPlacement | Доступная конфигурация региона/подсетей/топологии |
| MongoDBClass | Каталог CPU/RAM, общий в namespace каталога |
| MongoDBRuntime | Приватный composed artifact/health CR; клиенту не выдаётся |

`MongoDBCluster.spec`:

| Поле | Значение |
| --- | --- |
| region | Регион, неизменяем |
| topology | single / cluster / shard, неизменяем |
| shards | 0 для single/cluster, 2–4 для shard |
| hostCount | 1 / 3 / `3 * shards + 5` соответственно |
| version | 8.0, пакеты первой версии 8.0.34 |
| resources | class, vcpu, memoryGiB каждого хоста |
| subnets | name/uid; одна для single, три разных зоны одной сети для остальных |
| storageGiB | 20–8192 GiB на VM, неизменяем |
| storageType | HDD / SSD / NVME, неизменяем |
| database | Начальная БД; app по умолчанию, неизменяема; admin/config/local запрещены |
| allowedCIDRs | 1–16 канонических IPv4 сетей; редактируются |
| deletionProtection | Защита удаления, true по умолчанию |
| tags | Пользовательские строковые метки |

Пример single (подставьте фактические name/uid подсети и региональный класс):

```yaml
apiVersion: mongodb.gatorstack.dev/v1alpha1
kind: MongoDBCluster
metadata:
  name: my-mongodb
  namespace: my-project
spec:
  region: region-1
  topology: single
  shards: 0
  hostCount: 1
  version: '8.0'
  resources: {class: small, vcpu: 2, memoryGiB: 2}
  subnets:
    - {name: project-subnet-a, uid: replace-with-real-subnet-uid}
  storageGiB: 20
  storageType: SSD
  database: app
  allowedCIDRs: [192.0.2.0/24]
  deletionProtection: true
  tags: {}
```

Для cluster задайте `topology: cluster`, `hostCount: 3` и три subnet refs.
Для двух shards задайте `topology: shard`, `shards: 2`, `hostCount: 11` и три
subnet refs. Поля Crossplane binding/resourceRefs управляются платформой.

Status содержит phase/message, observedGeneration, hosts (role/set/zone/addresses),
connectionSecretRef и identity проекта. Секретные значения в status отсутствуют.
Поля output Secret: hosts, database, username, password, uri, ca.crt. Secret
принадлежит UID XR; чтение выдаётся отдельной Role с единственным resourceName.

Роли `mongodb.auditor/viewer/editor/owner` кумулятивны: чтение заказов и placement,
создание/изменение у editor, удаление у owner. Они не дают доступа к private
Runtime, infrastructure Objects, AnsibleRun и Secrets. Защита удаления применяется
также к прямому Kubernetes API. Квоты `mongodb` учитывают кластеры, hostCount,
суммарные vCPU/RAM и диски с множителем hostCount.

В shard клиентская app получает database-scoped custom role с единственным
действием enableSharding для начальной БД в дополнение к readWrite. Это позволяет
выбрать shard key через MongoDB client без выдачи cluster administrator.
