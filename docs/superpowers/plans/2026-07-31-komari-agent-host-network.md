# Komari Agent Host Network Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Komari Agent DaemonSet collect host network traffic by default, publish the patch release, and upgrade the live `kudeploy` release.

**Architecture:** Expose `agent.hostNetwork` and `agent.dnsPolicy` as paired pod values with host-monitoring defaults, and render them directly in the DaemonSet pod specification. Protect both the default and override contracts with Helm rendering tests, then let the repository Conventional Commit workflow create and publish the patch release before deploying that immutable OCI version.

**Tech Stack:** Helm 3 templates, Kubernetes `apps/v1` DaemonSet, Node.js built-in test runner, pnpm/Nx, GitHub Actions, Helm OCI.

## Global Constraints

- Keep `server.enabled: true` and `agent.enabled: false`.
- Default `agent.hostNetwork` to `true`.
- Default `agent.dnsPolicy` to `ClusterFirstWithHostNet`.
- Preserve the derived Agent endpoint `http://komari-server:25774`.
- Allow deliberate pod-network collection with `agent.hostNetwork=false` and `agent.dnsPolicy=ClusterFirst`.
- Do not rotate the auto-discovery key or replace per-node Agent identity files.
- Do not manually edit the Chart version; `fix(komari)` must produce the patch release through Nx.

---

### Task 1: Protect the Host-Network Rendering Contract

**Files:**
- Modify: `tests/komari-chart.test.js`

**Interfaces:**
- Consumes: `makeKomariChart().render()` and Helm `--set` overrides.
- Produces: regression coverage for the default and explicitly overridden Agent pod network settings.

- [ ] **Step 1: Add a failing rendering test**

Add a test that renders an enabled Agent with a managed discovery key. Assert the resulting DaemonSet contains the literal defaults:

```yaml
hostNetwork: true
dnsPolicy: ClusterFirstWithHostNet
```

Render again with:

```text
--set agent.hostNetwork=false
--set agent.dnsPolicy=ClusterFirst
```

Assert that the second DaemonSet contains:

```yaml
hostNetwork: false
dnsPolicy: ClusterFirst
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='Agent host network' tests/komari-chart.test.js
```

Expected: one failure because the current DaemonSet renders neither field.

---

### Task 2: Render and Document the Host-Network Defaults

**Files:**
- Modify: `charts/komari/values.yaml`
- Modify: `charts/komari/templates/agent-daemonset.yaml`
- Modify: `charts/komari/README.md`

**Interfaces:**
- Consumes: `.Values.agent.hostNetwork` as a boolean and `.Values.agent.dnsPolicy` as a Kubernetes DNS policy string.
- Produces: DaemonSet pod fields `hostNetwork` and `dnsPolicy`.

- [ ] **Step 1: Add the documented values**

Under the Komari Agent pod parameters, add:

```yaml
## @param agent.hostNetwork Share the node network namespace to collect host traffic
## @param agent.dnsPolicy DNS policy for Agent pods
hostNetwork: true
dnsPolicy: ClusterFirstWithHostNet
```

- [ ] **Step 2: Render the values**

At the beginning of the DaemonSet pod spec, add:

```yaml
hostNetwork: {{ .Values.agent.hostNetwork }}
dnsPolicy: {{ .Values.agent.dnsPolicy }}
```

- [ ] **Step 3: Document behavior and opt-out**

In the Agent scheduling section, explain that host networking is required
because Agent network counters come from its process network namespace. State
that `ClusterFirstWithHostNet` keeps the internal Service endpoint resolvable,
and include the paired pod-network override.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test --test-name-pattern='Agent host network' tests/komari-chart.test.js
```

Expected: pass with zero failures.

---

### Task 3: Verify, Commit, and Publish the Chart

**Files:**
- Include all Task 1 and Task 2 files plus this plan in the implementation commit.
- CI updates `charts/komari/Chart.yaml` and `charts/komari/CHANGELOG.md` in its release commit.

**Interfaces:**
- Consumes: repository test and release configuration.
- Produces: a tagged patch version at `oci://ghcr.io/community-helm-charts/komari`.

- [ ] **Step 1: Run chart and repository verification**

Run:

```bash
node --test tests/komari-chart.test.js
pnpm test
verify_dir="$(mktemp -d)"
trap 'rm -r -- "$verify_dir"' EXIT
cp -R charts/komari "$verify_dir/komari"
mkdir -p "$verify_dir/komari/charts" "$verify_dir/packages"
helm package charts/common --destination "$verify_dir/komari/charts"
helm lint "$verify_dir/komari"
helm package "$verify_dir/komari" --destination "$verify_dir/packages"
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 2: Review the exact change**

Run:

```bash
git diff --stat
git diff
git status --short
```

Confirm only the plan, Komari test, values, DaemonSet template, and README are
changed.

- [ ] **Step 3: Commit and push**

Run:

```bash
git add docs/superpowers/plans/2026-07-31-komari-agent-host-network.md \
  tests/komari-chart.test.js \
  charts/komari/values.yaml \
  charts/komari/templates/agent-daemonset.yaml \
  charts/komari/README.md
git commit -m "fix(komari): collect agent host network traffic"
git push origin main
```

- [ ] **Step 4: Verify release publication**

Wait for the `CI` workflow triggered by the implementation commit. Confirm it
passes, fetch the release commit and tag, and verify the new version is
available with:

```bash
helm show chart oci://ghcr.io/community-helm-charts/komari --version 1.1.1
```

---

### Task 4: Upgrade and Verify `kudeploy`

**Files:**
- No repository files.

**Interfaces:**
- Consumes: published Komari OCI patch release and existing Helm release values.
- Produces: revision 6 or later of release `komari` in namespace `komari`.

- [ ] **Step 1: Upgrade the immutable OCI version**

Run:

```bash
helm --kube-context kudeploy upgrade komari \
  oci://ghcr.io/community-helm-charts/komari \
  --version 1.1.1 \
  --namespace komari \
  --reuse-values \
  --rollback-on-failure \
  --wait \
  --timeout 5m
```

- [ ] **Step 2: Verify rollout and pod settings**

Confirm the DaemonSet is fully updated and each Agent pod has:

```text
spec.hostNetwork=true
spec.dnsPolicy=ClusterFirstWithHostNet
status.containerStatuses[0].ready=true
status.containerStatuses[0].restartCount=0
```

- [ ] **Step 3: Verify the original symptom**

For each Agent pod, confirm its pod IP equals its host IP and `/proc/net/dev`
contains the node primary interface `ens3`. Confirm that `komari-server`
resolves from the Agent container. Confirm the server remains Ready and
`https://monitor.huangxudong.com` returns HTTP 200 with valid TLS.
