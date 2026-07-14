# Shadowsocks Helm Chart

This chart deploys
[`ghcr.io/shadowsocks/ssserver-rust:v1.24.0`](https://github.com/shadowsocks/shadowsocks-rust)
as a Kubernetes DaemonSet. Every selected node runs one Shadowsocks server.

## Default behavior

- `hostNetwork` is enabled and `dnsPolicy` is `Default`.
- The server listens on `[::]:8388` in `tcp_and_udp` mode.
- A ClusterIP Service exposes TCP and UDP port 8388 with
  `internalTrafficPolicy: Local`.
- The password is read from a Kubernetes Secret through the
  `SHADOWSOCKS_PASSWORD` environment variable.
- A lightweight TCP liveness probe and readiness probe are enabled.

## Configuration

Values under `config.*` map directly to root-level fields in the generated
`config.json`:

```yaml
config:
  server: "::"
  server_port: 8388
  method: aes-256-gcm
  fast_open: true
  mode: tcp_and_udp
  udp_timeout: 300
```

The resulting ConfigMap also contains this reserved field:

```json
"password": "${SHADOWSOCKS_PASSWORD}"
```

Do not set `config.password`. The chart rejects plaintext passwords in the
configuration and always reads the password from a Secret. The container and
Service TCP/UDP ports follow `config.server_port`.

## Install with a chart-managed Secret

The default `auth.password` is `changeme` and is only a placeholder. Always
replace it outside disposable test environments:

```bash
helm upgrade --install shadowsocks ./charts/shadowsocks \
  --namespace shadowsocks \
  --create-namespace \
  --set-string auth.password='replace-with-a-strong-password'
```

The password value is written to the chart-managed `shadowsocks-auth` Secret.
Changing `auth.password` updates the DaemonSet checksum and rolls its pods.

## Install with an existing Secret

Create or manage the Secret separately:

```bash
kubectl create namespace shadowsocks
kubectl create secret generic shadowsocks-credentials \
  --namespace shadowsocks \
  --from-literal=password='replace-with-a-strong-password'
```

Install the chart with the Secret name and key:

```bash
helm upgrade --install shadowsocks ./charts/shadowsocks \
  --namespace shadowsocks \
  --set auth.existingSecret=shadowsocks-credentials \
  --set auth.existingSecretPasswordKey=password
```

Kubernetes does not update an existing container environment variable when a
Secret changes. Restart the DaemonSet after rotating an externally managed
password:

```bash
kubectl rollout restart daemonset/shadowsocks --namespace shadowsocks
```

## Networking

With the defaults, clients can reach port 8388 over TCP or UDP through a node's
address because the DaemonSet uses `hostNetwork`. In-cluster clients can also
use `shadowsocks.<namespace>.svc.cluster.local:8388`.

Set `service.enabled=false` to omit the ClusterIP Service. Set
`hostNetwork=false` and choose an appropriate `dnsPolicy` if the server should
only use the pod network.

TCP probes are not suitable for a UDP-only configuration. Disable
`livenessProbe.enabled` and `readinessProbe.enabled` when using UDP-only mode.
