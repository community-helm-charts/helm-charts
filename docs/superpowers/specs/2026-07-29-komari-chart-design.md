# Komari Helm Chart Design

## Goal

Add a production-oriented `komari` chart that can deploy the Komari server and
the Komari Agent from one Helm release.

- The server is enabled by default.
- The Agent is disabled by default.
- The server runs as a single-replica StatefulSet.
- The Agent runs as a DaemonSet on every schedulable node, including tainted
  nodes.
- Either component can be deployed independently.

## Chart Structure

Create `charts/komari` as one application chart with two independently
configurable components:

- `server.*` owns the StatefulSet, Service, optional Ingress, persistence,
  probes, server image, ServiceAccount, resources, security, and scheduling.
- `agent.*` owns the DaemonSet, auto-discovery credentials, identity
  persistence, Agent image, ServiceAccount, resources, security, and
  scheduling.

Both components use the repository's `common` library chart version `0.2.1`.
Their selectors and pod labels include distinct
`app.kubernetes.io/component: server` and
`app.kubernetes.io/component: agent` labels so the workloads cannot select
each other's pods.

The initial chart version is `1.0.0`. The default images pin the current stable
releases:

- Server: `ghcr.io/komari-monitor/komari:1.3.2`
- Agent: `ghcr.io/komari-monitor/komari-agent:1.2.60`

The chart `appVersion` is `1.3.2`, matching the primary server component.
Users can override either image tag, including choosing `latest`, but the
defaults remain reproducible.

## Server Component

`server.enabled` defaults to `true`.

The server workload is a StatefulSet with exactly one replica. The chart does
not expose a replica-count setting because the default SQLite-backed Komari
server and its local data directory are not designed for unsupervised
horizontal scaling.

The container:

- Listens on named port `http` at `25774`.
- Mounts the data volume at `/app/data`.
- Supports command and argument overrides.
- Supports additional environment variables, ConfigMap and Secret environment
  imports, volumes, mounts, init containers, and sidecars.
- Supports configurable pod and container security contexts.
- Supports explicit resources or a common resource preset.

The StatefulSet supports configurable update strategy, pod labels and
annotations, priority class, scheduler, termination grace period, host aliases,
affinity, node selector, tolerations, and topology spread constraints.

### Service and Ingress

The server Service:

- Is enabled by default.
- Defaults to `ClusterIP`.
- Exposes TCP port `25774` and targets the container's named `http` port.
- Supports NodePort, LoadBalancer, annotations, labels, traffic policies,
  session affinity, IP family settings, and extra ports following existing
  repository conventions.

Ingress is disabled by default and is rendered only when both the server and
server Service are enabled. It follows the repository's Bitnami-style ingress
shape: hostname, path, path type, ingress class, annotations, TLS, extra hosts,
extra paths, extra rules, and user-supplied TLS Secrets.

### Server Persistence

Server persistence is enabled by default. A StatefulSet
`volumeClaimTemplates` entry creates one PVC and mounts it at `/app/data`.

The default claim uses:

- Volume name `data`.
- Access mode `ReadWriteOnce`.
- Capacity `5Gi`.
- The global or component StorageClass resolution provided by the common
  library.

The persistence configuration supports annotations, labels, selector,
dataSource, subPath, and an existing claim. When an existing claim is named,
the StatefulSet mounts it instead of creating a claim template. When
persistence is disabled, the StatefulSet uses `emptyDir`.

### Server Health Checks

The chart provides configurable HTTP startup, liveness, and readiness probes
against the named `http` port. Startup may be disabled by default; liveness
and readiness are enabled by default. Each probe supports a complete custom
override so users can adapt to future Komari health endpoints without changing
the chart.

## Agent Component

`agent.enabled` defaults to `false`.

When enabled, the chart creates a DaemonSet. It does not create a Service. The
default tolerations are:

```yaml
tolerations:
  - operator: Exists
```

This matches the requested kube-prometheus-style node coverage by tolerating
all node taints. Users can replace the list to restrict scheduling. The Agent
also supports configurable update strategy, pod labels and annotations,
priority class, scheduler, termination grace period, host aliases, affinity,
node selector, topology spread constraints, resources, security contexts,
additional environment variables and environment imports, extra volumes and
mounts, extra init containers, and sidecars.

The Agent container receives supported Komari configuration through official
environment variables:

- `AGENT_ENDPOINT` for the server URL.
- `AGENT_AUTO_DISCOVERY_KEY` from a Kubernetes Secret.
- `AGENT_DISABLE_AUTO_UPDATE=true` by default.

Container self-update is disabled because Kubernetes image tags and Helm
upgrades own the Agent lifecycle. Other Agent settings can be supplied through
the generic environment-variable extension points.

### Agent Endpoint

Endpoint selection follows these rules:

1. A non-empty `agent.endpoint` is used verbatim after Helm template
   evaluation.
2. If `agent.endpoint` is empty and the server and its Service are enabled in
   the same release, the chart uses
   `http://<server-service-name>:<server-service-port>`.
3. If the Agent is enabled but neither an explicit endpoint nor an enabled
   in-release server Service is available, template rendering fails with an
   actionable message.

This allows a combined release to work without duplicating its own internal
address while keeping Agent-only installations explicit.

