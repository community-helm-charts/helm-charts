# Ghost Helm Chart

This chart deploys Ghost CMS with the same core services as the official Ghost Docker tooling: Ghost, MySQL, optional Tinybird analytics, and optional self-hosted ActivityPub.

The chart is intentionally direct: it does not include an operator, MySQL replication, backup automation, certificate management, or provider-specific ingress rules.

Ghost runs as a single-replica StatefulSet. This chart does not support horizontal scaling for one Ghost site.

Set `ghost.enabled=false` to stop the Ghost StatefulSet and Service while keeping shared chart resources such as MySQL and the Ghost content PVC. This is useful for database backup, rebuild, and import workflows where the application should not write to the database during maintenance.

## Install

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set ghost.config.url=https://example.com
```

Install with an Ingress:

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set ghost.config.url=https://blog.example.com \
  --set ingress.enabled=true \
  --set ingress.hostname=blog.example.com
```

For a non-persistent development install:

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set ghost.config.url=http://my-ghost.local \
  --set persistence.enabled=false \
  --set mysql.persistence.enabled=false
```

## Routing

The chart only targets root-path deployments. It does not try to support `https://example.com/blog`.

The public Ghost Service exposes Ghost and, when enabled, its ActivityPub sidecar. When `ingress.enabled=true`, the chart adds standard Kubernetes Ingress paths for the optional side services:

| Path | Destination |
| --- | --- |
| `/.ghost/analytics` | `traffic-analytics`, when `trafficAnalytics.enabled=true` |
| `/.ghost/activitypub` | ActivityPub, when `activitypub.enabled=true` |
| `/.well-known/webfinger` | ActivityPub, when `activitypub.enabled=true` |
| `/.well-known/nodeinfo` | ActivityPub, when `activitypub.enabled=true` |
| everything else | Ghost |

If you do not use the chart's Ingress, configure the same root-path routing in your external proxy or Ingress Controller.

## Ghost Configuration

Ghost runtime configuration lives under `ghost.config`. The chart flattens nested keys into Ghost environment variables and stores them in a generated Secret. For example, `ghost.config.mail.options.host` becomes `mail__options__host`. MySQL connection settings are managed separately through `mysql.auth` and `externalMysql`.

```yaml
ghost:
  config:
    url: https://blog.example.com
    privacy:
      useStructuredData: false
```

The generated Secret includes:

```text
url=https://blog.example.com
privacy__useStructuredData=false
```

## MySQL

The chart includes the `mysql` subchart by default. It creates the Ghost database through the official MySQL image environment variables. When self-hosted ActivityPub is enabled, the chart adds a small SQL init ConfigMap that is mounted by the MySQL subchart to create the `activitypub` database and grant access to the Ghost database user.

For the built-in database, set MySQL credentials under `mysql.auth`. The default
password Secret is `<release>-mysql`, such as `ghost-mysql`, with the keys
`mysql-password` and `mysql-root-password`. `mysql.fullnameOverride` changes the
default name; `mysql.auth.existingSecret` selects an existing Secret. The chart
resolves the host, Service port, username and database from the MySQL subchart.

```yaml
mysql:
  auth:
    username: ghost
    password: change-me
    database: ghost
```

Use an external MySQL database:

```yaml
mysql:
  enabled: false

externalMysql:
  host: mysql.example.svc.cluster.local
  port: 3306
  username: ghost
  password: <MYSQL_PASSWORD>
  database: ghost
```

The chart stores the raw password in `<fullname>-external-mysql`, using the
default key `mysql-password`. The database and user must already exist. Prefer
an existing Secret in the release namespace when managing credentials externally:

```yaml
mysql:
  enabled: false
externalMysql:
  host: mysql.example.svc.cluster.local
  username: ghost
  database: ghost
  existingSecret: ghost-external-mysql-credentials
  secretKey: mysql-password
```

Set only one of `externalMysql.password` and `externalMysql.existingSecret`.
Ghost, the MySQL wait container and ActivityPub read the same password Secret.
The application still uses Ghost's native `database__connection__*` environment
variables. Additional driver options, such as TLS, can be passed through
`ghost.config.database.connection.ssl`; host, port, user, database and password
are chart-managed and must be configured through `mysql` or `externalMysql`.
When using external MySQL with ActivityPub, also provision the
`activitypub.database` database and grant the configured user access to it.

