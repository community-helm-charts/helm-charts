# Cloudflared Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-oriented Helm chart that deploys a remotely managed Cloudflare Tunnel connector with secure token handling, fixed replicas, health checks, and optional metrics discovery.

**Architecture:** The chart creates a Deployment, a ServiceAccount, and either a chart-managed Secret or a reference to an existing Secret. Cloudflare owns route configuration; Helm owns only the connector pods and an optional metrics Service. Repository `common` helpers provide names, labels, images, resources, security contexts, and templated extensions.

**Tech Stack:** Helm 3 templates, Kubernetes apps/v1 and v1 resources, repository `common` chart `0.2.1`, Node.js built-in test runner, pnpm/Nx.

## Global Constraints

- Create chart `cloudflared` at version `1.0.0` with `appVersion: "2026.7.2"`.
- Pin the default image to `docker.io/cloudflare/cloudflared:2026.7.2` and annotate the Apache-2.0 license.
- Depend on `common` through `file://../common` at version `0.2.1`.
- Support remotely managed tunnel tokens only; do not create or update Cloudflare resources.
- Do not add CRDs, a Kubernetes API controller, RBAC permissions, local tunnel configuration files, autoscaling, or monitoring-specific custom resources.
- Do not discuss alternative traffic-entry mechanisms in chart documentation.
- Default to two fixed connector replicas, `resourcesPreset: nano`, API-token automount disabled, UID/GID `65532`, and `net.ipv4.ping_group_range: "65532 65532"`.
- Keep route hostnames and target services out of Helm values.
- Follow test-driven development: every production behavior starts with a focused test that is observed failing for the intended reason.

---

## File Structure

- `charts/cloudflared/Chart.yaml`: chart metadata, image annotation, license, and local common dependency.
- `charts/cloudflared/.helmignore`: excludes source-control and local build artifacts from packages.
- `charts/cloudflared/values.yaml`: documented public values for credentials, deployment, probes, metrics, security, scheduling, and extensions.
- `charts/cloudflared/templates/_helpers.tpl`: image, names, ServiceAccount, Secret, and generated argument helpers.
- `charts/cloudflared/templates/validate-values.yaml`: fail-fast validation for credentials, replicas, and metrics port.
- `charts/cloudflared/templates/secret.yaml`: optional chart-managed tunnel token.
- `charts/cloudflared/templates/serviceaccount.yaml`: API-token-free workload identity.
- `charts/cloudflared/templates/deployment.yaml`: connector workload, probes, security, scheduling, and extensions.
- `charts/cloudflared/templates/metrics-service.yaml`: optional ClusterIP metrics endpoint.
- `charts/cloudflared/templates/extra-list.yaml`: common `extraDeploy` rendering.
- `charts/cloudflared/templates/NOTES.txt`: operational inspection and restart commands.
- `charts/cloudflared/README.md`: install, authentication, remote routing, availability, probes, metrics, and rotation guidance.
- `charts/cloudflared/CHANGELOG.md`: initial chart release notes.
- `tests/cloudflared-chart.test.js`: chart metadata, rendering, validation, override, and documentation tests.

---

### Task 1: Core Connector Chart and Managed Token

**Files:**
- Create: `tests/cloudflared-chart.test.js`
- Create: `charts/cloudflared/Chart.yaml`
- Create: `charts/cloudflared/.helmignore`
- Create: `charts/cloudflared/values.yaml`
- Create: `charts/cloudflared/templates/_helpers.tpl`
- Create: `charts/cloudflared/templates/validate-values.yaml`
- Create: `charts/cloudflared/templates/secret.yaml`
- Create: `charts/cloudflared/templates/serviceaccount.yaml`
- Create: `charts/cloudflared/templates/deployment.yaml`
- Create: `charts/cloudflared/templates/extra-list.yaml`

