# Valkey Helm Chart

This chart deploys a single Valkey instance using the official Valkey image.

It is intentionally small: one StatefulSet, one ClusterIP Service, and one optional Secret for authentication.

## Install

```console
helm install my-valkey oci://ghcr.io/community-helm-charts/valkey
```

Install with an explicit password:

```console
helm install my-valkey oci://ghcr.io/community-helm-charts/valkey \
  --set auth.password='change-me'
```

## Connect

From inside the cluster:

```console
kubectl run my-valkey-client --rm --tty -i --restart='Never' \
  --image docker.io/valkey/valkey:8.1.3-alpine \
  --env="REDISCLI_AUTH=$(kubectl get secret my-valkey -o jsonpath='{.data.valkey-password}' | base64 -d)" \
  --command -- valkey-cli --host my-valkey ping
```

The service DNS name is:

```text
<release-name>.<namespace>.svc.cluster.local
```

## Storage

Persistence is enabled by default and mounted at `/data`, which is the data directory used by the official Valkey image.

For a non-persistent development instance:

```console
helm install my-valkey oci://ghcr.io/community-helm-charts/valkey \
  --set persistence.enabled=false \
  --set auth.password='change-me'
```

## Credentials

By default, the chart creates a Secret named after the release, using the key `valkey-password`.

Use an existing Secret:

```console
kubectl create secret generic my-valkey-auth --from-literal=valkey-password='change-me'

helm install my-valkey oci://ghcr.io/community-helm-charts/valkey \
  --set auth.existingSecret=my-valkey-auth
```

For local-only throwaway testing, authentication can be disabled:

```console
helm install my-valkey oci://ghcr.io/community-helm-charts/valkey \
  --set auth.enabled=false
```

## Configuration

Inline Valkey configuration is mounted as `valkey.conf` and passed to `valkey-server`:

```yaml
configuration: |
  appendonly yes
  maxmemory-policy allkeys-lru
```

You can also use an existing ConfigMap with a `valkey.conf` key:

```yaml
existingConfigmap: my-valkey-config
```

## Parameters

| Name | Description | Default |
| --- | --- | --- |
| `image.registry` | Valkey image registry | `docker.io` |
| `image.repository` | Valkey image repository | `valkey/valkey` |
| `image.tag` | Valkey image tag | `8.1.3-alpine` |
| `auth.enabled` | Enable password authentication | `true` |
| `auth.password` | Valkey password; generated when empty | `""` |
| `auth.existingSecret` | Existing Secret containing the password | `""` |
| `auth.existingSecretPasswordKey` | Password key in the existing Secret | `valkey-password` |
| `service.type` | Service type | `ClusterIP` |
| `service.ports.valkey` | Service port | `6379` |
| `containerPorts.valkey` | Container port | `6379` |
| `persistence.enabled` | Enable persistent storage | `true` |
| `persistence.size` | PVC size | `8Gi` |
| `persistence.mountPath` | Data volume mount path | `/data` |
| `configuration` | Inline Valkey configuration | `""` |
| `existingConfigmap` | Existing ConfigMap with `valkey.conf` | `""` |
| `resources` | Container resource requests and limits | `{}` |
| `extraEnvVars` | Extra environment variables | `[]` |
| `extraVolumes` | Extra pod volumes | `[]` |
| `extraVolumeMounts` | Extra Valkey volume mounts | `[]` |
| `initContainers` | Extra init containers | `[]` |
| `sidecars` | Extra sidecar containers | `[]` |

## Uninstall

```console
helm uninstall my-valkey
```

PersistentVolumeClaims created by the StatefulSet may remain after uninstall depending on your cluster and storage class reclaim policy.
