# Proxy Workload Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge Snell Server and Traefik onto the four non-egress nodes, Shadowsocks onto `us-lax-3`, and Traefik to 41.0.2 while preserving proxy credentials and Traefik custom resources.

**Architecture:** Node labels provide positive placement for Snell Server and Shadowsocks. The single retained `dedicated=proxy-egress:NoSchedule` taint reserves the Shadowsocks node, while Traefik uses a host-port DaemonSet, ClusterIP Service, no selector, and no toleration. Existing Traefik custom resources are backed up before its CRDs are replaced and restored after chart 41.0.2 is installed.

**Tech Stack:** Kubernetes v1.35, kubectl, Helm 4, local Snell Server and Shadowsocks charts, official Traefik OCI chart.

## Global Constraints

- Use kube context `kudeploy`.
- Every node except `us-lax-3` must have label `snell-server=true`; `us-lax-2` must have no `dedicated=proxy` taint.
- `us-lax-3` must have label `shadowsocks=true` and retain `dedicated=proxy-egress:NoSchedule`.
- Snell Server must use `nodeSelector: {snell-server: "true"}` and `tolerations: []`.
- Shadowsocks must use `nodeSelector: {shadowsocks: "true"}` and only tolerate `dedicated=proxy-egress:NoSchedule`.
- Traefik must use `nodeSelector: {}` and `tolerations: []`.
- Traefik must use a ClusterIP Service, host ports 80/443, rolling strategy `maxUnavailable: 1` / `maxSurge: 0`, and JSON general/access logs.
- Reuse Snell Server and Shadowsocks Helm values and override only scheduling fields.
- Keep Snell Server at chart `0.0.3` and Shadowsocks at chart `1.0.0`; upgrade Traefik from `40.2.0` to `41.0.2` / app `v3.7.6`.
- Preserve and restore the three existing Traefik custom resources when replacing its 25 CRDs.
- Never print or replace either proxy password.
- Stop after any failed readiness or placement check.

---

### Task 1: Verify preconditions and chart sources

**Files:**
- Read: `/root/projects/xudongcc/snell-server/helm/Chart.yaml`
- Read: `/root/projects/community-helm-charts/helm-charts/charts/shadowsocks/Chart.yaml`
- Cluster read only: nodes and Helm releases

**Interfaces:**
- Consumes: existing `kudeploy` node and Helm state.
- Produces: verified baseline required by every mutation task.

- [ ] **Step 1: Require five Ready nodes and exact starting taints**

Run:

```bash
set -euo pipefail
test "$(kubectl --context kudeploy get nodes --no-headers | awk '$2 == "Ready" { count++ } END { print count + 0 }')" = 5
test "$(kubectl --context kudeploy get node us-lax-2 -o json | jq -r '[(.spec.taints // [])[] | select(.key == "dedicated" and .effect == "NoSchedule") | .value] | join(",")')" = proxy
test "$(kubectl --context kudeploy get node us-lax-3 -o json | jq -r '[(.spec.taints // [])[] | select(.key == "dedicated" and .effect == "NoSchedule") | .value] | join(",")')" = proxy-egress
```

Expected: exit 0 without changing the cluster.

- [ ] **Step 2: Require deployed releases and matching chart versions**

Run:

```bash
set -euo pipefail
for release_namespace in 'snell-server snell-server 0.0.3' 'shadowsocks shadowsocks 1.0.0' 'traefik traefik 40.2.0'; do
  set -- $release_namespace
  metadata=$(helm --kube-context kudeploy get metadata "$1" --namespace "$2")
  test "$(printf '%s\n' "$metadata" | awk '$1 == "STATUS:" { print $2 }')" = deployed
  test "$(printf '%s\n' "$metadata" | awk '$1 == "VERSION:" { print $2 }')" = "$3"
done
```

Expected: all three releases are deployed at the pinned chart versions.

- [ ] **Step 3: Verify all chart inputs without modifying source trees**

Run:

```bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -a /root/projects/xudongcc/snell-server/helm "$tmp/snell-server"
cp -a /root/projects/community-helm-charts/helm-charts/charts/shadowsocks "$tmp/shadowsocks"
cp -a /root/projects/community-helm-charts/helm-charts/charts/common "$tmp/common"
rm -rf "$tmp/snell-server/charts" "$tmp/snell-server/Chart.lock" "$tmp/shadowsocks/charts" "$tmp/shadowsocks/Chart.lock"
helm dependency build "$tmp/snell-server"
helm dependency build "$tmp/shadowsocks"
helm lint "$tmp/snell-server"
helm lint "$tmp/shadowsocks"
helm show chart oci://ghcr.io/traefik/helm/traefik --version 41.0.2 | grep -Fxq 'version: 41.0.2'
```

