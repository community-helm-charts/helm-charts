# PostgreSQL Helm Chart

This chart deploys a single PostgreSQL instance using the Docker Official PostgreSQL image.

It is designed to be small and predictable: one StatefulSet, one ClusterIP Service, one headless Service, and one optional Secret for credentials. It does not include built-in replication, failover, backup jobs, metrics exporters, TLS management, LDAP helpers, password migration jobs, or operator-style lifecycle automation.

## Install

```console
helm install my-postgres oci://ghcr.io/community-helm-charts/postgresql
```

Install with an explicit password:

```console
helm install my-postgres oci://ghcr.io/community-helm-charts/postgresql \
  --set auth.password='change-me'
```

Install with a custom initial user and database:

```console
helm install my-postgres oci://ghcr.io/community-helm-charts/postgresql \
  --set auth.username=app \
  --set auth.password='change-me' \
  --set auth.database=app
```

## Connect

From inside the cluster:

```console
kubectl run my-postgres-client --rm --tty -i --restart='Never' \
  --image docker.io/library/postgres:18.3-alpine \
  --env="PGPASSWORD=$(kubectl get secret my-postgres-postgresql -o jsonpath='{.data.password}' | base64 -d)" \
  --command -- psql \
  --host my-postgres-postgresql \
  --username postgres \
  --dbname postgres
```

The service DNS name is:

```text
<release-name>-postgresql.<namespace>.svc.cluster.local
```

## Storage

Persistence is enabled by default. The chart mounts the persistent volume at `/var/lib/postgresql`, which matches the official image layout for PostgreSQL 18. The container image manages its own versioned data directory under that mount.

For a non-persistent development instance:

```console
helm install my-postgres oci://ghcr.io/community-helm-charts/postgresql \
  --set persistence.enabled=false \
  --set auth.password='change-me'
```

## Credentials

By default, the chart creates a Secret named after the release, using the key `password`.

Use an existing Secret:

```console
kubectl create secret generic my-postgres-auth --from-literal=password='change-me'

helm install my-postgres oci://ghcr.io/community-helm-charts/postgresql \
  --set auth.existingSecret=my-postgres-auth
```

For local-only throwaway testing, password authentication can be disabled:

```console
helm install my-postgres oci://ghcr.io/community-helm-charts/postgresql \
  --set auth.trustAuthentication=true
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
| `image.registry` | PostgreSQL image registry | `docker.io` |
| `image.repository` | PostgreSQL image repository | `library/postgres` |
| `image.tag` | PostgreSQL image tag | `18.3-alpine` |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `auth.username` | Initial PostgreSQL superuser | `postgres` |
| `auth.password` | Password for `auth.username`; generated when empty | `""` |
| `auth.database` | Initial database name | `""` |
| `auth.existingSecret` | Existing Secret containing the password | `""` |
| `auth.secretKeys.passwordKey` | Password key in the Secret | `password` |
| `auth.usePasswordFiles` | Use `POSTGRES_PASSWORD_FILE` instead of `POSTGRES_PASSWORD` | `true` |
| `auth.trustAuthentication` | Enable trust authentication and skip password Secret creation | `false` |
| `service.enabled` | Create the main Service | `true` |
| `service.type` | Service type | `ClusterIP` |
| `service.ports.postgresql` | Service port | `5432` |
| `containerPorts.postgresql` | Container port | `5432` |
| `persistence.enabled` | Enable persistent storage | `true` |
| `persistence.size` | PVC size | `8Gi` |
| `persistence.storageClass` | StorageClass override | `""` |
| `persistence.existingClaim` | Existing PVC name | `""` |
| `persistence.mountPath` | Data volume mount path | `/var/lib/postgresql` |
| `initdb.args` | Extra arguments for `initdb` | `""` |
| `initdb.walDir` | Custom WAL directory for initialization | `""` |
| `initdb.scripts` | Inline initialization scripts | `{}` |
| `initdb.scriptsConfigMap` | Existing ConfigMap with initialization scripts | `""` |
| `initdb.scriptsSecret` | Existing Secret with initialization scripts | `""` |
| `resources` | Container resource requests and limits | `{}` |
| `resourcesPreset` | Common resource preset from the shared helper chart | `none` |
| `podSecurityContext.enabled` | Enable pod security context | `false` |
| `containerSecurityContext.enabled` | Enable container security context | `false` |
| `extraEnvVars` | Extra environment variables for the PostgreSQL container | `[]` |
| `extraVolumes` | Extra pod volumes | `[]` |
| `extraVolumeMounts` | Extra PostgreSQL volume mounts | `[]` |
| `initContainers` | Extra init containers | `[]` |
| `sidecars` | Extra sidecar containers | `[]` |
| `serviceAccount.create` | Create a ServiceAccount | `true` |
| `serviceAccount.name` | Existing ServiceAccount name when creation is disabled | `""` |

## Uninstall

```console
helm uninstall my-postgres
```

PersistentVolumeClaims created by the StatefulSet may remain after uninstall depending on your cluster and storage class reclaim policy.
