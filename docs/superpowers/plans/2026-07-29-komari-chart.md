# Komari Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single Helm chart that deploys a stateful Komari server by default and an optional per-node Komari Agent DaemonSet.

**Architecture:** The `komari` application chart uses the local `common` library and separates all workload values and resources under `server.*` and `agent.*`. The server owns a single-replica StatefulSet, Service, optional Ingress, and `/app/data` persistence; the Agent owns a DaemonSet, Secret-backed auto-discovery, and a per-node identity file persisted at `/opt/komari/auto-discovery.json`.

**Tech Stack:** Helm 3 templates, Kubernetes `apps/v1`, repository `common` chart `0.2.1`, Node.js built-in test runner, pnpm/Nx.

## Global Constraints

- Create one chart at `charts/komari`; do not create separate server, Agent, or umbrella charts.
- Set chart version to `1.0.0` and `appVersion` to `1.3.2`.
- Pin the server image to `ghcr.io/komari-monitor/komari:1.3.2`.
- Pin the Agent image to `ghcr.io/komari-monitor/komari-agent:1.2.60`.
- Keep `server.enabled: true` and `agent.enabled: false`.
- Keep the server StatefulSet at exactly one replica.
- Mount server data at `/app/data`.
- Inject the Agent endpoint through `AGENT_ENDPOINT`.
- Inject the auto-discovery key through a Kubernetes Secret and `AGENT_AUTO_DISCOVERY_KEY`; never render it in container arguments.
- Set `AGENT_DISABLE_AUTO_UPDATE=true` by default.
- Default Agent tolerations to one entry with `operator: Exists`.
- Persist Agent identity on each node at `/opt/komari/auto-discovery.json` and mount it in the container at `/app/auto-discovery.json`.
- Support `hostPath` and `emptyDir` Agent identity volume types.
- Follow red-green-refactor for every production behavior.

---

## File Structure

- `charts/komari/Chart.yaml`: chart metadata, image annotations, and local common dependency.
- `charts/komari/.helmignore`: excludes packaging noise.
- `charts/komari/values.yaml`: documented global, server, Agent, and extension values.
- `charts/komari/templates/_helpers.tpl`: names, images, ServiceAccounts, endpoint, Secret selection, port validation, and Agent configuration validation.
- `charts/komari/templates/validate-values.yaml`: invokes validation for every render.
- `charts/komari/templates/server-statefulset.yaml`: stateful single-replica server workload and storage.
- `charts/komari/templates/server-service.yaml`: server network Service.
- `charts/komari/templates/server-serviceaccount.yaml`: server identity.
- `charts/komari/templates/server-ingress.yaml`: optional server HTTP ingress and TLS Secrets.
- `charts/komari/templates/agent-daemonset.yaml`: optional Agent workload, identity initialization, Secret injection, and scheduling.
- `charts/komari/templates/agent-secret.yaml`: optional chart-managed auto-discovery Secret.
- `charts/komari/templates/agent-serviceaccount.yaml`: Agent identity.
- `charts/komari/templates/extra-list.yaml`: arbitrary additional release resources.
- `charts/komari/templates/NOTES.txt`: access and rollout guidance for enabled components.
- `charts/komari/README.md`: installation, configuration, security, persistence, and scheduling guidance.
- `charts/komari/CHANGELOG.md`: initial chart release entry.
- `tests/komari-chart.test.js`: metadata, render, validation, and documentation regression tests.

---

### Task 1: Chart Metadata and Test Harness

**Files:**
- Create: `tests/komari-chart.test.js`
- Create: `charts/komari/Chart.yaml`
- Create: `charts/komari/.helmignore`

**Interfaces:**
- Consumes: Helm executable on `PATH`; source chart `charts/common` version `0.2.1`.
- Produces: `makeKomariChart()`, `resourceNames(manifest, kind)`, and `readChartFile(file)` test helpers used by all later tasks.

- [ ] **Step 1: Write the failing metadata test and reusable chart renderer**

Create `tests/komari-chart.test.js` with these imports and helpers:

```js
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeKomariChart() {
  const dir = mkdtempSync(join(tmpdir(), "komari-chart-"));
  const chart = join(dir, "komari");
  cpSync(join(ROOT, "charts", "komari"), chart, { recursive: true });
  rmSync(join(chart, "charts"), { force: true, recursive: true });
  mkdirSync(join(chart, "charts"), { recursive: true });

  const output = execFileSync(
    "helm",
    ["package", join(ROOT, "charts", "common"), "--destination", join(chart, "charts")],
    { encoding: "utf8" },
  );
  assert.match(output, /common-.*\.tgz/);

  function render(...args) {
    return execFileSync("helm", ["template", "komari", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function renderResult(...args) {
    return spawnSync("helm", ["template", "komari", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function cleanup() {
    rmSync(dir, { force: true, recursive: true });
  }

  return { cleanup, render, renderResult };
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

function readChartFile(file) {
  return readFileSync(join(ROOT, "charts", "komari", file), "utf8");
}

test("chart metadata pins stable Komari images and the local common dependency", () => {
  const chart = readChartFile("Chart.yaml");

  assert.match(chart, /^name: komari$/m);
  assert.match(chart, /^version: 1\.0\.0$/m);
  assert.match(chart, /^appVersion: "1\.3\.2"$/m);
  assert.match(chart, /image: ghcr\.io\/komari-monitor\/komari:1\.3\.2/);
  assert.match(chart, /image: ghcr\.io\/komari-monitor\/komari-agent:1\.2\.60/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
  assert.match(chart, /version: 0\.2\.1/);
});
```

- [ ] **Step 2: Run the metadata test and verify it fails**

Run:

```bash
node --test --test-name-pattern="chart metadata" tests/komari-chart.test.js
```

Expected: FAIL because `charts/komari/Chart.yaml` does not exist.

- [ ] **Step 3: Add exact chart metadata**

Create `charts/komari/Chart.yaml`:

```yaml
annotations:
  images: |
    - name: komari
      image: ghcr.io/komari-monitor/komari:1.3.2
    - name: komari-agent
      image: ghcr.io/komari-monitor/komari-agent:1.2.60
  licenses: MIT
apiVersion: v2
appVersion: "1.3.2"
dependencies:
  - name: common
    repository: file://../common
    version: 0.2.1
description: Komari server monitoring with an optional per-node Agent.
home: https://github.com/community-helm-charts/helm-charts
keywords:
  - komari
  - monitoring
  - server-monitoring
maintainers:
  - name: community-helm-charts
    url: https://github.com/community-helm-charts/helm-charts
name: komari
sources:
  - https://github.com/community-helm-charts/helm-charts/tree/main/charts/komari
  - https://github.com/komari-monitor/komari
  - https://github.com/komari-monitor/komari-agent
type: application
version: 1.0.0
```

Create `charts/komari/.helmignore` with:

```text
.DS_Store
.git/
.gitignore
.helmignore
.idea/
.project
.tmp/
.vscode/
*.swp
*.tmp
*.tgz
```

- [ ] **Step 4: Run the metadata test and verify it passes**

Run:

```bash
node --test --test-name-pattern="chart metadata" tests/komari-chart.test.js
```

Expected: one passing test and no failures.

- [ ] **Step 5: Commit the scaffold**

```bash
git add charts/komari/Chart.yaml charts/komari/.helmignore tests/komari-chart.test.js
git commit -m "feat: scaffold komari chart"
```

---

### Task 2: Default Stateful Server

**Files:**
- Create: `charts/komari/values.yaml`
- Create: `charts/komari/templates/_helpers.tpl`
- Create: `charts/komari/templates/validate-values.yaml`
- Create: `charts/komari/templates/server-serviceaccount.yaml`
- Create: `charts/komari/templates/server-service.yaml`
- Create: `charts/komari/templates/server-statefulset.yaml`
- Create: `charts/komari/templates/extra-list.yaml`
- Modify: `tests/komari-chart.test.js`

**Interfaces:**
- Consumes: common helpers `common.names.*`, `common.labels.*`, `common.images.*`, `common.storage.className`, `common.resources.preset`, and `common.compatibility.renderSecurityContext`.
- Produces: `komari.server.fullname`, `komari.server.image`, `komari.server.imagePullSecrets`, `komari.server.serviceAccountName`, `komari.server.serviceName`, and `komari.validateValues` helpers.

- [ ] **Step 1: Add failing tests for the default server and storage modes**

Append tests that assert the exact default behavior:

```js
test("default render creates only the stateful Komari server", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render();

    assert.deepEqual(resourceNames(manifest, "StatefulSet"), ["komari-server"]);
    assert.deepEqual(resourceNames(manifest, "DaemonSet"), []);
    assert.deepEqual(resourceNames(manifest, "Service"), ["komari-server"]);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["komari-server"]);
    assert.deepEqual(resourceNames(manifest, "Secret"), []);
    assert.match(manifest, /replicas: 1/);
    assert.match(manifest, /image: ghcr\.io\/komari-monitor\/komari:1\.3\.2/);
    assert.match(manifest, /containerPort: 25774/);
    assert.match(manifest, /mountPath: \/app\/data/);
    assert.match(manifest, /volumeClaimTemplates:/);
    assert.match(manifest, /storage: "5Gi"/);
  } finally {
    chart.cleanup();
  }
});

test("server persistence supports existing claims and temporary storage", () => {
  const chart = makeKomariChart();
  try {
    const existing = chart.render("--set", "server.persistence.existingClaim=komari-data");
    assert.match(existing, /claimName: komari-data/);
    assert.doesNotMatch(existing, /volumeClaimTemplates:/);

    const temporary = chart.render("--set", "server.persistence.enabled=false");
    assert.match(temporary, /emptyDir: \{\}/);
    assert.doesNotMatch(temporary, /volumeClaimTemplates:/);
  } finally {
    chart.cleanup();
  }
});
```

