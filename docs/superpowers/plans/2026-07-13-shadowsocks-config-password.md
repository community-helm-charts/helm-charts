# Shadowsocks config.password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `config.password` create the Helm-managed Shadowsocks Secret named `<fullname>-secret`, while preserving higher-priority existing Secret support and migrating the deployed release without changing its password.

**Architecture:** `config.password` remains a special `config.*` value: the Secret template consumes its plaintext value, while the ConfigMap renderer replaces it with `${SHADOWSOCKS_PASSWORD}`. `auth.existingSecret` continues to bypass managed Secret creation and takes priority over `config.password`.

**Tech Stack:** Helm 4 templates, Kubernetes Secrets and DaemonSets, Node.js built-in test runner, kubectl v1.35, kudeploy cluster.

## Global Constraints

- Default `config.password` is `changeme`.
- The managed Secret name is `<fullname>-secret`; for the current release it is `shadowsocks-secret`.
- The managed Secret key remains `password`.
- ConfigMap `config.json` must contain `"password": "${SHADOWSOCKS_PASSWORD}"`, never the plaintext value.
- `auth.existingSecret` takes priority and causes `config.password` to be ignored.
- Preserve the currently deployed random password during migration.
- Preserve `dedicated=proxy-egress:NoSchedule` toleration.
- Delete `shadowsocks-credentials` only after the new release is Ready and the password values match.

---

### Task 1: Move managed password ownership to config.password

**Files:**
- Modify: `tests/shadowsocks-chart.test.js`
- Modify: `charts/shadowsocks/values.yaml`
- Modify: `charts/shadowsocks/templates/_helpers.tpl`
- Modify: `charts/shadowsocks/templates/secret.yaml`

**Interfaces:**
- Consumes: `.Values.config.password`, `.Values.auth.existingSecret`, `.Values.auth.existingSecretPasswordKey`.
- Produces: managed Secret `<fullname>-secret` or an existing Secret reference, plus redacted ConfigMap JSON.

- [ ] **Step 1: Write failing tests**

Change the default test to expect `shadowsocks-secret`. Replace the plaintext rejection test with:

```js
test("config.password creates the managed Secret but is replaced in config.json", () => {
  const chart = makeShadowsocksChart();
  try {
    const manifest = chart.render("--set-string", "config.password=strong-password");
    assert.deepEqual(resourceNames(manifest, "Secret"), ["shadowsocks-secret"]);
    assert.match(manifest, /stringData:\n\s+password: "strong-password"/);
    assert.match(manifest, /"password": "\$\{SHADOWSOCKS_PASSWORD\}"/);
    assert.match(manifest, /name: shadowsocks-secret[\s\S]*?key: password/);
  } finally {
    chart.cleanup();
  }
});
```

Update the external Secret test to render with both `config.password=ignored-password` and `auth.existingSecret=shared-shadowsocks`, then assert no Secret renders, the external reference is used, and `ignored-password` is absent. Update the empty managed-password test to expect:

```text
config.password must not be empty when auth.existingSecret is empty
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-name-pattern="default render|config.password creates|existing Secret|empty managed password" tests/shadowsocks-chart.test.js
```

Expected: FAIL because `config.password` is rejected, the managed Secret is still `shadowsocks-auth`, and validation still reads `auth.password`.

- [ ] **Step 3: Implement minimal template changes**

Move the default value to:

```yaml
config:
  server: "::"
  server_port: 8388
  password: changeme
  method: aes-256-gcm
  fast_open: true
  mode: tcp_and_udp

auth:
  existingSecret: ""
  existingSecretPasswordKey: password
```

Change `shadowsocks.secretName` managed fallback to:

```gotemplate
{{- printf "%s-secret" (include "shadowsocks.fullname" .) | trunc 63 | trimSuffix "-" -}}
```

Remove the validation that rejects `config.password`. In managed mode validate `empty .Values.config.password`; keep existing Secret key validation unchanged. Keep `renderConfig` deep-copying the entire config and overwriting `password` with `${SHADOWSOCKS_PASSWORD}`. Change the managed Secret data to:

```gotemplate
stringData:
  password: {{ .Values.config.password | quote }}
```

- [ ] **Step 4: Run GREEN and commit**

Run `node --test tests/shadowsocks-chart.test.js`; expect all focused tests to pass. Then:

