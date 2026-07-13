# Shadowsocks Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested `shadowsocks` Helm chart that runs ssserver-rust v1.24.0 as a host-networked DaemonSet and reads its password from a Kubernetes Secret-backed environment variable.

**Architecture:** The chart depends on the local `common` library and renders a ConfigMap, optional chart-managed Secret, ServiceAccount, DaemonSet, and TCP/UDP Service. `values.yaml` `config.*` values become the root of `config.json`; the template reserves `password` and injects `${SHADOWSOCKS_PASSWORD}`, while the DaemonSet sources that variable from a Secret.

**Tech Stack:** Helm 3 templates, Kubernetes apps/v1 and v1 resources, repository `common` chart 0.2.1, Node.js built-in test runner, Nx/nx-helm.

## Global Constraints

- Chart name `shadowsocks`, chart version `1.0.0`, app version `v1.24.0`.
- Default image `ghcr.io/shadowsocks/ssserver-rust:v1.24.0`.
- DaemonSet defaults: `hostNetwork: true`, `dnsPolicy: Default`.
- Default config: `server: "::"`, `server_port: 8388`, `method: aes-256-gcm`, `fast_open: true`, `mode: tcp_and_udp`.
- `config.*` maps directly to `config.json`; `config.password` is forbidden and the chart injects `${SHADOWSOCKS_PASSWORD}`.
- The managed Secret defaults to `changeme`; existing Secrets are supported.
- ClusterIP Service defaults to enabled with TCP/UDP ports following `config.server_port` and `internalTrafficPolicy: Local`.
- Do not commit `Chart.lock`, dependency archives, or packaged charts.

---

### Task 1: Establish the chart metadata contract

**Files:**
- Create: `tests/shadowsocks-chart.test.js`
- Create: `charts/shadowsocks/Chart.yaml`
- Create: `charts/shadowsocks/.helmignore`

**Interfaces:**
- Consumes: chart discovery under `charts/*` and local `common` version `0.2.1`.
- Produces: application chart metadata for `shadowsocks` version `1.0.0`.

- [ ] **Step 1: Write the failing metadata test**

Create the Node test imports and repository root constant, then add this exact test:

```js
test("chart metadata pins shadowsocks-rust v1.24.0 and the local common dependency", () => {
  const chart = readFileSync(join(ROOT, "charts", "shadowsocks", "Chart.yaml"), "utf8");
  assert.match(chart, /^name: shadowsocks$/m);
  assert.match(chart, /^version: 1\.0\.0$/m);
  assert.match(chart, /^appVersion: "v1\.24\.0"$/m);
  assert.match(chart, /image: ghcr\.io\/shadowsocks\/ssserver-rust:v1\.24\.0/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
  assert.match(chart, /version: 0\.2\.1/);
});
```

- [ ] **Step 2: Run RED**

Run `node --test --test-name-pattern="chart metadata" tests/shadowsocks-chart.test.js`.
Expected: FAIL with `ENOENT` for `charts/shadowsocks/Chart.yaml`.

- [ ] **Step 3: Add minimal metadata**

Create `Chart.yaml` with the exact names/versions/image above, `apiVersion: v2`, `type: application`, MIT license, repository maintainer/home/source metadata, Shadowsocks keywords, and dependency `{name: common, repository: file://../common, version: 0.2.1}`. Copy the repository-standard application `.helmignore`.

- [ ] **Step 4: Run GREEN and commit**

Run the Step 2 command and expect one PASS, then:

```bash
git add tests/shadowsocks-chart.test.js charts/shadowsocks/Chart.yaml charts/shadowsocks/.helmignore
git commit -m "test: define shadowsocks chart metadata"
```

### Task 2: Render the default chart

**Files:**
- Modify: `tests/shadowsocks-chart.test.js`
- Create: `charts/shadowsocks/values.yaml`
- Create: `charts/shadowsocks/templates/_helpers.tpl`
- Create: `charts/shadowsocks/templates/configmap.yaml`
- Create: `charts/shadowsocks/templates/secret.yaml`
- Create: `charts/shadowsocks/templates/daemonset.yaml`
- Create: `charts/shadowsocks/templates/service.yaml`
- Create: `charts/shadowsocks/templates/serviceaccount.yaml`
- Create: `charts/shadowsocks/templates/extra-list.yaml`