- [ ] **Step 2: Run the default-server tests and verify they fail**

Run:

```bash
node --test --test-name-pattern="default render|server persistence" tests/komari-chart.test.js
```

Expected: FAIL because `values.yaml` and the server templates are absent.

- [ ] **Step 3: Add documented server defaults**

Create `values.yaml` with these concrete groups:

```yaml
global:
  imageRegistry: ""
  imagePullSecrets: []
  defaultStorageClassName: ""
  storageClassName: ""

kubeVersion: ""
nameOverride: ""
fullnameOverride: ""
namespaceOverride: ""
clusterDomain: cluster.local
commonLabels: {}
commonAnnotations: {}
extraDeploy: []

server:
  enabled: true
  image:
    registry: ghcr.io
    repository: komari-monitor/komari
    tag: 1.3.2
    digest: ""
    pullPolicy: IfNotPresent
    pullSecrets: []
  containerPorts:
    http: 25774
  service:
    enabled: true
    type: ClusterIP
    ports:
      http: 25774
    nodePorts:
      http: ""
    clusterIP: ""
    annotations: {}
    labels: {}
    internalTrafficPolicy: Cluster
    externalTrafficPolicy: Cluster
    loadBalancerClass: ""
    loadBalancerIP: ""
    loadBalancerSourceRanges: []
    sessionAffinity: None
    sessionAffinityConfig: {}
    ipFamilyPolicy: ""
    ipFamilies: []
    extraPorts: []
  persistence:
    enabled: true
    volumeName: data
    mountPath: /app/data
    subPath: ""
    storageClassName: ""
    accessModes:
      - ReadWriteOnce
    size: 5Gi
    annotations: {}
    labels: {}
    selector: {}
    dataSource: {}
    existingClaim: ""
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
  podLabels: {}
  podAnnotations: {}
  podSecurityContext:
    enabled: false
    fsGroupChangePolicy: Always
    sysctls: []
    supplementalGroups: []
    fsGroup: 1000
  containerSecurityContext:
    enabled: false
    runAsUser: 1000
    runAsGroup: 1000
    runAsNonRoot: true
    allowPrivilegeEscalation: false
    capabilities:
      drop:
        - ALL
    seccompProfile:
      type: RuntimeDefault
  resourcesPreset: none
  resources: {}
  startupProbe:
    enabled: false
    httpGet:
      path: /
      port: http
    initialDelaySeconds: 10
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 30
    successThreshold: 1
  livenessProbe:
    enabled: true
    httpGet:
      path: /
      port: http
    initialDelaySeconds: 30
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
    successThreshold: 1
  readinessProbe:
    enabled: true
    httpGet:
      path: /
      port: http
    initialDelaySeconds: 5
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
    successThreshold: 1
  customStartupProbe: {}
  customLivenessProbe: {}
  customReadinessProbe: {}
  priorityClassName: ""
  schedulerName: ""
  terminationGracePeriodSeconds: ""
  hostAliases: []
  affinity: {}
  nodeSelector: {}
  tolerations: []
  topologySpreadConstraints: []
  serviceAccount:
    create: true
    name: ""
    automountServiceAccountToken: false
    annotations: {}
  automountServiceAccountToken: false
```

Add this documented `server.ingress` group:

```yaml
  ingress:
    enabled: false
    pathType: ImplementationSpecific
    apiVersion: ""
    hostname: komari.local
    path: /
    annotations: {}
    ingressClassName: ""
    tls: false
    extraHosts: []
    extraPaths: []
    extraTls: []
    extraRules: []
    secrets: []
```

Add the exact `agent` defaults from Task 4 before its templates are introduced.

- [ ] **Step 4: Implement server helpers and validation**

Define the component names as `<release-fullname>-server`. Use the common image
helper for `server.image`. Validate both `server.containerPorts.http` and
`server.service.ports.http` with the same integer-and-range logic:

```gotemplate
{{- define "komari.validatePort" -}}
{{- $name := .name -}}
{{- $value := printf "%v" .value -}}
{{- if not (regexMatch "^[0-9]+$" $value) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" $name) -}}
{{- end -}}
{{- $port := int $value -}}
{{- if or (lt $port 1) (gt $port 65535) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" $name) -}}
{{- end -}}
{{- end -}}
```

