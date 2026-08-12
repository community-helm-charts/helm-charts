# FRP Server Helm Chart

This chart deploys one [FRP](https://github.com/fatedier/frp) server (`frps`) and converts structured `config.*` values into `frps.toml`. Client connections and virtual-host traffic use separate Kubernetes Services.

The chart is intentionally single-instance: FRPS keeps client control connections, proxy registrations, and work-connection state in one process without multi-server coordination. The Deployment always has one replica and uses the `Recreate` strategy so an update cannot briefly run two independent servers behind the same Services.

## Prerequisites and installation

- Kubernetes with a default `StorageClass` is not required; the chart has no persistent volume.
- Helm 3 is required.
- The default primary Service needs a working LoadBalancer implementation. Set `service.type=NodePort` or `ClusterIP` when appropriate.
- An Ingress controller and TLS configuration are required only when enabling Ingress.

Install with a chart-managed token:

```console
helm install frps oci://ghcr.io/community-helm-charts/frps \
  --set-string auth.token='<TOKEN>'
```

Values passed through Helm, including `auth.token`, are retained in Helm release metadata. Use an existing Secret when the token must not be stored in release values.

Create the Secret and select both its name and key:

```console
kubectl create secret generic frps-credentials \
  --from-literal=credential='<TOKEN>'

helm install frps oci://ghcr.io/community-helm-charts/frps \
  --set auth.existingSecret=frps-credentials \
  --set auth.existingSecretKey=credential
```

When `auth.existingSecret` is set, it takes precedence over `auth.token` and the chart does not create an authentication Secret.

## Server configuration

The default structured configuration is:

```yaml
config:
  bindPort: 7000
  vhostHTTPPort: 8080
  vhostHTTPSPort: 8443
```

The chart converts `config` to TOML and injects file-backed token authentication. The resulting configuration has this shape:

```toml
bindPort = 7000
vhostHTTPPort = 8080
vhostHTTPSPort = 8443

[auth]
method = "token"

[auth.tokenSource]
type = "file"

[auth.tokenSource.file]
path = "/etc/frp/token"
```

Arbitrary FRPS scalar fields, nested maps, arrays, and arrays of objects can be supplied below `config`. For example:

```yaml
config:
  bindPort: 7000
  vhostHTTPPort: 8080
  vhostHTTPSPort: 8443
  transport:
    maxPoolCount: 5
    tls:
      force: true
  allowPorts:
    - start: 2000
      end: 3000
    - single: 3001
  httpPlugins:
    - name: user-manager
      addr: 127.0.0.1:9000
      path: /handler
      ops:
        - Login
```

The chart owns authentication in the generated TOML. Do not set `config.auth.token` or `config.auth.tokenSource`. `config.auth.method` may be omitted or set to `token`; other methods are rejected. Rendering also fails when `auth`, `config`, or `config.auth` has the wrong type; when `auth.token`, `auth.existingSecret`, or `auth.existingSecretKey` is not a string; when a required port is not a unique integer from 1 through 65535; when no authentication source is configured; or when an existing Secret has an empty key.

The generated `frps.toml` is stored in a Kubernetes ConfigMap. Any other sensitive `config.*` field, such as `config.webServer.password`, is therefore stored as plaintext in the ConfigMap and Helm release metadata. Supply only values whose exposure is acceptable, or manage sensitive configuration outside this chart.

The default container security context uses a read-only root filesystem and FRPS logs to stdout. If `config.log.to` is changed to a file path, mount a writable volume at that path through `extraVolumes` and `extraVolumeMounts` (or explicitly override `containerSecurityContext.readOnlyRootFilesystem`).

## Services and proxy ports

The primary `<fullname>` Service defaults to `LoadBalancer` and exposes the FRPS client bind listener on TCP port 7000. Both Service types are configurable: use `service.type` for this primary Service and `vhostService.type` for virtual-host traffic.

FRPS cannot tell Helm which client-selected proxy ports must be reachable. Add every required externally reachable TCP or UDP port to `service.extraPorts` and configure the corresponding FRPS behavior where applicable:

```yaml
service:
  type: LoadBalancer
  extraPorts:
    - name: tcp-proxy
      port: 6000
      targetPort: 6000
      protocol: TCP
    - name: udp-proxy
      port: 7002
      targetPort: 7002
      protocol: UDP
```

The separate `<fullname>-vhost` Service exposes HTTP on 8080 and HTTPS on 8443. It defaults to `ClusterIP`, keeping virtual-host traffic internal, but `vhostService.type` can be changed when direct external exposure is required. It does not include `service.extraPorts`.

## HTTP Ingress and TLS

The optional Ingress is disabled by default. Enabling it is the recommended way to route HTTP virtual-host traffic: it sends requests to the `http` port of the internal vhost Service. TLS terminates at the Ingress controller, which still forwards HTTP to FRPS. The chart Ingress does not route to the FRPS HTTPS listener; configure controller-specific TCP or TLS passthrough separately when that behavior is needed.

```yaml
ingress:
  enabled: true
  ingressClassName: nginx
  hostname: tunnels.example.com
  tls: true
```

## Rotate an external token

Externally managed Secret contents are not part of the Deployment checksum. The token is mounted with `subPath` and FRPS reads it at startup, so update the Secret and explicitly restart the Deployment:

```console
kubectl rollout restart deployment/frps
kubectl rollout status deployment/frps
```

Adjust the Deployment name and namespace when the release uses a different name or namespace override.

## Parameters

### Global and common parameters

| Name | Description | Default |
| --- | --- | --- |
| `global.imageRegistry` | Global container image registry | `""` |
| `global.imagePullSecrets` | Global container registry secret names | `[]` |
| `kubeVersion` | Override Kubernetes version | `""` |
| `nameOverride` | Partially override the chart name | `""` |
| `fullnameOverride` | Fully override the chart name | `""` |
| `namespaceOverride` | Fully override the release namespace | `""` |
| `clusterDomain` | Kubernetes cluster domain | `cluster.local` |
| `commonLabels` | Labels added to every resource | `{}` |
| `commonAnnotations` | Annotations added to every resource | `{}` |
| `secretAnnotations` | Annotations to add to chart-managed Secret objects | `{}` |
| `extraDeploy` | Additional objects to deploy | `[]` |

### Image parameters

| Name | Description | Default |
| --- | --- | --- |
| `image.registry` | FRPS image registry | `ghcr.io` |
| `image.repository` | FRPS image repository | `fatedier/frps` |
| `image.tag` | FRPS image tag | `v0.70.1` |
| `image.digest` | FRPS image digest in the form `sha256:...` | `""` |
| `image.pullPolicy` | FRPS image pull policy | `IfNotPresent` |
| `image.pullSecrets` | FRPS image pull secrets | `[]` |

### Server and authentication parameters

| Name | Description | Default |
| --- | --- | --- |
| `config.bindPort` | FRPS client connection port | `7000` |
| `config.vhostHTTPPort` | FRPS HTTP virtual-host port | `8080` |
| `config.vhostHTTPSPort` | FRPS HTTPS virtual-host port | `8443` |
| `auth.token` | Token stored in the chart-managed Secret | `""` |
| `auth.existingSecret` | Existing Secret containing the token | `""` |
| `auth.existingSecretKey` | Token key in the existing Secret | `token` |

### Primary Service parameters

| Name | Description | Default |
| --- | --- | --- |
| `service.type` | Service type | `LoadBalancer` |
| `service.nodePorts.bind` | Node port for client connections | `""` |
| `service.clusterIP` | Service cluster IP | `""` |
| `service.annotations` | Additional Service annotations | `{}` |
| `service.labels` | Additional Service labels | `{}` |
| `service.internalTrafficPolicy` | Service internal traffic policy | `Cluster` |
| `service.externalTrafficPolicy` | Service external traffic policy | `Cluster` |
| `service.loadBalancerClass` | Load balancer implementation class | `""` |
| `service.loadBalancerIP` | Load balancer IP address | `""` |
| `service.loadBalancerSourceRanges` | Allowed source ranges for the load balancer | `[]` |
| `service.sessionAffinity` | Service session affinity | `None` |
| `service.sessionAffinityConfig` | Additional session affinity settings | `{}` |
| `service.ipFamilyPolicy` | Service IP family policy | `""` |
| `service.ipFamilies` | Service IP families | `[]` |
| `service.extraPorts` | Additional Service ports | `[]` |

### Virtual-host Service parameters

| Name | Description | Default |
| --- | --- | --- |
| `vhostService.type` | Service type | `ClusterIP` |
| `vhostService.clusterIP` | Service cluster IP | `""` |
| `vhostService.annotations` | Additional Service annotations | `{}` |
| `vhostService.labels` | Additional Service labels | `{}` |
| `vhostService.internalTrafficPolicy` | Service internal traffic policy | `Cluster` |
| `vhostService.sessionAffinity` | Service session affinity | `None` |
| `vhostService.sessionAffinityConfig` | Additional session affinity settings | `{}` |
| `vhostService.ipFamilyPolicy` | Service IP family policy | `""` |
| `vhostService.ipFamilies` | Service IP families | `[]` |

### Ingress parameters

| Name | Description | Default |
| --- | --- | --- |
| `ingress.enabled` | Enable the Ingress resource | `false` |
| `ingress.pathType` | Ingress path type | `ImplementationSpecific` |
| `ingress.apiVersion` | Override Ingress API version | `""` |
| `ingress.hostname` | Default Ingress hostname | `frps.local` |
| `ingress.path` | Default Ingress path | `/` |
| `ingress.annotations` | Additional Ingress annotations | `{}` |
| `ingress.ingressClassName` | Ingress class name | `""` |
| `ingress.tls` | Enable TLS for the default host | `false` |
| `ingress.extraHosts` | Additional Ingress hosts | `[]` |
| `ingress.extraPaths` | Additional Ingress paths | `[]` |
| `ingress.extraTls` | Additional TLS configurations | `[]` |
| `ingress.extraRules` | Additional Ingress rules | `[]` |
| `ingress.secrets` | TLS secrets | `[]` |

### Deployment and probe parameters

| Name | Description | Default |
| --- | --- | --- |
| `command` | Override the FRPS container command | `[]` |
| `args` | Override the FRPS container arguments | `[]` |
| `extraEnvVars` | Additional environment variables | `[]` |
| `extraEnvVarsCM` | Existing ConfigMap imported as environment variables | `""` |
| `extraEnvVarsSecret` | Existing Secret imported as environment variables | `""` |
| `extraVolumes` | Additional pod volumes | `[]` |
| `extraVolumeMounts` | Additional container volume mounts | `[]` |
| `initContainers` | Additional init containers | `[]` |
| `sidecars` | Additional sidecar containers | `[]` |
| `livenessProbe.enabled` | Enable the liveness probe | `true` |
| `livenessProbe.initialDelaySeconds` | Initial liveness probe delay | `10` |
| `livenessProbe.periodSeconds` | Liveness probe interval | `10` |
| `livenessProbe.timeoutSeconds` | Liveness probe timeout | `5` |
| `livenessProbe.failureThreshold` | Liveness probe failure threshold | `1` |
| `livenessProbe.successThreshold` | Liveness probe success threshold | `1` |
| `readinessProbe.enabled` | Enable the readiness probe | `true` |
| `readinessProbe.initialDelaySeconds` | Initial readiness probe delay | `5` |
| `readinessProbe.periodSeconds` | Readiness probe interval | `10` |
| `readinessProbe.timeoutSeconds` | Readiness probe timeout | `5` |
| `readinessProbe.failureThreshold` | Readiness probe failure threshold | `3` |
| `readinessProbe.successThreshold` | Readiness probe success threshold | `1` |
| `customLivenessProbe` | Complete liveness probe override | `{}` |
| `customReadinessProbe` | Complete readiness probe override | `{}` |

### Resources and security parameters

| Name | Description | Default |
| --- | --- | --- |
| `resourcesPreset` | Common resource preset | `nano` |
| `resources` | Explicit resource requests and limits | `{}` |
| `podSecurityContext.enabled` | Enable the pod security context | `true` |
| `podSecurityContext.sysctls` | Pod sysctls | See `values.yaml` |
| `containerSecurityContext.enabled` | Enable the container security context | `true` |
| `containerSecurityContext.runAsUser` | Container user ID | `1000` |
| `containerSecurityContext.runAsGroup` | Container group ID | `1000` |
| `containerSecurityContext.runAsNonRoot` | Require a non-root container | `true` |
| `containerSecurityContext.allowPrivilegeEscalation` | Allow privilege escalation | `false` |
| `containerSecurityContext.readOnlyRootFilesystem` | Use a read-only root filesystem | `true` |
| `containerSecurityContext.capabilities.drop` | Linux capabilities to drop | `[ALL]` |
| `containerSecurityContext.seccompProfile.type` | Seccomp profile type | `RuntimeDefault` |

### Scheduling and ServiceAccount parameters

| Name | Description | Default |
| --- | --- | --- |
| `podLabels` | Additional pod labels | `{}` |
| `podAnnotations` | Additional pod annotations | `{}` |
| `priorityClassName` | Pod priority class | `""` |
| `schedulerName` | Alternate scheduler | `""` |
| `terminationGracePeriodSeconds` | Pod termination grace period | `""` |
| `hostAliases` | Pod host aliases | `[]` |
| `affinity` | Pod affinity rules | `{}` |
| `nodeSelector` | Node selection labels | `{}` |
| `tolerations` | Pod tolerations | `[]` |
| `topologySpreadConstraints` | Pod topology spread constraints | `[]` |
| `serviceAccount.create` | Create a ServiceAccount | `true` |
| `serviceAccount.name` | ServiceAccount name | `""` |
| `serviceAccount.automountServiceAccountToken` | Automount API credentials on the ServiceAccount | `false` |
| `serviceAccount.annotations` | Additional ServiceAccount annotations | `{}` |
| `automountServiceAccountToken` | Automount API credentials in server pods | `false` |
