# Ghost Helm Chart

This chart deploys Ghost CMS with the same core services as the official Ghost Docker tooling: Ghost, MySQL, optional Tinybird analytics, and optional self-hosted ActivityPub.

The chart is intentionally direct: it does not include an operator, MySQL replication, backup automation, certificate management, or provider-specific ingress rules.

Ghost runs as a single-replica StatefulSet. This chart does not support horizontal scaling for one Ghost site.

## Install

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set url=https://example.com
```

Install with an Ingress:

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set url=https://blog.example.com \
  --set ingress.enabled=true \
  --set ingress.hostname=blog.example.com
```

For a non-persistent development install:

```console
helm install my-ghost oci://ghcr.io/community-helm-charts/ghost \
  --set url=http://my-ghost.local \
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

## MySQL

The chart includes a single MySQL instance by default. It creates the Ghost database through the official MySQL image environment variables. When self-hosted ActivityPub is enabled, the chart adds a small SQL init file to create the `activitypub` database and grant access to the Ghost database user.

Use an external MySQL database:

```yaml
mysql:
  enabled: false

externalDatabase:
  host: mysql.example.svc.cluster.local
  port: 3306
  user: ghost
  password: change-me
  database: ghost
```

Use an existing Secret for the database password:

```yaml
externalDatabase:
  existingSecret: ghost-db
  existingSecretPasswordKey: mysql-password
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

Ghost requires SMTP for staff invites, password resets, and other transactional mail. Enable the built-in SMTP values to set Ghost's mail environment variables:

```yaml
smtp:
  enabled: true
  from: "'Ghost' <noreply@ghost.local>"
  host: smtp.resend.com
  port: 465
  secure: true
  user: resend
  password: change-me
```

Use an existing Secret for the SMTP password:

```yaml
smtp:
  enabled: true
  existingSecret: ghost-smtp
  existingSecretPasswordKey: smtp-password
```

## Parameters

| Name | Description | Default |
| --- | --- | --- |
| `image.repository` | Ghost image repository | `library/ghost` |
| `image.tag` | Ghost image tag | `6-alpine` |
| `url` | Public Ghost URL | `http://localhost:2368` |
| `adminUrl` | Optional separate Ghost Admin URL | `""` |
| `service.type` | Public Service type | `ClusterIP` |
| `service.ports.http` | Public Service HTTP port | `80` |
| `ingress.enabled` | Create an Ingress | `true` |
| `ingress.hostname` | Ingress hostname | `ghost.local` |
| `smtp.enabled` | Enable SMTP mail configuration | `false` |
| `smtp.from` | Ghost mail sender | `'Ghost' <noreply@ghost.local>` |
| `smtp.host` | SMTP host | `smtp.resend.com` |
| `smtp.port` | SMTP port | `465` |
| `smtp.secure` | Use secure SMTP connection | `true` |
| `smtp.user` | SMTP username | `resend` |
| `smtp.password` | SMTP password; stored in a generated Secret when set | `""` |
| `smtp.existingSecret` | Existing Secret containing the SMTP password | `""` |
| `smtp.existingSecretPasswordKey` | Password key in the existing SMTP Secret | `smtp-password` |
| `persistence.enabled` | Persist Ghost content | `true` |
| `persistence.size` | Ghost content PVC size | `8Gi` |
| `mysql.enabled` | Deploy built-in MySQL | `true` |
| `mysql.image.repository` | MySQL image repository | `library/mysql` |
| `mysql.image.tag` | MySQL image tag | `8.0.44` |
| `mysql.auth.username` | MySQL user for Ghost | `ghost` |
| `mysql.auth.database` | Ghost database name | `ghost` |
| `mysql.auth.existingSecret` | Existing Secret containing built-in MySQL credentials | `""` |
| `mysql.auth.existingSecretRootPasswordKey` | Root password key in the existing MySQL Secret | `mysql-root-password` |
| `mysql.auth.existingSecretPasswordKey` | User password key in the existing MySQL Secret | `mysql-password` |
| `mysql.service.port` | Built-in MySQL Service port | `3306` |
| `mysql.persistence.enabled` | Persist MySQL data | `true` |
| `mysql.persistence.storageClass` | MySQL PVC storage class | `""` |
| `mysql.persistence.size` | MySQL PVC size | `8Gi` |
| `mysql.persistence.existingClaim` | Existing PVC for MySQL data | `""` |
| `mysql.resources` | MySQL resource requests and limits | `{}` |
| `externalDatabase.host` | External MySQL host when `mysql.enabled=false` | `""` |
| `externalDatabase.existingSecret` | Existing Secret containing the external database password | `""` |
| `externalDatabase.existingSecretPasswordKey` | Password key in the existing external database Secret | `mysql-password` |
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