**Interfaces:**
- Consumes: image, config, auth, networking, probes, resources, security, scheduling, ServiceAccount, and extension values.
- Produces: `shadowsocks-config`, `shadowsocks-auth`, ServiceAccount, DaemonSet, and TCP/UDP Service.

- [ ] **Step 1: Add the failing render test**

Add the same temporary-chart harness used by `tests/openviking-chart.test.js`: copy the source chart, remove copied dependencies, package local `common`, expose `render(...args)` via `helm template`, expose `renderResult(...args)` via `spawnSync`, and clean up. Add `resourceNames()`.

The default test must assert exact resource names, v1.24.0 image, host network, Default DNS, all five config values, `${SHADOWSOCKS_PASSWORD}`, managed Secret value `changeme`, `secretKeyRef` name/key, config mount path, TCP/UDP 8388 container ports, TCP probes, ClusterIP TCP/UDP 8388 Service ports, and `internalTrafficPolicy: Local`.

- [ ] **Step 2: Run RED**

Run `node --test --test-name-pattern="default render" tests/shadowsocks-chart.test.js`.
Expected: FAIL because no ConfigMap or DaemonSet renders.

- [ ] **Step 3: Implement the values and helpers**

Use these exact core defaults and document every value with `@param` comments:

```yaml
image:
  registry: ghcr.io
  repository: shadowsocks/ssserver-rust
  tag: v1.24.0
  digest: ""
  pullPolicy: IfNotPresent
  pullSecrets: []
config:
  server: "::"
  server_port: 8388
  method: aes-256-gcm
  fast_open: true
  mode: tcp_and_udp
auth:
  password: changeme
  existingSecret: ""
  existingSecretPasswordKey: password
hostNetwork: true
dnsPolicy: Default
service:
  enabled: true
  type: ClusterIP
  internalTrafficPolicy: Local
resourcesPreset: nano
resources: {}
```

Add repository-standard global/common, image, service options, rolling update, liveness/readiness probe timings, pod/container security context, scheduling, ServiceAccount without token automount, extra env/volume/init/sidecar, and `extraDeploy` values.

Define helpers for fullname, image, pull secrets, ServiceAccount name, ConfigMap name `<fullname>-config`, Secret name `<fullname>-auth` or the templated existing name, server port, validation, and JSON rendering. JSON rendering deep-copies `.Values.config`, sets `password` to the literal `${SHADOWSOCKS_PASSWORD}`, then calls `toPrettyJson`.

- [ ] **Step 4: Implement the resources**

Render the ConfigMap and conditional Opaque Secret. Render an apps/v1 DaemonSet with common labels, ConfigMap and managed-Secret checksums, host networking, DNS policy, Secret env source, `/etc/shadowsocks-rust/config.json` subPath mount, TCP/UDP ports, optional TCP probes, resources/security/scheduling extensions, and ServiceAccount. Render the conditional Service with TCP/UDP ports from the server-port helper and all documented Service options. Render ServiceAccount and `extraDeploy` using existing repository patterns.

- [ ] **Step 5: Run GREEN and commit**

Run the Step 2 command and expect PASS, then:

```bash
git add charts/shadowsocks tests/shadowsocks-chart.test.js
git commit -m "feat: add shadowsocks daemonset chart"
```

### Task 3: Prove mapping, port propagation, and existing Secrets

**Files:**
- Modify: `tests/shadowsocks-chart.test.js`
- Modify if the new tests expose gaps: `charts/shadowsocks/templates/_helpers.tpl`, `secret.yaml`, `daemonset.yaml`, `service.yaml`

**Interfaces:**
- Consumes: arbitrary `config.*`, `config.server_port`, `auth.existingSecret`, and its key.
- Produces: arbitrary JSON, synchronized ports, and external Secret wiring.

- [ ] **Step 1: Write and run a custom config RED test**

