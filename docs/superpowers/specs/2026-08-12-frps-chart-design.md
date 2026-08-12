# FRP Server Helm Chart Design

## Goal

Add a repository-native `frps` Helm chart that runs one FRP server in
Kubernetes using `ghcr.io/fatedier/frps:v0.70.1`. Operators configure the
server through structured `config.*` Helm values. The chart converts those
values to `/etc/frp/frps.toml`, mounts token authentication from a Kubernetes
Secret at `/etc/frp/token`, and exposes FRP control traffic separately from
HTTP and HTTPS virtual-host traffic.

The chart is intentionally single-instance. FRP v0.70.1 keeps client control
connections, proxy registrations, and work-connection state in one `frps`
process and does not provide multi-server state coordination. Placing ordinary
replicas behind one Service would therefore be unsafe.

## Chart Metadata and Repository Integration

Create `charts/frps` as an application chart at version `1.0.0` with
`appVersion: "v0.70.1"`. The image annotation and default image both use
`ghcr.io/fatedier/frps:v0.70.1`. The chart records the upstream Apache-2.0
license and links to both this chart's repository path and
`https://github.com/fatedier/frp`.

The chart depends on the repository's local `common` chart through
`repository: file://../common` at version `0.2.1`. It uses common helpers for
names, namespaces, labels, image rendering, image pull secrets, resource
presets, security contexts, ingress compatibility, and templated user values.

Standard repository values include global image overrides, name and namespace
overrides, common labels and annotations, `extraDeploy`, pod metadata,
scheduling, resources, security contexts, container extensions, and
ServiceAccount configuration.

## Structured FRPS Configuration

The default configuration values are deliberately minimal:

```yaml
config:
  bindPort: 7000
  vhostHTTPPort: 8080
  vhostHTTPSPort: 8443
```

`config` accepts arbitrary FRP server fields and nested YAML structures. The
chart deep-copies the map, injects its managed authentication configuration,
and passes the result to Helm's `toToml` function. This supports scalar fields,
nested tables, arrays, arrays of objects, and constructs such as:

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

The generated TOML is stored as `frps.toml` in a ConfigMap and mounted read-only
at `/etc/frp/frps.toml`. The container runs `frps -c /etc/frp/frps.toml` unless
the user supplies complete command or argument overrides. A ConfigMap checksum
on the pod template causes configuration changes to replace the pod.

The three default port fields are also the only source for the Deployment
container ports, Services, and default probes. The chart does not duplicate
these ports under Service or probe values.

## Token Authentication

The chart always configures FRP's token authentication and uses the official
v0.70.1 file-backed token source:

```toml
[auth]
method = "token"

[auth.tokenSource]
type = "file"

[auth.tokenSource.file]
path = "/etc/frp/token"
```

Authentication values have this shape:

```yaml
auth:
  token: ""
  existingSecret: ""
  existingSecretKey: token
```

When `auth.existingSecret` is empty, the chart creates an Opaque Secret with
the configured `auth.token` under the `token` key. The Secret key is mounted
read-only as the single file `/etc/frp/token`. A checksum of the managed Secret
is added to the pod template so a Helm-managed token change replaces the pod.

When `auth.existingSecret` is non-empty, it takes priority. The chart does not
create a Secret, ignores `auth.token`, and mounts `auth.existingSecretKey` from
the selected Secret at the same path. Externally managed Secret content cannot
be included in a Helm checksum. The single-file `subPath` mount also does not
receive live Secret updates, and `frps` reads authentication configuration at
startup, so the README instructs operators to restart the Deployment after an
external token rotation.

Passing `auth.token` through Helm stores the value in Helm release metadata.
The README recommends an existing Secret when operators do not want token
material retained in release values.

The chart owns the authentication portion of `frps.toml`. Users may not set
`config.auth.token` or `config.auth.tokenSource`. `config.auth.method` may be
omitted or set to `token`; any other method is rejected. The rendered
configuration always contains `method = "token"` and the file token source.

## Deployment and Pod

The chart creates one Deployment with a literal `replicas: 1`; there is no
`replicaCount` value. Its update strategy is fixed to `Recreate` and is not
user-configurable. This prevents a rolling update from temporarily running two
independent FRP servers behind the same Services.

The container declares named TCP ports for `bind`, `vhost-http`, and
`vhost-https`. Default liveness and readiness probes use a TCP socket against
the named `bind` port. Both probes expose the normal timing and threshold
values and support complete custom overrides.

The Deployment supports full `command` and `args` overrides, extra environment
variables, ConfigMap and Secret environment imports, extra volumes and mounts,
init containers, sidecars, pod labels and annotations, priority class,
scheduler, termination grace period, host aliases, affinity, node selector,
tolerations, topology spread constraints, and explicit resources or a common
resource preset. `resourcesPreset` defaults to `nano`; explicit `resources`
take priority.

The ServiceAccount is created by default and does not automount Kubernetes API
credentials. The pod also disables credential automount explicitly. The
container security context defaults to non-root execution, privilege
escalation disabled, a read-only root filesystem, all Linux capabilities
dropped, and the runtime-default seccomp profile. Security contexts remain
overridable for image or platform compatibility. The ConfigMap and Secret are
mounted read-only as separate files under `/etc/frp`, so neither volume masks
the other:

```text
/etc/frp/
├── frps.toml
└── token
```

## External FRP Service

