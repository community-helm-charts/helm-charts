# Cloudflared Helm Chart Design

## Goal

Add a repository-native `cloudflared` Helm chart that runs a remotely managed
Cloudflare Tunnel connector in Kubernetes. The chart deploys only the connector
workload and supporting Kubernetes resources. Public hostnames, origin services,
and other tunnel routes remain managed in Cloudflare through the dashboard, API,
or Terraform and are not represented in Helm values.

The design follows Cloudflare's Kubernetes deployment guidance: use one
Deployment with multiple replicas of the same tunnel for availability, inject a
tunnel token from a Secret, expose the built-in metrics endpoint, and use its
`/ready` endpoint for health checks.

## Chart Metadata and Repository Integration

Create `charts/cloudflared` as an application chart at version `1.0.0` with
`appVersion: "2026.7.2"`. The default image is
`docker.io/cloudflare/cloudflared:2026.7.2`, the image annotation records the
same immutable tag, and the license annotation is Apache-2.0.

The chart depends on the repository's local `common` chart through
`repository: file://../common` at version `0.2.1`. It uses common helpers for
names, namespaces, labels, image rendering, image pull secrets, resource
presets, security contexts, and templated user-supplied values.

Standard repository values include global image overrides, name and namespace
overrides, common labels and annotations, `extraDeploy`, pod metadata,
scheduling, resources, security contexts, container extensions, and
ServiceAccount configuration.

## Authentication

The connector always uses a remotely managed tunnel token. Authentication
values have this shape:

```yaml
auth:
  tunnelToken: ""
  existingSecret: ""
  existingSecretKey: token
```

When `auth.existingSecret` is empty, the chart creates an Opaque Secret named
`<fullname>` with the key `token` populated from `auth.tunnelToken`. The Secret
template rejects an empty token. The Deployment injects the key as
`TUNNEL_TOKEN` through `secretKeyRef`; the token is never rendered in the
container command or arguments.

When `auth.existingSecret` is non-empty, it takes priority. The chart does not
create a Secret, ignores `auth.tunnelToken`, and reads
`auth.existingSecretKey` from the named Secret. Rendering fails when the key
name is empty.

The managed Secret checksum is recorded on the pod template so a token change
through Helm triggers a rollout. Externally managed Secret updates do not
restart containers that consume the token through an environment variable, so
the README provides an explicit `kubectl rollout restart deployment` command.

Passing `auth.tunnelToken` through Helm stores the value in Helm release
metadata. The README recommends an existing Secret when operators do not want
the token retained in release values.

## Connector Deployment

The chart creates one Deployment with `replicaCount: 2` by default. Both pods
run the same tunnel token, providing connector redundancy without creating
additional tunnels. Autoscaling is not included because Cloudflare recommends
fixed replicas and warns that downscaling interrupts connections.

Unless users provide full `command` or `args` overrides, the container runs:

```text
cloudflared tunnel --no-autoupdate --loglevel info --metrics 0.0.0.0:2000 run
```

The default command is an explicit list whose log level and metrics port come
from `tunnel.logLevel` and `metrics.port`. `tunnel.extraArgs` is inserted before
`run` for additional supported tunnel run parameters. A non-empty `command`
replaces the image entrypoint, and a non-empty `args` replaces the complete
generated argument list.

The container declares a named TCP port `metrics` on port `2000`. Liveness and
readiness probes are enabled by default and call `/ready` on that named port.
Both probes expose the normal timing and threshold values and support complete
custom overrides.

The Deployment supports a configurable rolling update strategy, pod labels and
annotations, priority class, scheduler, termination grace period, host aliases,
affinity, node selector, tolerations, topology spread constraints, resources,
extra environment variables, ConfigMap and Secret environment imports, extra
volumes and mounts, init containers, and sidecars.

`resourcesPreset` defaults to `nano`; explicit `resources` take priority.

## Security Defaults