Expected: both local charts lint successfully and the official Traefik OCI chart resolves at `41.0.2`.

### Task 2: Apply final node metadata

**Files:**
- Cluster mutation: all five nodes

**Interfaces:**
- Consumes: verified node baseline from Task 1.
- Produces: labels used by the two workload selectors and four untainted Traefik nodes.

- [ ] **Step 1: Add placement labels**

Run:

```bash
kubectl --context kudeploy label node us-lax-2 snell-server=true --overwrite
kubectl --context kudeploy label node us-lax-1 snell-server=true --overwrite
kubectl --context kudeploy label node us-west-ccs-1 snell-server=true --overwrite
kubectl --context kudeploy label node us-west-hostdzire-1 snell-server=true --overwrite
kubectl --context kudeploy label node us-lax-3 snell-server- 2>/dev/null || true
kubectl --context kudeploy label node us-lax-3 shadowsocks=true --overwrite
```

Expected: both commands report `labeled` or `not labeled` only when the exact value already exists.

- [ ] **Step 2: Verify labels before changing the taint**

Run:

```bash
test "$(kubectl --context kudeploy get node us-lax-2 -o jsonpath='{.metadata.labels.snell-server}')" = true
test "$(kubectl --context kudeploy get node us-lax-1 -o jsonpath='{.metadata.labels.snell-server}')" = true
test "$(kubectl --context kudeploy get node us-west-ccs-1 -o jsonpath='{.metadata.labels.snell-server}')" = true
test "$(kubectl --context kudeploy get node us-west-hostdzire-1 -o jsonpath='{.metadata.labels.snell-server}')" = true
test -z "$(kubectl --context kudeploy get node us-lax-3 -o jsonpath='{.metadata.labels.snell-server}')"
test "$(kubectl --context kudeploy get node us-lax-3 -o jsonpath='{.metadata.labels.shadowsocks}')" = true
```

Expected: exit 0.

- [ ] **Step 3: Remove only the obsolete ingress-node taint**

Run:

```bash
kubectl --context kudeploy taint node us-lax-2 dedicated=proxy:NoSchedule-
```

Expected: `node/us-lax-2 untainted`.

- [ ] **Step 4: Verify final node taints**

Run:

```bash
set -euo pipefail
test "$(kubectl --context kudeploy get node us-lax-2 -o json | jq '[.spec.taints // [] | .[] | select(.key == "dedicated" and .effect == "NoSchedule")] | length')" = 0
test "$(kubectl --context kudeploy get node us-lax-3 -o json | jq -r '[(.spec.taints // [])[] | select(.key == "dedicated" and .effect == "NoSchedule") | .value] | join(",")')" = proxy-egress
```

Expected: `us-lax-2` has no dedicated NoSchedule taint and `us-lax-3` still has proxy-egress.

### Task 3: Converge Snell Server onto the four non-egress nodes

**Files:**
- Read and package: `/root/projects/xudongcc/snell-server/helm`
- Cluster mutation: Helm release `snell-server` in namespace `snell-server`

**Interfaces:**
- Consumes: label `snell-server=true` on four untainted nodes.
- Produces: four Ready Snell Server pods, excluding `us-lax-3`.

- [ ] **Step 1: Upgrade with reused values and final scheduling fields**

Run:

```bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -a /root/projects/xudongcc/snell-server/helm "$tmp/snell-server"
rm -rf "$tmp/snell-server/charts" "$tmp/snell-server/Chart.lock"
helm dependency build "$tmp/snell-server"
helm --kube-context kudeploy upgrade snell-server "$tmp/snell-server" \
  --namespace snell-server \
  --reuse-values \
  --set-json 'nodeSelector={"snell-server":"true"}' \
  --set-json 'tolerations=[]' \
  --rollback-on-failure \
  --wait \
  --timeout 5m
```

Expected: release status `deployed` and a new revision with `Upgrade complete`.

- [ ] **Step 2: Verify release values and exact pod placement**

Run:

```bash
set -euo pipefail
values=$(helm --kube-context kudeploy get values snell-server --namespace snell-server -o json)
test "$(printf '%s' "$values" | jq -r '.nodeSelector["snell-server"]')" = true
test "$(printf '%s' "$values" | jq '.tolerations | length')" = 0
test "$(kubectl --context kudeploy --namespace snell-server get daemonset snell-server -o jsonpath='{.status.desiredNumberScheduled}')" = 4
test "$(kubectl --context kudeploy --namespace snell-server get daemonset snell-server -o jsonpath='{.status.numberReady}')" = 4
actual=$(kubectl --context kudeploy --namespace snell-server get pods -l app.kubernetes.io/instance=snell-server -o json | jq -r '[.items[] | .spec.nodeName] | sort | join(",")')
test "$actual" = 'us-lax-1,us-lax-2,us-west-ccs-1,us-west-hostdzire-1'
```

