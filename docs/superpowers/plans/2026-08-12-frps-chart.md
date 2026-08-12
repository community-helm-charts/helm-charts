# FRP Server Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repository-native `frps` Helm chart that converts structured `config.*` values to TOML, mounts a file-backed token, and exposes separate external FRP and internal virtual-host Services.

**Architecture:** One fixed-replica Deployment runs `frps -c /etc/frp/frps.toml` with a `Recreate` strategy. Helm deep-copies `.Values.config`, injects the reserved file-backed token configuration, serializes it with `toToml`, and mounts the ConfigMap and Secret as separate read-only files. A LoadBalancer Service exposes FRP control and explicit proxy ports, a ClusterIP Service exposes HTTP/HTTPS virtual-host ports, and an optional Ingress targets only virtual-host HTTP.

**Tech Stack:** Helm 3 templates, Kubernetes `apps/v1` and core resources, repository `common` chart 0.2.1, Node.js `node:test`, `helm template`, `helm lint`, pnpm/Nx.

## Global Constraints

- Default and annotated image: `ghcr.io/fatedier/frps:v0.70.1`.
- Chart version: `1.0.0`; `appVersion: "v0.70.1"`; local `common` dependency: `0.2.1`.
- Deployment is always `replicas: 1` with `strategy.type: Recreate`; do not add a replica or strategy value.
- Default config fields are exactly `bindPort: 7000`, `vhostHTTPPort: 8080`, and `vhostHTTPSPort: 8443` before managed authentication is injected.
- Generated config path: `/etc/frp/frps.toml`; mounted token path: `/etc/frp/token`.
- Authentication always uses `auth.method = "token"` and FRP's file `tokenSource`.
- `config.auth.token` and `config.auth.tokenSource` are reserved; OIDC is out of scope.
- The primary Service defaults to `LoadBalancer`; the vhost Service defaults to `ClusterIP` and has no extra ports.
- Ingress is disabled by default and targets only the vhost Service's named `http` port.
- Follow strict RED → verify failure → GREEN → verify pass for every production behavior.

## File Structure

- `charts/frps/Chart.yaml`: chart metadata, image/license annotations, and local common dependency.
- `charts/frps/values.yaml`: documented public values and safe defaults.
- `charts/frps/templates/_helpers.tpl`: names, image, ports, authentication, validation, and TOML rendering helpers.
- `charts/frps/templates/validate-values.yaml`: invokes validation before resource rendering.
- `charts/frps/templates/configmap.yaml`: generated `frps.toml`.
- `charts/frps/templates/secret.yaml`: optional chart-managed token Secret.
- `charts/frps/templates/deployment.yaml`: fixed single-instance FRPS pod.
- `charts/frps/templates/service.yaml`: external FRP control/proxy Service.
- `charts/frps/templates/vhost-service.yaml`: internal HTTP/HTTPS virtual-host Service.
- `charts/frps/templates/ingress.yaml`: optional HTTP Ingress and optional TLS Secrets.
- `charts/frps/templates/serviceaccount.yaml`: optional ServiceAccount.
- `charts/frps/templates/extra-list.yaml`: `extraDeploy` resources.
- `charts/frps/templates/NOTES.txt`: endpoints, inspection commands, and token rotation guidance.
- `charts/frps/.helmignore`: package exclusions.
- `charts/frps/README.md`: operator guide and generated value reference.
- `charts/frps/CHANGELOG.md`: initial release notes.
- `tests/frps-chart.test.js`: real `helm template` behavior tests.

---

### Task 1: Chart skeleton, test harness, and metadata

**Files:**
- Create: `tests/frps-chart.test.js`
- Create: `charts/frps/Chart.yaml`
- Create: `charts/frps/values.yaml`
- Create: `charts/frps/.helmignore`

**Interfaces:**
- Consumes: repository `charts/common` package and the `helm` executable.
- Produces: `makeFrpsChart()`, `resourceNames(manifest, kind)`, chart metadata, and the complete public values tree used by later tasks.

- [ ] **Step 1: Write the failing metadata test and reusable real-Helm harness**

Create `tests/frps-chart.test.js` with these imports and helpers:

```js
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeFrpsChart() {
  const dir = mkdtempSync(join(tmpdir(), "frps-chart-"));
  const chart = join(dir, "frps");
  cpSync(join(ROOT, "charts", "frps"), chart, { recursive: true });
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
      ["template", "frps", chart, "--set-string", "auth.token=test-token", ...args],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  function renderResult(...args) {
    return spawnSync("helm", ["template", "frps", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  return {
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
    render,
    renderResult,
  };
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

test("chart metadata pins frps v0.70.1 and the local common dependency", () => {
  const chart = readFileSync(join(ROOT, "charts", "frps", "Chart.yaml"), "utf8");
  assert.match(chart, /^name: frps$/m);
  assert.match(chart, /^version: 1\.0\.0$/m);
  assert.match(chart, /^appVersion: "v0\.70\.1"$/m);
  assert.match(chart, /image: ghcr\.io\/fatedier\/frps:v0\.70\.1/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
  assert.match(chart, /version: 0\.2\.1/);
});
```

Production mutation caught: wrong image/app version or broken common dependency metadata.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
node --test --test-name-pattern='chart metadata' tests/frps-chart.test.js
```

Expected: FAIL with `ENOENT` for `charts/frps/Chart.yaml`.

- [ ] **Step 3: Add metadata and the full values contract**

Create `charts/frps/Chart.yaml` with `name: frps`, version `1.0.0`, app version `"v0.70.1"`, Apache-2.0 and image annotations, repository/upstream sources, proxy/server keywords, and the exact local common dependency from Global Constraints.

Create `charts/frps/values.yaml` with parameter annotations and these top-level sections and defaults:

```yaml
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
secretAnnotations: {}
extraDeploy: []

image:
  registry: ghcr.io
  repository: fatedier/frps
  tag: v0.70.1
  digest: ""
  pullPolicy: IfNotPresent
  pullSecrets: []

config:
  bindPort: 7000
  vhostHTTPPort: 8080
  vhostHTTPSPort: 8443

auth:
  token: ""
  existingSecret: ""
  existingSecretKey: token

service:
  type: LoadBalancer
  nodePorts:
    bind: ""
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

vhostService:
  type: ClusterIP
  clusterIP: ""
  annotations: {}
  labels: {}
  internalTrafficPolicy: Cluster
  sessionAffinity: None
  sessionAffinityConfig: {}
  ipFamilyPolicy: ""
  ipFamilies: []

ingress:
  enabled: false
  pathType: ImplementationSpecific
  apiVersion: ""
  hostname: frps.local
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

Continue the same file with `command`, `args`, environment imports, pod extensions, probes plus custom probe overrides, `resourcesPreset: nano`, `resources`, pod and container security contexts, scheduling, and ServiceAccount fields matching `charts/cloudflared/values.yaml`. Set `containerSecurityContext.enabled: true`, `runAsUser: 1000`, `runAsGroup: 1000`, `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, capability drop `ALL`, and `RuntimeDefault`. The upstream Alpine image does not declare `USER`, so an explicit non-zero UID/GID is required for `runAsNonRoot` to work; FRPS only binds the default unprivileged ports and writes logs to stdout.

Create `.helmignore` from `charts/cloudflared/.helmignore`.

- [ ] **Step 4: Run the metadata test to verify GREEN**

Run:

```bash
node --test --test-name-pattern='chart metadata' tests/frps-chart.test.js
```

Expected: PASS, one test and zero failures.

- [ ] **Step 5: Commit the skeleton**

```bash
git add charts/frps/Chart.yaml charts/frps/values.yaml charts/frps/.helmignore tests/frps-chart.test.js
git commit -m "feat(frps): scaffold chart"
```

### Task 2: Structured TOML and file-backed token authentication

**Files:**
- Modify: `tests/frps-chart.test.js`
- Create: `charts/frps/templates/_helpers.tpl`
- Create: `charts/frps/templates/validate-values.yaml`
- Create: `charts/frps/templates/configmap.yaml`
- Create: `charts/frps/templates/secret.yaml`

**Interfaces:**
- Consumes: `.Values.config`, `.Values.auth`, common naming/label helpers.
- Produces: helpers `frps.fullname`, `frps.image`, `frps.imagePullSecrets`, `frps.serviceAccountName`, `frps.secretName`, `frps.secretKey`, `frps.renderConfig`, `frps.validateValues`; resources `<fullname>-config` ConfigMap and optional `<fullname>-auth` Secret.

- [ ] **Step 1: Add failing behavior tests for TOML, both Secret sources, and validation**

Append tests that render with the default managed token and assert:

```js
test("default config becomes TOML with a file-backed token and no token plaintext", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render();
    assert.deepEqual(resourceNames(manifest, "ConfigMap"), ["frps-config"]);
    assert.deepEqual(resourceNames(manifest, "Secret"), ["frps-auth"]);
    assert.match(manifest, /frps\.toml: \|/);
    assert.match(manifest, /bindPort = 7000/);
    assert.match(manifest, /vhostHTTPPort = 8080/);
    assert.match(manifest, /vhostHTTPSPort = 8443/);
    assert.match(manifest, /\[auth\][\s\S]*method = "token"/);
    assert.match(manifest, /\[auth\.tokenSource\][\s\S]*type = "file"/);
    assert.match(manifest, /\[auth\.tokenSource\.file\][\s\S]*path = "\/etc\/frp\/token"/);
    assert.match(manifest, /stringData:\n\s+token: "test-token"/);
    const configMap = manifest.split(/^---$/m).find((doc) => doc.includes("kind: ConfigMap"));
    assert.ok(configMap);
    assert.doesNotMatch(configMap, /test-token/);
  } finally { chart.cleanup(); }
});