```bash
git add charts/shadowsocks tests/shadowsocks-chart.test.js
git commit -m "feat: manage shadowsocks password from config"
```

### Task 2: Update operator documentation

**Files:**
- Modify: `tests/shadowsocks-chart.test.js`
- Modify: `charts/shadowsocks/README.md`
- Verify: `charts/shadowsocks/templates/NOTES.txt`

**Interfaces:**
- Consumes: final `config.password`, `auth.existingSecret`, and `shadowsocks-secret` names.
- Produces: accurate managed/external Secret instructions and rotation guidance.

- [ ] **Step 1: Make the documentation test fail**

Update the README test to require `config.password`, `shadowsocks-secret`, and `auth.existingSecret`, and to reject `--set-string auth.password`. Run only the README test and confirm RED against the current README.

- [ ] **Step 2: Update README**

Replace managed install examples with:

```bash
helm upgrade --install shadowsocks ./charts/shadowsocks \
  --namespace shadowsocks \
  --create-namespace \
  --set-string config.password='replace-with-a-strong-password'
```

Explain that `config.password` creates `shadowsocks-secret`, is replaced by the environment placeholder in ConfigMap, and is stored in Helm release metadata. Preserve the external Secret example for operators that do not want a password stored in Helm values. Ensure NOTES obtains both the managed Secret name and key through helpers.

- [ ] **Step 3: Verify and commit**

Run `node --test tests/shadowsocks-chart.test.js`; expect all tests to pass. Then:

```bash
git add charts/shadowsocks/README.md tests/shadowsocks-chart.test.js
git commit -m "docs: document shadowsocks managed password"
```

### Task 3: Run complete source verification

**Files:**
- Verify only: `charts/shadowsocks/**`, `tests/shadowsocks-chart.test.js`

**Interfaces:**
- Consumes: completed chart source.
- Produces: clean Node, Helm 4, dependency, render, and package evidence.

- [ ] **Step 1: Run repository tests**

Run `node --test tests/*.test.js` and `pnpm test`; expect zero failures.

- [ ] **Step 2: Run Helm verification in a temporary chart copy**

Copy `charts/shadowsocks` and `charts/common` to one temporary parent. Run `helm dependency build`, `helm lint`, `helm template`, and `helm package` with `config.password=test-password` and the proxy-egress toleration. Expect all commands to exit 0 and no dependency artifacts in the source chart.

- [ ] **Step 3: Confirm clean source state**

Run `git diff --check` and `git status --short`; expect no uncommitted files and no `Chart.lock`, `charts/`, or `.tgz` beneath `charts/shadowsocks`.

### Task 4: Migrate the kudeploy release

**Files:**
- Cluster resources only; no repository files.

**Interfaces:**
- Consumes: current `shadowsocks-credentials/password`, verified local chart, release `shadowsocks`, namespace `shadowsocks`.
- Produces: release revision using `shadowsocks-secret/password`, four Ready DaemonSet pods, unchanged password, and no obsolete credentials Secret.

- [ ] **Step 1: Read the current password without printing it**

Store this command's decoded result in a shell variable and require it to be non-empty:

```bash
password=$(kubectl --context kudeploy --namespace shadowsocks get secret shadowsocks-credentials -o jsonpath='{.data.password}' | base64 -d)
test -n "$password"
```

- [ ] **Step 2: Upgrade atomically with the managed Secret**

Build the local dependency in a temporary chart copy, then run:

```bash
helm --kube-context kudeploy upgrade --install shadowsocks <temporary-chart> \
  --namespace shadowsocks \
  --set-string config.password="$password" \
  --set tolerations[0].key=dedicated \
  --set tolerations[0].operator=Equal \
  --set tolerations[0].value=proxy-egress \
  --set tolerations[0].effect=NoSchedule \
  --rollback-on-failure \
  --wait \
  --timeout 5m
```

- [ ] **Step 3: Verify migration before cleanup**

Require release status `deployed`, DaemonSet desired/ready counts `4/4`, four Running/Ready pods including `us-lax-3`, `SHADOWSOCKS_PASSWORD` referencing `shadowsocks-secret/password`, and byte-for-byte equality between old and new Secret password values.

- [ ] **Step 4: Delete the obsolete Secret and recheck**

Delete `shadowsocks-credentials`, confirm it is absent, confirm `shadowsocks-secret` remains, and run `/readyz` plus DaemonSet rollout status again.