The primary Service is named with the chart fullname and defaults to type
`LoadBalancer`. It exposes only `config.bindPort` by default as a TCP port named
`bind`, allowing `frpc` instances to connect to `frps`.

`service.extraPorts` appends explicit Kubernetes Service ports for operators
who need to expose TCP or UDP proxy ports, KCP, QUIC, TCP multiplexing, or other
FRP listeners. These entries follow the native Kubernetes `ServicePort` shape.
The Service additionally supports repository-standard annotations, labels,
cluster IP, internal and external traffic policies, load balancer settings,
session affinity, node port for the bind port, and IP family settings.

The chart cannot discover client-selected proxy ports dynamically. Operators
must declare every externally reachable proxy port through
`service.extraPorts` and configure the corresponding field in FRP where
applicable.

## Internal Virtual-Host Service

A second Service named `<fullname>-vhost` defaults to `ClusterIP`. It always
exposes two TCP ports:

- `http`, sourced from `config.vhostHTTPPort` and defaulting to `8080`;
- `https`, sourced from `config.vhostHTTPSPort` and defaulting to `8443`.

The Service is intended for cluster-internal consumers and as the backend for
Ingress. It does not support extra ports. It supports annotations, labels,
cluster IP, internal traffic policy, session affinity, and IP family settings.

## Ingress

An optional Ingress is disabled by default. When enabled, it routes HTTP paths
to the `http` port of `<fullname>-vhost`; it never routes to the HTTPS port.
TLS termination belongs to the Ingress controller. Operators needing TLS or
TCP passthrough to the FRP HTTPS listener must configure that separately in
their ingress controller.

Ingress values follow the repository's existing shape and include ingress
class name, hostname, path, path type, annotations, TLS enablement, extra hosts,
extra paths, extra TLS entries, and optional generated TLS Secrets.

## Validation and Failure Behavior

Helm rendering fails with actionable messages when:

- neither a non-empty managed token nor an existing Secret is configured;
- an existing Secret is selected with an empty key name;
- `config` is not a map;
- `config.bindPort`, `config.vhostHTTPPort`, or `config.vhostHTTPSPort` is not
  an integer from 1 through 65535;
- the three required ports contain duplicate values;
- `config.auth` is not a map when present;
- `config.auth.token` or `config.auth.tokenSource` is set; or
- `config.auth.method` is set to a value other than `token`.

The two token inputs may both be present; `auth.existingSecret` wins and the
chart does not render the managed token. Kubernetes validates user-supplied
Service ports, ingress extensions, pod extensions, scheduling values, and
security context overrides.

If `frps` rejects the generated configuration or cannot read the Secret file,
the container exits and its logs expose the error. If the bind listener is not
healthy, TCP probes keep the pod NotReady and restart it according to the
liveness probe policy.

## Additional Resources and Notes

The chart renders top-level `extraDeploy` objects through the common helper.
`NOTES.txt` reports the external FRP endpoint, internal vhost endpoints,
Ingress hostname when enabled, commands to inspect the pod and logs, and the
external Secret restart requirement.

The chart includes `.helmignore`, an initial `CHANGELOG.md`, and a generated
parameter reference in `README.md` matching repository conventions.

## Documentation

`charts/frps/README.md` documents:

- installation with a chart-managed token;
- installation with an existing Secret;
- the Helm release metadata implication of passing a token through values;
- structured `config.*` conversion to TOML, including nested examples;
- reserved authentication fields and file-backed token injection;
- fixed single-instance and `Recreate` behavior;
- the external bind Service and explicit proxy-port declarations;
- the internal HTTP/HTTPS vhost Service;
- optional HTTP Ingress and its TLS-termination behavior;
- external Secret rotation and the required Deployment restart; and
- image, probes, resources, security, scheduling, and pod extension values.

## Testing

Add `tests/frps-chart.test.js` following the repository's Node test pattern. It
copies the chart into a temporary directory, packages the local common
dependency, and renders the result with `helm template`.

The suite verifies:

- chart metadata, exact default image, and local common dependency version;
- default values render valid TOML with all three ports and the injected
  file-backed token source;
- nested tables, arrays, and arrays of objects convert correctly;
- the Deployment has one replica, uses `Recreate`, runs the expected config
  path, exposes all three named ports, and mounts ConfigMap and Secret files at
  the documented paths;
- probes, API credential automount policy, resources, and default container
  security settings;
- managed and existing Secret authentication paths, precedence, and pod
  checksums without exposing token material in the ConfigMap or pod spec;
- the external LoadBalancer Service, its bind port, and arbitrary extra TCP or
  UDP Service ports;
- the internal ClusterIP vhost Service and its fixed HTTP and HTTPS ports;
- Ingress is absent by default and targets only the vhost HTTP port when
  enabled;
- common labels, annotations, image overrides, probes, resources, scheduling,
  pod extensions, ServiceAccount settings, and `extraDeploy`;
- every invalid configuration described above fails with its documented
  message; and
- README contains the required authentication, networking, single-instance,
  Ingress, rotation, and structured configuration guidance.

Final verification runs the focused Node test, `helm lint` with a test token,
the complete repository `pnpm test` suite, and a clean chart package operation.

## Out of Scope

- Running multiple coordinated `frps` instances or horizontal autoscaling.
- Automatically discovering or exposing proxy ports selected by clients.
- Creating `frpc` resources or managing client configurations.
- Supporting OIDC authentication in this initial chart.
- Providing ingress-controller-specific TCP or TLS passthrough resources.
- Installing the chart into a live Kubernetes cluster.