test("nested config maps, arrays, and object arrays become TOML", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render("-f", join(ROOT, "tests", "fixtures", "frps-nested-values.yaml"));
    assert.match(manifest, /\[transport\][\s\S]*maxPoolCount = 5/);
    assert.match(manifest, /\[transport\.tls\][\s\S]*force = true/);
    assert.match(manifest, /\[\[allowPorts\]\][\s\S]*start = 2000[\s\S]*end = 3000/);
    assert.match(manifest, /\[\[httpPlugins\]\][\s\S]*name = "user-manager"[\s\S]*ops = \["Login"\]/);
  } finally { chart.cleanup(); }
});
```

Create `tests/fixtures/frps-nested-values.yaml` with:

```yaml
auth:
  token: test-token
config:
  bindPort: 7000
  vhostHTTPPort: 8080
  vhostHTTPSPort: 8443
  transport:
    maxPoolCount: 5
    tls:
      force: true
  allowPorts:
    - start: 2000
      end: 3000
    - single: 3001
  httpPlugins:
    - name: user-manager
      addr: 127.0.0.1:9000
      path: /handler
      ops:
        - Login
```

Production mutations caught: losing nesting, serializing as YAML/JSON, or leaking token plaintext into ConfigMap.

Append an existing-Secret test that renders with:

```js
const manifest = chart.render(
  "--set-string", "auth.token=ignored-token",
  "--set", "auth.existingSecret=shared-frps",
  "--set", "auth.existingSecretKey=credential",
);
assert.deepEqual(resourceNames(manifest, "Secret"), []);
assert.doesNotMatch(manifest, /ignored-token/);
```

This task verifies existing Secret precedence only at the rendered-resource
boundary. Task 3 verifies the selected Secret key projection and
`/etc/frp/token` mount after the Deployment exists.

Add table-driven failure tests with these literal inputs and expected messages:

```js
const invalidCases = [
  [[], /auth\.token must not be empty when auth\.existingSecret is empty/],
  [["--set", "auth.existingSecret=shared", "--set-string", "auth.existingSecretKey="], /auth\.existingSecretKey must not be empty when auth\.existingSecret is set/],
  [["-f", join(ROOT, "tests", "fixtures", "frps-config-not-map.yaml")], /config must be a map/],
  [["--set-string", "auth.token=test", "--set-string", "config.bindPort=0"], /config\.bindPort must be an integer from 1 through 65535/],
  [["--set-string", "auth.token=test", "--set-string", "config.vhostHTTPPort=65536"], /config\.vhostHTTPPort must be an integer from 1 through 65535/],
  [["--set-string", "auth.token=test", "--set-string", "config.vhostHTTPSPort=1.5"], /config\.vhostHTTPSPort must be an integer from 1 through 65535/],
  [["--set-string", "auth.token=test", "--set-string", "config.bindPort=many"], /config\.bindPort must be an integer from 1 through 65535/],
  [["--set-string", "auth.token=test", "--set", "config.vhostHTTPPort=7000"], /config\.bindPort, config\.vhostHTTPPort, and config\.vhostHTTPSPort must be unique/],
  [["-f", join(ROOT, "tests", "fixtures", "frps-auth-not-map.yaml")], /config\.auth must be a map/],
  [["--set-string", "auth.token=test", "--set-string", "config.auth.token=unsafe"], /config\.auth\.token is managed by the chart and must not be set/],
  [["--set-string", "auth.token=test", "--set", "config.auth.tokenSource.type=file"], /config\.auth\.tokenSource is managed by the chart and must not be set/],
  [["--set-string", "auth.token=test", "--set", "config.auth.method=oidc"], /config\.auth\.method must be token when set/],
];
```

For each case, call `chart.renderResult(...args)`, assert a non-zero status, and match `stderr`. The first case deliberately omits the harness's default token by using `renderResult`. Create `frps-config-not-map.yaml` with `config: invalid` plus `auth.token: test`, and `frps-auth-not-map.yaml` with the three required ports, `config.auth: invalid`, and `auth.token: test`.

- [ ] **Step 2: Run the new tests to verify RED**

Run:

```bash
node --test --test-name-pattern='default config|nested config|existing Secret|rejects invalid' tests/frps-chart.test.js
```

Expected: selected tests FAIL because no templates render ConfigMap/Secret resources and invalid values are not rejected.

- [ ] **Step 3: Implement helpers, ConfigMap, Secret, and validation**

In `_helpers.tpl`, delegate naming/image helpers to common and implement authentication helpers with these exact decisions:

```gotemplate
{{- define "frps.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- tpl .Values.auth.existingSecret $ -}}
{{- else -}}
{{- printf "%s-auth" (include "frps.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "frps.secretKey" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecretKey -}}
{{- else -}}token{{- end -}}
{{- end -}}

{{- define "frps.renderConfig" -}}
{{- $config := mustDeepCopy .Values.config -}}
{{- $auth := default (dict) (get $config "auth") -}}
{{- $_ := set $auth "method" "token" -}}
{{- $_ := set $auth "tokenSource" (dict "type" "file" "file" (dict "path" "/etc/frp/token")) -}}
{{- $_ := set $config "auth" $auth -}}
{{- $config | toToml -}}
{{- end -}}
```

Implement `frps.validateValues` using `kindIs`, `hasKey`, `regexMatch`, integer conversion only after lexical validation, bounds checks, and a `dict` used as a set for duplicate ports. Emit the exact messages documented by the design, including:

```text
auth.token must not be empty when auth.existingSecret is empty
auth.existingSecretKey must not be empty when auth.existingSecret is set
config must be a map
config.bindPort must be an integer from 1 through 65535
config.vhostHTTPPort must be an integer from 1 through 65535
config.vhostHTTPSPort must be an integer from 1 through 65535
config.bindPort, config.vhostHTTPPort, and config.vhostHTTPSPort must be unique
config.auth must be a map
config.auth.token is managed by the chart and must not be set
config.auth.tokenSource is managed by the chart and must not be set
config.auth.method must be token when set
```

Make `validate-values.yaml` call the helper. Also begin `frps.renderConfig` and every resource template that directly reads `.Values.config.*` with `include "frps.validateValues" .`; this guarantees the documented validation error is raised before a non-map config can be dereferenced regardless of Helm template render order. Render `configmap.yaml` with key `frps.toml` and `include "frps.renderConfig"`. Render `secret.yaml` only without `existingSecret`, with `stringData.token` from `auth.token` and merged common/secret annotations.

- [ ] **Step 4: Verify TOML/auth/validation GREEN**

Run:

```bash
node --test --test-name-pattern='default config|nested config|existing Secret|rejects invalid' tests/frps-chart.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit configuration and authentication**

```bash
git add charts/frps/templates/_helpers.tpl charts/frps/templates/validate-values.yaml charts/frps/templates/configmap.yaml charts/frps/templates/secret.yaml tests/frps-chart.test.js tests/fixtures/frps-*.yaml
git commit -m "feat(frps): render secure server configuration"
```

### Task 3: Fixed single-instance Deployment and pod extensions

**Files:**
- Modify: `tests/frps-chart.test.js`
- Create: `charts/frps/templates/deployment.yaml`
- Create: `charts/frps/templates/serviceaccount.yaml`

**Interfaces:**
- Consumes: helpers and resources from Task 2 plus pod-related values.
- Produces: one Deployment `<fullname>`, one optional ServiceAccount, named ports `bind`, `vhost-http`, and `vhost-https`.

- [ ] **Step 1: Write a failing default Deployment behavior test**

Assert the rendered Deployment has literal one replica, `Recreate`, exact image, `-c /etc/frp/frps.toml`, named ports driven by config, TCP probes on `bind`, both read-only `subPath` mounts, Secret item key selection, ConfigMap/managed Secret checksums, API token automount disabled, resource preset output, and default security fields. Assert the token plaintext does not occur inside the Deployment document.

Key literal assertions:

```js
assert.match(deployment, /replicas: 1/);
assert.match(deployment, /strategy:\n\s+type: Recreate/);
assert.match(deployment, /image: ghcr\.io\/fatedier\/frps:v0\.70\.1/);
assert.match(deployment, /args:\n\s+- -c\n\s+- \/etc\/frp\/frps\.toml/);
assert.match(deployment, /mountPath: \/etc\/frp\/frps\.toml[\s\S]*subPath: frps\.toml[\s\S]*readOnly: true/);
assert.match(deployment, /mountPath: \/etc\/frp\/token[\s\S]*subPath: token[\s\S]*readOnly: true/);
assert.match(deployment, /livenessProbe:[\s\S]*tcpSocket:[\s\S]*port: bind/);
assert.match(deployment, /readOnlyRootFilesystem: true/);
assert.match(deployment, /automountServiceAccountToken: false/);
```

Production mutations caught: horizontal replicas, rolling overlap, wrong mount paths, stale Secret selection, or weakened defaults.

- [ ] **Step 2: Run the Deployment test to verify RED**

```bash
node --test --test-name-pattern='single-instance Deployment' tests/frps-chart.test.js
```

Expected: FAIL because no Deployment is rendered.

- [ ] **Step 3: Implement Deployment and ServiceAccount**

Follow `charts/cloudflared/templates/deployment.yaml` for repository conventions, but implement only the default workload behavior covered by Step 1 and hardcode:

```yaml
spec:
  replicas: 1
  strategy:
    type: Recreate
```

Default args are `-c` and `/etc/frp/frps.toml`. Declare three TCP ports from config. Mount `config` and `auth` volumes using single-key `items`, so the configured existing Secret key is projected to path `token`. Only include `checksum/secret` for the managed Secret. Implement the default TCP probes, resource preset, image pull secrets, API credential automount, and default security contexts needed by Step 1. Do not add custom command/args, custom probes, environment imports, scheduling, or pod extension branches until their failing tests in Step 5.

Create ServiceAccount from the cloudflared pattern with merged annotations and `automountServiceAccountToken`.

- [ ] **Step 4: Verify Deployment GREEN**

```bash
node --test --test-name-pattern='single-instance Deployment' tests/frps-chart.test.js
```

Expected: PASS.

- [ ] **Step 5: Add failing extension and checksum tests**

Add tests proving:

- changing any of the three config ports changes both TOML and matching container ports;
- managed config/token changes change their respective checksum without exposing plaintext in the Deployment;
- existing Secrets omit only the managed Secret checksum and project `existingSecretKey` to `token`;
- custom image, command/args, probes, explicit resources, labels, annotations, environment imports, scheduling, volumes, mounts, init containers, sidecars, and ServiceAccount settings render their observable Kubernetes fields.

Run:

```bash
node --test --test-name-pattern='port|checksum|extension|ServiceAccount|existing Secret' tests/frps-chart.test.js
```

Expected: at least the newly added extension tests FAIL because the corresponding branches have not yet been added to the Deployment template.

- [ ] **Step 6: Implement the missing extension branches and verify GREEN**

Add only the missing Deployment or ServiceAccount branches exercised by Step 5, following the exact common-helper rendering pattern in `charts/cloudflared/templates/deployment.yaml`.

Run:

```bash
node --test --test-name-pattern='port|checksum|extension|ServiceAccount|existing Secret' tests/frps-chart.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the workload**

```bash
git add charts/frps/templates/deployment.yaml charts/frps/templates/serviceaccount.yaml tests/frps-chart.test.js
git commit -m "feat(frps): deploy a single server instance"
```

### Task 4: External and virtual-host Services

**Files:**
- Modify: `tests/frps-chart.test.js`
- Modify: `charts/frps/templates/_helpers.tpl`
- Create: `charts/frps/templates/service.yaml`
- Create: `charts/frps/templates/vhost-service.yaml`

**Interfaces:**
- Consumes: config port helpers and pod match labels.
- Produces: Service `<fullname>` with `bind` plus `service.extraPorts`; Service `<fullname>-vhost` with only `http` and `https`.

- [ ] **Step 1: Write failing two-Service behavior tests**

Assert default resource names are `frps` and `frps-vhost`. Parse the two Service documents by metadata name, then assert:

```js
assert.match(externalService, /type: LoadBalancer/);
assert.match(externalService, /- name: bind\n\s+port: 7000\n\s+targetPort: bind\n\s+protocol: TCP/);
assert.doesNotMatch(externalService, /name: http|name: https/);
assert.match(vhostService, /type: ClusterIP/);
assert.match(vhostService, /- name: http\n\s+port: 8080\n\s+targetPort: vhost-http/);
assert.match(vhostService, /- name: https\n\s+port: 8443\n\s+targetPort: vhost-https/);
assert.doesNotMatch(vhostService, /name: bind/);
```

Add a render with `service.extraPorts[0]` as TCP 6000 and `[1]` as UDP 7002, then assert both appear only in the external Service. Add a policy render before implementation that sets external/internal annotations and labels, `internalTrafficPolicy`, `externalTrafficPolicy`, load-balancer fields, session affinity, and IP family fields and asserts the literal Kubernetes Service output. Production mutations caught: collapsing traffic classes into one Service, wrong port source, leaking proxy ports into the internal Service, or wiring policies to the wrong Service.

- [ ] **Step 2: Run Service tests to verify RED**

```bash
node --test --test-name-pattern='two Services|extra proxy ports|Service policies' tests/frps-chart.test.js
```

Expected: selected tests FAIL because no Services render.

- [ ] **Step 3: Implement Service helpers and templates**

Add helpers:

```gotemplate
{{- define "frps.serviceName" -}}{{ include "frps.fullname" . }}{{- end -}}
{{- define "frps.vhostServiceName" -}}{{ printf "%s-vhost" (include "frps.fullname" .) | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "frps.bindPort" -}}{{ .Values.config.bindPort }}{{- end -}}
{{- define "frps.vhostHTTPPort" -}}{{ .Values.config.vhostHTTPPort }}{{- end -}}
{{- define "frps.vhostHTTPSPort" -}}{{ .Values.config.vhostHTTPSPort }}{{- end -}}
```

Build `service.yaml` from the repository's full Service pattern, using `service.*`, bind nodePort conditionally for NodePort/LoadBalancer, and rendering `service.extraPorts` after bind. Build `vhost-service.yaml` with only ClusterIP-valid fields from `vhostService.*` and no extra-port branch. Both selectors must match the Deployment's `app.kubernetes.io/component: frps` label.

- [ ] **Step 4: Verify Service GREEN and policy fields**

```bash
node --test --test-name-pattern='two Services|extra proxy ports|Service policies' tests/frps-chart.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit Services**

```bash
git add charts/frps/templates/_helpers.tpl charts/frps/templates/service.yaml charts/frps/templates/vhost-service.yaml tests/frps-chart.test.js
git commit -m "feat(frps): separate control and vhost services"
```

### Task 5: Optional HTTP Ingress and generic extra resources

**Files:**
- Modify: `tests/frps-chart.test.js`
- Create: `charts/frps/templates/ingress.yaml`
- Create: `charts/frps/templates/extra-list.yaml`

**Interfaces:**
- Consumes: `frps.vhostServiceName`, named Service port `http`, common ingress compatibility helpers, `.Values.ingress`, `.Values.extraDeploy`.
- Produces: optional Ingress/TLS Secrets and arbitrary rendered extra resources.

- [ ] **Step 1: Write failing Ingress and extraDeploy tests**

Assert no Ingress by default. Enable `ingress.enabled`, set hostname/class/path/TLS, and assert the Ingress backend is `frps-vhost` port name `http`, never `https` or the primary Service. Add an extra host/path/TLS Secret case. Add `extraDeploy` with a literal ConfigMap and assert it renders with templated release/name context.

Production mutations caught: accidentally targeting FRP control, forwarding to 8443 behind TLS termination, or dropping extension resources.

- [ ] **Step 2: Run tests to verify RED**

```bash
node --test --test-name-pattern='Ingress|extraDeploy' tests/frps-chart.test.js
```

Expected: enabled Ingress and extraDeploy tests FAIL because templates are absent.

- [ ] **Step 3: Implement Ingress and extra-list templates**

Adapt `charts/openviking/templates/ingress.yaml` but always pass:

```gotemplate
{{ include "common.ingress.backend" (dict
  "serviceName" (include "frps.vhostServiceName" .)
  "servicePort" "http"
  "context" $) }}
```

Keep API version detection, ingress class, main/extra hosts and paths, extra rules, TLS and generated TLS Secrets. Render `extraDeploy` through `common.tplvalues.render` in `extra-list.yaml`.

- [ ] **Step 4: Verify Ingress and extra resources GREEN**

```bash
node --test --test-name-pattern='Ingress|extraDeploy' tests/frps-chart.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit routing and extensions**

```bash
git add charts/frps/templates/ingress.yaml charts/frps/templates/extra-list.yaml tests/frps-chart.test.js
git commit -m "feat(frps): add optional vhost ingress"
```

### Task 6: Operator documentation, notes, and full verification

**Files:**
- Modify: `tests/frps-chart.test.js`
- Create: `charts/frps/templates/NOTES.txt`
- Create: `charts/frps/README.md`
- Create: `charts/frps/CHANGELOG.md`

**Interfaces:**
- Consumes: the final public values and rendered resource names.
- Produces: complete operator handoff and a package-ready chart.

- [ ] **Step 1: Write failing rendered-NOTES test**

Render the chart and assert NOTES output contains the primary Service inspection command, the two internal vhost addresses, pod/log inspection commands, and—when `auth.existingSecret` is set—the exact restart instruction:

```text
kubectl rollout restart deployment/frps
```

Do not grep README prose in automated tests; review human documentation against the spec checklist instead.

- [ ] **Step 2: Run NOTES test to verify RED**

```bash
node --test --test-name-pattern='NOTES' tests/frps-chart.test.js
```

Expected: FAIL because `NOTES.txt` is absent.

- [ ] **Step 3: Implement NOTES and documentation**

Write `NOTES.txt` with LoadBalancer/NodePort/ClusterIP-specific bind instructions, internal HTTP/HTTPS Service DNS names, enabled Ingress URL, `kubectl get pods`, `kubectl logs`, and the external Secret rotation restart warning.

Write `README.md` with these concrete sections:

1. chart purpose and single-instance limitation;
2. prerequisites and install with `--set-string auth.token=...` plus Helm metadata warning;
3. existing Secret creation and `auth.existingSecret`/key install example;
4. default `config` and generated tokenSource TOML;
5. nested `config.*` example from the spec;
6. reserved authentication keys and validation behavior;
7. external LoadBalancer Service plus TCP/UDP `service.extraPorts` example;
8. internal 8080/8443 vhost Service;
9. optional HTTP Ingress with TLS termination explanation;
10. external Secret rotation restart command;
11. values parameter table covering every `## @param` entry.

Create `CHANGELOG.md` with an `1.0.0` entry for the initial chart release.

- [ ] **Step 4: Verify NOTES GREEN and review documentation coverage**

Run:

```bash
node --test --test-name-pattern='NOTES' tests/frps-chart.test.js
rg -n 'single|Recreate|existingSecret|tokenSource|service.extraPorts|8080|8443|Ingress|rollout restart' charts/frps/README.md
```

Expected: test PASS; each required documentation topic has at least one intentional occurrence. The `rg` output is a review aid, not a behavior test.

- [ ] **Step 5: Run focused chart tests**

```bash
node --test tests/frps-chart.test.js
```

Expected: all FRPS tests PASS with zero failures.

- [ ] **Step 6: Run Helm lint and package verification**

```bash
helm dependency build charts/frps
helm lint charts/frps --set-string auth.token=test-token
helm package charts/frps --destination "$(mktemp -d)"
```

Expected: dependency build succeeds, lint reports `0 chart(s) failed`, and package creates `frps-1.0.0.tgz` in the temporary directory. Do not commit `charts/frps/charts` or `Chart.lock` unless repository convention requires them; remove generated dependency artifacts from the worktree after verification.

- [ ] **Step 7: Run the complete repository suite**

```bash
pnpm test
```

Expected: Nx workspace test succeeds with zero failing tests.

- [ ] **Step 8: Verify the final diff and commit documentation**

```bash
git diff --check
git status --short
git add charts/frps/README.md charts/frps/CHANGELOG.md charts/frps/templates/NOTES.txt tests/frps-chart.test.js
git commit -m "docs(frps): document server chart"
git status --short --branch
```

Expected: diff check is clean; the final status has no uncommitted chart/test changes and shows only the expected commits ahead of the base branch.