Expected: Snell Server is `4/4` Ready on every node except `us-lax-3`.

### Task 4: Converge Shadowsocks onto us-lax-3

**Files:**
- Read and package: `/root/projects/community-helm-charts/helm-charts/charts/shadowsocks`
- Cluster mutation: Helm release `shadowsocks` in namespace `shadowsocks`

**Interfaces:**
- Consumes: node label `shadowsocks=true` and retained proxy-egress taint.
- Produces: one Ready Shadowsocks pod on `us-lax-3`, with its existing managed Secret reference.

- [ ] **Step 1: Upgrade with reused values and final scheduling fields**

Run:

```bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -a /root/projects/community-helm-charts/helm-charts/charts/shadowsocks "$tmp/shadowsocks"
cp -a /root/projects/community-helm-charts/helm-charts/charts/common "$tmp/common"
rm -rf "$tmp/shadowsocks/charts" "$tmp/shadowsocks/Chart.lock"
helm dependency build "$tmp/shadowsocks"
helm --kube-context kudeploy upgrade shadowsocks "$tmp/shadowsocks" \
  --namespace shadowsocks \
  --reuse-values \
  --set-json 'nodeSelector={"shadowsocks":"true"}' \
  --set-json 'tolerations=[{"key":"dedicated","operator":"Equal","value":"proxy-egress","effect":"NoSchedule"}]' \
  --rollback-on-failure \
  --wait \
  --timeout 5m
```

Expected: release status `deployed` and a new revision with `Upgrade complete`.

- [ ] **Step 2: Verify scheduling values, Secret reference, and placement**

Run:

```bash
set -euo pipefail
values=$(helm --kube-context kudeploy get values shadowsocks --namespace shadowsocks -o json)
test "$(printf '%s' "$values" | jq -r '.nodeSelector.shadowsocks')" = true
test "$(printf '%s' "$values" | jq -r '.tolerations[0] | [.key,.operator,.value,.effect] | join("/")')" = dedicated/Equal/proxy-egress/NoSchedule
test "$(printf '%s' "$values" | jq '.tolerations | length')" = 1
test "$(kubectl --context kudeploy --namespace shadowsocks get daemonset shadowsocks -o jsonpath='{.status.desiredNumberScheduled}')" = 1
test "$(kubectl --context kudeploy --namespace shadowsocks get daemonset shadowsocks -o jsonpath='{.status.numberReady}')" = 1
test "$(kubectl --context kudeploy --namespace shadowsocks get pods -l app.kubernetes.io/instance=shadowsocks -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}')" = us-lax-3
test "$(kubectl --context kudeploy --namespace shadowsocks get daemonset shadowsocks -o jsonpath='{.spec.template.spec.containers[?(@.name=="shadowsocks")].env[?(@.name=="SHADOWSOCKS_PASSWORD")].valueFrom.secretKeyRef.name}')" = shadowsocks-secret
test "$(kubectl --context kudeploy --namespace shadowsocks get daemonset shadowsocks -o jsonpath='{.spec.template.spec.containers[?(@.name=="shadowsocks")].env[?(@.name=="SHADOWSOCKS_PASSWORD")].valueFrom.secretKeyRef.key}')" = password
```

Expected: Shadowsocks is `1/1` Ready only on `us-lax-3` and still reads `shadowsocks-secret/password`.

### Task 5: Reinstall Traefik 41.0.2 and restore custom resources

**Files:**
- Remote read: `oci://ghcr.io/traefik/helm/traefik:41.0.2`
- Create: `/root/traefik-backups/2026-07-14-traefik-crs.json`
- Cluster mutation: Traefik CRDs and Helm release `traefik` in namespace `traefik`

**Interfaces:**
- Consumes: four untainted nodes, one proxy-egress-tainted node, and three existing Traefik custom resources.
- Produces: 25 current CRDs, three restored custom resources, and four Ready Traefik v3.7.6 pods.

- [ ] **Step 1: Back up and verify all existing Traefik custom resources**

Sanitize the live `IngressRouteTCP`, `Middleware`, and `ServersTransport` objects by removing `creationTimestamp`, `generation`, `managedFields`, `resourceVersion`, `uid`, and `status`. Store the resulting Kubernetes `List` at `/root/traefik-backups/2026-07-14-traefik-crs.json`, then run:

