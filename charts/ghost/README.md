# Ghost Helm Chart

This chart deploys Ghost CMS with the same core services as the official Ghost Docker tooling: Ghost, MySQL, optional Tinybird analytics, and optional self-hosted ActivityPub.

The chart is intentionally direct: it does not include an operator, MySQL replication, backup automation, certificate management, or provider-specific ingress rules.

Ghost runs as a single-replica StatefulSet. This chart does not support horizontal scaling for one Ghost site.

## Install

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set config.url=https://example.com
```

Install with an Ingress:

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set config.url=https://blog.example.com \
  --set ingress.enabled=true \
  --set ingress.hostname=blog.example.com
```

For a non-persistent development install:

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set config.url=http://my-ghost.local \
  --set persistence.enabled=false \
  --set mysql.persistence.enabled=false
```

## Routing

The chart only targets root-path deployments. It does not try to support `https://example.com/blog`.

The public Service points directly at Ghost. When `ingress.enabled=true`, the chart adds standard Kubernetes Ingress paths for the optional side services:

| Path | Destination |
| --- | --- |
| `/.ghost/analytics` | `traffic-analytics`, when `analytics.enabled=true` |
| `/.ghost/activitypub` | ActivityPub, when `activitypub.enabled=true` |
| `/.well-known/webfinger` | ActivityPub, when `activitypub.enabled=true` |
| `/.well-known/nodeinfo` | ActivityPub, when `activitypub.enabled=true` |
| everything else | Ghost |

If you do not use the chart's Ingress, configure the same root-path routing in your external proxy or Ingress Controller.

## Ghost Configuration

Ghost runtime configuration lives under `config`. The chart flattens nested keys into Ghost environment variables and stores them in a generated Secret. For example, `config.database.connection.host` becomes `database__connection__host`.

```yaml
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

The chart includes a single MySQL instance by default. It creates the Ghost database through the official MySQL image environment variables. When self-hosted ActivityPub is enabled, the chart adds a small SQL init file to create the `activitypub` database and grant access to the Ghost database user.

Use an external MySQL database:

```yaml
mysql:
  enabled: false

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
analytics:
  enabled: true
  tinybird:
    apiUrl: https://api.tinybird.co
    trackerToken: p.xxxxx
    adminToken: p.xxxxx
    workspaceId: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

You can also reference an existing Secret:

```yaml
analytics:
  enabled: true
  tinybird:
    existingSecret: ghost-tinybird
```

The optional Tinybird deploy Job copies the Tinybird datafiles from the Ghost image and runs the Tinybird CLI deploy command:

```yaml
analytics:
  tinybird:
    deploy:
      enabled: true
```

If you manage Tinybird datafiles outside Helm, leave the deploy Job disabled and only provide the runtime tokens.

## ActivityPub

Enable self-hosted ActivityPub:

```yaml
activitypub:
  enabled: true
```

The ActivityPub pod runs the official migration image as an init container before starting the service. It stores local ActivityPub files under the shared Ghost content volume, so persistent storage should stay enabled for production. The chart only supports the self-hosted ActivityPub service.

If the public site uses a `www` hostname, configure the root-domain redirect at your edge or Ingress layer as described in Ghost's Docker documentation.

## Mail

Ghost requires SMTP for staff invites, password resets, and other transactional mail. Configure SMTP under `config.mail`:

```yaml
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
| `image.repository` | Ghost image repository | `library/ghost` |
| `image.tag` | Ghost image tag | `6-alpine` |
| `config` | Ghost runtime configuration, flattened into environment variables in a Secret | See `values.yaml` |
| `config.url` | Public Ghost URL | `http://localhost:2368` |
| `config.admin.url` | Optional separate Ghost Admin URL | `""` |
| `config.database.connection.host` | Database host; defaults to built-in MySQL service when empty | `""` |
| `config.database.connection.port` | Database port | `3306` |
| `config.database.connection.user` | Database user | `ghost` |
| `config.database.connection.password` | Database password; stored in the generated config Secret | `""` |
| `config.database.connection.database` | Database name | `ghost` |
| `service.type` | Public Service type | `ClusterIP` |
| `service.ports.http` | Public Service HTTP port | `80` |
| `ingress.enabled` | Create an Ingress | `true` |
| `ingress.hostname` | Ingress hostname | `ghost.local` |
| `persistence.enabled` | Persist Ghost content | `true` |
| `persistence.size` | Ghost content PVC size | `8Gi` |
| `mysql.enabled` | Deploy built-in MySQL | `true` |
| `mysql.auth.existingSecret` | Existing Secret containing built-in MySQL credentials | `""` |
| `mysql.persistence.enabled` | Persist MySQL data | `true` |
| `mysql.persistence.size` | MySQL PVC size | `8Gi` |
| `mysql.persistence.existingClaim` | Existing PVC for MySQL data | `""` |
| `mysql.resources` | MySQL resource requests and limits | `{}` |
| `analytics.enabled` | Enable Tinybird traffic analytics | `false` |
| `analytics.tinybird.apiUrl` | Tinybird API URL | `https://api.tinybird.co` |
| `analytics.tinybird.existingSecret` | Secret containing Tinybird tokens | `""` |
| `analytics.tinybird.deploy.enabled` | Run Tinybird deploy hook Job | `false` |
| `activitypub.enabled` | Enable self-hosted ActivityPub | `false` |
| `extraEnvVars` | Extra environment variables for Ghost | `[]` |
| `resources` | Ghost resource requests and limits | `{}` |

## Uninstall

```console
helm uninstall my-ghost
```

PersistentVolumeClaims may remain after uninstall depending on your cluster and storage class reclaim policy.
