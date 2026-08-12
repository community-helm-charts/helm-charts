# FRPS Subdomain Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in wildcard Ingress derived from FRPS `config.subDomainHost`, with optional TLS termination and no implicit exposure.

**Architecture:** Keep `config.subDomainHost` as the single source of truth for both `frps.toml` and the wildcard hostname. Render a separate `<fullname>-subdomain` Ingress only when `subdomainIngress.enabled` is true; route it to the existing vhost Service's named `http` port and keep its class, annotations, and TLS settings independent from the existing Ingress.

**Tech Stack:** Helm 3 templates, Kubernetes `networking.k8s.io/v1` Ingress, repository `common` chart 0.2.2, Node.js `node:test`, YAML parsing, pnpm/Nx.

## Global Constraints

- `config.subDomainHost` is the only hostname input; do not add a duplicate hostname value under `subdomainIngress`.
- `subdomainIngress.enabled` defaults to `false`; setting `config.subDomainHost` alone must not expose traffic.
- `subdomainIngress.ingressClassName` defaults to `""`, `annotations` to `{}`, `tls` to `false`, and `secretName` to `""`.
- The wildcard is exactly `*.<config.subDomainHost>` and follows one-label Kubernetes wildcard semantics.
- The new Ingress always routes `/` to the existing `<fullname>-vhost` Service's named `http` port; TLS terminates at the Ingress.
- When TLS is enabled and `secretName` is empty, use `<fullname>-subdomain-tls`.
- Reserve space for `-subdomain` and `-subdomain-tls` before truncating derived names so they remain unique at the 63-character fullname limit.
- Do not create a cert-manager `Certificate`, issuer, or TLS Secret; users provide controller/certificate annotations.
- Keep the existing `ingress` resource and values behavior unchanged and independently configurable.
- Accept only lower-case DNS names with at least two labels, at most 251 characters, and no wildcard, scheme, port, path, whitespace, or trailing dot.
- Use the dedicated `frps` namespace in tests and operator examples; NOTES commands always include the actual release namespace.
- Follow strict RED → verify failure → GREEN → verify pass for each production behavior.

## File Structure

- `charts/frps/values.yaml`: add the documented `config.subDomainHost` and `subdomainIngress` public values.
- `charts/frps/templates/_helpers.tpl`: validate the domain and ingress values and provide wildcard/name/Secret helpers.
- `charts/frps/templates/subdomain-ingress.yaml`: render the isolated wildcard Ingress.
- `charts/frps/templates/NOTES.txt`: report the enabled wildcard endpoint without claiming DNS or certificate readiness.
- `charts/frps/README.md`: document wildcard behavior, TLS/DNS-01 prerequisites, and every new value.
- `tests/frps-chart.test.js`: exercise TOML rendering, opt-in exposure, routing, TLS, validation, coexistence, NOTES, and documentation.
- `tests/cloudflared-chart.test.js`, `tests/komari-chart.test.js`, `tests/shadowsocks-chart.test.js`: reconcile stale `common` dependency assertions with the already-published 0.2.2 repository baseline so full verification can run.

---

### Task 1: Values, TOML rendering, and validation

**Files:**
- Modify: `tests/frps-chart.test.js`
- Modify: `charts/frps/values.yaml`
- Modify: `charts/frps/templates/_helpers.tpl`

**Interfaces:**
- Consumes: `.Values.config.subDomainHost` and `.Values.subdomainIngress`.
- Produces: `frps.subdomainHost`, `frps.subdomainWildcard`, `frps.subdomainIngressName`, `frps.subdomainTlsSecretName`, and validation invoked by the existing `frps.validateValues` helper.

- [ ] **Step 1: Write failing tests for configuration and validation**

Add a test proving a configured domain appears in TOML while no Ingress is created:

```js
test("subDomainHost config does not implicitly expose a wildcard Ingress", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render("--set", "config.subDomainHost=example.com");
    assert.match(manifest, /subDomainHost = "example\.com"/);
    assert.deepEqual(resourceNames(manifest, "Ingress"), []);
  } finally { chart.cleanup(); }
});
```

Extend the invalid-values table with enabled wildcard cases for an empty domain, `*.example.com`, `https://example.com`, `example.com:443`, `example.com/path`, `Example.com`, `example.com.`, a boolean domain, and a boolean `secretName`. Require the domain failures to match `config.subDomainHost must be a lower-case DNS name with at least two labels` and the Secret failure to match `subdomainIngress.secretName must be a string`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='subDomainHost config|rejects invalid' tests/frps-chart.test.js
```

Expected: the configuration test fails because the value/default does not exist yet, and each invalid enabled ingress currently renders or fails without the required actionable message.

- [ ] **Step 3: Add the public values and helper validation**

Add this documented values contract:

```yaml
config:
  bindPort: 7000
  vhostHTTPPort: 8080
  vhostHTTPSPort: 8443
  subDomainHost: ""

