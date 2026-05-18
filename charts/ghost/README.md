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

The public Service points directly at Ghost. When `ingress.enabled=true`, the chart adds standard Kubernetes Ingress paths for the optional side services:

| Path | Destination |
| --- | --- |
| `/.ghost/analytics` | `traffic-analytics`, when `trafficAnalytics.enabled=true` |
| `/.ghost/activitypub` | ActivityPub, when `activitypub.enabled=true` |
| `/.well-known/webfinger` | ActivityPub, when `activitypub.enabled=true` |
| `/.well-known/nodeinfo` | ActivityPub, when `activitypub.enabled=true` |
| everything else | Ghost |

If you do not use the chart's Ingress, configure the same root-path routing in your external proxy or Ingress Controller.

## Ghost Configuration

Ghost runtime configuration lives under `ghost.config`. The chart flattens nested keys into Ghost environment variables and stores them in a generated Secret. For example, `ghost.config.database.connection.host` becomes `database__connection__host`.

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

For the built-in database, set MySQL credentials under `mysql.auth`. Ghost reads the generated MySQL Secret unless `ghost.config.database.connection.password` is explicitly set.

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

ghost:
  config:
    database:
      connection:
        host: mysql.example.svc.cluster.local
        port: 3306
        user: ghost
        password: change-me
        database: ghost
```

## Analytics

Ghost analytics uses Tinybird plus the `ghost/traffic-analytics` proxy service.

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
When `ingress.className` is set to a Traefik or nginx class, only the matching rewrite annotations are rendered.
When `ingress.className` is empty, both Traefik and ingress-nginx annotations are rendered so the default IngressClass can handle the route.
The route matches the concrete `page_hit` endpoint instead of using a regex path; nginx rewrites it directly to `/api/v1/page_hit`, and Traefik strips the `/.ghost/analytics` prefix.

## ActivityPub

Enable self-hosted ActivityPub:

```yaml
activitypub:
  enabled: true
```

The ActivityPub pod runs the official migration image as an init container before starting the service. When ActivityPub is enabled, the Ghost pod waits for the ActivityPub service `/ping` endpoint before starting, mirroring the startup ordering used by Ghost's Docker Compose setup. ActivityPub stores local files under the shared site content volume, so persistent storage should stay enabled for production. The chart creates a dedicated ActivityPub Ingress for `/.ghost/activitypub` and the required `/.well-known` endpoints. The chart only supports the self-hosted ActivityPub service.

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
| `ghost.image.tag` | Ghost image tag | `6-alpine` |
| `ghost.config` | Ghost runtime configuration, flattened into environment variables in a Secret | See `values.yaml` |
| `ghost.config.url` | Public Ghost URL | `http://localhost:2368` |
| `ghost.config.admin.url` | Optional separate Ghost Admin URL | `""` |
| `ghost.config.database.connection.host` | Database host; defaults to built-in MySQL service when empty | `""` |
| `ghost.config.database.connection.port` | Database port | `3306` |
| `ghost.config.database.connection.user` | Database user | `ghost` |
| `ghost.config.database.connection.password` | External database password, or an explicit override for Ghost's database password env var | `""` |
| `ghost.config.database.connection.database` | Database name | `ghost` |
| `ghost.service.type` | Ghost Service type | `ClusterIP` |
| `ghost.service.ports.http` | Ghost Service HTTP port | `80` |
| `ingress.enabled` | Create an Ingress | `true` |
| `ingress.hostname` | Ingress hostname | `ghost.local` |
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
| `trafficAnalytics.enabled` | Enable Tinybird traffic analytics | `false` |
| `trafficAnalytics.tinybird.apiUrl` | Tinybird API URL | `https://api.tinybird.co` |
| `trafficAnalytics.tinybird.existingSecret` | Secret containing Tinybird tokens | `""` |
| `trafficAnalytics.tinybird.deploy.enabled` | Run Tinybird deploy hook Job | `false` |
| `activitypub.enabled` | Enable self-hosted ActivityPub | `false` |
| `activitypub.database` | MySQL database name for ActivityPub | `activitypub` |
| `ghost.extraEnvVars` | Extra environment variables for Ghost | `[]` |
| `ghost.resources` | Ghost resource requests and limits | `{}` |

## Uninstall

```console
helm uninstall my-ghost
```

PersistentVolumeClaims may remain after uninstall depending on your cluster and storage class reclaim policy.
