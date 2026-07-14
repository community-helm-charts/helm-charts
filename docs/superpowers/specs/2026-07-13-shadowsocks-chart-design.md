# Shadowsocks Helm Chart Design

## Goal

Add a repository-native `shadowsocks` Helm chart that deploys
`ghcr.io/shadowsocks/ssserver-rust:v1.24.0` on every selected Kubernetes node.
The default installation listens on the host network at `[::]:8388`, supports
both TCP and UDP, and obtains its password from a Kubernetes Secret through an
environment variable.

## Chart Metadata and Repository Integration

The chart lives at `charts/shadowsocks` and starts at chart version `1.0.0` with
`appVersion: "v1.24.0"`. Its image annotation names
`ghcr.io/shadowsocks/ssserver-rust:v1.24.0`, and its license annotation is MIT.
It depends on the repository's local `common` chart using
`repository: file://../common` and version `0.2.1`, matching the current source
chart convention and dependency tests.

The chart uses `common` helpers for names, namespaces, labels, image rendering,
pull secrets, resources, security contexts, and templated user-supplied values.
It includes the same standard repository metadata and extension points used by
the other application charts: global image settings, name and namespace
overrides, common labels and annotations, `extraDeploy`, image pull settings,
pod labels and annotations, scheduling controls, resources, security contexts,
and ServiceAccount configuration.

## Configuration and Authentication

`values.yaml` exposes a `config` mapping whose keys and nested values map
directly to the root of the generated `config.json`. The defaults are:

```yaml
config:
  server: "::"
  server_port: 8388
  password: changeme
  method: aes-256-gcm
  fast_open: true
  mode: tcp_and_udp
```

Users may add any additional shadowsocks-rust configuration fields beneath
`config`, including nested maps or lists. The chart renders this mapping with
`toPrettyJson` into a chart-managed ConfigMap. `config.server_port` is also the
single source of truth for both container ports and default Service ports.

`config.password` is the only special configuration key. It supplies the
chart-managed Secret rather than being copied into the ConfigMap. After copying
the user configuration, the chart replaces this field with:

```json
"password": "${SHADOWSOCKS_PASSWORD}"
```

shadowsocks-rust expands the environment reference when it reads the file. The
DaemonSet defines `SHADOWSOCKS_PASSWORD` with `secretKeyRef`.

External Secret values use this shape:

```yaml
auth:
  existingSecret: ""
  existingSecretPasswordKey: password
```

With the defaults, the chart creates an Opaque Secret named
`<fullname>-secret`, containing the key `password` and the placeholder value
from `config.password`. The README prominently states that `changeme` must be
replaced for real deployments. When `auth.existingSecret` is non-empty, it has
priority: the chart does not create a Secret, ignores `config.password`, and the
DaemonSet reads `auth.existingSecretPasswordKey` from the named Secret instead.
The chart-managed Secret template rejects an empty `config.password`.

Passing `config.password` through Helm means Helm stores the supplied value in
its release metadata Secret. Operators that do not want the password retained
in release values should use `auth.existingSecret`.

The ConfigMap checksum and, when the chart manages it, Secret checksum are pod
template annotations so changes trigger a DaemonSet rollout. Kubernetes does
not restart pods when an externally managed Secret used through an environment
variable changes, so the README tells users to restart the DaemonSet after such
a change.

## Workload

The workload is a single DaemonSet. Its pod specification defaults to:

```yaml
hostNetwork: true
dnsPolicy: Default
```

Each selected node therefore runs one server bound to its host network. The
DaemonSet uses a rolling update strategy and mounts the generated ConfigMap at
`/etc/shadowsocks-rust/config.json`, matching the official image's chart usage.
It declares named TCP and UDP container ports using `config.server_port`.

The container uses `ghcr.io/shadowsocks/ssserver-rust:v1.24.0` with
`IfNotPresent` pull policy. The chart exposes standard image, resources,
container security context, extra environment variables, extra volume mounts,
init container, sidecar, node selector, affinity, toleration, priority class,
scheduler, host alias, topology spread, and termination grace period settings.
The ServiceAccount does not automount Kubernetes API credentials by default.

TCP socket liveness and readiness probes target the named TCP port and are
enabled by default. Each probe has an `enabled` flag and normal timing fields so
users selecting an incompatible configuration such as UDP-only mode can disable
the TCP probes.

## Networking

A ClusterIP Service is enabled by default. It selects every DaemonSet pod and
exposes the same `config.server_port` once as TCP and once as UDP. The Service
defaults to `internalTrafficPolicy: Local`, while direct access through each
node's host address remains available because `hostNetwork` is enabled.

Service values support disabling the Service, changing its type, annotations,
labels, ClusterIP, node ports, load balancer settings, external traffic policy,
session affinity, IP family settings, and extra ports. The default TCP and UDP
service ports intentionally follow `config.server_port` instead of introducing
a second port setting.

## Validation and Failure Behavior

Template rendering fails with an actionable error when:

- `config.server_port` is absent or not a valid Kubernetes port from 1 through
  65535;
- the chart manages the Secret and `config.password` is empty; or
- an external Secret is selected but `auth.existingSecretPasswordKey` is empty.

Kubernetes remains responsible for validating user-supplied extension objects,
security contexts, scheduling values, and Service options. The chart does not
attempt to validate arbitrary shadowsocks-rust configuration fields beyond the
special password handling and required server port.

## Documentation

`README.md` documents the default DaemonSet, host-network behavior, TCP and UDP
access, the `config.*` to `config.json` mapping, the special password behavior,
and the insecure `changeme` placeholder. It includes installation examples for
both a chart-managed Secret and a pre-created Secret, plus a note about manually
restarting the DaemonSet when an external Secret changes.

## Existing Release Migration

The deployed `shadowsocks` release currently uses external Secret
`shadowsocks-credentials`. The upgrade reads its current random password and
passes that value as `config.password`, removes the external Secret override,
and creates `shadowsocks-secret`. After all four DaemonSet pods are Ready and
the new Secret reference is confirmed, the obsolete `shadowsocks-credentials`
Secret is deleted.

## Testing

A new `tests/shadowsocks-chart.test.js` follows the repository's Node test
pattern: it copies the chart into a temporary directory, packages the local
`common` dependency, and renders with `helm template`.

Tests cover:

- chart metadata and the exact v1.24.0 image;
- one DaemonSet with `hostNetwork: true` and `dnsPolicy: Default`;
- direct `config.*` JSON rendering and automatic password placeholder injection;
- default `shadowsocks-secret` creation from `config.password: changeme` and
  `secretKeyRef` environment wiring;
- omission of the chart-managed Secret and custom key wiring when an existing
  Secret is selected;
- TCP and UDP container ports and ClusterIP Service ports at 8388;
- `internalTrafficPolicy: Local` and default Service enablement;
- propagation of a custom `config.server_port` to the ConfigMap, DaemonSet, and
  Service;
- omission of the plaintext `config.password` value from the ConfigMap;
- validation failures for invalid ports and empty managed or external Secret
  settings; and
- standard chart overrides that materially affect the rendered workload.

Verification runs the focused Node test first, then the complete repository test
suite, Helm dependency build, `helm lint`, `helm template`, and `helm package` for
the new chart.
