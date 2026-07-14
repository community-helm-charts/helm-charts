# Proxy Workload Scheduling Design

## Goal

Use a small combination of node labels, one egress taint, and Helm workload
settings so that:

- Snell Server runs only on `us-lax-2`.
- Shadowsocks runs only on `us-lax-3`.
- Traefik runs on every node except `us-lax-3`.
- The Shadowsocks node remains protected from workloads that do not explicitly
  tolerate proxy-egress capacity.

## Current State

The `kudeploy` cluster has five Ready nodes.

- `us-lax-2` has taint `dedicated=proxy:NoSchedule`.
- `us-lax-3` has taint `dedicated=proxy-egress:NoSchedule`.
- The Snell Server DaemonSet has no node selector, tolerates both taints, and
  runs on all five nodes.
- The Shadowsocks DaemonSet has no node selector, tolerates proxy-egress, and
  runs on four nodes.
- The Traefik DaemonSet has no node selector, tolerates the old proxy taint,
  and is excluded from the proxy-egress node.

## Final Node Policy

### `us-lax-2`

- Add node label `snell-server=true`.
- Remove taint `dedicated=proxy:NoSchedule`.
- Do not add another taint.

This label positively selects the Snell Server node. Because the node is not
tainted, normal workloads and Traefik may also run there.

### `us-lax-3`

- Add node label `shadowsocks=true`.
- Keep taint `dedicated=proxy-egress:NoSchedule`.

The label positively selects the Shadowsocks node. The taint prevents Traefik
and ordinary workloads from using the node unless they explicitly tolerate
proxy-egress.

### Other nodes

Do not add proxy-specific labels or taints. They remain ordinary nodes.

## Final Workload Policy

### Snell Server

Configure the existing Helm release with:

```yaml
nodeSelector:
  snell-server: "true"
tolerations: []
```

The selector limits the DaemonSet to `us-lax-2`. No dedicated toleration is
needed because the old proxy taint is removed.

### Shadowsocks

Configure the existing Helm release with:

```yaml
nodeSelector:
  shadowsocks: "true"
tolerations:
  - key: dedicated
    operator: Equal
    value: proxy-egress
    effect: NoSchedule
```

Both settings are required. The selector attracts the DaemonSet only to
`us-lax-3`; the toleration permits it to run through that node's taint.

### Traefik

Configure the existing Helm release with:

```yaml
nodeSelector: {}
tolerations: []
```

Traefik needs no proxy-specific scheduling configuration. As a DaemonSet, it
runs on the four untainted nodes. The proxy-egress taint excludes it from
`us-lax-3`.

## Release Sources and Value Preservation

- Upgrade Snell Server with the local chart at
  `/root/projects/xudongcc/snell-server/helm`, which matches deployed chart
  version `0.0.3` and app version `5.0.1`.
- Upgrade Shadowsocks with the verified local chart at
  `/root/projects/community-helm-charts/helm-charts/charts/shadowsocks`, which
  matches deployed chart version `1.0.0` and app version `v1.24.0`.
- Upgrade Traefik with the official chart package at the currently deployed
  chart version `40.2.0`; do not upgrade the chart or app version as part of
  this change.
- Reuse existing release values and override only `nodeSelector` and
  `tolerations`. Passwords and unrelated settings must remain unchanged.
- Use Helm wait, timeout, and rollback-on-failure behavior for every release
  upgrade.

## Migration Order

1. Add `snell-server=true` to `us-lax-2` and `shadowsocks=true` to `us-lax-3`.
2. Verify both labels and the existing proxy-egress taint.
3. Remove only `dedicated=proxy:NoSchedule` from `us-lax-2`.
4. Upgrade Snell Server with its final node selector and empty tolerations.
5. Upgrade Shadowsocks with its final node selector and exact proxy-egress
   toleration.
6. Upgrade Traefik with empty node selector and tolerations.
7. Verify final pod placement, readiness, Helm release status, and cluster
   readiness.

Adding labels before applying selectors prevents unschedulable workloads.
Removing the old proxy taint before removing Snell and Traefik tolerations
avoids a scheduling gap. The proxy-egress taint remains in place throughout.

## Failure Handling and Rollback

- Stop immediately if either node is not Ready or if expected current taints
  differ from this design.
- Let Helm roll back a release automatically if its DaemonSet does not become
  Ready before the timeout.
- Do not proceed to the next workload until the current workload has the
  expected Ready count and node placement.
- If a later step fails, preserve the successfully applied node labels because
  they do not exclude workloads. Restore the previous Helm revision for the
  failed release before changing taints or selectors again.
- If required, restore `dedicated=proxy:NoSchedule` on `us-lax-2` only after
  restoring the old Snell and Traefik tolerations.

## Verification

The migration is complete only when all of these checks pass:

- All five nodes are Ready.
- `us-lax-2` has label `snell-server=true` and no `dedicated=proxy` taint.
- `us-lax-3` has label `shadowsocks=true` and retains exactly the expected
  `dedicated=proxy-egress:NoSchedule` proxy taint.
- Snell Server is `1/1` Ready and its only pod runs on `us-lax-2`.
- Shadowsocks is `1/1` Ready and its only pod runs on `us-lax-3`.
- Traefik is `4/4` Ready, runs on every node except `us-lax-3`, and has no
  proxy-specific node selector or toleration.
- The Shadowsocks password still references `shadowsocks-secret/password`.
- The `snell-server`, `shadowsocks`, and `traefik` Helm releases are deployed.
- Kubernetes `/readyz` returns `ok`.

## Out of Scope

- Changing container images, chart versions, service configuration, ports, or
  credentials.
- Reserving `us-lax-2` exclusively for Snell Server.
- Allowing Traefik or unrelated workloads onto the proxy-egress node.