**Interfaces:**
- Consumes: repository chart `charts/common` version `0.2.1`; Helm executable; Node.js test runner.
- Produces: values `auth.tunnelToken`, `replicaCount`, `image.*`, `tunnel.logLevel`, `tunnel.extraArgs`, `metrics.port`, probe settings, resources, security contexts, scheduling, and extension lists; helpers `cloudflared.fullname`, `cloudflared.image`, `cloudflared.imagePullSecrets`, `cloudflared.serviceAccountName`, `cloudflared.secretName`, `cloudflared.secretKey`, and `cloudflared.args`.

- [ ] **Step 1: Create the failing chart test harness and core behavior tests**

Create `tests/cloudflared-chart.test.js` with the reusable temporary-chart harness and the first three tests:

```js
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeCloudflaredChart() {
  const dir = mkdtempSync(join(tmpdir(), "cloudflared-chart-"));
  const chart = join(dir, "cloudflared");
  cpSync(join(ROOT, "charts", "cloudflared"), chart, { recursive: true });
  rmSync(join(chart, "charts"), { force: true, recursive: true });
  mkdirSync(join(chart, "charts"), { recursive: true });
  const output = execFileSync(
    "helm",
    ["package", join(ROOT, "charts", "common"), "--destination", join(chart, "charts")],
    { encoding: "utf8" },
  );
  assert.match(output, /common-.*\.tgz/);

  function render(...args) {
    return execFileSync(
      "helm",
      ["template", "cloudflared", chart, "--set-string", "auth.tunnelToken=test-token", ...args],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  function renderResult(...args) {
    return spawnSync("helm", ["template", "cloudflared", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), render, renderResult };
}

function resourceNames(manifest, kind) {
  return manifest
    .split(/^---$/m)
    .map((doc) => {
      const lines = doc.split("\n");
      if (!lines.some((line) => line === `kind: ${kind}`)) return "";
      const name = lines.find((line) => line.startsWith("  name: "));
      return name ? name.replace("  name: ", "").trim().replaceAll('"', "") : "";
    })
    .filter(Boolean)
    .sort();
}

test("chart metadata pins cloudflared 2026.7.2 and the local common dependency", () => {
  const chart = readFileSync(join(ROOT, "charts", "cloudflared", "Chart.yaml"), "utf8");
  assert.match(chart, /^name: cloudflared$/m);
  assert.match(chart, /^appVersion: "2026\.7\.2"$/m);
  assert.match(chart, /image: docker\.io\/cloudflare\/cloudflared:2026\.7\.2/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
  assert.match(chart, /version: 0\.2\.1/);
});

test("managed token renders a secure two-replica connector Deployment", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render();
    assert.deepEqual(resourceNames(manifest, "Deployment"), ["cloudflared"]);
    assert.deepEqual(resourceNames(manifest, "Secret"), ["cloudflared"]);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["cloudflared"]);
    assert.match(manifest, /replicas: 2/);
    assert.match(manifest, /image: docker\.io\/cloudflare\/cloudflared:2026\.7\.2/);
    assert.match(manifest, /stringData:\n\s+token: "test-token"/);
    assert.match(manifest, /name: TUNNEL_TOKEN[\s\S]*?name: cloudflared[\s\S]*?key: token/);
    assert.match(manifest, /- tunnel\n\s+- --no-autoupdate\n\s+- --loglevel\n\s+- info/);
    assert.match(manifest, /- --metrics\n\s+- 0\.0\.0\.0:2000\n\s+- run/);
    assert.match(manifest, /name: metrics\n\s+containerPort: 2000/);
    assert.match(manifest, /livenessProbe:[\s\S]*?path: \/ready[\s\S]*?port: metrics/);
    assert.match(manifest, /readinessProbe:[\s\S]*?path: \/ready[\s\S]*?port: metrics/);
    assert.match(manifest, /automountServiceAccountToken: false/);
    assert.match(manifest, /name: net\.ipv4\.ping_group_range\n\s+value: "65532 65532"/);
    assert.match(manifest, /runAsUser: 65532/);
    assert.match(manifest, /runAsNonRoot: true/);
    assert.match(manifest, /allowPrivilegeEscalation: false/);
  } finally {
    chart.cleanup();
  }
});

test("missing managed token fails before installation", () => {
  const chart = makeCloudflaredChart();
  try {
    const result = chart.renderResult();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /auth\.tunnelToken must not be empty when auth\.existingSecret is empty/);
  } finally {
    chart.cleanup();
  }
});
```

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run:

```bash
node --test tests/cloudflared-chart.test.js
```

Expected: FAIL because `charts/cloudflared` and its `Chart.yaml` do not exist. This proves the tests depend on the new chart rather than existing resources.

- [ ] **Step 3: Add metadata, defaults, helpers, validation, and the core resources**

Create `charts/cloudflared/Chart.yaml` with these exact metadata decisions:

```yaml
annotations:
  images: |
    - name: cloudflared
      image: docker.io/cloudflare/cloudflared:2026.7.2
  licenses: Apache-2.0
apiVersion: v2
appVersion: "2026.7.2"
dependencies:
  - name: common
    repository: file://../common
    version: 0.2.1
description: A remotely managed Cloudflare Tunnel connector.
home: https://github.com/community-helm-charts/helm-charts
keywords:
  - cloudflare
  - cloudflared
  - tunnel
maintainers:
  - name: community-helm-charts
    url: https://github.com/community-helm-charts/helm-charts
name: cloudflared
sources:
  - https://github.com/community-helm-charts/helm-charts/tree/main/charts/cloudflared
  - https://github.com/cloudflare/cloudflared
type: application
version: 1.0.0
```

Create `.helmignore` with these exact package exclusions:

```text
# Patterns to ignore when building packages.
.DS_Store
.git/
.gitignore
.bzr/
.bzrignore
.hg/
.hgignore
.svn/
*.swp
*.bak
*.tmp
*~
.project
.idea/
*.tmproj
CHANGELOG.md
Chart.lock
```

Define `values.yaml` with these exact defaults for the interfaces listed above:

```yaml
image:
  registry: docker.io
  repository: cloudflare/cloudflared
  tag: "2026.7.2"
  digest: ""
  pullPolicy: IfNotPresent
  pullSecrets: []
replicaCount: 2
auth:
  tunnelToken: ""
  existingSecret: ""
  existingSecretKey: token
tunnel:
  logLevel: info
  extraArgs: []
metrics:
  port: 2000
  service:
    enabled: false
command: []
args: []
resourcesPreset: nano
resources: {}
podSecurityContext:
  enabled: true
  sysctls:
    - name: net.ipv4.ping_group_range
      value: "65532 65532"
containerSecurityContext:
  enabled: true
  runAsUser: 65532
  runAsGroup: 65532
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: false
  capabilities:
    drop:
      - ALL
  seccompProfile:
    type: RuntimeDefault
serviceAccount:
  create: true
  name: ""
  automountServiceAccountToken: false
  annotations: {}
automountServiceAccountToken: false
global:
  imageRegistry: ""
  imagePullSecrets: []
kubeVersion: ""
nameOverride: ""
fullnameOverride: ""
namespaceOverride: ""
clusterDomain: cluster.local
commonLabels: {}
commonAnnotations: {}
extraDeploy: []
updateStrategy:
  type: RollingUpdate
command: []
args: []
extraEnvVars: []
extraEnvVarsCM: ""
extraEnvVarsSecret: ""
extraVolumes: []
extraVolumeMounts: []
initContainers: []
sidecars: []
livenessProbe:
  enabled: true
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 1
  successThreshold: 1
readinessProbe:
  enabled: true
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
  successThreshold: 1
customLivenessProbe: {}
customReadinessProbe: {}
podLabels: {}
podAnnotations: {}
priorityClassName: ""
schedulerName: ""
terminationGracePeriodSeconds: ""
hostAliases: []
affinity: {}
nodeSelector: {}
tolerations: []
topologySpreadConstraints: []
```

Document every value with `## @section` and `## @param` comments following `charts/shadowsocks/values.yaml`.

