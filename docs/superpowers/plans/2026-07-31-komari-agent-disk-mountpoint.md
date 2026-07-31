# Komari Agent Disk Mountpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Komari Agent from counting its identity-file bind mount as a second copy of the node root disk, publish Chart 1.1.2, and update `kudeploy`.

**Architecture:** Add a dedicated semicolon-delimited `agent.includeMountpoints` value that defaults to `/` and inject it through the official `AGENT_INCLUDE_MOUNTPOINTS` environment variable. Preserve identity persistence, network settings, and server configuration while protecting default, custom, and empty overrides with real Helm rendering tests.

**Tech Stack:** Helm 3 templates, Kubernetes `apps/v1` DaemonSet, Node.js built-in test runner, pnpm/Nx, GitHub Actions, Helm OCI.

## Global Constraints

- Keep `server.enabled: true` and `agent.enabled: false`.
- Default `agent.includeMountpoints` to `/`.
- Render the value through `AGENT_INCLUDE_MOUNTPOINTS`.
- Preserve `/opt/komari/auto-discovery.json` identity persistence.
- Preserve `agent.hostNetwork: true` and `agent.dnsPolicy: ClusterFirstWithHostNet`.
- Allow semicolon-delimited custom paths and an empty-string automatic-discovery opt-out.
- Do not add a host-root volume mount or expand container privileges.
- Do not manually edit Chart version; `fix(komari)` must generate 1.1.2 through Nx.

---

### Task 1: Protect the Mountpoint Filter Contract

**Files:**
- Modify: `tests/komari-chart.test.js`

**Interfaces:**
- Consumes: `makeKomariChart().render()` and Helm value overrides.
- Produces: DaemonSet rendering coverage for default, custom, and empty mountpoint filters.

- [ ] **Step 1: Add a failing rendering test**

Render an enabled Agent with a managed discovery key and assert its DaemonSet
contains:

```yaml
- name: AGENT_INCLUDE_MOUNTPOINTS
  value: "/"
```

Render a second manifest with:

```text
--set-string agent.includeMountpoints=/;/data
```

Assert the environment value is `"/;/data"`. Render once more with an empty
string and assert the value is `""`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='Agent mountpoint filter' tests/komari-chart.test.js
```

Expected: one failure because the current DaemonSet has no
`AGENT_INCLUDE_MOUNTPOINTS` environment entry.

---

### Task 2: Render and Document the Root Mountpoint Default

**Files:**
- Modify: `charts/komari/values.yaml`
- Modify: `charts/komari/templates/agent-daemonset.yaml`
- Modify: `charts/komari/README.md`

**Interfaces:**
- Consumes: `.Values.agent.includeMountpoints` as a string.
- Produces: `AGENT_INCLUDE_MOUNTPOINTS` in the Agent container environment.

- [ ] **Step 1: Add the documented value**

Add this Agent parameter and default:

```yaml
## @param agent.includeMountpoints Semicolon-delimited mountpoints included in disk statistics
includeMountpoints: "/"
```

- [ ] **Step 2: Inject the official environment variable**

After `AGENT_DISABLE_AUTO_UPDATE`, add:

```yaml
- name: AGENT_INCLUDE_MOUNTPOINTS
  value: {{ .Values.agent.includeMountpoints | quote }}
```

- [ ] **Step 3: Document disk monitoring**

Explain that the identity `subPath` and container root expose the same host
filesystem under different device names, that `/` prevents double counting,
and that users can supply semicolon-delimited mounted paths or `""` for
automatic discovery.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test --test-name-pattern='Agent mountpoint filter' tests/komari-chart.test.js
```

Expected: pass with zero failures.

---

### Task 3: Verify, Commit, and Publish Chart 1.1.2

**Files:**
- Include the plan, Komari test, values, DaemonSet template, and README.
- CI updates `charts/komari/Chart.yaml` and `charts/komari/CHANGELOG.md`.

**Interfaces:**
- Consumes: repository test and Nx release configuration.
- Produces: tag `komari@1.1.2` and OCI Chart 1.1.2.

- [ ] **Step 1: Run complete verification**

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

Expected: all tests pass, Helm reports zero lint failures, and
`komari-1.1.1.tgz` packages before the release commit.

- [ ] **Step 2: Review and commit the exact scope**

Confirm only the plan, test, values, Agent DaemonSet, and README changed. Commit:

```bash
git commit -m "fix(komari): avoid duplicate agent disk statistics"
```

- [ ] **Step 3: Push and verify publication**

Fast-forward push `main`, wait for the `CI` workflow, pull its release commit,
and verify:

```bash
helm show chart oci://ghcr.io/community-helm-charts/komari --version 1.1.2
```

---

### Task 4: Upgrade and Verify `kudeploy`

**Files:**
- No repository files.

**Interfaces:**
- Consumes: OCI Chart 1.1.2 and existing release values.
- Produces: a healthy Helm revision 7 or later.

- [ ] **Step 1: Dry-run with new defaults**

Use `--reset-then-reuse-values`, `--dry-run=server`, and `--hide-secret`.
Assert the rendered Agent environment contains
`AGENT_INCLUDE_MOUNTPOINTS="/"`, while host networking, the internal endpoint,
and public Ingress remain unchanged.

- [ ] **Step 2: Upgrade the immutable OCI version**

Run:

```bash
helm --kube-context kudeploy upgrade komari \
  oci://ghcr.io/community-helm-charts/komari \
  --version 1.1.2 \
  --namespace komari \
  --reset-then-reuse-values \
  --rollback-on-failure \
  --wait \
  --timeout 5m
```

- [ ] **Step 3: Verify the original symptom and regressions**

Require five updated and Ready Agent pods with zero restarts. For each pod,
assert `AGENT_INCLUDE_MOUNTPOINTS=/`, a non-empty identity file, successful
internal server HTTP access, a connected or recovered WebSocket, and exactly:

```text
Monitoring Mountpoints: [/]
```

Confirm `/` reports one root filesystem capacity instead of the previous
two-mount sum. Confirm host-network interface collection, the server
StatefulSet, valid public TLS with HTTP 200, tag `komari@1.1.2`, a clean
worktree, and synchronized `origin/main`.
