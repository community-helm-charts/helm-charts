# OpenViking Helm Chart

This chart deploys OpenViking as a single-replica StatefulSet.

OpenViking stores its default local data in `/app/data`, so the chart uses a
`ReadWriteOnce` persistent volume by default and always renders one StatefulSet
replica. The chart does not expose a `replicaCount` value.

The rendered `ov.conf` is stored in a Kubernetes Secret rather than a ConfigMap.
Use `config.existingSecret` and `config.existingSecretKey` to provide the config
Secret yourself.

```bash
helm install openviking ./charts/openviking \
  --set config.server.root_api_key="YOUR_ROOT_API_KEY" \
  --set config.embedding.dense.api_key="YOUR_VOLCENGINE_API_KEY" \
  --set config.vlm.api_key="YOUR_VOLCENGINE_API_KEY"
```

For production, prefer supplying an externally managed Secret:

```yaml
config:
  existingSecret: openviking-config
  existingSecretKey: ov.conf
```

Ingress values follow the Bitnami-style `hostname`/`path` shape:

```yaml
ingress:
  enabled: true
  ingressClassName: traefik
  hostname: openviking.example.com
  path: /
```
