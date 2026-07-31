# Komari Agent Host Network Design

## Goal

Make Komari Agent collect each Kubernetes node's network traffic by default,
publish the corrected Helm chart as an OCI artifact, and upgrade the existing
`komari` release in the `kudeploy` cluster.

## Root Cause

Komari Agent obtains interface counters from its process network namespace.
The current DaemonSet uses the pod network namespace, so the Agent sees only
the pod's `eth0` and `lo` devices. It cannot see the node's physical interface,
CNI bridge, overlay interface, or other host devices.

Mounting a host `/proc` directory alone does not correct this counter path.
The Agent process must join the host network namespace.

## Chart Interface and Defaults

Add two Agent pod values:

```yaml
agent:
  hostNetwork: true
  dnsPolicy: ClusterFirstWithHostNet
```

The DaemonSet renders both values directly into its pod specification.
`hostNetwork: true` exposes host interface counters. The paired
`ClusterFirstWithHostNet` policy preserves Kubernetes Service discovery, so
the default endpoint `http://komari-server:25774` continues to resolve.

Both settings remain configurable. An operator deliberately choosing pod-level
network statistics sets both of these values:

```yaml
agent:
  hostNetwork: false
  dnsPolicy: ClusterFirst
```

The chart does not automatically rewrite an explicitly supplied DNS policy.

## Documentation and Tests

The chart README explains why host networking is enabled, why the DNS policy is
paired with it, and how to opt back into pod networking.

The existing Komari rendering test first fails against the current chart by
requiring an enabled Agent DaemonSet to contain:

```yaml
hostNetwork: true
dnsPolicy: ClusterFirstWithHostNet
```

A second rendering assertion verifies that `agent.hostNetwork=false` and
`agent.dnsPolicy=ClusterFirst` are honored. Final verification includes the
Komari test file, Helm lint, the full repository test suite, and Helm package.

## Release and Deployment

Commit the implementation with a Conventional Commit using the `fix(komari)`
scope. The repository release workflow derives a patch release from that
commit, updates Chart metadata and changelog, tags the release, and publishes
the resulting chart to:

```text
oci://ghcr.io/community-helm-charts/komari
```

After the new OCI version is available, upgrade release `komari` in namespace
`komari` on context `kudeploy` while reusing its current values. The rollout
must leave five updated and Ready Agent pods with zero restarts. Each Agent pod
must use host networking, retain `ClusterFirstWithHostNet`, resolve the
in-cluster server endpoint, and expose its node's primary host interface in
`/proc/net/dev`.

The deployment does not rotate the auto-discovery key, replace Agent
identities, or change the Komari server configuration.