Implement `_helpers.tpl` so `cloudflared.args` emits this exact order:

```yaml
- tunnel
- --no-autoupdate
- --loglevel
- {{ .Values.tunnel.logLevel }}
- --metrics
- 0.0.0.0:{{ .Values.metrics.port }}
{{- range .Values.tunnel.extraArgs }}
- {{ tpl . $ | quote }}
{{- end }}
- run
```

Implement the managed Secret and ServiceAccount with common names, labels, annotations, and API-token automount policy. Add `validate-values.yaml` through a named helper included at the top of `deployment.yaml`; fail when the managed token is empty, `replicaCount` is not an integer at least one, or `metrics.port` is outside `1..65535`.

Implement `deployment.yaml` with the generated args unless `args` is non-empty, `TUNNEL_TOKEN` from the managed Secret, managed Secret checksum, named metrics port, default/custom probes, security contexts, resource preset precedence, and all documented extensions. Render `extraDeploy` in `extra-list.yaml` through `common.tplvalues.render`.

- [ ] **Step 4: Run the focused tests and verify green**

Run:

```bash
node --test tests/cloudflared-chart.test.js
```

Expected: all three Task 1 tests PASS with no warnings or stderr output.

- [ ] **Step 5: Commit the core connector chart**

```bash
git add charts/cloudflared tests/cloudflared-chart.test.js
git commit -m "feat(cloudflared): add remote tunnel connector"
```

---

### Task 2: Existing Secret and Validation Boundaries

**Files:**
- Modify: `tests/cloudflared-chart.test.js`
- Modify: `charts/cloudflared/templates/_helpers.tpl`
- Modify: `charts/cloudflared/templates/validate-values.yaml`
- Modify: `charts/cloudflared/templates/secret.yaml`
- Modify: `charts/cloudflared/templates/deployment.yaml`

**Interfaces:**
- Consumes: Task 1 helpers and values `auth.existingSecret`, `auth.existingSecretKey`, `replicaCount`, and `metrics.port`.
- Produces: existing Secret precedence, helper-selected Secret name/key, conditional managed Secret checksum, and complete documented validation messages.

- [ ] **Step 1: Add failing existing-Secret and invalid-value tests**

Append these tests:

```js
test("existing Secret is referenced without rendering a managed Secret or checksum", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set", "auth.existingSecret=shared-tunnel",
      "--set", "auth.existingSecretKey=credential",
    );
    assert.deepEqual(resourceNames(manifest, "Secret"), []);
    assert.match(manifest, /name: TUNNEL_TOKEN[\s\S]*?name: shared-tunnel[\s\S]*?key: credential/);
    assert.doesNotMatch(manifest, /checksum\/secret:/);
    assert.doesNotMatch(manifest, /test-token/);
  } finally {
    chart.cleanup();
  }
});

test("invalid authentication and numeric values fail with actionable errors", () => {
  const chart = makeCloudflaredChart();
  try {
    const cases = [
      [["--set", "auth.existingSecret=shared", "--set-string", "auth.existingSecretKey="], /auth\.existingSecretKey must not be empty when auth\.existingSecret is set/],
      [["--set-string", "auth.tunnelToken=test-token", "--set-string", "replicaCount=0"], /replicaCount must be an integer greater than or equal to 1/],
      [["--set-string", "auth.tunnelToken=test-token", "--set-string", "metrics.port=65536"], /metrics\.port must be an integer from 1 through 65535/],
    ];
    for (const [args, pattern] of cases) {
      const result = chart.renderResult(...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
    }
  } finally {
    chart.cleanup();
  }
});

test("managed token changes roll the Deployment without appearing in its pod spec", () => {
  const chart = makeCloudflaredChart();
  try {
    function deployment(manifest) {
      return manifest.split(/^---$/m).find((doc) => doc.includes("kind: Deployment"));
    }
    const first = deployment(chart.render("--set-string", "auth.tunnelToken=first-token"));
    const second = deployment(chart.render("--set-string", "auth.tunnelToken=second-token"));
    assert.ok(first);
    assert.ok(second);
    const firstChecksum = first.match(/checksum\/secret: ([a-f0-9]+)/)?.[1];
    const secondChecksum = second.match(/checksum\/secret: ([a-f0-9]+)/)?.[1];
    assert.ok(firstChecksum);
    assert.ok(secondChecksum);
    assert.notEqual(firstChecksum, secondChecksum);
    assert.doesNotMatch(first, /first-token/);
    assert.doesNotMatch(second, /second-token/);
  } finally {
    chart.cleanup();
  }
});
```

