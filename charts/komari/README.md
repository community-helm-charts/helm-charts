# Komari

This chart deploys the [Komari](https://github.com/komari-monitor/komari)
monitoring server and, optionally, the
[Komari Agent](https://github.com/komari-monitor/komari-agent) on Kubernetes.

The default installation contains a single stateful server. The Agent is an
opt-in DaemonSet and can be installed with the server or as an Agent-only
release.

## Images

| Component | Default image |
| --- | --- |
| Server | `ghcr.io/komari-monitor/komari:1.3.2` |
| Agent | `ghcr.io/komari-monitor/komari-agent:1.2.60` |

Both tags are pinned for reproducible upgrades. Override the corresponding
`server.image.*` or `agent.image.*` values to use another release.

## Install

### Server only

The server is enabled and the Agent is disabled by default:

```bash
helm install komari ./charts/komari
```

The server runs as a one-replica StatefulSet, listens on port `25774`, and
stores data in `/app/data`.

### Server and Agent

For a quick test, let the chart create the auto-discovery Secret:

```bash
helm install komari ./charts/komari \
  --set agent.enabled=true \
  --set-string agent.auth.autoDiscoveryKey='replace-with-key'
```

When both components are in one release and `agent.endpoint` is empty, the
Agent uses the in-cluster server URL:

```text
http://<release-name>-komari-server:25774
```

With the release name from the example above, the generated URL is
`http://komari-server:25774`.

Helm stores chart-managed values in the release record. For production, prefer
an existing Secret:

```bash
kubectl create secret generic komari-discovery \
  --from-literal=auto-discovery-key='replace-with-key'

helm install komari ./charts/komari \
  --set agent.enabled=true \
  --set agent.auth.existingSecret=komari-discovery
```

The DaemonSet injects the key through the official
`AGENT_AUTO_DISCOVERY_KEY` environment variable. The key is not placed in the
container command or arguments.

### Agent only

Disable the server and provide an externally reachable endpoint:

```bash
helm install komari-agent ./charts/komari \
  --set server.enabled=false \
  --set agent.enabled=true \
  --set agent.endpoint=https://monitor.example.com \
  --set agent.auth.existingSecret=komari-discovery
```

Rendering fails if Agent-only mode has no `agent.endpoint`.

## Server persistence

Persistence is enabled by default:

```yaml
server:
  persistence:
    enabled: true
    size: 5Gi
    accessModes:
      - ReadWriteOnce
```

The StatefulSet creates a claim template and mounts it at `/app/data`.
`server.persistence.storageClassName` overrides the global StorageClass.
When it is empty, the chart resolves `global.defaultStorageClassName` and the
compatibility value `global.storageClassName` through the common library.

Use an existing PVC:

```yaml
server:
  persistence:
    existingClaim: komari-data
```

Use temporary storage:

```yaml
server:
  persistence:
    enabled: false
```

Disabling persistence creates an `emptyDir`; all Komari configuration and
history are lost when the pod is replaced.

The server intentionally remains one replica. The default SQLite database and
local data directory must not be scaled horizontally without an external
database design.

## Agent identity persistence

Auto-discovery returns a UUID and Agent token. Komari Agent stores them in
`/app/auto-discovery.json`. By default, the chart persists that file on each
node at:

```text
/opt/komari/auto-discovery.json
```

The DaemonSet uses a `DirectoryOrCreate` hostPath and a built-in init container
to create the file before mounting it with `subPath`. A replacement pod on the
same node therefore reuses the same Komari identity.

Clusters that prohibit hostPath can use temporary identity storage:

```yaml
agent:
  persistence:
    type: emptyDir
```

With `emptyDir`, pod replacement discards the UUID and token and causes another
auto-discovery registration.

Do not run a native Komari Agent and this DaemonSet concurrently on the same
node when both use `/opt/komari/auto-discovery.json`. They would connect with
the same identity.

## Agent disk monitoring

The Agent limits disk statistics to the container root by default:

```yaml
agent:
  includeMountpoints: "/"
```

The container root and the identity file's hostPath `subPath` expose the same
node root filesystem under different device names. Automatic mount discovery
would count `/` and `/app/auto-discovery.json` separately, doubling both total
and used disk space. The chart injects the official
`AGENT_INCLUDE_MOUNTPOINTS=/` setting to count the root filesystem once.

Use a semicolon-delimited string when additional filesystems are deliberately
mounted into the Agent container:

```yaml
agent:
  includeMountpoints: "/;/data"
```

Set `agent.includeMountpoints` to an empty string to restore the Agent's
automatic mountpoint discovery.

## Agent scheduling

The Agent shares each node's network namespace by default:

```yaml
agent:
  hostNetwork: true
  dnsPolicy: ClusterFirstWithHostNet
```

Komari reads network counters from its process network namespace. Host
networking therefore lets the DaemonSet report node interfaces and traffic
instead of only the pod's `eth0`. `ClusterFirstWithHostNet` keeps Kubernetes
Service discovery available, including the derived
`http://komari-server:25774` endpoint.

To deliberately monitor the pod network instead, override both values:

```yaml
agent:
  hostNetwork: false
  dnsPolicy: ClusterFirst
```

The Agent tolerates all taints by default so the DaemonSet can cover every
schedulable node, matching common node-monitoring deployments:

```yaml
agent:
  tolerations:
    - operator: Exists
```

Replace the toleration list and add a selector to restrict placement:

```yaml
agent:
  nodeSelector:
    monitoring: "true"
  tolerations:
    - key: dedicated
      operator: Equal
      value: monitoring
      effect: NoSchedule
```

The chart does not create an Agent Service.

## Agent updates and extra configuration

`agent.disableAutoUpdate` defaults to `true`, which injects:

```text
AGENT_DISABLE_AUTO_UPDATE=true
```

Container images and Helm upgrades own the Agent version. This avoids replacing
the binary inside a running container and losing that replacement on restart.

Additional official Agent options can be supplied through
`agent.extraEnvVars`, for example:

```yaml
agent:
  extraEnvVars:
    - name: AGENT_DISABLE_WEB_SSH
      value: "true"
    - name: AGENT_INTERVAL
      value: "5"
    - name: AGENT_EXCLUDE_NICS
      value: "lo,docker0"
```

`agent.extraEnvVarsCM` and `agent.extraEnvVarsSecret` import complete
ConfigMaps or Secrets. `agent.command` and `agent.args` override the image
entrypoint arguments for advanced use.

## Exposing the server

The Service defaults to `ClusterIP` on port `25774`. Use port forwarding:

```bash
kubectl port-forward svc/komari-server 25774:25774
```

Then open `http://127.0.0.1:25774`.

Enable Ingress:

```yaml
server:
  ingress:
    enabled: true
    hostname: monitor.example.com
    ingressClassName: nginx
    tls: true
```

The Ingress supports extra hosts, paths, rules, TLS entries, and chart-managed
TLS Secrets. The Service supports ClusterIP, NodePort, and LoadBalancer
settings.

## Security and extensibility

Kubernetes API token automount is disabled by default for both components.
Pod and container security contexts are configurable independently:

```yaml
server:
  podSecurityContext:
    enabled: true
    fsGroup: 1000
  containerSecurityContext:
    enabled: true
    runAsUser: 1000
    runAsGroup: 1000
    runAsNonRoot: true

agent:
  containerSecurityContext:
    enabled: false
```

The Agent defaults to the image's root user because it must create the
per-node hostPath identity file. If a pre-provisioned directory has compatible
ownership, a stricter Agent security context can be enabled.

Both components support:

- Explicit resources or a common resource preset.
- Pod labels and annotations.
- Affinity, node selectors, tolerations, and topology spread constraints.
- Priority class, scheduler, host aliases, and termination grace period.
- Extra volumes, mounts, init containers, and sidecars.
- Component-specific image pull Secrets combined with global image settings.

`extraDeploy` renders additional objects that belong to the Helm release.

## Important values

### Global and common

| Value | Default | Description |
| --- | --- | --- |
| `global.imageRegistry` | `""` | Global image registry override |
| `global.imagePullSecrets` | `[]` | Global image pull Secrets |
| `global.defaultStorageClassName` | `""` | Default PVC StorageClass |
| `nameOverride` | `""` | Partial chart name override |
| `fullnameOverride` | `""` | Full release resource-name override |
| `namespaceOverride` | `""` | Resource namespace override |
| `commonLabels` | `{}` | Labels added to chart resources |
| `commonAnnotations` | `{}` | Annotations added to chart resources |
| `extraDeploy` | `[]` | Additional templated resources |

### Server

| Value | Default | Description |
| --- | --- | --- |
| `server.enabled` | `true` | Deploy the server |
| `server.image.registry` | `ghcr.io` | Server image registry |
| `server.image.repository` | `komari-monitor/komari` | Server image repository |
| `server.image.tag` | `1.3.2` | Server image tag |
| `server.containerPorts.http` | `25774` | Server container port |
| `server.service.enabled` | `true` | Create the server Service |
| `server.service.type` | `ClusterIP` | Service type |
| `server.service.ports.http` | `25774` | Service port |
| `server.ingress.enabled` | `false` | Create the server Ingress |
| `server.ingress.hostname` | `komari.local` | Main Ingress host |
| `server.persistence.enabled` | `true` | Persist server data |
| `server.persistence.mountPath` | `/app/data` | Server data path |
| `server.persistence.size` | `5Gi` | Requested storage |
| `server.persistence.existingClaim` | `""` | Existing PVC name |
| `server.resourcesPreset` | `none` | Common resource preset |
| `server.resources` | `{}` | Explicit resource requests and limits |
| `server.startupProbe.enabled` | `false` | Enable startup checks |
| `server.livenessProbe.enabled` | `true` | Enable liveness checks |
| `server.readinessProbe.enabled` | `true` | Enable readiness checks |
| `server.serviceAccount.create` | `true` | Create the server ServiceAccount |
| `server.automountServiceAccountToken` | `false` | Mount API credentials in the server pod |

### Agent

| Value | Default | Description |
| --- | --- | --- |
| `agent.enabled` | `false` | Deploy the Agent DaemonSet |
| `agent.image.registry` | `ghcr.io` | Agent image registry |
| `agent.image.repository` | `komari-monitor/komari-agent` | Agent image repository |
| `agent.image.tag` | `1.2.60` | Agent image tag |
| `agent.endpoint` | `""` | External endpoint or automatic in-release endpoint |
| `agent.disableAutoUpdate` | `true` | Disable in-container binary updates |
| `agent.auth.autoDiscoveryKey` | `""` | Key placed in the chart-managed Secret |
| `agent.auth.existingSecret` | `""` | Existing auto-discovery Secret |
| `agent.auth.existingSecretKey` | `auto-discovery-key` | Key within the existing Secret |
| `agent.persistence.type` | `hostPath` | `hostPath` or `emptyDir` identity volume |
| `agent.persistence.hostPath` | `/opt/komari` | Per-node identity directory |
| `agent.persistence.fileName` | `auto-discovery.json` | Identity filename |
| `agent.persistence.mountPath` | `/app/auto-discovery.json` | Container identity path |
| `agent.tolerations` | `[{operator: Exists}]` | DaemonSet tolerations |
| `agent.resourcesPreset` | `none` | Common resource preset |
| `agent.resources` | `{}` | Explicit resource requests and limits |
| `agent.serviceAccount.create` | `true` | Create the Agent ServiceAccount |
| `agent.automountServiceAccountToken` | `false` | Mount API credentials in Agent pods |

See [`values.yaml`](values.yaml) for every Service, Ingress, probe, security,
scheduling, and extension field.

## Uninstall

```bash
helm uninstall komari
```

StatefulSet PVCs and node files under `/opt/komari` are not automatically
deleted. Remove retained data only after confirming it is no longer needed.
