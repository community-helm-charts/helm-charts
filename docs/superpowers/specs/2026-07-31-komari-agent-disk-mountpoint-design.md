# Komari Agent Disk Mountpoint Design

## Goal

Make the containerized Komari Agent report each node's root disk capacity and
usage exactly once, publish the corrected Helm chart as an OCI artifact, and
upgrade the existing `komari` release in the `kudeploy` cluster.

## Root Cause

The Agent currently discovers two monitored mountpoints inside every pod:

```text
/                         (overlay)
/app/auto-discovery.json  (ext4)
```

The second entry is the per-node identity file mounted from the host with
`subPath`. Both entries expose the same root filesystem capacity and usage, but
Komari Agent sees different device names (`overlay` and `/dev/sda1` or
`/dev/vda1`) and sums them as separate disks. This makes both reported total
and used space exactly twice the node values.

The identity hostPath remains necessary so a replacement pod on the same node
reuses its UUID and token. The fix must not remove or relocate that identity.

## Selected Design

Add a first-class Agent value:

```yaml
agent:
  includeMountpoints: "/"
```

The DaemonSet injects it through the official Agent environment variable:

```yaml
- name: AGENT_INCLUDE_MOUNTPOINTS
  value: "/"
```

Komari Agent then calls disk usage only for `/`, avoiding automatic discovery
of the identity-file bind mount. On the deployed nodes, the container root
overlay reports the same Total and Used values as the host root filesystem, so
this removes the duplicate without mounting any additional host paths.

The value is a semicolon-delimited string matching the Agent's official
configuration format. Operators may provide multiple paths when they
deliberately mount and monitor additional filesystems. Setting it to an empty
string restores the Agent's automatic mountpoint discovery.

## Rejected Alternatives

Using a default entry in `agent.extraEnvVars` would work initially, but users
commonly replace that list and could accidentally remove the correctness
default. A dedicated value makes the behavior discoverable and stable.

Changing the identity mount layout would conflict with the Agent's fixed
`/app/auto-discovery.json` identity location or require replacing `/app`,
which also contains the Agent binary.

Mounting the entire host root at another path would allow broader filesystem
inspection but unnecessarily expands host filesystem exposure. It is not
required because `/` already returns the correct root filesystem statistics.

## Documentation and Tests

The chart README explains the default filter, the duplicate bind-mount problem,
the semicolon syntax, and the empty-string opt-out.

The Komari rendering suite first fails against the current chart by requiring
an enabled Agent to contain:

```yaml
- name: AGENT_INCLUDE_MOUNTPOINTS
  value: "/"
```

It also verifies that a custom semicolon-delimited value renders unchanged and
that an empty value is allowed. The test exercises the rendered DaemonSet
rather than grepping source text.

Final repository verification includes the Komari-specific tests, the complete
workspace test suite, Helm lint, Helm package, and a clean diff check.

## Release and Deployment

Commit the implementation with a Conventional Commit using the `fix(komari)`
scope. The release workflow must derive Chart version `1.1.2`, create tag
`komari@1.1.2`, and publish:

```text
oci://ghcr.io/community-helm-charts/komari:1.1.2
```

Upgrade release `komari` in namespace `komari` on context `kudeploy` with
`--reset-then-reuse-values` so the new default is merged with existing user
configuration.

The rollout is complete only when all five Agent pods are updated and Ready
with zero restarts, each pod log reports:

```text
Monitoring Mountpoints: [/]
```

For every node, `df` for `/` must match the previously duplicated root
filesystem values, internal server connectivity and WebSocket operation must
remain healthy, per-node identity files must remain non-empty, and the Komari
server and public HTTPS endpoint must remain available.

The deployment does not rotate credentials, replace Agent identities, change
network collection, or modify the Komari server configuration.