```bash
set -euo pipefail
backup=/root/traefik-backups/2026-07-14-traefik-crs.json
test "$(jq '.items | length' "$backup")" = 3
jq -e '.items[] | select(.kind == "IngressRouteTCP" and .metadata.namespace == "snell-server" and .metadata.name == "snell-server-8443")' "$backup" >/dev/null
jq -e '.items[] | select(.kind == "Middleware" and .metadata.namespace == "blog" and .metadata.name == "ghost-traffic-analytics-strip-prefix")' "$backup" >/dev/null
jq -e '.items[] | select(.kind == "ServersTransport" and .metadata.namespace == "dnsproxy" and .metadata.name == "dnsproxy")' "$backup" >/dev/null
```

Expected: exactly the three known resources are backed up without server metadata.

- [ ] **Step 2: Delete the old release namespace and old Traefik CRDs**

Run:

```bash
set -euo pipefail
kubectl --context kudeploy delete namespace traefik --wait=true --timeout=3m
crds=$(kubectl --context kudeploy get crd -o json | jq -r '.items[] | select(.spec.group == "traefik.io" or .spec.group == "hub.traefik.io") | .metadata.name')
test "$(printf '%s\n' "$crds" | sed '/^$/d' | wc -l)" = 25
kubectl --context kudeploy delete crd $crds --wait=true --timeout=3m
```

Expected: the old namespace and all 25 old Traefik CRDs are absent; the external backup remains.

- [ ] **Step 3: Install Traefik 41.0.2 with chart-41 value names**

Run:

```bash
helm --kube-context kudeploy upgrade --install traefik oci://ghcr.io/traefik/helm/traefik \
  --version 41.0.2 \
  --namespace traefik \
  --create-namespace \
  --set deployment.kind=DaemonSet \
  --set service.spec.type=ClusterIP \
  --set ports.web.hostPort=80 \
  --set ports.websecure.hostPort=443 \
  --set updateStrategy.type=RollingUpdate \
  --set updateStrategy.rollingUpdate.maxUnavailable=1 \
  --set updateStrategy.rollingUpdate.maxSurge=0 \
  --set log.format=json \
  --set accessLog.enabled=true \
  --set accessLog.format=json \
  --rollback-on-failure \
  --wait \
  --timeout 5m
```

Expected: chart `41.0.2` / app `v3.7.6` is deployed. A ClusterIP Service avoids a K3s `svclb` host-port conflict.

- [ ] **Step 4: Restore and verify the custom resources**

Run:

```bash
set -euo pipefail
test "$(kubectl --context kudeploy get crd -o json | jq '[.items[] | select(.spec.group == "traefik.io" or .spec.group == "hub.traefik.io")] | length')" = 25
kubectl --context kudeploy apply -f /root/traefik-backups/2026-07-14-traefik-crs.json
kubectl --context kudeploy --namespace snell-server get ingressroutetcps.traefik.io snell-server-8443 >/dev/null
kubectl --context kudeploy --namespace blog get middlewares.traefik.io ghost-traffic-analytics-strip-prefix >/dev/null
kubectl --context kudeploy --namespace dnsproxy get serverstransports.traefik.io dnsproxy >/dev/null
```

Expected: all three custom resources exist again.

- [ ] **Step 5: Verify Traefik configuration and placement**

Run:

```bash
set -euo pipefail
values=$(helm --kube-context kudeploy get values traefik --namespace traefik -o json)
test "$(printf '%s' "$values" | jq -r '.deployment.kind')" = DaemonSet
test "$(printf '%s' "$values" | jq -r '.service.spec.type')" = ClusterIP
test "$(printf '%s' "$values" | jq -r '.ports.web.hostPort')" = 80
test "$(printf '%s' "$values" | jq -r '.ports.websecure.hostPort')" = 443
test "$(printf '%s' "$values" | jq -r '.updateStrategy.rollingUpdate.maxUnavailable')" = 1
test "$(printf '%s' "$values" | jq -r '.updateStrategy.rollingUpdate.maxSurge')" = 0
test "$(printf '%s' "$values" | jq -r '.log.format')" = json
test "$(printf '%s' "$values" | jq -r '.accessLog.enabled')" = true
test "$(printf '%s' "$values" | jq -r '.accessLog.format')" = json
test "$(printf '%s' "$values" | jq '(.nodeSelector // {}) | length')" = 0
test "$(printf '%s' "$values" | jq '(.tolerations // []) | length')" = 0
test "$(kubectl --context kudeploy --namespace traefik get daemonset traefik -o jsonpath='{.status.desiredNumberScheduled}/{.status.numberReady}')" = 4/4
actual=$(kubectl --context kudeploy --namespace traefik get pods -l app.kubernetes.io/instance=traefik-traefik -o json | jq -r '[.items[] | .spec.nodeName] | sort | join(",")')
test "$actual" = 'us-lax-1,us-lax-2,us-west-ccs-1,us-west-hostdzire-1'
test "$(kubectl --context kudeploy --namespace kube-system get daemonset -l svccontroller.k3s.cattle.io/svcname=traefik -o json | jq '.items | length')" = 0
```

