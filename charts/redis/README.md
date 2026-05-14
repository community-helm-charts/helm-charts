# Redis Helm Chart

This chart deploys a single Redis instance using the Docker Official Redis image.

It is intentionally small: one StatefulSet, one ClusterIP Service, one headless Service, and one optional Secret for authentication.

## Install

```console
helm install my-redis oci://ghcr.io/community-helm-charts/redis
```

Install with an explicit password:

```console
helm install my-redis oci://ghcr.io/community-helm-charts/redis \
  --set auth.password='change-me'
```

## Connect

From inside the cluster:

```console
kubectl run my-redis-client --rm --tty -i --restart='Never' \
  --image docker.io/library/redis:8.2.1-alpine \
  --env="REDISCLI_AUTH=$(kubectl get secret my-redis -o jsonpath='{.data.password}' | base64 -d)" \
  --command -- redis-cli --host my-redis ping
```

The service DNS name is:

```text
<release-name>.<namespace>.svc.cluster.local
```

## Storage

Persistence is enabled by default and mounted at `/data`, which is the data directory used by the official Redis image.

For a non-persistent development instance:

```console
helm install my-redis oci://ghcr.io/community-helm-charts/redis \
  --set persistence.enabled=false \
  --set auth.password='change-me'
```

## Credentials

By default, the chart creates a Secret named after the release, using the key `password`.

Use an existing Secret:

```console
kubectl create secret generic my-redis-auth --from-literal=password='change-me'

helm install my-redis oci://ghcr.io/community-helm-charts/redis \
  --set auth.existingSecret=my-redis-auth
```

For local-only throwaway testing, authentication can be disabled:

```console
helm install my-redis oci://ghcr.io/community-helm-charts/redis \
  --set auth.enabled=false
```

## Configuration

Inline Redis configuration is mounted as `redis.conf` and passed to `redis-server`:

```yaml
configuration: |
  appendonly yes
  maxmemory-policy allkeys-lru
```

You can also use an existing ConfigMap with a `redis.conf` key:

```yaml
existingConfigmap: my-redis-config
```

## Parameters

| Name | Description | Default |
| --- | --- | --- |
| `image.registry` | Redis image registry | `docker.io` |
| `image.repository` | Redis image repository | `library/redis` |
| `image.tag` | Redis image tag | `8.2.1-alpine` |
| `auth.enabled` | Enable password authentication | `true` |
| `auth.password` | Redis password; generated when empty | `""` |
| `auth.existingSecret` | Existing Secret containing the password | `""` |
| `auth.secretKeys.passwordKey` | Password key in the Secret | `password` |
| `service.type` | Service type | `ClusterIP` |
| `service.ports.redis` | Service port | `6379` |
| `containerPorts.redis` | Container port | `6379` |
| `persistence.enabled` | Enable persistent storage | `true` |
| `persistence.size` | PVC size | `8Gi` |
| `persistence.mountPath` | Data volume mount path | `/data` |
| `configuration` | Inline Redis configuration | `""` |
| `existingConfigmap` | Existing ConfigMap with `redis.conf` | `""` |
| `resources` | Container resource requests and limits | `{}` |
| `extraEnvVars` | Extra environment variables | `[]` |
| `extraVolumes` | Extra pod volumes | `[]` |
| `extraVolumeMounts` | Extra Redis volume mounts | `[]` |
| `initContainers` | Extra init containers | `[]` |
| `sidecars` | Extra sidecar containers | `[]` |

## Uninstall

```console
helm uninstall my-redis
```

PersistentVolumeClaims created by the StatefulSet may remain after uninstall depending on your cluster and storage class reclaim policy.
