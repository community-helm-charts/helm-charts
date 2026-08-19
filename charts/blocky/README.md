# Blocky Helm Chart

This chart deploys [Blocky](https://github.com/0xERR0R/blocky) as a lightweight DNS proxy and DNS-over-HTTPS endpoint. It is designed to run behind a TLS-terminating Ingress controller: clients use HTTPS, while the Ingress controller forwards plain HTTP to Blocky inside the cluster.

```text
DoH client --HTTPS--> Ingress controller --HTTP--> Blocky --DNS--> upstream resolver
```

Blocky therefore does not mount or load the public TLS certificate. cert-manager can renew the Ingress certificate without restarting Blocky, and no Secret reloader or backend `ServersTransport` is required.

## Prerequisites and installation

- Kubernetes and Helm 3.
- An Ingress controller when `ingress.enabled=true`.
- cert-manager and the selected Issuer/ClusterIssuer when certificate issuance is requested through Ingress annotations.

Install Blocky behind Traefik with a cert-manager `ClusterIssuer`:

```console
helm upgrade --install blocky oci://ghcr.io/community-helm-charts/blocky \
  --namespace blocky \
  --create-namespace \
  --set ingress.enabled=true \
  --set ingress.hostname=dns.example.com \
  --set ingress.tls=true \
  --set ingress.tlsSecretName=dns-example-tls \
  --set-string ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-prod
```

The resulting traffic path is HTTPS from the client to Traefik and HTTP from Traefik to the `blocky` Service. Do not add `traefik.ingress.kubernetes.io/service.serversscheme: https`; Blocky's chart-managed backend listener is intentionally plain HTTP.

## Upstream resolver

By default, an init container reads the Pod's `/etc/resolv.conf` and writes every nameserver into Blocky's `default` upstream group. On Kubernetes this normally selects the cluster DNS Service, allowing names such as `kubernetes.default.svc.cluster.local` to resolve through CoreDNS.

Set explicit upstreams when the Pod resolver should not be used:

```yaml
blocky:
  upstreams:
    - 10.43.0.10:53

podDnsUpstream:
  enabled: false
```

Explicit `blocky.upstreams` take precedence when discovery remains enabled. Each value accepts a Blocky upstream such as an IP address, `host:port`, `tcp-tls:host:port`, or DoH URL.

Because the default upstream is the cluster-local resolver, the chart sets `specialUseDomains.enable=false` so Kubernetes names under `cluster.local` are forwarded to CoreDNS instead of being answered locally with NXDOMAIN. Set it back to `true` when using only remote upstreams and cluster-local resolution is not required.

The generated configuration is assembled from multiple YAML files in an `emptyDir`. `blocky.config` accepts additional native Blocky configuration, but `ports` and `upstreams` are reserved because the chart manages them consistently with the Service and probes:

```yaml
blocky:
  config:
    upstreams:
      timeout: 3s # Invalid: the whole upstreams key is chart-managed.
```

Configure supported upstream settings through explicit upstream endpoints, or use `extraVolumes`, `extraVolumeMounts`, `command`, and `args` for a fully external configuration.

## Health probes

Liveness, readiness, and startup all send an RFC 8484 HTTP GET request to the internal HTTP listener at `/dns-query`, querying `healthcheck.blocky` with `Accept: application/dns-message`. This verifies that Blocky's HTTP listener and DoH route can accept and process a DNS message. The probes do not use TLS and do not depend on the Ingress certificate.

Blocky's dedicated `healthcheck.blocky` handler is registered on its DNS listeners, not on the DoH handler. A DoH request for this name can therefore contain an NXDOMAIN response while still returning HTTP 200. Kubernetes HTTP probes evaluate only the HTTP status, so these defaults check transport and route health rather than DNS RCODE, answer content, or upstream reachability.

Each default probe can be disabled with its `enabled` field. Following the conventions used by the other charts in this repository, `customLivenessProbe`, `customReadinessProbe`, and `customStartupProbe` accept complete Kubernetes probe objects and take precedence over their defaults:

```yaml
customReadinessProbe:
  httpGet:
    scheme: HTTP
    port: http
    path: /dns-query?dns=AAABAAABAAAAAAAABmdvb2dsZQNjb20AAAEAAQ
    httpHeaders:
      - name: Accept
        value: application/dns-message
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 3
```

An HTTP 200 response means Blocky accepted the DoH query and returned a DNS message; it does not prove that the response has the expected RCODE or answer records. The public TLS certificate and upstream DNS resolution are also outside the default Pod probe semantics. Use an external DoH synthetic monitor to validate certificate expiry, hostname verification, DNS RCODE, and expected answers end to end.

## Ingress certificate

`ingress.tls=true` references a TLS Secret only at the Ingress. Select an existing Secret with `ingress.tlsSecretName`. To let cert-manager create it through ingress-shim, add the issuer annotation:

```yaml
ingress:
  enabled: true
  hostname: dns.example.com
  tls: true
  tlsSecretName: dns-example-tls
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

When `ingress.tlsSecretName` is empty, the chart derives a name such as `dns-example-com-tls`. Blocky itself never mounts that Secret. The chart does not create cert-manager custom resources and can also use a Secret managed outside cert-manager.

## Security

The default Pod and container security contexts run Blocky as UID/GID 100, use a read-only root filesystem, disable privilege escalation, drop all Linux capabilities, and disable service-account token mounting. DNS listens on unprivileged port 5353, so `NET_BIND_SERVICE` is not required. Only the HTTP port is exposed through the default Service.

The HTTP listener also serves Blocky's API, metrics, and debugging endpoints. The default Ingress exposes only `/dns-query`; keep the ClusterIP Service inaccessible to untrusted workloads or add NetworkPolicies when namespace isolation is required.

## Parameters

### Image and Blocky configuration

| Name | Description | Default |
| --- | --- | --- |
| `image.registry` | Blocky image registry | `ghcr.io` |
| `image.repository` | Blocky image repository | `0xerr0r/blocky` |
| `image.tag` | Blocky image tag | `v0.34.0` |
| `image.digest` | Blocky image digest | `""` |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `blocky.httpPort` | Plain HTTP/DoH container port | `4000` |
| `blocky.dnsPort` | Plain DNS TCP/UDP container port | `5353` |
| `blocky.dohPath` | DoH path | `/dns-query` |
| `blocky.upstreams` | Explicit default-group upstreams | `[]` |
| `blocky.config` | Additional native Blocky configuration | `{specialUseDomains: {enable: false}}` |
| `podDnsUpstream.enabled` | Discover upstreams from Pod resolver configuration | `true` |

### Service and Ingress

| Name | Description | Default |
| --- | --- | --- |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service HTTP port | `4000` |
| `service.annotations` | Additional Service annotations | `{}` |
| `ingress.enabled` | Create an Ingress | `false` |
| `ingress.ingressClassName` | Ingress class | `""` |
| `ingress.hostname` | Default hostname | `blocky.local` |
| `ingress.path` | Default path | `/dns-query` |
| `ingress.pathType` | Default path matching mode | `Exact` |
| `ingress.tls` | Enable TLS at the Ingress | `false` |
| `ingress.tlsSecretName` | TLS Secret name | `""` |

### Deployment and probes

| Name | Description | Default |
| --- | --- | --- |
| `replicaCount` | Blocky replicas | `1` |
| `livenessProbe.enabled` | Enable the HTTP DoH liveness probe | `true` |
| `readinessProbe.enabled` | Enable the HTTP DoH readiness probe | `true` |
| `startupProbe.enabled` | Enable the HTTP DoH startup probe | `true` |
| `customLivenessProbe` | Complete liveness probe override | `{}` |
| `customReadinessProbe` | Complete readiness probe override | `{}` |
| `customStartupProbe` | Complete startup probe override | `{}` |
| `resourcesPreset` | Common resource preset | `nano` |
| `resources` | Explicit resource requests and limits | `{}` |
| `podAnnotations` | Additional Pod annotations | `{}` |
| `extraEnvVars` | Additional environment variables | `[]` |
| `extraVolumes` | Additional volumes | `[]` |
| `extraVolumeMounts` | Additional volume mounts | `[]` |
| `initContainers` | Additional init containers | `[]` |
| `sidecars` | Additional sidecars | `[]` |