Render with `config.server_port=9443`, `config.udp_timeout=300`, and `config.outbound_bind_addr=192.0.2.10`. Assert all fields appear in JSON, all four TCP/UDP workload and Service port occurrences use 9443, and 8388 is absent. Run only this test and confirm it fails before generalizing any incomplete renderer/port code.

- [ ] **Step 2: Implement and verify direct mapping**

Use the whole deep-copied config map plus injected password for JSON, and use the server-port helper in container ports, probes, and Service ports. Re-run the custom test and expect PASS.

- [ ] **Step 3: Write and run an existing Secret RED test**

Render with `auth.existingSecret=shared-shadowsocks` and `auth.existingSecretPasswordKey=credential`. Assert no Secret renders and the env source references exactly that Secret and key. Confirm RED, implement the conditional Secret/name behavior, then confirm GREEN.

- [ ] **Step 4: Commit**

```bash
git add charts/shadowsocks tests/shadowsocks-chart.test.js
git commit -m "feat: support shadowsocks config and existing secrets"
```

### Task 4: Validate unsafe and invalid values

**Files:**
- Modify: `tests/shadowsocks-chart.test.js`
- Modify: `charts/shadowsocks/templates/_helpers.tpl`

**Interfaces:**
- Consumes: plaintext `config.password`, invalid port, empty managed password, empty external Secret key.
- Produces: non-zero Helm rendering with stable messages.

- [ ] **Step 1: Add failing validation tests**

Use `renderResult()` to check non-zero status and these exact stderr fragments, running every test before implementation:

```text
config.password is reserved; configure auth.password or auth.existingSecret
config.server_port must be an integer from 1 through 65535
auth.password must not be empty when auth.existingSecret is empty
auth.existingSecretPasswordKey must not be empty when auth.existingSecret is set
```

- [ ] **Step 2: Implement minimal validation**

Use `hasKey` for the reserved password. Require `server_port`, stringify it, regex-check digits, convert it to an integer, and range-check 1–65535. If an existing Secret is selected require its key; otherwise require the managed password. Invoke validation before JSON mutation/rendering.

- [ ] **Step 3: Verify and commit**

Run `node --test tests/shadowsocks-chart.test.js` and expect all tests PASS, then:

```bash
git add charts/shadowsocks/templates/_helpers.tpl tests/shadowsocks-chart.test.js
git commit -m "feat: validate shadowsocks chart values"
```

### Task 5: Document and fully verify

**Files:**
- Modify: `tests/shadowsocks-chart.test.js`
- Create: `charts/shadowsocks/README.md`
- Create: `charts/shadowsocks/templates/NOTES.txt`

**Interfaces:**
- Consumes: final values and resource names.
- Produces: installation and operations guidance without exposing password values in NOTES.

- [ ] **Step 1: Add a failing documentation test**

Read README and assert it includes `changeme`, `auth.existingSecret`, `SHADOWSOCKS_PASSWORD`, `config.*`, `hostNetwork`, TCP, UDP, and `kubectl rollout restart daemonset`. Run only this test and expect `ENOENT`.

- [ ] **Step 2: Write README and NOTES**

Document v1.24.0 and `[::]:8388`, DaemonSet/host network, ClusterIP TCP/UDP, direct config mapping, reserved password, managed Secret install, existing Secret creation/install, and rollout restart after an external Secret change. NOTES identifies node and Service access without reading the Secret.

- [ ] **Step 3: Run complete verification**

Run `node --test tests/shadowsocks-chart.test.js`, then `pnpm test`; expect zero failures. In a temporary chart copy, package local `common`, run `helm dependency build`, `helm lint`, `helm template`, and `helm package`; expect exit 0 and `shadowsocks-1.0.0.tgz`. Remove the temporary data and confirm the source chart has no `Chart.lock`, `charts/`, or `.tgz` artifacts.

- [ ] **Step 4: Review and commit**

Run `git diff --check`, inspect `git diff --stat` and `git status --short`, then:

```bash
git add charts/shadowsocks tests/shadowsocks-chart.test.js
git commit -m "docs: add shadowsocks chart usage"
```