Invoke `komari.validateValues` from `templates/validate-values.yaml` so invalid
values fail even when a conditional resource would otherwise hide them.

- [ ] **Step 5: Implement the server ServiceAccount, Service, and StatefulSet**

Guard all three resources with `server.enabled`; additionally guard the
Service with `server.service.enabled`. Use component-specific match labels.
The StatefulSet must contain:

```yaml
spec:
  replicas: 1
  serviceName: <server-service-name>
  template:
    spec:
      automountServiceAccountToken: false
      containers:
        - name: server
          ports:
            - name: http
              containerPort: 25774
              protocol: TCP
          volumeMounts:
            - name: data
              mountPath: /app/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 5Gi
```

Render existing claims under `spec.template.spec.volumes`, render `emptyDir`
when persistence is disabled, and render the claim template only when
persistence is enabled with no existing claim. Include command, args,
environment extensions, probes, resources, security, scheduling, extra
containers, volumes, and mounts from the exact values defined above.

- [ ] **Step 6: Add the shared extra-resource renderer**

Create `templates/extra-list.yaml`:

```gotemplate
{{- range .Values.extraDeploy }}
---
{{ include "common.tplvalues.render" (dict "value" . "context" $) }}
{{- end }}
```

- [ ] **Step 7: Run the server tests and full existing suite**

First append and run this storage-class regression test:

```js
test("server persistence inherits the global default StorageClass", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render("--set", "global.defaultStorageClassName=fast");
    assert.match(manifest, /storageClassName: fast/);
  } finally {
    chart.cleanup();
  }
});
```

Run:

```bash
node --test --test-name-pattern="default render|server persistence" tests/komari-chart.test.js
pnpm test
```

Expected: the new server tests pass and the full suite reports zero failures.

- [ ] **Step 8: Commit the default server**

```bash
git add charts/komari/values.yaml charts/komari/templates tests/komari-chart.test.js
git commit -m "feat: add komari server statefulset"
```

---

### Task 3: Server Ingress, Probes, and Access Notes

**Files:**
- Create: `charts/komari/templates/server-ingress.yaml`
- Create: `charts/komari/templates/NOTES.txt`
- Modify: `charts/komari/templates/server-statefulset.yaml`
- Modify: `charts/komari/templates/server-service.yaml`
- Modify: `tests/komari-chart.test.js`

**Interfaces:**
- Consumes: `server.ingress`, `server.service`, probe, and scheduling values from Task 2.
- Produces: optional Ingress and reader-facing server access instructions.

- [ ] **Step 1: Add failing tests for server customization**

```js
test("server ingress, probes, and scheduling values render", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render(
      "--set", "server.ingress.enabled=true",
      "--set", "server.ingress.hostname=monitor.example.com",
      "--set", "server.ingress.ingressClassName=traefik",
      "--set", "server.startupProbe.enabled=true",
      "--set", "server.customLivenessProbe.exec.command[0]=true",
      "--set", "server.nodeSelector.role=monitoring",
      "--set", "server.tolerations[0].operator=Exists",
    );

    assert.deepEqual(resourceNames(manifest, "Ingress"), ["komari-server"]);
    assert.match(manifest, /host: "monitor\.example\.com"/);
    assert.match(manifest, /ingressClassName: "traefik"/);
    assert.match(manifest, /startupProbe:[\s\S]*?port: http/);
    assert.match(manifest, /livenessProbe:\n\s+exec:\n\s+command:\n\s+- true/);
    assert.match(manifest, /nodeSelector:\n\s+role: monitoring/);
    assert.match(manifest, /tolerations:\n\s+- operator: Exists/);
  } finally {
    chart.cleanup();
  }
});

test("server resources disappear together when disabled", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render("--set", "server.enabled=false");
    assert.deepEqual(resourceNames(manifest, "StatefulSet"), []);
    assert.deepEqual(resourceNames(manifest, "Service"), []);
    assert.deepEqual(resourceNames(manifest, "Ingress"), []);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), []);
  } finally {
    chart.cleanup();
  }
});

test("server image registry and tag can be overridden", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render(
      "--set", "server.image.registry=registry.example.com",
      "--set", "server.image.repository=observability/komari",
      "--set", "server.image.tag=custom",
    );
    assert.match(manifest, /image: registry\.example\.com\/observability\/komari:custom/);
  } finally {
    chart.cleanup();
  }
});
```

- [ ] **Step 2: Run the new tests and verify the ingress test fails**

Run:

```bash
node --test --test-name-pattern="server ingress|server resources disappear" tests/komari-chart.test.js
```

Expected: the ingress test fails because no Ingress exists.

