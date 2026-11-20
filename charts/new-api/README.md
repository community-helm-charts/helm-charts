# New API Helm Chart

Deploys [New API](https://github.com/QuantumNous/new-api), an LLM gateway,
with the official `docker.io/calciumion/new-api:v1.0.0-rc.51` image. This pinned
upstream version is a release candidate; override `image.tag` or `image.digest`
to select another compatible release.

Defaults:

- One master StatefulSet with one Pod and `NODE_TYPE=master`.
- Optional slave StatefulSet with `NODE_TYPE=slave`, disabled by default.
- A shared ClusterIP Service on port 80, targeting application port 3000, plus
  role-specific Services and governing headless Services for stable Pod identities.
- The repository's PostgreSQL and Valkey subcharts, each with authentication and
  an 8 Gi persistent volume.
- No application PVC or `/data` or log volume. A temporary `emptyDir` mounts at
  `/tmp` for uploads and request-body caching; it is discarded with the Pod.
- File logging disabled explicitly with `--log-dir=`. Runtime logs go to
  stdout/stderr; usage and other database-backed business logs remain in PostgreSQL.
- A non-root application container (UID/GID 1001), read-only root filesystem,
  dropped Linux capabilities, and no mounted ServiceAccount token.
- Ingress disabled. Startup, liveness and readiness probes use `/api/status`.

## Install from this repository

Requires Helm 3.7+ and Kubernetes 1.23+. Build the local dependencies first:

```bash
helm dependency build ./charts/postgresql --skip-refresh
helm dependency build ./charts/valkey --skip-refresh
helm dependency build ./charts/new-api --skip-refresh
helm install new-api ./charts/new-api --namespace ai --create-namespace
kubectl port-forward --namespace ai statefulset/new-api-master 3000:3000
```

Open http://localhost:3000 and complete the initial setup wizard.

Inspect application logs:

```bash
kubectl logs --namespace ai statefulset/new-api-master -c new-api
```

## Master and slave nodes

This chart follows the [upstream cluster deployment guide](https://docs.newapi.ai/zh/docs/installation/deployment-methods/cluster-deployment).
The master always has one replica. Enable and scale slave nodes separately:

```yaml
slave:
  enabled: true
  replicaCount: 2
config:
  syncFrequency: 60
  batchUpdateEnabled: true
  batchUpdateInterval: 5
```

For release `new-api`, the master Pod is `new-api-master-0`, and slave Pods are
`new-api-slave-0`, `new-api-slave-1`, and so on. Each Pod uses its stable name as
`NODE_NAME`. Both roles are StatefulSets; application data remains in PostgreSQL,
and neither application StatefulSet creates a PVC. `/tmp` is temporary per Pod.

All nodes share the same PostgreSQL connection, Valkey endpoint,
`SESSION_SECRET` and `CRYPTO_SECRET`. `config.syncFrequency` sets `SYNC_FREQUENCY`,
`config.batchUpdateEnabled` sets `BATCH_UPDATE_ENABLED`, and
`config.batchUpdateInterval` sets `BATCH_UPDATE_INTERVAL` on both roles. Defaults
are 60 seconds, enabled, and 5 seconds respectively. The chart fixes `NODE_TYPE`
for each role. On initial startup,
slaves wait for the master `/api/status` endpoint to report success, so the
master can initialize the database before slaves start.

`config.errorLogEnabled` sets database-backed `ERROR_LOG_ENABLED` (default
`false`); this does not enable file logging. `config.memoryCacheEnabled` sets
`MEMORY_CACHE_ENABLED` (default `false`), and `config.timezone` sets `TZ` (default
`UTC`). These application settings apply to both roles.

The shared `new-api` Service and default Ingress distribute requests across
ready master and slave Pods. They do not inspect HTTP requests to split reads
and writes. The ClusterIP Services `new-api-master` and `new-api-slave` select
only their respective roles; the slave Service exists only when slaves are
enabled. Each role also has its own `-headless` Service for stable Pod DNS,
including when `service.enabled=false`.

`extraEnvVars` and `resources` apply to both roles. Use `slave.extraEnvVars` and
`slave.resources` for slave-specific settings; a slave environment variable
overrides a shared variable with the same name. Optional `slave.frontendBaseUrl`
sets `FRONTEND_BASE_URL` only on slaves. Point it at an entry routed to the master
when you want slave frontend requests redirected there.

## Bundled PostgreSQL and Valkey

PostgreSQL defaults to user `newapi` and database `newapi`. Both subcharts
generate a password when none is supplied. The application reads each password
from the same Secret as its server. For a release named `new-api`, the bundled
PostgreSQL password Secret defaults to `new-api-postgresql`, with the key
`postgresql-password`. The Valkey password Secret defaults to `new-api-valkey`,
with the key `valkey-password`. To use existing Secrets:

```yaml
postgresql:
  auth:
    username: newapi
    database: newapi
    existingSecret: new-api-postgresql-credentials
    existingSecretPasswordKey: password
  persistence:
    size: 20Gi
valkey:
  auth:
    existingSecret: new-api-valkey-credentials
    existingSecretPasswordKey: password
```

Create both Secrets in the release namespace before installing. Store raw
passwords, not URL-encoded values. The startup wrapper percent-encodes the raw
credentials into `SQL_DSN` and `REDIS_CONN_STRING`, then uses `exec` to start
`/new-api` so it receives termination signals. It uses the shell and standard
utilities in the official Debian image; no additional runtime is required.
Generated URLs disable PostgreSQL TLS and use unencrypted Valkey connections
to the bundled services inside the cluster. For TLS connections, use external URLs.

Valkey uses the Redis protocol. New API's environment variable remains
`REDIS_CONN_STRING`, and connection URLs use `redis://` or `rediss://`, including
when the server is Valkey. Chart configuration and helper names use `valkey`.

The chart resolves names, Service ports and Secret keys from each subchart,
including `global.postgresql` overrides. If using `namespaceOverride`, set
`postgresql.namespaceOverride` and `valkey.namespaceOverride` to the same namespace
so the application can reference their password Secrets. Other settings are in
the [PostgreSQL values](../postgresql/values.yaml) and
[Valkey values](../valkey/values.yaml).

The startup probe allows time for database migrations. If either service is
unavailable during initialization, Kubernetes restarts the application until
it can connect. The application does not fall back to SQLite when a configured
PostgreSQL connection fails.

## External PostgreSQL and Valkey

Disable either bundled dependency independently and provide its connection
URL or an existing Secret. Prefer existing Secrets in the release namespace:

```yaml
postgresql:
  enabled: false
valkey:
  enabled: false
externalPostgresql:
  existingSecret: new-api-external-postgresql
  secretKey: sql-dsn
externalValkey:
  existingSecret: new-api-external-valkey
  secretKey: valkey-url
config:
  existingSecret: new-api-credentials
  sessionSecretKey: session-secret
  cryptoSecretKey: crypto-secret
```

The database Secret must contain a complete PostgreSQL URL, such as
`postgresql://newapi:<URL_ENCODED_PASSWORD>@postgres.example.com:5432/newapi?sslmode=require`.
The database and user must already exist, with permission to apply schema migrations.
The Valkey Secret must contain a complete `redis://` or `rediss://` URL, such as
`rediss://default:<URL_ENCODED_PASSWORD>@valkey.example.com:6380/0`.
External URLs are passed through unchanged; URL-encode reserved characters in
credentials yourself.

Alternatively, use a private values file. The chart stores these URLs in Secrets:

```yaml
postgresql:
  enabled: false
valkey:
  enabled: false
externalPostgresql:
  url: postgresql://newapi:<URL_ENCODED_PASSWORD>@postgres.example.com:5432/newapi?sslmode=require
externalValkey:
  url: rediss://default:<URL_ENCODED_PASSWORD>@valkey.example.com:6380/0
```

Choose only one of `url` and `existingSecret` under `externalPostgresql` and
`externalValkey`. External connection settings cannot be combined with the
corresponding bundled service. When a URL is supplied, the chart creates
`<fullname>-external-postgresql` or `<fullname>-external-valkey` to store it. An
`existingSecret` overrides that name. Bundled services retain their own
PostgreSQL and Valkey password Secrets.

## Application secrets and upgrades

Application settings live under `config.*`; deployment settings remain at the
top level, and bundled dependencies use `postgresql.*` and `valkey.*`.

`config.sessionSecret` sets `SESSION_SECRET`; `config.cryptoSecret` sets `CRYPTO_SECRET`.
When empty, the chart generates two independent 64-character secrets and reuses
them on upgrades through Helm's Secret lookup. The generated application Secret
is named `<fullname>` (`new-api` for release `new-api`), with the default keys
`session-secret` and `crypto-secret`.

To provide the values directly, use a private values file:

```yaml
config:
  sessionSecret: "<SESSION_SECRET>"
  cryptoSecret: "<CRYPTO_SECRET>"
```

Or reference a Secret created in the release namespace before installation:

```yaml
config:
  existingSecret: new-api-credentials
  sessionSecretKey: session-secret
  cryptoSecretKey: crypto-secret
```

The existing Secret must contain both keys. This mode skips creation of the
application Secret and only supplies `SESSION_SECRET` and `CRYPTO_SECRET`; other
`config.*` settings still come from values. Leave `config.sessionSecret` and
`config.cryptoSecret` empty when using `config.existingSecret`; combining them
is rejected. Both roles reference the same application Secret.

For GitOps and reproducible offline rendering, supply both values or use
`config.existingSecret`. Keep both secrets stable and shared across replicas.
Back them up with the database: replacing the crypto secret can make previously
encrypted data unreadable. Reinstalling with retained database storage also
requires the original secrets.

Changes to credentials supplied through this chart's values trigger an application
rollout. Restart both StatefulSets after updating an externally managed Secret.
Updating a PostgreSQL Secret does not change the password inside an existing
database; coordinate password rotation with PostgreSQL first.

Back up PostgreSQL before application upgrades. The startup wait checks master
availability; it does not enforce cross-StatefulSet ordering during upgrades.
Update the master first, wait for its schema migrations and readiness, and then
roll slaves. A two-phase upgrade can freeze existing slaves using a partition:

```bash
# Example with two existing slave replicas; retain the same values file in both upgrades.
helm upgrade new-api ./charts/new-api -n ai -f values-private.yaml \
  --set slave.updateStrategy.rollingUpdate.partition=2
kubectl rollout status statefulset/new-api-master -n ai
helm upgrade new-api ./charts/new-api -n ai -f values-private.yaml \
  --set slave.updateStrategy.rollingUpdate.partition=0
kubectl rollout status statefulset/new-api-slave -n ai
```

Set the partition to at least the number of existing slaves in the first phase.
`updateStrategy` accepts StatefulSet strategies `RollingUpdate` and `OnDelete`;
`slave.updateStrategy` merges overrides into that strategy. For upgrades requiring
exclusive migration access, scale slaves to zero before updating the master.

## Ingress and additional configuration

```yaml
ingress:
  enabled: true
  ingressClassName: nginx
  hostname: api.example.com
  tls: true
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
config:
  batchUpdateEnabled: true
  errorLogEnabled: true
  memoryCacheEnabled: false
  timezone: UTC
extraEnvVars:
  - name: SESSION_COOKIE_SECURE
    value: "true"
  - name: SESSION_COOKIE_TRUSTED_URL
    value: https://api.example.com
```

TLS uses `api.example.com-tls`; provide the Secret or configure a certificate
controller. Configure `TRUSTED_PROXIES` for your ingress proxy addresses if
needed. Additional hosts, paths, TLS entries and rules follow the repository's
Ingress conventions.

See [values.yaml](values.yaml) for replicas, images, resource requests and
limits, scheduling, probes, ServiceAccount settings, extra environment sources,
sidecars and additional volumes. `extraEnvVars` and `slave.extraEnvVars` cannot override the managed
`SQL_DSN`, `REDIS_CONN_STRING`, `SESSION_SECRET`, `CRYPTO_SECRET`, `NODE_NAME`,
`NODE_TYPE`, `SYNC_FREQUENCY`, `BATCH_UPDATE_ENABLED`, `BATCH_UPDATE_INTERVAL`,
`ERROR_LOG_ENABLED`, `MEMORY_CACHE_ENABLED`, `TZ`, `FRONTEND_BASE_URL`, or internal `NEW_API_*` variables. For a separate business-log database,
provide `LOG_SQL_DSN` through an additional Secret environment variable.

`containerPorts.http` controls the application's `--port` argument as well as
the container port. `command` overrides the executable after URL generation;
`args` replaces the application arguments after `--port`. Retain `--log-dir=`
when customizing arguments to keep file logging disabled. Removing it restores
the upstream default `./logs`, which cannot be written with the default read-only
root filesystem. Features that write other local files, such as profiling,
need a writable volume at their configured path.

## Validation

```bash
node --test tests/new-api-chart.test.js
helm lint ./charts/new-api --strict
helm template new-api ./charts/new-api
```