subdomainIngress:
  enabled: false
  apiVersion: ""
  ingressClassName: ""
  annotations: {}
  pathType: ImplementationSpecific
  tls: false
  secretName: ""
```

In `frps.renderConfig`, remove `subDomainHost` from the copied config when it is the empty default so the historical default TOML remains limited to the three ports plus managed authentication. Preserve a non-empty value unchanged.

Add helpers with these exact results:

```gotemplate
{{- define "frps.subdomainHost" -}}
{{- get .Values.config "subDomainHost" -}}
{{- end -}}

{{- define "frps.subdomainWildcard" -}}
{{- printf "*.%s" (include "frps.subdomainHost" .) -}}
{{- end -}}

{{- define "frps.subdomainIngressName" -}}
{{- printf "%s-subdomain" (include "frps.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "frps.subdomainTlsSecretName" -}}
{{- default (printf "%s-subdomain-tls" (include "frps.fullname" .) | trunc 63 | trimSuffix "-") .Values.subdomainIngress.secretName -}}
{{- end -}}
```

Inside `frps.validateValues`, when `subdomainIngress.enabled` is true:

1. Require `config.subDomainHost` to exist and be a string.
2. Require length at most 251, leaving room for `*.`, and match `^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)+$`.
3. Require `subdomainIngress` to be a map, `enabled` and `tls` to be booleans, its remaining scalar fields to be strings, and `annotations` to be a map.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command again. Expected: all selected tests pass, and default rendering still omits `subDomainHost = ""`.

- [ ] **Step 5: Commit Task 1**

```bash
git add charts/frps/values.yaml charts/frps/templates/_helpers.tpl tests/frps-chart.test.js
git commit -m "feat(frps): validate subdomain ingress settings"
```

---

### Task 2: Wildcard Ingress and operator notes

**Files:**
- Create: `charts/frps/templates/subdomain-ingress.yaml`
- Modify: `charts/frps/templates/NOTES.txt`
- Modify: `tests/frps-chart.test.js`

**Interfaces:**
- Consumes: the four `frps.subdomain*` helpers from Task 1, `common.capabilities.ingress.apiVersion`, `common.labels.standard`, `common.tplvalues.merge`, `common.tplvalues.render`, and `common.ingress.backend`.
- Produces: one optional Ingress named by `frps.subdomainIngressName` and a conditional NOTES endpoint.

- [ ] **Step 1: Write failing wildcard Ingress tests**

Add a test rendering:

```text
config.subDomainHost=example.com
subdomainIngress.enabled=true
subdomainIngress.ingressClassName=nginx
subdomainIngress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-dns
subdomainIngress.pathType=Prefix
subdomainIngress.tls=true
```

Parse `Ingress/frps-subdomain` and assert:

```js
assert.equal(ingress.spec.ingressClassName, "nginx");
assert.equal(ingress.metadata.annotations["cert-manager.io/cluster-issuer"], "letsencrypt-dns");
assert.equal(ingress.spec.rules[0].host, "*.example.com");
assert.equal(ingress.spec.rules[0].http.paths[0].path, "/");
assert.equal(ingress.spec.rules[0].http.paths[0].pathType, "Prefix");
assert.deepEqual(ingress.spec.rules[0].http.paths[0].backend.service, {
  name: "frps-vhost",
  port: { name: "http" },
});
assert.deepEqual(ingress.spec.tls, [{
  hosts: ["*.example.com"],
  secretName: "frps-subdomain-tls",
}]);
```

Add a second render with `subdomainIngress.secretName=wildcard-example-tls` and assert the explicit Secret is used. Add a coexistence render with both ingress blocks enabled and assert the names are exactly `frps` and `frps-subdomain` and their hosts remain distinct.

Extend the NOTES test to assert `https://*.example.com` when wildcard TLS is enabled and `http://*.example.com` when it is disabled.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='wildcard Ingress|Ingress resources coexist|NOTES cover' tests/frps-chart.test.js
```

Expected: wildcard resource assertions fail because `subdomain-ingress.yaml` and its NOTES branch do not exist.

- [ ] **Step 3: Implement the separate wildcard Ingress**

Create `subdomain-ingress.yaml`, gated only by `.Values.subdomainIngress.enabled`, with:

- API version from `subdomainIngress.apiVersion` or the common capability helper.
- name from `frps.subdomainIngressName` and the common namespace.
- standard/common labels.
- merged `subdomainIngress.annotations` plus `commonAnnotations`.
- optional quoted `ingressClassName`.
- one quoted wildcard host, path `/`, configured `pathType`, and backend `<fullname>-vhost:http` via `common.ingress.backend`.
- optional TLS with the same wildcard host and `frps.subdomainTlsSecretName`.

In `NOTES.txt`, when enabled, report:

```gotemplate
   The wildcard Ingress routes HTTP virtual-host traffic for one-label subdomains at:

     {{ ternary "https" "http" .Values.subdomainIngress.tls }}://{{ include "frps.subdomainWildcard" . }}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command again. Expected: all wildcard, coexistence, and NOTES assertions pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add charts/frps/templates/subdomain-ingress.yaml charts/frps/templates/NOTES.txt tests/frps-chart.test.js
git commit -m "feat(frps): add wildcard subdomain ingress"
```

---

### Task 3: Documentation and repository verification

**Files:**
- Modify: `charts/frps/README.md`
- Modify: `tests/frps-chart.test.js`
- Modify: `tests/cloudflared-chart.test.js`
- Modify: `tests/komari-chart.test.js`
- Modify: `tests/shadowsocks-chart.test.js`

**Interfaces:**
- Consumes: the final public values and behavior from Tasks 1–2.
- Produces: operator guidance, a complete parameter table, and a green repository-wide verification baseline.

- [ ] **Step 1: Write the failing documentation test**

Add a test that reads `charts/frps/README.md` and requires all of these strings:

```js
assert.match(readme, /config\.subDomainHost/);
assert.match(readme, /subdomainIngress\.enabled/);
assert.match(readme, /\*\.example\.com/);
assert.match(readme, /exactly one DNS label/);
assert.match(readme, /DNS-01/);
assert.match(readme, /cert-manager\.io\/cluster-issuer/);
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```bash
node --test --test-name-pattern='README documents wildcard' tests/frps-chart.test.js
```

Expected: FAIL because the README does not yet document the feature.

- [ ] **Step 3: Document the feature and every value**

Add `subDomainHost: example.com` to the server configuration example. Extend the Ingress section with a separate example:

```yaml
config:
  subDomainHost: example.com

subdomainIngress:
  enabled: true
  ingressClassName: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-dns
  tls: true
  secretName: ""
```

Explain that the annotations/class are user-controlled defaults, the wildcard matches exactly one DNS label, TLS terminates at Ingress, and ACME wildcard issuance normally requires DNS-01. Add parameter rows for `config.subDomainHost` and all seven `subdomainIngress.*` values with defaults matching `values.yaml`.

- [ ] **Step 4: Reconcile already-published dependency assertions**

Update the hard-coded local common dependency expectation from `0.2.1` to the repository's current `0.2.2` in the FRPS, cloudflared, Komari, and Shadowsocks metadata tests. Update the FRPS chart-version assertion from `1.0.0` to the current published source version `1.1.0`. Do not change any Chart version manually.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --test tests/frps-chart.test.js
pnpm test
```

Expected: all tests pass.

Package the local dependency in an isolated chart copy and lint without modifying the source tree:

```bash
lint_dir=$(mktemp -d)
cp -R charts/frps "$lint_dir/frps"
mkdir -p "$lint_dir/frps/charts"
helm package charts/common --destination "$lint_dir/frps/charts"
helm lint "$lint_dir/frps" --set-string auth.token=test-token
helm template frps "$lint_dir/frps" \
  --namespace frps \
  --set-string auth.token=test-token \
  --set config.subDomainHost=example.com \
  --set subdomainIngress.enabled=true \
  --set subdomainIngress.tls=true >/dev/null
```

Expected: lint reports `1 chart(s) linted, 0 chart(s) failed`; representative template rendering exits 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add charts/frps/README.md tests/frps-chart.test.js tests/cloudflared-chart.test.js tests/komari-chart.test.js tests/shadowsocks-chart.test.js
git commit -m "docs(frps): document wildcard subdomain ingress"
```

- [ ] **Step 7: Review the completed change**

Run:

```bash
git diff --check HEAD~3..HEAD
git status --short
git log --oneline -5
```

Confirm that only the approved feature, its tests/docs, and stale release-baseline assertions changed; confirm no generated `Chart.lock`, dependency archive, plaintext token, or temporary file is present.