- [ ] **Step 3: Implement Bitnami-style server Ingress**

Render Ingress only under:

```gotemplate
{{- if and .Values.server.enabled .Values.server.service.enabled .Values.server.ingress.enabled }}
```

Use `common.capabilities.ingress.apiVersion`, `common.ingress.backend`, and the
server Service name. Render main host/path, extra paths, extra hosts, extra
rules, main TLS, extra TLS, and user-provided TLS Secrets. Merge ingress and
common annotations, and apply standard labels with the `server` component.

- [ ] **Step 4: Complete custom probes, Service options, and scheduling**

For every probe, use a custom probe object when non-empty; otherwise render the
default object without its `enabled` key. Complete Service support for
NodePort, LoadBalancer, traffic policies, IP families, session affinity, and
extra ports. Render scheduling values with `common.tplvalues.render`.

- [ ] **Step 5: Add conditional access notes**

`NOTES.txt` must cover Ingress, NodePort, LoadBalancer, and port-forward
access. Its port-forward command must target `svc/<server-service-name>` and
port `25774`. When the server is disabled, print `Komari server is disabled.`
without emitting a server access command.

- [ ] **Step 6: Run the tests**

Run:

```bash
node --test --test-name-pattern="server ingress|server resources disappear" tests/komari-chart.test.js
pnpm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit server access features**

```bash
git add charts/komari/templates charts/komari/values.yaml tests/komari-chart.test.js
git commit -m "feat: add komari server ingress"
```

---

### Task 4: Agent DaemonSet with Managed Auto-Discovery

**Files:**
- Create: `charts/komari/templates/agent-secret.yaml`
- Create: `charts/komari/templates/agent-serviceaccount.yaml`
- Create: `charts/komari/templates/agent-daemonset.yaml`
- Modify: `charts/komari/values.yaml`
- Modify: `charts/komari/templates/_helpers.tpl`
- Modify: `charts/komari/templates/NOTES.txt`
- Modify: `tests/komari-chart.test.js`

**Interfaces:**
- Consumes: in-release server Service name and port when `agent.endpoint` is empty.
- Produces: `komari.agent.fullname`, `komari.agent.image`, `komari.agent.imagePullSecrets`, `komari.agent.serviceAccountName`, `komari.agent.secretName`, `komari.agent.secretKey`, and `komari.agent.endpoint`.

- [ ] **Step 1: Add a failing combined-release Agent test**

```js
test("enabled Agent uses managed discovery, internal endpoint, and per-node identity", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render(
      "--set", "agent.enabled=true",
      "--set-string", "agent.auth.autoDiscoveryKey=discovery-key",
    );

    assert.deepEqual(resourceNames(manifest, "DaemonSet"), ["komari-agent"]);
    assert.deepEqual(resourceNames(manifest, "Secret"), ["komari-agent"]);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["komari-agent", "komari-server"]);
    assert.match(manifest, /image: ghcr\.io\/komari-monitor\/komari-agent:1\.2\.60/);
    assert.match(manifest, /stringData:\n\s+auto-discovery-key: "discovery-key"/);
    assert.match(manifest, /name: AGENT_ENDPOINT\n\s+value: "http:\/\/komari-server:25774"/);
    assert.match(manifest, /name: AGENT_AUTO_DISCOVERY_KEY[\s\S]*?secretKeyRef:[\s\S]*?name: komari-agent[\s\S]*?key: auto-discovery-key/);
    assert.match(manifest, /name: AGENT_DISABLE_AUTO_UPDATE\n\s+value: "true"/);
    assert.match(manifest, /tolerations:\n\s+- operator: Exists/);
    assert.match(manifest, /path: \/opt\/komari\n\s+type: DirectoryOrCreate/);
    assert.match(manifest, /mountPath: \/app\/auto-discovery\.json\n\s+subPath: auto-discovery\.json/);
    assert.doesNotMatch(manifest, /--auto-discovery/);
    assert.doesNotMatch(manifest, /args:[\s\S]*?discovery-key/);
  } finally {
    chart.cleanup();
  }
});
```

- [ ] **Step 2: Run the Agent test and verify it fails**

Run:

```bash
node --test --test-name-pattern="enabled Agent uses managed" tests/komari-chart.test.js
```

Expected: FAIL because Agent values and resources do not exist.

- [ ] **Step 3: Add exact Agent defaults**

Append a top-level `agent` map to `values.yaml`:

```yaml
agent:
  enabled: false
  image:
    registry: ghcr.io
    repository: komari-monitor/komari-agent
    tag: 1.2.60
    digest: ""
    pullPolicy: IfNotPresent
    pullSecrets: []
  endpoint: ""
  disableAutoUpdate: true
  auth:
    autoDiscoveryKey: ""
    existingSecret: ""
    existingSecretKey: auto-discovery-key
  persistence:
    type: hostPath
    hostPath: /opt/komari
    fileName: auto-discovery.json
    mountPath: /app/auto-discovery.json
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
  podLabels: {}
  podAnnotations: {}
  podSecurityContext:
    enabled: false
    fsGroupChangePolicy: Always
    sysctls: []
    supplementalGroups: []
    fsGroup: 0
  containerSecurityContext:
    enabled: false
    runAsUser: 0
    runAsGroup: 0
    runAsNonRoot: false
    allowPrivilegeEscalation: false
    capabilities:
      drop:
        - ALL
    seccompProfile:
      type: RuntimeDefault
  resourcesPreset: none
  resources: {}
  priorityClassName: ""
  schedulerName: ""
  terminationGracePeriodSeconds: ""
  hostAliases: []
  affinity: {}
  nodeSelector: {}
  tolerations:
    - operator: Exists
  topologySpreadConstraints: []
  serviceAccount:
    create: true
    name: ""
    automountServiceAccountToken: false
    annotations: {}
  automountServiceAccountToken: false
