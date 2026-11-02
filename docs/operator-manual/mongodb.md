# Установка и эксплуатация Managed MongoDB

Пакет устанавливается отдельным Helm release. Dashboard использует обычный
GVK-контракт; продуктовая логика находится в Composition и отдельном adapter.
Основной заказ — namespaced XR `MongoDBCluster`, API
`mongodb.gatorstack.dev/v1alpha1`. Устанавливать отдельную plain CRD этого kind
не следует: её создаёт XRD.

Нужны Crossplane 2 с namespaced XR, provider-openstack, stock provider-kubernetes
v1.4.1 и provider-ansible v0.8.0 с работающим Ansible runtime. Устанавливайте
общие провайдеры один раз. Каждый проект должен иметь собственный региональный
OpenStack ProviderConfig, ссылку на местный credential Secret и готовые SubnetV2.
Ubuntu 24.04 amd64 image и flavor IDs задаются профилем оператора.

Adapter проверяет identity подсетей, сеть, регион, зоны и класс; MR создаёт только
Composition. Служебные MR и credentials находятся в `gator-mongodb-system`.
Provider-kubernetes SA должен иметь права из чарта на этот namespace;
provider-ansible — читать его Secret artifacts. Проектные connection Secrets
никогда не содержат root, SSH ключ или private TLS ключ.

Получите chart из поставляемого комплекта и задайте kubeconfig своего кластера:

```sh
export KUBECONFIG=/secure/path/kubeconfig
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
helm dependency build products/mongodb/chart
kubectl apply --server-side -f products/mongodb/chart/crds/
```

Минимальный `mongodb-values.yaml` (замените IDs на реальные):

```yaml
systemNamespace: gator-mongodb-system
createSystemNamespace: false
projectNamespaces: [my-project]
controller:
  image: ghcr.io/gatorstack/gator-mongodb:0.1.0
  imagePullSecrets: [{name: registry-pull}]
composition:
  installKubernetes: false
  kubernetesServiceAccount: provider-kubernetes
profile:
  endpointDomain: mongo.example.org
  operatorCIDRs: [192.0.2.10/32]
  minimumClientPrefix: 8
  regions:
    region-1:
      zones: [zone-a, zone-b, zone-c]
      imageID: ubuntu-2404-image-id
      externalNetworkName: external-region-1
      sshUser: ubuntu
      flavors:
        small: {id: flavor-small-id, vcpu: 2, memoryGiB: 2}
        medium: {id: flavor-medium-id, vcpu: 4, memoryGiB: 4}
```

Создайте namespace `kubectl create namespace gator-mongodb-system`, затем
подготовьте pull Secret в нём штатным секретным механизмом. В примере
`createSystemNamespace: false` сохраняет владение namespace у администратора.
Не помещайте registry credentials в values или Git. Настройте DNS домена так,
чтобы `A-B-C-D.mongo.example.org` разрешалось в floating IP `A.B.C.D` каждого
узла. В study для этой функции используется sslip.io. На VM peer hostname
разрешается через управляемый `/etc/hosts` во внутренний IP; внешние клиенты
получают FIP. У клиента должны быть рабочие маршруты до всех replica members.

Команды ниже используют Helm 3. Для Helm 4 замените `--wait` на
`--wait=legacy`; при обновлении после ручного apply Composition добавьте
`--server-side=false`, чтобы Helm сохранил владение полями своего release.

Установку выполняйте в два шага: сначала API без квот, затем квоты после
обнаружения GVK. В кластере уже должны быть CRD Dashboard и Gator Quotas.

```sh
helm upgrade --install gator-mongodb products/mongodb/chart \
  -n gator-dashboard -f mongodb-values.yaml --set quotas.enabled=false --wait
kubectl wait crd/mongodbclusters.mongodb.gatorstack.dev \
  --for=condition=Established --timeout=120s
helm upgrade gator-mongodb products/mongodb/chart \
  -n gator-dashboard -f mongodb-values.yaml --wait
kubectl -n gator-mongodb-system rollout status deployment/mongodb-controller
kubectl get functions.pkg.crossplane.io
kubectl get mongodbplacements -n my-project
```

Проверьте HEALTHY у обеих функций. Placement catalog появляется по готовым
подсетям проекта; изменение UID подсети не переносит существующую БД. Три зоны
в одной сети дают cluster/shard; одна подсеть даёт single. Квоты Nova/Cinder проекта должны вмещать все VM и
boot volumes: минимальный shard требует 11 VM/дисков, плюс существующие ресурсы. MongoDB пакеты
закреплены на Community 8.0.34 из официального apt repository MongoDB.

Для выдачи клиентского подключения назначьте точечную Role, созданную рядом
с Secret. Узнайте её имя из `status.connectionSecretRef.name`, затем создайте
RoleBinding в проекте. Не выдавайте продуктовым ролям чтение всех Secrets.

```sh
connection_role="$(kubectl -n my-project get mongodbcluster my-mongodb \
  -o jsonpath='{.status.connectionSecretRef.name}')"
kubectl -n my-project create rolebinding mongodb-app-connection \
  --role="$connection_role" --user=application-owner
```

Для диагностики смотрите `MongoDBCluster.status`, composed `MongoDBRuntime`,
Crossplane Object/Usage и статусы AnsibleRun. Не выводите Secret, inventory,
playbook или сырой driver exception: они могут содержать credentials.
`Ready` требует TLS ping и authentication всех процессов, ожидаемого состава
shards и живых primary/secondary replica members.

TLS CA и server certificates создаются на 10 лет; автоматическая ротация пока
не реализована. Планируйте её отдельно. Удаление идёт в обратном порядке через
Usage: Run/VM/FIP перед provider/port и private artifacts. Не снимайте finalizers
для обхода зависимостей. При потере API провайдера восстановите его перед cleanup.

Первый выпуск не включает backup/PITR, resize, major upgrades, смену topology,
автоматическое шардирование коллекций, биллинг, метрики и доставку логов.
Данные сохраняйте внешними средствами MongoDB с отдельно проверенным восстановлением.
Состав sharded cluster соответствует [руководству MongoDB](https://www.mongodb.com/docs/v8.0/tutorial/deploy-sharded-cluster-with-keyfile-access-control/).