### Agent Auto-Discovery Secret

The auto-discovery key is required whenever the Agent is enabled.

The chart supports two modes:

- A chart-managed Secret populated from `agent.auth.autoDiscoveryKey`.
- An existing Secret selected by `agent.auth.existingSecret` and
  `agent.auth.existingSecretKey`.

The managed key defaults to an empty string. Rendering fails when the Agent is
enabled and neither a non-empty managed key nor a valid existing Secret
reference is configured. The key is injected through `secretKeyRef`; it is
never rendered into the DaemonSet command or arguments.

### Per-Node Agent Identity

Komari Agent stores the UUID and token returned by auto-discovery in
`auto-discovery.json` next to its executable. The container image executable is
`/app/komari-agent`, so the runtime file is `/app/auto-discovery.json`.

By default, each DaemonSet pod persists this file in the node directory
`/opt/komari`, matching the official native installer:

1. A `hostPath` volume uses `/opt/komari` with `DirectoryOrCreate`.
2. A built-in init container mounts the directory and creates
   `auto-discovery.json` when it does not exist.
3. The Agent container mounts that file at `/app/auto-discovery.json` with
   `subPath`.

The Agent reuses the same identity after pod recreation on the same node. The
host path is configurable. An `emptyDir` mode is available for clusters that
forbid hostPath; this mode deliberately loses the identity on pod replacement
and can cause another auto-discovery registration.

Operators must not run a native Komari Agent and the DaemonSet on the same node
using the same `/opt/komari/auto-discovery.json`, because both processes would
connect with one identity.

## Service Accounts and Image Pull Secrets

Server and Agent ServiceAccounts are independently configurable and are
created only for enabled components. Each supports a custom name, annotations,
and API-token automount policy. Workload token automount defaults to disabled.

Image pull secrets combine global and component image settings through the
common library. Server and Agent images can use different registries,
repositories, tags, digests, and pull policies.

## Additional Resources

The chart supports a top-level `extraDeploy` list rendered through the common
template helper. This is intentionally shared because these objects belong to
the release rather than either workload.

`NOTES.txt` reports:

- How to reach the server through ClusterIP port-forwarding, NodePort,
  LoadBalancer, or Ingress when the server is enabled.
- How to inspect Agent DaemonSet rollout and pods when the Agent is enabled.
- A clear message when one component is disabled.

## Validation and Failure Behavior

Helm rendering fails before installation when:

- The Agent is enabled without a managed auto-discovery key or an existing
  Secret.
- The Agent is enabled with an existing Secret but its key name is empty.
- The Agent is enabled without an explicit endpoint while the in-release
  server or server Service is disabled.
- A required server or Agent port value is not an integer from 1 through
  65535.
- An unsupported Agent identity volume type is selected.

Kubernetes handles process restart through StatefulSet and DaemonSet pod
policies. Server health probes prevent an unready server from receiving
Service traffic. Agent startup errors remain visible in pod status and logs;
the DaemonSet restarts failed Agent containers.

## Documentation

`charts/komari/README.md` documents:

- Server-only installation, which is the default.
- Combined Server and Agent installation.
- Agent-only installation with an external endpoint.
- Chart-managed and existing Secret credential modes.
- Stateful server storage, existing PVCs, and temporary storage.
- Per-node Agent identity storage and the native-Agent conflict warning.
- Default all-taint toleration and examples for restricting Agent placement.
- Image version overrides and the disabled Agent self-update policy.
- Common service, Ingress, resources, security, scheduling, and extension
  values.

The chart also includes `.helmignore` and an initial `CHANGELOG.md`.

## Testing

Add a repository Node test suite that packages the local common dependency and
renders the chart with Helm.

The suite verifies:

- Chart metadata, stable image versions, and local common dependency version.
- Default rendering creates one server StatefulSet, Service, server
  ServiceAccount, and claim template while creating no Agent resources.
- Server persistence uses `/app/data`, supports global StorageClass,
  existingClaim, and `emptyDir`.
- Server Service, Ingress, probes, custom probes, image settings, and
  scheduling values render correctly.
- Enabling the Agent creates one DaemonSet, Agent ServiceAccount, and managed
  Secret.
- The combined release derives the internal server endpoint.
- The Agent DaemonSet injects the auto-discovery key with `secretKeyRef`,
  disables self-update, tolerates all taints, initializes and mounts the
  per-node identity file, and does not expose the key in arguments.
- Agent-only mode accepts an explicit external endpoint.
- Existing Secret mode suppresses the managed Secret and references the
  configured key.
- Agent `emptyDir` identity mode renders without hostPath.
- Disabled components do not leave orphaned ServiceAccounts, Secrets,
  Services, or workloads.
- Every invalid configuration described above fails with its documented
  message.
- README contains the required security, persistence, combined-release, and
  Agent-only guidance.

Final verification runs the chart-specific Node tests, `helm lint`, the full
repository `pnpm test` suite, and a clean chart package operation.

## Out of Scope

- Installing Komari into a live Kubernetes cluster.
- Creating or rotating the auto-discovery key in the Komari server.
- Running multiple server replicas or configuring an external database.
- Modifying the Komari server or Agent images.
- Sharing one Agent identity across nodes.
- Automatically migrating a natively installed Agent into the DaemonSet.