```

Annotate every value with the repository's `## @section` and `## @param`
format when writing the actual file.

- [ ] **Step 4: Implement Agent helpers, managed Secret, and validation**

The endpoint helper must choose the explicit endpoint first and otherwise
derive:

```gotemplate
{{- printf "http://%s:%v" (include "komari.server.serviceName" .) .Values.server.service.ports.http -}}
```

When `agent.enabled` is true, validation must require either
`agent.auth.autoDiscoveryKey` or `agent.auth.existingSecret`, and must require
an explicit endpoint unless both `server.enabled` and
`server.service.enabled` are true.

Render the managed Secret only when the Agent is enabled and
`agent.auth.existingSecret` is empty:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: <agent-fullname>
type: Opaque
stringData:
  auto-discovery-key: <quoted managed key>
```

- [ ] **Step 5: Implement the Agent DaemonSet**

Use a component-specific selector and render this identity setup:

```yaml
initContainers:
  - name: prepare-identity
    image: <agent-image>
    command:
      - /bin/sh
      - -ec
    args:
      - touch "/identity/auto-discovery.json"
    volumeMounts:
      - name: identity
        mountPath: /identity
containers:
  - name: agent
    env:
      - name: AGENT_ENDPOINT
        value: "http://komari-server:25774"
      - name: AGENT_AUTO_DISCOVERY_KEY
        valueFrom:
          secretKeyRef:
            name: <agent-secret-name>
            key: <agent-secret-key>
      - name: AGENT_DISABLE_AUTO_UPDATE
        value: "true"
    volumeMounts:
      - name: identity
        mountPath: /app/auto-discovery.json
        subPath: auto-discovery.json
volumes:
  - name: identity
    hostPath:
      path: /opt/komari
      type: DirectoryOrCreate
```

Append user init containers after `prepare-identity`. Render all documented
security, resources, scheduling, environment imports, extra volumes and
mounts, and sidecars.

- [ ] **Step 6: Update notes and run the Agent test**

When Agent is enabled, notes must include:

```text
kubectl rollout status daemonset/<agent-fullname>
kubectl get pods -l app.kubernetes.io/component=agent
```

Run:

```bash
node --test --test-name-pattern="enabled Agent uses managed" tests/komari-chart.test.js
pnpm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit the managed Agent**

```bash
git add charts/komari/values.yaml charts/komari/templates tests/komari-chart.test.js
git commit -m "feat: add komari agent daemonset"
```

---

### Task 5: Agent-Only, Existing Secret, EmptyDir, and Invalid Values

**Files:**
- Modify: `charts/komari/templates/_helpers.tpl`
- Modify: `charts/komari/templates/agent-daemonset.yaml`
- Modify: `charts/komari/templates/agent-secret.yaml`
- Modify: `tests/komari-chart.test.js`

**Interfaces:**
- Consumes: Agent helper interfaces from Task 4.
- Produces: complete validation messages and both supported Agent identity volume modes.

- [ ] **Step 1: Add failing Agent mode and validation tests**