Changes to credentials in chart values roll the Ghost Pod. Restart the Pod after
updating an externally managed Secret. Changing a password Secret does not change
the password stored by MySQL; coordinate database password changes first.

## Analytics

Ghost analytics uses Tinybird plus the `ghost/traffic-analytics` proxy service.

With analytics persistence enabled, updates use `Recreate` so the old pod releases
its volume before the replacement starts. Without persistence, updates use
`RollingUpdate`.

```yaml
trafficAnalytics:
  enabled: true
  tinybird:
    apiUrl: https://api.tinybird.co
    trackerToken: p.xxxxx
    adminToken: p.xxxxx
    workspaceId: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

You can also reference an existing Secret:

```yaml
trafficAnalytics:
  enabled: true
  tinybird:
    existingSecret: ghost-tinybird
```

The optional Tinybird deploy Job copies the Tinybird datafiles from the Ghost image and runs the Tinybird Forward CLI deploy command. The Job uses the admin token and allows destructive operations so the deployed Tinybird schema matches Ghost's bundled datafiles:

```yaml
trafficAnalytics:
  tinybird:
    deploy:
      enabled: true
```

If you manage Tinybird datafiles outside Helm, leave the deploy Job disabled and only provide the runtime tokens.

The chart creates a dedicated analytics Ingress because Ghost sends browser traffic to
`/.ghost/analytics/api/v1/page_hit`, while the analytics service expects `/api/v1/page_hit`.
When `ingress.ingressClassName` is set to a Traefik or nginx class, only the matching rewrite annotations are rendered.
When `ingress.ingressClassName` is empty, both Traefik and ingress-nginx annotations are rendered so the default IngressClass can handle the route.
The route matches the concrete `page_hit` endpoint instead of using a regex path; nginx rewrites it directly to `/api/v1/page_hit`, and Traefik strips the `/.ghost/analytics` prefix.

## ActivityPub

Enable self-hosted ActivityPub:

```yaml
activitypub:
  enabled: true
```

ActivityPub runs as a Kubernetes-native sidecar in the Ghost StatefulSet and requires Kubernetes 1.29 or newer. The official migration image runs after the database wait init container. Kubernetes then starts the ActivityPub sidecar and waits for its `/ping` startup probe before starting Ghost. Both containers share the site content volume and Pod network, avoiding cross-node attachment of the `ReadWriteOnce` content PVC.

The main Ghost Service exposes a separate `activitypub` port for the sidecar. A dedicated ActivityPub Ingress routes `/.ghost/activitypub` and the required `/.well-known` endpoints to that port; no separate ActivityPub Deployment or Service is created. The chart only supports the self-hosted ActivityPub service.

When upgrading from a chart that deployed ActivityPub separately, move Pod-level values to their Ghost equivalents: `activitypub.podLabels` to `ghost.podLabels`, `activitypub.podAnnotations` to `ghost.podAnnotations`, `activitypub.podSecurityContext` to `ghost.podSecurityContext`, and ActivityPub scheduling values to the corresponding `ghost` scheduling values. Move `activitypub.service.annotations` and `activitypub.service.labels` to `ghost.service.annotations` and `ghost.service.labels`. Custom ActivityPub HTTP or TCP probes that use the former `http` named port are translated to the numeric ActivityPub container port automatically.

For fresh installs with the built-in MySQL subchart, the chart creates the `activitypub` database through MySQL initdb. For upgrades of an existing built-in MySQL release, a `pre-upgrade` hook Job runs first and idempotently creates the database and grant before the ActivityPub migration init container starts. If you use an external MySQL database, create the ActivityPub database and grants outside this chart.

If the public site uses a `www` hostname, configure the root-domain redirect at your edge or Ingress layer as described in Ghost's Docker documentation.

## Mail

Ghost requires SMTP for staff invites, password resets, and other transactional mail. Configure SMTP under `ghost.config.mail`:

```yaml
ghost:
  config:
    mail:
      transport: SMTP
      from: "'Ghost' <noreply@ghost.local>"
      options:
        host: smtp.resend.com
        port: 465
        secure: true
        auth:
          user: resend
          pass: change-me