The ServiceAccount is created by default and does not automount Kubernetes API
credentials. The pod also disables API credential automount explicitly. No
Kubernetes API permissions are required.

The pod security context is enabled and configures the safe sysctl required by
Cloudflare's Kubernetes example:

```yaml
sysctls:
  - name: net.ipv4.ping_group_range
    value: "65532 65532"
```

The container security context is enabled with UID and GID `65532`,
`runAsNonRoot: true`, privilege escalation disabled, all Linux capabilities
dropped, and the runtime-default seccomp profile. The root filesystem remains
writable by default for compatibility with future cloudflared behavior, while
the entire security context can be overridden.

## Metrics Service

The metrics endpoint is directly available on each connector pod for probes.
An optional ClusterIP Service is disabled by default and exposes only the
`metrics` port when `metrics.service.enabled` is true. It supports annotations,
labels, cluster IP, traffic policies, session affinity, IP family settings, and
extra ports following repository conventions.

The chart does not create a monitoring-specific custom resource. Monitoring
systems can discover the optional Service through user-provided annotations or
other separately managed resources.

## Additional Resources and Notes

The chart renders top-level `extraDeploy` objects through the common helper.

`NOTES.txt` reports the Deployment rollout command, commands to inspect
connector pods and logs, and the metrics Service address when it is enabled. It
also reminds users that tunnel routing is managed remotely.

## Validation and Failure Behavior

Helm rendering fails with actionable messages when:

- neither a non-empty managed token nor an existing Secret is configured;
- an existing Secret is selected with an empty key name;
- `replicaCount` is not an integer greater than or equal to one; or
- `metrics.port` is not an integer from 1 through 65535.

Kubernetes validates user-supplied extension objects, scheduling values, and
security context overrides. If the tunnel token is invalid or Cloudflare is
unreachable, the `/ready` endpoint stays unhealthy, the pod remains NotReady,
and connector logs expose the cloudflared error. Liveness failures restart the
container according to Kubernetes probe policy.

## Documentation

`charts/cloudflared/README.md` documents:

- prerequisites and creation of a remotely managed tunnel;
- installation with a chart-managed token;
- installation with an existing Secret;
- the Helm release metadata implication of passing a token through values;
- Cloudflare-managed route configuration using Kubernetes Service DNS names;
- fixed replica availability behavior;
- health probes and optional metrics Service;
- external Secret rotation and the required Deployment restart; and
- image, resources, security, scheduling, and extension values.

The chart also includes `.helmignore` and an initial `CHANGELOG.md`.

## Testing

Add `tests/cloudflared-chart.test.js` following the repository's Node test
pattern. It copies the chart into a temporary directory, packages the local
common dependency, and renders the result with `helm template`.

The suite verifies:

- chart metadata, exact default image, and local common dependency version;
- a managed-token render creates one Deployment, Secret, and ServiceAccount;
- the default Deployment has two replicas and the expected command, token
  `secretKeyRef`, metrics port, probes, API-token automount policy, sysctl, and
  non-root container security context;
- an existing Secret suppresses the managed Secret and references the selected
  key without a managed Secret checksum;
- managed token changes affect the pod template checksum without exposing the
  token in container arguments;
- custom image, log level, metrics port, probes, resources, scheduling, pod
  extensions, and full command or argument overrides render correctly;
- the optional metrics Service renders only when enabled and targets the named
  metrics port;
- every invalid configuration described above fails with its documented
  message; and
- README contains the required credential, remote-routing, availability,
  metrics, and Secret-rotation guidance.

Final verification runs the focused Node test, `helm lint` with a test token,
the complete repository `pnpm test` suite, and a clean chart package operation.

## Out of Scope

- Creating, deleting, or reconfiguring Cloudflare Tunnel resources.
- Watching Kubernetes objects or reconciling routes.
- Locally managed tunnel credentials or configuration files.
- Autoscaling and monitoring-specific custom resources.
- Installing the chart into a live Kubernetes cluster.
