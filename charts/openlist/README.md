# OpenList Helm Chart

This chart deploys OpenList as a single-replica StatefulSet.

OpenList stores its container data in `/opt/openlist/data`, so the chart uses a
`ReadWriteOnce` persistent volume by default and always renders one StatefulSet
replica. The chart does not expose a `replicaCount` value.

The default values follow the upstream Docker Compose reference: `UMASK=022`,
`TZ=Asia/Shanghai`, port `5244` for the main HTTP service, and port `5245` for
the secondary HTTPS listener.

```bash
helm install openlist ./charts/openlist
```

Ingress values follow the Bitnami-style `hostname`/`path` shape:

```yaml
ingress:
  enabled: true
  ingressClassName: traefik
  hostname: openlist.example.com
  path: /
```
