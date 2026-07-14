# Proxy Workload Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge Snell Server onto `us-lax-2`, Shadowsocks onto `us-lax-3`, and Traefik onto the four non-egress nodes without changing images, credentials, or chart versions.

**Architecture:** Node labels provide positive placement for Snell Server and Shadowsocks. The single retained `dedicated=proxy-egress:NoSchedule` taint reserves the Shadowsocks node, while Traefik uses default DaemonSet scheduling with no selector or toleration.

**Tech Stack:** Kubernetes v1.35, kubectl, Helm 4, local Snell Server and Shadowsocks charts, official Traefik OCI chart.

## Global Constraints

- Use kube context `kudeploy`.
- `us-lax-2` must have label `snell-server=true` and no `dedicated=proxy` taint.
- `us-lax-3` must have label `shadowsocks=true` and retain `dedicated=proxy-egress:NoSchedule`.
- Snell Server must use `nodeSelector: {snell-server: "true"}` and `tolerations: []`.
- Shadowsocks must use `nodeSelector: {shadowsocks: "true"}` and only tolerate `dedicated=proxy-egress:NoSchedule`.
- Traefik must use `nodeSelector: {}` and `tolerations: []`.
- Reuse existing Helm values and override only scheduling fields.
- Keep Snell Server at chart `0.0.3`, Shadowsocks at chart `1.0.0`, and Traefik at chart `40.2.0`.
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
helm show chart oci://ghcr.io/traefik/helm/traefik --version 40.2.0 | grep -Fxq 'version: 40.2.0'
```

Expected: both local charts lint successfully and the official Traefik OCI chart resolves at `40.2.0`.

### Task 2: Apply final node metadata

**Files:**
- Cluster mutation: nodes `us-lax-2` and `us-lax-3`

**Interfaces:**
- Consumes: verified node baseline from Task 1.
- Produces: labels used by the two workload selectors and four untainted Traefik nodes.

- [ ] **Step 1: Add placement labels**

Run:

```bash
kubectl --context kudeploy label node us-lax-2 snell-server=true --overwrite
kubectl --context kudeploy label node us-lax-3 shadowsocks=true --overwrite
```

Expected: both commands report `labeled` or `not labeled` only when the exact value already exists.

- [ ] **Step 2: Verify labels before changing the taint**

Run:

```bash
test "$(kubectl --context kudeploy get node us-lax-2 -o jsonpath='{.metadata.labels.snell-server}')" = true
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

### Task 3: Converge Snell Server onto us-lax-2

**Files:**
- Read and package: `/root/projects/xudongcc/snell-server/helm`
- Cluster mutation: Helm release `snell-server` in namespace `snell-server`

**Interfaces:**
- Consumes: node label `snell-server=true` and an untainted `us-lax-2`.
- Produces: one Ready Snell Server pod on `us-lax-2`.

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
test "$(kubectl --context kudeploy --namespace snell-server get daemonset snell-server -o jsonpath='{.status.desiredNumberScheduled}')" = 1
test "$(kubectl --context kudeploy --namespace snell-server get daemonset snell-server -o jsonpath='{.status.numberReady}')" = 1
test "$(kubectl --context kudeploy --namespace snell-server get pods -l app.kubernetes.io/instance=snell-server -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}')" = us-lax-2
```

Expected: Snell Server is `1/1` Ready only on `us-lax-2`.

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

### Task 5: Remove proxy-specific Traefik scheduling values

**Files:**
- Remote read: `oci://ghcr.io/traefik/helm/traefik:40.2.0`
- Cluster mutation: Helm release `traefik` in namespace `traefik`

**Interfaces:**
- Consumes: four untainted nodes and one proxy-egress-tainted node.
- Produces: four Ready Traefik pods with default DaemonSet scheduling.

- [ ] **Step 1: Upgrade the pinned chart with empty scheduling fields**

Run:

```bash
helm --kube-context kudeploy upgrade traefik oci://ghcr.io/traefik/helm/traefik \
  --version 40.2.0 \
  --namespace traefik \
  --reuse-values \
  --set-json 'nodeSelector={}' \
  --set-json 'tolerations=[]' \
  --rollback-on-failure \
  --wait \
  --timeout 5m
```

Expected: release remains on chart `40.2.0`, status `deployed`.

- [ ] **Step 2: Verify empty scheduling fields and four-node placement**

Run:

```bash
set -euo pipefail
values=$(helm --kube-context kudeploy get values traefik --namespace traefik -o json)
test "$(printf '%s' "$values" | jq '.nodeSelector | length')" = 0
test "$(printf '%s' "$values" | jq '.tolerations | length')" = 0
test "$(kubectl --context kudeploy --namespace traefik get daemonset traefik -o jsonpath='{.status.desiredNumberScheduled}')" = 4
test "$(kubectl --context kudeploy --namespace traefik get daemonset traefik -o jsonpath='{.status.numberReady}')" = 4
actual=$(kubectl --context kudeploy --namespace traefik get pods -l app.kubernetes.io/instance=traefik -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort)
expected=$(printf '%s\n' us-lax-1 us-lax-2 us-west-ccs-1 us-west-hostdzire-1 | sort)
test "$actual" = "$expected"
```

Expected: Traefik runs on all nodes except `us-lax-3`.

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
for release_namespace in 'snell-server snell-server 0.0.3' 'shadowsocks shadowsocks 1.0.0' 'traefik traefik 40.2.0'; do
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
test "$(kubectl --context kudeploy --namespace snell-server get daemonset snell-server -o jsonpath='{.status.desiredNumberScheduled}/{.status.numberReady}')" = 1/1
test "$(kubectl --context kudeploy --namespace shadowsocks get daemonset shadowsocks -o jsonpath='{.status.desiredNumberScheduled}/{.status.numberReady}')" = 1/1
test "$(kubectl --context kudeploy --namespace traefik get daemonset traefik -o jsonpath='{.status.desiredNumberScheduled}/{.status.numberReady}')" = 4/4
kubectl --context kudeploy get pods --all-namespaces -o json | jq -e '
  [.items[] | select(.metadata.namespace == "snell-server" and (.metadata.name | startswith("snell-server-"))) | .spec.nodeName] == ["us-lax-2"] and
  [.items[] | select(.metadata.namespace == "shadowsocks" and (.metadata.name | startswith("shadowsocks-"))) | .spec.nodeName] == ["us-lax-3"] and
  ([.items[] | select(.metadata.namespace == "traefik" and (.metadata.name | startswith("traefik-"))) | .spec.nodeName] | sort) == (["us-lax-1","us-lax-2","us-west-ccs-1","us-west-hostdzire-1"] | sort)
' >/dev/null
```

Expected: Snell `1/1`, Shadowsocks `1/1`, Traefik `4/4`, with exact nodes.

- [ ] **Step 3: Require node and cluster health**

Run:

```bash
set -euo pipefail
test "$(kubectl --context kudeploy get nodes --no-headers | awk '$2 == "Ready" { count++ } END { print count + 0 }')" = 5
test "$(kubectl --context kudeploy get node us-lax-2 -o jsonpath='{.metadata.labels.snell-server}')" = true
test "$(kubectl --context kudeploy get node us-lax-3 -o jsonpath='{.metadata.labels.shadowsocks}')" = true
test "$(kubectl --context kudeploy get node us-lax-2 -o json | jq '[.spec.taints // [] | .[] | select(.key == "dedicated" and .effect == "NoSchedule")] | length')" = 0
test "$(kubectl --context kudeploy get node us-lax-3 -o json | jq -r '[(.spec.taints // [])[] | select(.key == "dedicated" and .effect == "NoSchedule") | .value] | join(",")')" = proxy-egress
test "$(kubectl --context kudeploy get --raw='/readyz')" = ok
git -C /root/projects/community-helm-charts/helm-charts diff --check
git -C /root/projects/xudongcc/snell-server diff --check
```

Expected: all nodes and the API server are healthy, final labels and taints match, and no source chart was modified.
