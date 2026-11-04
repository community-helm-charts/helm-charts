# Redis Helm Chart

This chart deploys a single Redis instance using the Docker Official Redis image.

It is intentionally small: one StatefulSet, one ClusterIP Service, and one optional Secret for authentication.

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
  --image docker.io/library/redis:8.10.2-alpine \
  --env="REDISCLI_AUTH=$(kubectl get secret my-redis -o jsonpath='{.data.redis-password}' | base64 -d)" \
  --command -- redis-cli --host my-redis ping
```

The service DNS name is:

```text
<release-name>.<namespace>.svc.cluster.local
```

## Ports

`containerPorts.redis` sets the Redis listening port, container port, and
default probe target. `service.ports.redis` sets the separate client-facing
Service port and forwards to that listening port.

The default startup command applies this port after loading the configuration
file, so it takes precedence over a `port` setting in that file.

Explicit `command` or `args` overrides remain under your control; configure
the server to listen on `containerPorts.redis` when overriding startup.

## Storage

Persistence is enabled by default and mounted at `/data`, which is the data directory used by the official Redis image.

The container runs as UID 999 and GID 1000 from startup, matching the `redis`
account in the default Alpine image. The pod sets `fsGroup: 1000` and
`fsGroupChangePolicy: OnRootMismatch` so Kubernetes or the CSI driver can make
a newly provisioned PVC writable by the service group before the container starts.
Use a volume type and CSI driver that support `fsGroup` ownership or mount-group
handling. The chart does not run a root permissions init container.

These defaults target new PVCs; they do not provide a migration for existing data
volumes. If you change the image, verify its service UID/GID and adjust
`containerSecurityContext` and `podSecurityContext.fsGroup` together.

For a non-persistent development instance:

```console
helm install my-redis oci://ghcr.io/community-helm-charts/redis \
  --set persistence.enabled=false \
  --set auth.password='change-me'
```

## Credentials

By default, the chart creates a Secret named after the release, using the key `redis-password`.

Use an existing Secret:

```console
kubectl create secret generic my-redis-auth --from-literal=redis-password='change-me'

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
| `image.tag` | Redis image tag | `8.10.2-alpine` |
| `auth.enabled` | Enable password authentication | `true` |
| `auth.password` | Redis password; generated when empty | `""` |
| `auth.existingSecret` | Existing Secret containing the password | `""` |
| `auth.existingSecretPasswordKey` | Password key in the existing Secret | `redis-password` |
| `service.type` | Service type | `ClusterIP` |
| `service.ports.redis` | Service port | `6379` |
| `containerPorts.redis` | Container port | `6379` |
| `persistence.enabled` | Enable persistent storage | `true` |
| `persistence.size` | PVC size | `8Gi` |
| `persistence.mountPath` | Data volume mount path | `/data` |
| `podSecurityContext.enabled` | Enable pod security context | `true` |
| `podSecurityContext.fsGroup` | Data volume access group | `1000` |
| `podSecurityContext.fsGroupChangePolicy` | Volume permission change policy | `OnRootMismatch` |
| `containerSecurityContext.enabled` | Enable container security context | `true` |
| `containerSecurityContext.runAsUser` | Container user ID | `999` |
| `containerSecurityContext.runAsGroup` | Container group ID | `1000` |
| `containerSecurityContext.runAsNonRoot` | Require a non-root user | `true` |
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
