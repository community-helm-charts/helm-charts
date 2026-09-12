# Uptime Kuma

A Helm chart for [Uptime Kuma](https://github.com/louislam/uptime-kuma), a
self-hosted monitoring application with notifications and public status pages.

The default image is `docker.io/louislam/uptime-kuma:2.5.4`, pinned to the
[upstream stable release](https://github.com/louislam/uptime-kuma/releases/tag/2.5.4).
The chart uses the local `common` library and the repository's Nx release workflow.

## Install

Once published, install the chart from the OCI registry:

```console
helm upgrade --install uptime-kuma oci://ghcr.io/community-helm-charts/uptime-kuma \
  --namespace monitoring --create-namespace
```

To install from this repository:

```console
helm dependency build charts/uptime-kuma
helm upgrade --install uptime-kuma ./charts/uptime-kuma \
  --namespace monitoring --create-namespace
```

Access the initial setup screen and create an administrator account:

```console
kubectl port-forward --namespace monitoring statefulset/uptime-kuma 3001:3001
```

Open `http://localhost:3001`. Complete setup before exposing the application
publicly. The chart does not create or store administrator credentials.

## Workload and storage

The chart runs exactly one StatefulSet replica with a `1Gi` ReadWriteOnce volume
mounted at `/app/data`. A headless Service provides the StatefulSet's network
identity; a separate ClusterIP Service exposes HTTP on port `3001`.

Uptime Kuma stores its configuration, SQLite database, and uploaded assets in
the data directory. Do not share a SQLite data directory between instances or
scale the StatefulSet manually. Use storage compatible with SQLite filesystem
locking; upstream does not support NFS for its data directory. See the
[official installation instructions](https://github.com/louislam/uptime-kuma/wiki/%F0%9F%94%A7-How-to-Install).

The default is a starting size for small installations, not a capacity guarantee.
Storage use depends on monitor count, check frequency, history retention, and
uploaded files. Monitor free space and choose a larger volume as needed.
Choose a StorageClass and size before installation:

```yaml
persistence:
  storageClassName: fast
  size: 10Gi
```

StorageClass precedence follows `common`: `global.storageClassName`, then
`persistence.storageClassName`, then `global.defaultStorageClassName`, then the
cluster default. Set `persistence.storageClassName: "-"` to request no
StorageClass. Most StatefulSet volume claim template changes require a workload
recreation; expand an existing PVC separately if its StorageClass supports it.

To use an existing PVC in the release namespace:

```yaml
persistence:
  existingClaim: uptime-kuma-data
```

Setting `persistence.enabled: false` uses `emptyDir` and loses local data when
the pod is removed. With SQLite, use this only for disposable installations;
external MariaDB has different requirements described below. StatefulSet-created PVCs are
retained on uninstall by default; existing PVCs are not owned by this chart.

Back up the data volume before upgrading the application. For migration from
v1, follow the [upstream migration guide](https://github.com/louislam/uptime-kuma/wiki/Migration-From-v1-To-v2).
The startup probe allows approximately ten minutes before restarting an
unresponsive application; increase its threshold for larger migrations.

## External MariaDB and optional ephemeral storage

Uptime Kuma v2 supports external MariaDB through the
[official database environment variables](https://github.com/louislam/uptime-kuma/wiki/Environment-Variables#mariadb-environment-variables).
The application still writes local files under `/app/data`: `db-config.json`,
uploads, screenshots, and Docker TLS files. Moving the database does not move
these files. See the pinned upstream
[data directory implementation](https://github.com/louislam/uptime-kuma/blob/2.5.4/server/database.js).

Keeping the small PVC is the simplest way to preserve these files. To run
without a PVC, supply database configuration on every start and ensure local
assets are disposable or provisioned separately. The
[upstream setup code](https://github.com/louislam/uptime-kuma/blob/2.5.4/server/setup-database.js)
recreates `db-config.json` from environment variables. Configuring the database
only through the setup UI will lose its connection settings on pod replacement.

For example, create a Secret named `uptime-kuma-database` in the release namespace
with keys `UPTIME_KUMA_DB_TYPE` (value `mariadb`), `UPTIME_KUMA_DB_HOSTNAME`,
`UPTIME_KUMA_DB_PORT` (typically `3306`), `UPTIME_KUMA_DB_NAME`,
`UPTIME_KUMA_DB_USERNAME`, and `UPTIME_KUMA_DB_PASSWORD`, then use:

```yaml
persistence:
  enabled: false
extraEnvVarsSecret: uptime-kuma-database
```

This chart references the Secret; it does not create the external database or
its credentials. Database records survive pod replacement only if the external
database is itself durable. Local uploads and certificates will not survive
unless supplied through separate mounts. An external database does not make
this chart a multi-replica deployment.

## Ingress and TLS

Ingress is disabled by default. The default hostname and documentation example
are `status.example.com`. Save this as a values file and supply `-f` during install:

```yaml
ingress:
  enabled: true
  hostname: status.example.com
  ingressClassName: traefik
  tls: true
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
```

This example requires cert-manager and an existing `letsencrypt` ClusterIssuer.
It references a TLS Secret named `status.example.com-tls`; the chart does not
create an issuer or certificate controller. You can instead provision that Secret
yourself, or use `ingress.extraTls` with `ingress.tls: false` to reference another
Secret name. `ingress.secrets` can create TLS Secrets from supplied certificate
and key strings; avoid committing private keys to values files.

TLS terminates at the Ingress controller and traffic to the application remains
HTTP. The controller must support WebSocket upgrades for the dashboard. Use `/`
at the root of a dedicated hostname; this chart does not configure subpath
rewrites. Configure DNS for `status.example.com` to reach your controller.

## Configuration

| Parameter | Default | Description |
| --- | --- | --- |
| `image.registry` | `docker.io` | Container registry |
| `image.repository` | `louislam/uptime-kuma` | Official image repository |
| `image.tag` | `2.5.4` | Pinned application version |
| `image.digest` | `""` | Optional digest; takes precedence over tag |
| `containerPorts.http` | `3001` | Container port and `UPTIME_KUMA_PORT` |
| `service.enabled` | `true` | Create the client Service; headless Service always exists |
| `service.type` | `ClusterIP` | Also supports NodePort and LoadBalancer |
| `service.ports.http` | `3001` | Client Service port |
| `service.nodePorts.http` | `""` | Optional explicit node port |
| `ingress.enabled` | `false` | Create Ingress |
| `ingress.hostname` | `status.example.com` | Default hostname |
| `ingress.path` | `/` | Default path |
| `ingress.ingressClassName` | `""` | Controller class |
| `ingress.tls` | `false` | Reference the default hostname's TLS Secret |
| `persistence.enabled` | `true` | Persist application data |
| `persistence.existingClaim` | `""` | Existing PVC, instead of claim templates |
| `persistence.mountPath` | `/app/data` | Data mount and `DATA_DIR` |
| `persistence.size` | `1Gi` | Requested storage |
| `persistence.accessModes` | `[ReadWriteOnce]` | PVC access modes |
| `persistence.storageClassName` | `""` | StorageClass selection |
| `startupProbe.enabled` | `true` | Allow initialization before liveness/readiness probing |
| `livenessProbe.enabled` | `true` | HTTP `/` probe |
| `readinessProbe.enabled` | `true` | HTTP `/` probe |
| `resourcesPreset` | `none` | Optional common resource preset |
| `resources` | `{}` | Explicit requests and limits |
| `podSecurityContext.enabled` | `false` | Enable configured pod security context |
| `containerSecurityContext.enabled` | `false` | Enable configured container security context |
| `serviceAccount.create` | `true` | Create a dedicated ServiceAccount |
| `automountServiceAccountToken` | `false` | Mount Kubernetes API credentials in the pod |

See [values.yaml](values.yaml) for annotations, scheduling, registry credentials,
probe overrides, resources, additional environment variables, volumes, init
containers, sidecars, and `extraDeploy` support.

The chart sets `UPTIME_KUMA_PORT` and `DATA_DIR` from their corresponding values
so the application agrees with the rendered ports and mounts. Set other upstream
environment variables through `extraEnvVars`, `extraEnvVarsCM`, or
`extraEnvVarsSecret`. Command and argument overrides must remain consistent with
these settings and the configured probes.

The default security context preserves the official image's runtime settings.
For non-root operation, enable the pod and container security contexts (configured
for UID/GID 1000) and ensure the data volume is writable. Test monitor types that
need additional permissions, such as ICMP, before dropping capabilities. Docker
socket access is not enabled; configure extra volumes and mounts explicitly only
when needed. Set resource requests and limits for your monitor count and use of
browser-based checks.