```js
test("Agent-only mode uses an external endpoint and existing Secret", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render(
      "--set", "server.enabled=false",
      "--set", "agent.enabled=true",
      "--set", "agent.endpoint=https://monitor.example.com",
      "--set", "agent.auth.existingSecret=komari-discovery",
      "--set", "agent.auth.existingSecretKey=key",
    );

    assert.deepEqual(resourceNames(manifest, "StatefulSet"), []);
    assert.deepEqual(resourceNames(manifest, "Secret"), []);
    assert.match(manifest, /name: AGENT_ENDPOINT\n\s+value: "https:\/\/monitor\.example\.com"/);
    assert.match(manifest, /name: komari-discovery[\s\S]*?key: key/);
  } finally {
    chart.cleanup();
  }
});

test("Agent identity can use emptyDir", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render(
      "--set", "agent.enabled=true",
      "--set-string", "agent.auth.autoDiscoveryKey=discovery-key",
      "--set", "agent.persistence.type=emptyDir",
    );
    assert.match(manifest, /- name: identity\n\s+emptyDir: \{\}/);
    assert.doesNotMatch(manifest, /path: \/opt\/komari/);
  } finally {
    chart.cleanup();
  }
});

test("invalid Agent configuration fails with actionable messages", () => {
  const chart = makeKomariChart();
  try {
    const cases = [
      {
        args: ["--set", "agent.enabled=true"],
        message: /agent\.auth\.autoDiscoveryKey must not be empty/,
      },
      {
        args: [
          "--set", "server.enabled=false",
          "--set", "agent.enabled=true",
          "--set-string", "agent.auth.autoDiscoveryKey=key",
        ],
        message: /agent\.endpoint must not be empty/,
      },
      {
        args: [
          "--set", "server.service.enabled=false",
          "--set", "agent.enabled=true",
          "--set-string", "agent.auth.autoDiscoveryKey=key",
        ],
        message: /agent\.endpoint must not be empty/,
      },
      {
        args: [
          "--set", "agent.enabled=true",
          "--set", "agent.auth.existingSecret=komari-discovery",
          "--set-string", "agent.auth.existingSecretKey=",
        ],
        message: /agent\.auth\.existingSecretKey must not be empty/,
      },
      {
        args: [
          "--set", "agent.enabled=true",
          "--set-string", "agent.auth.autoDiscoveryKey=key",
          "--set", "agent.persistence.type=pvc",
        ],
        message: /agent\.persistence\.type must be hostPath or emptyDir/,
      },
    ];

    for (const entry of cases) {
      const result = chart.renderResult(...entry.args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, entry.message);
    }
  } finally {
    chart.cleanup();
  }
});
```

- [ ] **Step 2: Verify the new tests fail for missing alternate modes**

Run:

```bash
node --test --test-name-pattern="Agent-only|Agent identity|invalid Agent" tests/komari-chart.test.js
```

Expected: at least the emptyDir and validation cases fail.

- [ ] **Step 3: Complete Secret selection and endpoint validation**

When `existingSecret` is set, `komari.agent.secretName` must render the
templated existing name and `komari.agent.secretKey` must return
`existingSecretKey`. Otherwise both helpers return the managed Secret name and
the fixed `auto-discovery-key`.

Use these exact validation messages:

```text
agent.auth.autoDiscoveryKey must not be empty when agent is enabled and agent.auth.existingSecret is empty
agent.auth.existingSecretKey must not be empty when agent.auth.existingSecret is set
agent.endpoint must not be empty when agent is enabled without the in-release server Service
agent.persistence.type must be hostPath or emptyDir
```

- [ ] **Step 4: Render emptyDir identity storage**

Keep the same built-in init container and subPath mount for both volume modes.
Select only the volume source:

```gotemplate
{{- if eq .Values.agent.persistence.type "hostPath" }}
hostPath:
  path: {{ .Values.agent.persistence.hostPath }}
  type: DirectoryOrCreate
{{- else }}
emptyDir: {}
{{- end }}
```

- [ ] **Step 5: Add server port validation tests**

```js
test("invalid server ports are rejected", () => {
  const chart = makeKomariChart();
  try {
    for (const key of ["server.containerPorts.http", "server.service.ports.http"]) {
      for (const value of ["0", "65536", "not-a-port"]) {
        const result = chart.renderResult("--set-string", `${key}=${value}`);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`${key.replaceAll(".", "\\.")} must be an integer from 1 through 65535`));
      }
    }
  } finally {
    chart.cleanup();
  }
});
```

Run this test and verify it fails before completing `komari.validateValues`,
then run it again and verify all six invalid inputs fail for the intended
reason.

- [ ] **Step 6: Run all Komari tests and the repository suite**

```bash
node --test tests/komari-chart.test.js
pnpm test
```

Expected: all Komari tests pass and the repository suite reports zero failures.

- [ ] **Step 7: Commit alternate Agent modes and validation**

```bash
git add charts/komari/templates tests/komari-chart.test.js
git commit -m "feat: validate komari agent configuration"
```

---

### Task 6: Documentation, Changelog, and Release Verification

**Files:**
- Create: `charts/komari/README.md`
- Create: `charts/komari/CHANGELOG.md`
- Modify: `tests/komari-chart.test.js`