Expected: Traefik runs on all nodes except `us-lax-3`, with no K3s LoadBalancer DaemonSet.

### Task 6: Run end-to-end verification

**Files:**
- Verify only: repository state and `kudeploy` resources

**Interfaces:**
- Consumes: completed node and release changes.
- Produces: final evidence that every requirement is satisfied.

- [ ] **Step 1: Require all Helm releases deployed at pinned versions**

Run:

```bash
set -euo pipefail
for release_namespace in 'snell-server snell-server 0.0.3' 'shadowsocks shadowsocks 1.0.0' 'traefik traefik 41.0.2'; do
  set -- $release_namespace
  metadata=$(helm --kube-context kudeploy get metadata "$1" --namespace "$2")
  test "$(printf '%s\n' "$metadata" | awk '$1 == "STATUS:" { print $2 }')" = deployed
  test "$(printf '%s\n' "$metadata" | awk '$1 == "VERSION:" { print $2 }')" = "$3"
done
```

Expected: all checks exit 0.

- [ ] **Step 2: Require exact DaemonSet counts and placements**

Run:

```bash
set -euo pipefail
test "$(kubectl --context kudeploy --namespace snell-server get daemonset snell-server -o jsonpath='{.status.desiredNumberScheduled}/{.status.numberReady}')" = 4/4
test "$(kubectl --context kudeploy --namespace shadowsocks get daemonset shadowsocks -o jsonpath='{.status.desiredNumberScheduled}/{.status.numberReady}')" = 1/1
test "$(kubectl --context kudeploy --namespace traefik get daemonset traefik -o jsonpath='{.status.desiredNumberScheduled}/{.status.numberReady}')" = 4/4
kubectl --context kudeploy get pods --all-namespaces -o json | jq -e '
  ([.items[] | select(.metadata.namespace == "snell-server" and (.metadata.name | startswith("snell-server-"))) | .spec.nodeName] | sort) == (["us-lax-1","us-lax-2","us-west-ccs-1","us-west-hostdzire-1"] | sort) and
  [.items[] | select(.metadata.namespace == "shadowsocks" and (.metadata.name | startswith("shadowsocks-"))) | .spec.nodeName] == ["us-lax-3"] and
  ([.items[] | select(.metadata.namespace == "traefik" and (.metadata.name | startswith("traefik-"))) | .spec.nodeName] | sort) == (["us-lax-1","us-lax-2","us-west-ccs-1","us-west-hostdzire-1"] | sort)
' >/dev/null
```

Expected: Snell `4/4`, Shadowsocks `1/1`, Traefik `4/4`, with exact nodes.

- [ ] **Step 3: Require node and cluster health**

Run:

```bash
set -euo pipefail
test "$(kubectl --context kudeploy get nodes --no-headers | awk '$2 == "Ready" { count++ } END { print count + 0 }')" = 5
test "$(kubectl --context kudeploy get node us-lax-2 -o jsonpath='{.metadata.labels.snell-server}')" = true
test "$(kubectl --context kudeploy get nodes -l snell-server=true --no-headers | wc -l)" = 4
test -z "$(kubectl --context kudeploy get node us-lax-3 -o jsonpath='{.metadata.labels.snell-server}')"
test "$(kubectl --context kudeploy get node us-lax-3 -o jsonpath='{.metadata.labels.shadowsocks}')" = true
test "$(kubectl --context kudeploy get node us-lax-2 -o json | jq '[.spec.taints // [] | .[] | select(.key == "dedicated" and .effect == "NoSchedule")] | length')" = 0
test "$(kubectl --context kudeploy get node us-lax-3 -o json | jq -r '[(.spec.taints // [])[] | select(.key == "dedicated" and .effect == "NoSchedule") | .value] | join(",")')" = proxy-egress
test "$(kubectl --context kudeploy get --raw='/readyz')" = ok
git -C /root/projects/community-helm-charts/helm-charts diff --check
git -C /root/projects/xudongcc/snell-server diff --check
```

Expected: all nodes and the API server are healthy, final labels and taints match, and no source chart was modified.
