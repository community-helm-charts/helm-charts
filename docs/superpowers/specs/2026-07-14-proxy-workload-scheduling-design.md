# Proxy Workload Scheduling Design

## Goal

Use a small combination of node labels, one egress taint, and Helm workload
settings so that:

- Snell Server runs on every node except `us-lax-3`.
- Shadowsocks runs only on `us-lax-3`.
- Traefik runs on every node except `us-lax-3`.
- Traefik is upgraded to chart `41.0.2` and Traefik `v3.7.6`.
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

Add `snell-server=true` to `us-lax-1`, `us-west-ccs-1`, and
`us-west-hostdzire-1`. Do not add proxy-specific taints; they remain ordinary
nodes that also run Snell Server.

## Final Workload Policy

### Snell Server

Configure the existing Helm release with:

```yaml
nodeSelector:
  snell-server: "true"
tolerations: []
```

The selector limits the DaemonSet to the four nodes labeled
`snell-server=true`. No dedicated toleration is needed because all four nodes
are untainted. `us-lax-3` has no Snell label.

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
deployment:
  kind: DaemonSet
service:
  spec:
    type: ClusterIP
ports:
  web:
    hostPort: 80
  websecure:
    hostPort: 443
updateStrategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1
    maxSurge: 0
log:
  format: json
accessLog:
  enabled: true
  format: json
nodeSelector: {}
tolerations: []
```

Traefik needs no proxy-specific scheduling configuration. As a DaemonSet, it
runs on the four untainted nodes. The proxy-egress taint excludes it from
`us-lax-3`. The ClusterIP Service avoids a K3s `svclb` DaemonSet competing
with Traefik for host ports 80 and 443. `maxUnavailable: 1` and `maxSurge: 0`
also prevent replacement pods from competing with old pods for those ports.

Chart 41 uses `log` and `accessLog` instead of the chart 40 `logs.general` and
`logs.access` keys. It also uses `service.spec.type` instead of `service.type`.

## Release Sources and Value Preservation

- Upgrade Snell Server with the local chart at
  `/root/projects/xudongcc/snell-server/helm`, which matches deployed chart
  version `0.0.3` and app version `5.0.1`.
- Upgrade Shadowsocks with the verified local chart at
  `/root/projects/community-helm-charts/helm-charts/charts/shadowsocks`, which
  matches deployed chart version `1.0.0` and app version `v1.24.0`.
- Reinstall Traefik from the official OCI chart at version `41.0.2`, which
  deploys Traefik `v3.7.6`.
- Reuse the existing Snell Server and Shadowsocks release values and override
  only their scheduling fields. Passwords must remain unchanged.
- Back up all existing Traefik custom resources before replacing its CRDs.
  The backup contains the Snell Server `IngressRouteTCP`, Ghost `Middleware`,
  and dnsproxy `ServersTransport`.
- Let Traefik recreate all 25 `traefik.io` and `hub.traefik.io` CRDs, then
  restore the three custom resources from the sanitized backup.
- Use Helm wait, timeout, and rollback-on-failure behavior for every release
  upgrade.

## Migration Order

1. Add `snell-server=true` to all nodes except `us-lax-3`, and add
   `shadowsocks=true` only to `us-lax-3`.
2. Verify both labels and the existing proxy-egress taint.
3. Remove only `dedicated=proxy:NoSchedule` from `us-lax-2`.
4. Upgrade Snell Server with its final node selector and empty tolerations.
5. Upgrade Shadowsocks with its final node selector and exact proxy-egress
   toleration.
6. Back up the three existing Traefik custom resources without Kubernetes
   server metadata.
7. Delete the old Traefik namespace and its 25 old CRDs.
8. Install Traefik chart `41.0.2` as a DaemonSet with ClusterIP Service,
   host ports 80/443, rolling strategy 1/0, JSON logs, empty node selector,
   and empty tolerations.
9. Restore and verify the three custom resources.
10. Verify final pod placement, readiness, Helm release status, and cluster
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
- Do not delete Traefik CRDs until the sanitized custom-resource backup has
  been validated against all live Traefik custom-resource instances.
- Do not restore custom resources until Traefik is deployed and all 25 CRDs
  exist again.
- If a later step fails, preserve the successfully applied node labels because
  they do not exclude workloads. Restore the previous Helm revision for the
  failed release before changing taints or selectors again.
- If required, restore `dedicated=proxy:NoSchedule` on `us-lax-2` only after
  restoring the old Snell and Traefik tolerations.

## Verification

The migration is complete only when all of these checks pass:

- All five nodes are Ready.
- All nodes except `us-lax-3` have label `snell-server=true`; `us-lax-2` has
  no `dedicated=proxy` taint.
- `us-lax-3` has label `shadowsocks=true` and retains exactly the expected
  `dedicated=proxy-egress:NoSchedule` proxy taint.
- Snell Server is `4/4` Ready and runs on every node except `us-lax-3`.
- Shadowsocks is `1/1` Ready and its only pod runs on `us-lax-3`.
- Traefik is `4/4` Ready, runs on every node except `us-lax-3`, and has no
  proxy-specific node selector or toleration.
- Traefik is chart `41.0.2` / app `v3.7.6`, uses a ClusterIP Service, binds
  host ports 80/443, rolls with `maxUnavailable: 1` and `maxSurge: 0`, and
  emits general and access logs as JSON.
- No K3s `svclb-traefik` DaemonSet exists.
- All 25 Traefik CRDs and the three backed-up custom resources exist.
- The Shadowsocks password still references `shadowsocks-secret/password`.
- The `snell-server`, `shadowsocks`, and `traefik` Helm releases are deployed.
- Kubernetes `/readyz` returns `ok`.

## Out of Scope

- Changing Snell Server or Shadowsocks images, chart versions, ports, or
  credentials.
- Reserving any untainted node exclusively for Snell Server.
- Allowing Traefik or unrelated workloads onto the proxy-egress node.