**Interfaces:**
- Consumes: all public values and behavior implemented in Tasks 1 through 5.
- Produces: operator documentation and final release evidence.

- [ ] **Step 1: Add a failing documentation test**

```js
test("README documents component modes, credentials, and persistence", () => {
  const readme = readChartFile("README.md");

  assert.match(readme, /server\.enabled/);
  assert.match(readme, /agent\.enabled/);
  assert.match(readme, /agent\.endpoint/);
  assert.match(readme, /agent\.auth\.autoDiscoveryKey/);
  assert.match(readme, /agent\.auth\.existingSecret/);
  assert.match(readme, /AGENT_AUTO_DISCOVERY_KEY/);
  assert.match(readme, /\/app\/data/);
  assert.match(readme, /\/opt\/komari\/auto-discovery\.json/);
  assert.match(readme, /operator: Exists/);
  assert.match(readme, /emptyDir/);
  assert.match(readme, /native Komari Agent/i);
  assert.match(readme, /AGENT_DISABLE_AUTO_UPDATE/);
});
```

- [ ] **Step 2: Run the documentation test and verify it fails**

Run:

```bash
node --test --test-name-pattern="README documents" tests/komari-chart.test.js
```

Expected: FAIL because `charts/komari/README.md` does not exist.

- [ ] **Step 3: Write operator documentation**

Create a README with these executable examples:

```bash
helm install komari ./charts/komari

helm install komari ./charts/komari \
  --set agent.enabled=true \
  --set-string agent.auth.autoDiscoveryKey='replace-with-key'

helm install komari-agent ./charts/komari \
  --set server.enabled=false \
  --set agent.enabled=true \
  --set agent.endpoint=https://monitor.example.com \
  --set agent.auth.existingSecret=komari-discovery
```

Document that the combined release derives its endpoint, the Secret key is
injected with `AGENT_AUTO_DISCOVERY_KEY`, server data lives at `/app/data`,
Agent identity lives at `/opt/komari/auto-discovery.json`, and native and
DaemonSet Agents must not share that file concurrently. Document the default
all-taint toleration, a restrictive nodeSelector/toleration example,
`emptyDir` identity loss, existing PVC use, Ingress, image overrides, and
`AGENT_DISABLE_AUTO_UPDATE=true`.

Include a values reference table covering every documented `server.*` and
`agent.*` value.

- [ ] **Step 4: Add the initial changelog**

Create `CHANGELOG.md`:

```markdown
# Changelog

## 1.0.0

- Add the stateful Komari server with persistent `/app/data` storage.
- Add the optional Komari Agent DaemonSet with Secret-backed auto-discovery.
- Persist per-node Agent identity and tolerate all node taints by default.
```

- [ ] **Step 5: Run the documentation and complete test suites**

```bash
node --test tests/komari-chart.test.js
pnpm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Lint the chart with its local dependency**

Use a temporary chart copy so no packaged dependency is committed:

```bash
verification_dir="$(mktemp -d)"
cp -R charts/komari "$verification_dir/komari"
mkdir -p "$verification_dir/komari/charts"
helm package charts/common --destination "$verification_dir/komari/charts"
helm lint "$verification_dir/komari"
```

Expected: `1 chart(s) linted, 0 chart(s) failed`.

- [ ] **Step 7: Verify clean package creation**

```bash
package_root="$(mktemp -d)"
cp -R charts/komari "$package_root/komari"
mkdir -p "$package_root/komari/charts"
helm package charts/common --destination "$package_root/komari/charts"
package_dir="$(mktemp -d)"
helm package "$package_root/komari" --destination "$package_dir"
tar -tzf "$package_dir/komari-1.0.0.tgz" | sort
```

Expected: package creation succeeds and the archive contains Chart metadata,
values, templates, README, changelog, and the common dependency without a
source `Chart.lock`.

- [ ] **Step 8: Review the implementation against the design**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD
```

Then compare every section of
`docs/superpowers/specs/2026-07-29-komari-chart-design.md` against the rendered
tests. Correct any missing requirement and rerun Steps 5 through 7.

- [ ] **Step 9: Commit documentation and final chart state**

```bash
git add charts/komari/README.md charts/komari/CHANGELOG.md tests/komari-chart.test.js
git commit -m "docs: add komari chart usage"
```

- [ ] **Step 10: Run fresh post-commit verification**

```bash
node --test tests/komari-chart.test.js
pnpm test
post_commit_root="$(mktemp -d)"
cp -R charts/komari "$post_commit_root/komari"
mkdir -p "$post_commit_root/komari/charts"
helm package charts/common --destination "$post_commit_root/komari/charts"
helm lint "$post_commit_root/komari"
git status --short
```

Expected: both test commands report zero failures, Helm reports zero failed
charts, and the worktree is clean.
