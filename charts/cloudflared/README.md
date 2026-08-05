# Cloudflared Helm Chart

This chart runs Cloudflare Tunnel connectors in remotely managed mode. Tunnel
routes and public hostnames are configured in Cloudflare; the chart deploys the
`cloudflared` connector process and supplies its tunnel token.

## Install

Create a remotely managed tunnel in Cloudflare and copy its token, then install
the chart:

```console
helm install cloudflared oci://ghcr.io/community-helm-charts/cloudflared \
  --set-string auth.tunnelToken='<TUNNEL_TOKEN>'
```

`auth.tunnelToken` creates a Secret owned by the Helm release. The value is
stored in Helm release metadata, so use an existing Secret when the token must
not be included in Helm values:

```console
kubectl create secret generic cloudflared-token \
  --from-literal=token='<TUNNEL_TOKEN>'

helm install cloudflared oci://ghcr.io/community-helm-charts/cloudflared \
  --set auth.existingSecret=cloudflared-token
```

Set `auth.existingSecretKey` if the token is stored under a key other than
`token`. When `auth.existingSecret` is set, it takes precedence over
`auth.tunnelToken` and the chart does not create a Secret.

## Remote routing

Configure routes in the Cloudflare dashboard or API. A route to a workload in
the same Kubernetes cluster can use its complete Service DNS name, for example:

```text
http://my-service.my-namespace.svc.cluster.local:8080
```

The connector does not need Kubernetes API credentials to reach a Service. The
chart disables ServiceAccount token mounting by default.

## Availability and health

The chart defaults to `replicaCount: 2`. Each replica connects independently to
Cloudflare, providing connector availability. `replicaCount` is a fixed replica
count; this chart does not create an autoscaler.

The liveness and readiness probes call cloudflared's `/ready` endpoint on the
metrics port. A successful response means the process has an active connection
to Cloudflare.

## Metrics

Cloudflared exposes metrics on port `2000` by default. The port is available to
probes without creating a Service. Set `metrics.service.enabled=true` when a
cluster monitoring system needs a stable Service endpoint:

```console
helm upgrade --install cloudflared oci://ghcr.io/community-helm-charts/cloudflared \
  --set auth.existingSecret=cloudflared-token \
  --set metrics.service.enabled=true
```

The default metrics Service DNS name is
`cloudflared-metrics.<namespace>.svc.cluster.local` when the release is named
`cloudflared`.

## Rotate the tunnel token

Changing `auth.tunnelToken` updates the chart-managed Secret and automatically
rolls the Deployment. When using `auth.existingSecret`, update the Secret and
restart the Deployment so every connector reads the new token:

```console
kubectl rollout restart deployment/cloudflared
kubectl rollout status deployment/cloudflared
```

Adjust the Deployment name when `nameOverride`, `fullnameOverride`, or a
different release name is used.

## Parameters

### Global and common parameters

| Name | Description | Default |
| --- | --- | --- |
| `global.imageRegistry` | Global image registry override | `""` |
| `global.imagePullSecrets` | Global image pull Secret names | `[]` |
| `kubeVersion` | Kubernetes version override | `""` |
| `nameOverride` | Partial resource name override | `""` |
| `fullnameOverride` | Full resource name override | `""` |
| `namespaceOverride` | Resource namespace override | `""` |
| `clusterDomain` | Kubernetes cluster domain | `cluster.local` |
| `commonLabels` | Labels added to every resource | `{}` |
| `commonAnnotations` | Annotations added to every resource | `{}` |
| `extraDeploy` | Additional Kubernetes objects | `[]` |

### Image and connector parameters

| Name | Description | Default |
| --- | --- | --- |
| `image.registry` | Cloudflared image registry | `docker.io` |
| `image.repository` | Cloudflared image repository | `cloudflare/cloudflared` |
| `image.tag` | Cloudflared image tag | `2026.7.2` |
| `image.digest` | Cloudflared image digest | `""` |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `image.pullSecrets` | Image pull Secret names | `[]` |
| `replicaCount` | Fixed number of connector replicas | `2` |
| `tunnel.logLevel` | Cloudflared log level | `info` |
| `tunnel.extraArgs` | Arguments inserted before `tunnel run` | `[]` |
| `command` | Complete container command override | `[]` |
| `args` | Complete container argument override | `[]` |

### Authentication parameters

| Name | Description | Default |
| --- | --- | --- |
| `auth.tunnelToken` | Tunnel token stored in a chart-managed Secret | `""` |
| `auth.existingSecret` | Existing Secret containing the tunnel token | `""` |
| `auth.existingSecretKey` | Token key in the existing Secret | `token` |

### Metrics parameters

| Name | Description | Default |
| --- | --- | --- |
| `metrics.port` | Metrics and readiness port | `2000` |
| `metrics.service.enabled` | Create a metrics Service | `false` |
| `metrics.service.type` | Metrics Service type | `ClusterIP` |
| `metrics.service.clusterIP` | Metrics Service cluster IP | `""` |
| `metrics.service.annotations` | Metrics Service annotations | `{}` |
| `metrics.service.labels` | Metrics Service labels | `{}` |
| `metrics.service.internalTrafficPolicy` | Internal traffic policy | `Cluster` |
| `metrics.service.sessionAffinity` | Session affinity | `None` |
| `metrics.service.sessionAffinityConfig` | Session affinity configuration | `{}` |
| `metrics.service.ipFamilyPolicy` | IP family policy | `""` |
| `metrics.service.ipFamilies` | IP families | `[]` |
| `metrics.service.extraPorts` | Additional Service ports | `[]` |

### Workload parameters

| Name | Description | Default |
| --- | --- | --- |
| `updateStrategy` | Deployment update strategy | `RollingUpdate` |
| `extraEnvVars` | Additional container environment variables | `[]` |
| `extraEnvVarsCM` | ConfigMap imported as environment variables | `""` |
| `extraEnvVarsSecret` | Secret imported as environment variables | `""` |
| `extraVolumes` | Additional pod volumes | `[]` |
| `extraVolumeMounts` | Additional connector volume mounts | `[]` |
| `initContainers` | Additional init containers | `[]` |
| `sidecars` | Additional sidecar containers | `[]` |
| `resourcesPreset` | Common resource preset | `nano` |
| `resources` | Explicit resource requests and limits | `{}` |
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

### Probe and security parameters

| Name | Description | Default |
| --- | --- | --- |
| `livenessProbe.enabled` | Enable the liveness probe | `true` |
| `readinessProbe.enabled` | Enable the readiness probe | `true` |
| `customLivenessProbe` | Complete liveness probe override | `{}` |
| `customReadinessProbe` | Complete readiness probe override | `{}` |
| `podSecurityContext` | Pod security context | See `values.yaml` |
| `containerSecurityContext` | Connector security context | See `values.yaml` |
| `serviceAccount.create` | Create a ServiceAccount | `true` |
| `serviceAccount.name` | ServiceAccount name | `""` |
| `serviceAccount.automountServiceAccountToken` | Mount API credentials on the ServiceAccount | `false` |
| `serviceAccount.annotations` | ServiceAccount annotations | `{}` |
| `automountServiceAccountToken` | Mount API credentials in connector pods | `false` |

