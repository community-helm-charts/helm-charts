# Common Helm Library Chart

`common` is a Helm library chart with shared template helpers for the Community Helm Charts project. It is not installed directly and does not create Kubernetes resources by itself.

Use it as a dependency from another chart:

```yaml
dependencies:
  - name: common
    version: 0.0.0
    repository: oci://ghcr.io/community-helm-charts
```

Then update chart dependencies:

```console
helm dependency update
```

## Helper Usage

Library helpers are called with Helm's `include` function:

```yaml
metadata:
  name: {{ include "common.names.fullname" . }}
  labels:
    {{- include "common.labels.standard" . | nindent 4 }}
```

## Helper Groups

This chart provides helpers for common chart authoring tasks:

| Group | Purpose |
| --- | --- |
| `common.names.*` | Generate release-aware resource names and namespaces. |
| `common.labels.*` | Generate standard Kubernetes labels and selectors. |
| `common.images.*` | Build image references from registry, repository, tag, digest, and global image registry values. |
| `common.resources.*` | Render resource requests and limits from explicit values or presets. |
| `common.storage.*` | Render persistence, PVC, and storage class related values. |
| `common.secrets.*` | Resolve generated and existing secret names, keys, and values. |
| `common.tplvalues.*` | Render values that may contain templates. |
| `common.capabilities.*` | Resolve Kubernetes API version capabilities. |
| `common.affinities.*` | Build affinity presets for pods. |
| `common.validations.*` and `common.warnings.*` | Render chart validation errors and user-facing warnings. |

## Image Values

Helpers that accept image values expect this shape:

```yaml
image:
  registry: docker.io
  repository: library/nginx
  tag: 1.29-alpine
  digest: ""
```

If `global.imageRegistry` is set in the parent chart, image helpers use it as the registry unless the chart template passes a different value explicitly.

## Existing Secrets

Secret helpers accept either a plain secret name:

```yaml
existingSecret: my-secret
```

or an object form when a chart needs to map logical keys to keys in an existing Kubernetes Secret:

```yaml
existingSecret:
  name: my-secret
  keyMapping:
    password: redis-password
```

## Notes For Maintainers

Keep this chart generic. It should not mention or assume a specific image vendor, registry vendor, application chart, or external chart collection. Helpers should remain stable because application charts may call them by name.