```

## Parameters

| Name | Description | Default |
| --- | --- | --- |
| `ghost.enabled` | Deploy the Ghost StatefulSet and Service | `true` |
| `ghost.image.repository` | Ghost image repository | `library/ghost` |
| `ghost.image.tag` | Ghost image tag | `6.72.0-alpine` |
| `ghost.config` | Ghost runtime configuration, flattened into environment variables in a Secret | See `values.yaml` |
| `ghost.config.url` | Public Ghost URL | `http://localhost:2368` |
| `ghost.config.admin.url` | Optional separate Ghost Admin URL | `""` |
| `ghost.service.type` | Ghost Service type | `ClusterIP` |
| `ghost.service.ports.http` | Ghost Service HTTP port | `80` |
| `ingress.enabled` | Create an Ingress | `true` |
| `ingress.ingressClassName` | IngressClass name | `""` |
| `ingress.hostname` | Ingress hostname | `ghost.local` |
| `ingress.pathType` | Ingress path type | `ImplementationSpecific` |
| `persistence.enabled` | Persist the shared site content volume used by Ghost and ActivityPub | `true` |
| `persistence.size` | Shared site content PVC size | `5Gi` |
| `mysql.enabled` | Deploy built-in MySQL | `true` |
| `mysql.auth.username` | Built-in MySQL user for Ghost | `ghost` |
| `mysql.auth.password` | Built-in MySQL user password | `""` |
| `mysql.auth.database` | Built-in MySQL database for Ghost | `ghost` |
| `mysql.auth.existingSecret` | Existing Secret containing built-in MySQL credentials | `""` |
| `mysql.persistence.enabled` | Persist MySQL data | `true` |
| `mysql.persistence.volumeName` | Built-in MySQL data volume claim template name | `mysql-data` |
| `mysql.persistence.size` | MySQL PVC size | `5Gi` |
| `mysql.persistence.existingClaim` | Existing PVC for MySQL data | `""` |
| `mysql.initdb.scriptsConfigMap` | Initdb ConfigMap mounted by the MySQL subchart | `{{ .Release.Name }}-mysql-initdb` |
| `mysql.resourcesPreset` | MySQL resource preset | `small` |
| `mysql.resources` | MySQL resource requests and limits | `{}` |
| `externalMysql.host` | External MySQL host; required when `mysql.enabled=false` | `""` |
| `externalMysql.port` | External MySQL Service port | `3306` |
| `externalMysql.username` | External MySQL user for Ghost and ActivityPub | `ghost` |
| `externalMysql.database` | External MySQL database for Ghost | `ghost` |
| `externalMysql.password` | Raw password stored in the generated external MySQL Secret | `""` |
| `externalMysql.existingSecret` | Existing Secret containing the external MySQL password | `""` |
| `externalMysql.secretKey` | Password key in the external MySQL Secret | `mysql-password` |
| `trafficAnalytics.enabled` | Enable Tinybird traffic analytics | `false` |
| `trafficAnalytics.tinybird.apiUrl` | Tinybird API URL | `https://api.tinybird.co` |
| `trafficAnalytics.tinybird.existingSecret` | Secret containing Tinybird tokens | `""` |
| `trafficAnalytics.tinybird.deploy.enabled` | Run Tinybird deploy hook Job | `false` |
| `activitypub.enabled` | Enable self-hosted ActivityPub | `false` |
| `activitypub.database` | MySQL database name for ActivityPub | `activitypub` |
| `activitypub.service.ports.http` | ActivityPub port exposed by the Ghost Service | `8080` |
| `activitypub.startupProbe.enabled` | Wait for ActivityPub startup before starting Ghost | `true` |
| `ghost.extraEnvVars` | Extra environment variables for Ghost | `[]` |
| `ghost.resources` | Ghost resource requests and limits | `{}` |

## Uninstall

```console
helm uninstall my-ghost
```

PersistentVolumeClaims may remain after uninstall depending on your cluster and storage class reclaim policy.

## Container security

Container security contexts are enabled for Ghost, traffic analytics, ActivityPub,
their migrations, and the chart-owned helper Jobs and initialization containers.
They disable privilege escalation, drop all capabilities, and use the runtime
default seccomp profile. Ghost and its helpers run as UID/GID 1000; MySQL uses its
own subchart defaults (UID/GID 999).

The ActivityPub migration container shares `activitypub.containerSecurityContext`.
Database wait/init and Tinybird file synchronization containers share
`ghost.containerSecurityContext`; the Tinybird CLI shares
`trafficAnalytics.containerSecurityContext`. The Tinybird Job uses
`ghost.podSecurityContext` for its shared writable volume.

New persistent volumes require storage that supports the configured `fsGroup`
ownership or CSI mount-group handling. Existing volumes must already have
compatible permissions; this chart does not migrate their ownership.
