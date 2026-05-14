# MySQL Helm Chart

This chart deploys a single MySQL instance using the Docker Official MySQL image.

It is designed to be small and predictable: one StatefulSet, one ClusterIP Service, one headless Service, and one Secret for credentials. It does not include built-in replication, failover, backup jobs, metrics exporters, TLS management, password migration jobs, or operator-style lifecycle automation.

## Install

```console
helm install my-mysql oci://ghcr.io/community-helm-charts/mysql
```

Install with an explicit root password:

```console
helm install my-mysql oci://ghcr.io/community-helm-charts/mysql \
  --set auth.rootPassword='change-me'
```

Install with an initial application user and database:

```console
helm install my-mysql oci://ghcr.io/community-helm-charts/mysql \
  --set auth.rootPassword='change-me' \
  --set auth.username=app \
  --set auth.password='app-password' \
  --set auth.database=app
```

## Connect

From inside the cluster:

```console
export MYSQL_ROOT_PASSWORD=$(kubectl get secret my-mysql -o jsonpath='{.data.root-password}' | base64 -d)

kubectl run my-mysql-client --rm --tty -i --restart='Never' \
  --image docker.io/library/mysql:8.4.9 \
  --env="MYSQL_PWD=$MYSQL_ROOT_PASSWORD" \
  --command -- mysql \
  --host my-mysql \
  --user root
```

The service DNS name is:

```text
my-mysql.<namespace>.svc.cluster.local
```

## Image

The default image is `docker.io/library/mysql:8.4.9`, the current MySQL 8.4 LTS official image tag. The Docker Official MySQL image does not publish an Alpine variant, so this chart does not default to an Alpine tag.

## Storage

Persistence is enabled by default. The chart mounts the persistent volume at `/var/lib/mysql`, which matches the official MySQL image data directory.

For a non-persistent development instance:

```console
helm install my-mysql oci://ghcr.io/community-helm-charts/mysql \
  --set persistence.enabled=false \
  --set auth.rootPassword='change-me'
```

## Credentials

By default, the chart creates a Secret named after the release, using the key `root-password` for the root password. If `auth.username` is set, the same Secret also includes the key `password` for that user.

Use an existing Secret:

```console
kubectl create secret generic my-mysql-auth \
  --from-literal=root-password='change-me' \
  --from-literal=password='app-password'

helm install my-mysql oci://ghcr.io/community-helm-charts/mysql \
  --set auth.existingSecret=my-mysql-auth \
  --set auth.username=app \
  --set auth.database=app
```

## Init Scripts

Inline initialization scripts are mounted into `/docker-entrypoint-initdb.d` and run only when the database is initialized for the first time:

```yaml
initdb:
  scripts:
    init.sql: |
      create table if not exists example (id int primary key);
```

You can also provide scripts through an existing ConfigMap or Secret:

```yaml
initdb:
  scriptsConfigMap: my-initdb-scripts
  scriptsSecret: my-private-initdb-scripts
```

## Parameters

| Name | Description | Default |
| --- | --- | --- |
| `image.registry` | MySQL image registry | `docker.io` |
| `image.repository` | MySQL image repository | `library/mysql` |
| `image.tag` | MySQL image tag | `8.4.9` |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `auth.rootPassword` | MySQL root password; generated when empty | `""` |
| `auth.username` | Optional initial non-root user | `""` |
| `auth.password` | Password for `auth.username`; generated when empty and `auth.username` is set | `""` |
| `auth.database` | Optional initial database name | `""` |
| `auth.existingSecret` | Existing Secret containing credentials | `""` |
| `auth.secretKeys.rootPasswordKey` | Root password key in the Secret | `root-password` |
| `auth.secretKeys.passwordKey` | User password key in the Secret | `password` |
| `service.enabled` | Create the main Service | `true` |
| `service.type` | Service type | `ClusterIP` |
| `service.ports.mysql` | Service port | `3306` |
| `containerPorts.mysql` | Container port | `3306` |
| `persistence.enabled` | Enable persistent storage | `true` |
| `persistence.size` | PVC size | `8Gi` |
| `persistence.storageClass` | StorageClass override | `""` |
| `persistence.existingClaim` | Existing PVC name | `""` |
| `persistence.mountPath` | Data volume mount path | `/var/lib/mysql` |
| `initdb.scripts` | Inline initialization scripts | `{}` |
| `initdb.scriptsConfigMap` | Existing ConfigMap with initialization scripts | `""` |
| `initdb.scriptsSecret` | Existing Secret with initialization scripts | `""` |
| `resources` | Container resource requests and limits | `{}` |
| `resourcesPreset` | Common resource preset from the shared helper chart | `none` |
| `podSecurityContext.enabled` | Enable pod security context | `false` |
| `containerSecurityContext.enabled` | Enable container security context | `false` |
| `extraEnvVars` | Extra environment variables for the MySQL container | `[]` |
| `extraVolumes` | Extra pod volumes | `[]` |
| `extraVolumeMounts` | Extra MySQL volume mounts | `[]` |
| `initContainers` | Extra init containers | `[]` |
| `sidecars` | Extra sidecar containers | `[]` |
| `serviceAccount.create` | Create a ServiceAccount | `true` |
| `serviceAccount.name` | Existing ServiceAccount name when creation is disabled | `""` |

## Uninstall

```console
helm uninstall my-mysql
```

PersistentVolumeClaims created by the StatefulSet may remain after uninstall depending on your cluster and storage class reclaim policy.
