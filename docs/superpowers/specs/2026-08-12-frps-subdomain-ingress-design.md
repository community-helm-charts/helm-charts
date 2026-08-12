# FRPS Subdomain Ingress Design

## Goal

Add an opt-in wildcard Ingress for the FRPS `subDomainHost` feature. A user who configures `config.subDomainHost: example.com` can expose FRPS HTTP subdomain proxies through `*.example.com` and can optionally terminate wildcard TLS at the Ingress controller.

## Values interface

`config.subDomainHost` remains an ordinary FRPS configuration field and is rendered unchanged into `frps.toml`. A new top-level Chart-specific block controls the Kubernetes Ingress:

```yaml
config:
  subDomainHost: ""

subdomainIngress:
  enabled: false
  apiVersion: ""
  ingressClassName: ""
  annotations: {}
  pathType: ImplementationSpecific
  tls: false
  secretName: ""
```

The defaults do not expose traffic, select an Ingress controller, request a certificate, or depend on cert-manager. Users supply controller and certificate annotations for their environment.

## Resource behavior

When `subdomainIngress.enabled` is `false`, the Chart does not create the wildcard Ingress. Setting only `config.subDomainHost` changes the FRPS configuration without creating an external entry point.

When `subdomainIngress.enabled` is `true`, the Chart creates a separate Ingress named `<fullname>-subdomain`. The host is derived from `config.subDomainHost` as `*.<subDomainHost>` so the FRPS routing domain and Kubernetes routing domain cannot drift apart. The Ingress sends path `/` to the named `http` port of the existing `<fullname>-vhost` Service. TLS terminates at the Ingress controller; upstream traffic to FRPS remains HTTP.

Derived Ingress and TLS Secret names reserve space for their `-subdomain` and `-subdomain-tls` suffixes before truncating the fullname. They therefore remain distinct from the existing Ingress even when `fullnameOverride` reaches Kubernetes' 63-character name limit.

The wildcard follows Kubernetes Ingress semantics: it matches exactly one DNS label, such as `a.example.com`, but not `example.com` or `a.b.example.com`.

The existing `ingress` block and resource remain independent. Users may enable either or both resources, with separate class names, annotations, and TLS settings.

## TLS behavior

When `subdomainIngress.tls` is `false`, the resource has no `spec.tls` entry.

When it is `true`, `spec.tls.hosts` contains the same wildcard host used by the rule. `subdomainIngress.secretName` selects an existing or controller-managed TLS Secret. If it is empty, the Chart uses `<fullname>-subdomain-tls`.

The Chart does not create a `Certificate` resource or embed certificate material. Users can add annotations such as `cert-manager.io/cluster-issuer` when their Ingress integration provisions certificates. ACME wildcard certificates generally require a DNS-01 solver, which is an operational prerequisite rather than a Chart default.

## Validation

Rendering fails with an actionable error when `subdomainIngress.enabled` is true and any of these conditions apply:

- `config.subDomainHost` is absent, empty, or not a string.
- `config.subDomainHost` contains a wildcard prefix, URL scheme, port, path, whitespace, or trailing dot instead of a plain DNS name.
- `subdomainIngress` is not a map, `enabled` or `tls` is not a boolean, its string fields are not strings, or `annotations` is not a map.

The Chart accepts a lower-case DNS name with at least two labels and at most 251 characters, leaving room for the generated `*.` prefix within the Kubernetes 253-character host limit. This keeps the generated wildcard valid for the Kubernetes Ingress API and avoids ambiguous single-label cluster-local names.

Examples and tests use a dedicated `frps` namespace. `NOTES.txt` always includes the actual release namespace in `kubectl` commands, so the recommended installation produces `-n frps` consistently without breaking namespace overrides.

## Documentation and notes

The README documents the feature, its disabled defaults, one-label wildcard behavior, Ingress-controller dependency, and DNS-01 requirement for common ACME issuers. The generated values table includes every new field.

When the wildcard Ingress is enabled, `NOTES.txt` reports the `http` or `https` wildcard endpoint without claiming that DNS records or certificates are ready.

## Verification

Automated tests cover:

- no wildcard Ingress by default;
- `config.subDomainHost` rendering without implicit exposure;
- wildcard rule generation and routing to `<fullname>-vhost:http`;
- independent Ingress class and annotations;
- TLS host and explicit/default Secret names;
- coexistence with the existing Ingress;
- invalid or missing `config.subDomainHost` failures;
- README values-table synchronization and rendered NOTES behavior.

Full workspace tests, Helm lint with a vendored `common` dependency, and representative Helm template renders must pass before integration.