- [ ] **Step 2: Run the focused tests and verify failures are behavioral**

Run:

```bash
node --test tests/cloudflared-chart.test.js
```

Expected: existing Secret assertions or validation cases FAIL because Task 1 only supports the managed-token path. Failures must identify rendered Secret/checksum behavior or a missing validation message, not JavaScript syntax.

- [ ] **Step 3: Implement existing Secret precedence and complete validation**

Add helpers with these rules:

```gotemplate
{{- define "cloudflared.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- tpl .Values.auth.existingSecret $ -}}
{{- else -}}
{{- include "cloudflared.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "cloudflared.secretKey" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecretKey -}}
{{- else -}}
token
{{- end -}}
{{- end -}}
```

Guard `secret.yaml` with `not .Values.auth.existingSecret`. In `deployment.yaml`, render `checksum/secret` only for a chart-managed Secret, but always build the `secretKeyRef` from `cloudflared.secretName` and `cloudflared.secretKey`.

Extend validation so the four failures use these exact messages:

```text
auth.tunnelToken must not be empty when auth.existingSecret is empty
auth.existingSecretKey must not be empty when auth.existingSecret is set
replicaCount must be an integer greater than or equal to 1
metrics.port must be an integer from 1 through 65535
```

- [ ] **Step 4: Run all focused tests and verify green**

```bash
node --test tests/cloudflared-chart.test.js
```

Expected: all Task 1 and Task 2 tests PASS.

- [ ] **Step 5: Commit existing Secret support**

```bash
git add charts/cloudflared/templates tests/cloudflared-chart.test.js
git commit -m "feat(cloudflared): support existing tunnel secrets"
```

---

### Task 3: Metrics Service and Workload Overrides

**Files:**
- Modify: `tests/cloudflared-chart.test.js`
- Modify: `charts/cloudflared/values.yaml`
- Modify: `charts/cloudflared/templates/_helpers.tpl`
- Modify: `charts/cloudflared/templates/deployment.yaml`
- Create: `charts/cloudflared/templates/metrics-service.yaml`

**Interfaces:**
- Consumes: Task 1 named `metrics` container port and values `metrics.port`, `metrics.service.*`, `command`, `args`, `tunnel.logLevel`, probes, resources, scheduling, and extensions.
- Produces: optional Service named `<fullname>-metrics`; full user overrides without changing credential wiring.

- [ ] **Step 1: Add failing metrics Service and override tests**

Append:

```js
test("metrics Service is opt-in and targets the named metrics port", () => {
  const chart = makeCloudflaredChart();
  try {
    assert.deepEqual(resourceNames(chart.render(), "Service"), []);
    const manifest = chart.render(
      "--set", "metrics.service.enabled=true",
      "--set", "metrics.port=2100",
      "--set", "metrics.service.annotations.prometheus\\.io/scrape=true",
    );
    assert.deepEqual(resourceNames(manifest, "Service"), ["cloudflared-metrics"]);
    assert.match(manifest, /prometheus\.io\/scrape: "true"/);
    assert.match(manifest, /port: 2100\n\s+targetPort: metrics\n\s+protocol: TCP/);
    assert.match(manifest, /containerPort: 2100/);
    assert.match(manifest, /- 0\.0\.0\.0:2100/);
  } finally {
    chart.cleanup();
  }
});

test("connector command, probes, resources, scheduling, and extensions are configurable", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set", "image.registry=registry.example.com",
      "--set", "image.repository=network/cloudflared",
      "--set", "image.tag=custom",
      "--set", "tunnel.logLevel=debug",
      "--set-string", "tunnel.extraArgs[0]=--protocol",
      "--set-string", "tunnel.extraArgs[1]=http2",
      "--set", "livenessProbe.enabled=false",
      "--set", "customReadinessProbe.exec.command[0]=cloudflared",
      "--set", "customReadinessProbe.exec.command[1]=version",
      "--set", "resources.requests.cpu=25m",
      "--set", "nodeSelector.role=edge",
      "--set", "tolerations[0].operator=Exists",
      "--set", "extraEnvVars[0].name=EDGE_IP_VERSION",
      "--set-string", "extraEnvVars[0].value=4",
    );
    assert.match(manifest, /image: registry\.example\.com\/network\/cloudflared:custom/);
    assert.match(manifest, /- debug/);
    assert.match(manifest, /- "--protocol"\n\s+- "http2"\n\s+- run/);
    assert.doesNotMatch(manifest, /livenessProbe:/);
    assert.match(manifest, /readinessProbe:\n\s+exec:\n\s+command:\n\s+- cloudflared\n\s+- version/);
    assert.match(manifest, /requests:\n\s+cpu: 25m/);
    assert.match(manifest, /nodeSelector:\n\s+role: edge/);
    assert.match(manifest, /tolerations:\n\s+- operator: Exists/);
    assert.match(manifest, /name: EDGE_IP_VERSION\n\s+value: "4"/);
  } finally {
    chart.cleanup();
  }
});

test("full command and args overrides replace generated process settings", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set", "command[0]=/bin/sh",
      "--set-string", "args[0]=-ec",
      "--set-string", "args[1]=cloudflared version",
    );
    assert.match(manifest, /command:\n\s+- \/bin\/sh/);
    assert.match(manifest, /args:\n\s+- -ec\n\s+- cloudflared version/);
    assert.doesNotMatch(manifest, /- --no-autoupdate/);
  } finally {
    chart.cleanup();
  }
});
```

- [ ] **Step 2: Run focused tests and confirm the new assertions fail**

```bash
node --test tests/cloudflared-chart.test.js
```

Expected: FAIL because the metrics Service is absent or one or more override values are not yet rendered.

- [ ] **Step 3: Implement the optional Service and complete override rendering**

Expand `metrics.service` values with this exact interface:

```yaml
service:
  enabled: false
  type: ClusterIP
  clusterIP: ""
  annotations: {}
  labels: {}
  internalTrafficPolicy: Cluster
  sessionAffinity: None
  sessionAffinityConfig: {}
  ipFamilyPolicy: ""
  ipFamilies: []
  extraPorts: []
```

Add a `cloudflared.metricsServiceName` helper returning `<fullname>-metrics`. Render `metrics-service.yaml` only when enabled, use common labels plus `app.kubernetes.io/component: connector`, select connector pods, expose `metrics.port`, and target the named `metrics` container port. Render annotations, labels, cluster IP, traffic policy, session affinity, IP families, and extra ports only when configured.

Complete Deployment rendering for generated and explicit commands/args, custom/default probes, explicit resources over presets, environment imports, extra volumes and mounts, init containers, sidecars, and every scheduling value listed in the file structure.

- [ ] **Step 4: Run focused tests and verify green**

```bash
node --test tests/cloudflared-chart.test.js
```

Expected: all focused tests PASS with the Service absent by default and present only when explicitly enabled.

- [ ] **Step 5: Commit metrics and extensions**

```bash
git add charts/cloudflared tests/cloudflared-chart.test.js
git commit -m "feat(cloudflared): expose connector metrics options"
```

---

### Task 4: Operator Documentation and Release Verification

**Files:**
- Modify: `tests/cloudflared-chart.test.js`
- Create: `charts/cloudflared/README.md`
- Create: `charts/cloudflared/CHANGELOG.md`
- Create: `charts/cloudflared/templates/NOTES.txt`

**Interfaces:**
- Consumes: all chart values and operational behavior from Tasks 1-3.
- Produces: user-facing install and operations contract plus complete repository verification evidence.

- [ ] **Step 1: Add a failing documentation contract test**

Append:

```js
test("README documents remote management, credentials, availability, metrics, and rotation", () => {
  const readme = readFileSync(join(ROOT, "charts", "cloudflared", "README.md"), "utf8");
  assert.match(readme, /remotely managed/i);
  assert.match(readme, /auth\.tunnelToken/);
  assert.match(readme, /auth\.existingSecret/);
  assert.match(readme, /Helm release metadata/);
  assert.match(readme, /replicaCount/);
  assert.match(readme, /\/ready/);
  assert.match(readme, /metrics\.service\.enabled/);
  assert.match(readme, /kubectl rollout restart deployment/);
  assert.match(readme, /\.svc\.cluster\.local/);
});
```

- [ ] **Step 2: Run the focused test and verify the missing-file failure**

```bash
node --test tests/cloudflared-chart.test.js
```

Expected: FAIL with `ENOENT` for `charts/cloudflared/README.md`.

- [ ] **Step 3: Write README, notes, and changelog with concrete commands**

Write `README.md` with these exact operational examples:

```bash
helm install cloudflared oci://ghcr.io/community-helm-charts/cloudflared \
  --set-string auth.tunnelToken='<TUNNEL_TOKEN>'

kubectl create secret generic cloudflared-token \
  --from-literal=token='<TUNNEL_TOKEN>'

helm install cloudflared oci://ghcr.io/community-helm-charts/cloudflared \
  --set auth.existingSecret=cloudflared-token

kubectl rollout restart deployment/cloudflared
kubectl rollout status deployment/cloudflared
```

Explain that direct token values are stored in Helm release metadata, existing Secrets take priority, remote routes may target `http://service.namespace.svc.cluster.local:port`, fixed replicas provide availability rather than load balancing, `/ready` requires an active Cloudflare connection, and the metrics Service is enabled with `metrics.service.enabled=true`.

Write `NOTES.txt` using Helm-computed namespace and names. It must print rollout status, label-selected pod and log commands, the external Secret restart reminder when applicable, and the metrics Service DNS name and port only when enabled.

Write `CHANGELOG.md` with release `1.0.0`, dated `2026-08-04`, recording the remotely managed connector Deployment, managed/existing token modes, health checks, security defaults, and optional metrics Service.

- [ ] **Step 4: Run the focused tests and Helm lint**

```bash
node --test tests/cloudflared-chart.test.js
helm dependency build charts/cloudflared
helm lint charts/cloudflared --set-string auth.tunnelToken=test-token
```

Expected: tests PASS; dependency build packages `common-0.2.1.tgz`; Helm lint reports `0 chart(s) failed`.

- [ ] **Step 5: Run repository regression tests and packaging checks**

```bash
pnpm test
helm template cloudflared charts/cloudflared --set-string auth.tunnelToken=test-token >/dev/null
cloudflared_package_dir=$(mktemp -d)
helm package charts/cloudflared --dependency-update --destination "$cloudflared_package_dir"
git diff --check
git status --short
```

Expected: the entire Node suite passes, Helm renders and packages `cloudflared-1.0.0.tgz`, `git diff --check` is silent, and status contains only intentional chart, test, and plan changes. Remove generated `charts/cloudflared/Chart.lock` and `charts/cloudflared/charts/` if `helm dependency build` created them before committing, because source charts do not commit dependency locks or packaged dependencies.

- [ ] **Step 6: Commit documentation and final verification state**

```bash
git add charts/cloudflared tests/cloudflared-chart.test.js docs/superpowers/plans/2026-08-04-cloudflared-chart.md
git commit -m "docs(cloudflared): document connector chart"
```

After committing, rerun:

```bash
pnpm test
git status --short --branch
```

Expected: the complete suite passes and the worktree is clean.
