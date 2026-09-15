import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse, parseAllDocuments } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");

function makeChart(t) {
  const dir = mkdtempSync(join(tmpdir(), "uptime-kuma-chart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chart = join(dir, "uptime-kuma");
  cpSync(join(ROOT, "charts", "uptime-kuma"), chart, { recursive: true });
  rmSync(join(chart, "charts"), { recursive: true, force: true });
  mkdirSync(join(chart, "charts"));
  execFileSync("helm", ["package", join(ROOT, "charts", "common"), "-d", join(chart, "charts")]);
  const options = { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] };
  return {
    path: chart,
    render(values = {}) {
      const output = execFileSync("helm", ["template", "uptime-kuma", chart, "-f", "-"], {
        ...options, input: JSON.stringify(values),
      });
      return parseAllDocuments(output).map((doc) => {
        assert.deepEqual(doc.errors, []);
        return doc.toJSON();
      }).filter(Boolean);
    },
    result(values) {
      return spawnSync("helm", ["template", "uptime-kuma", chart, "-f", "-"], {
        ...options, input: JSON.stringify(values),
      });
    },
  };
}

const resource = (docs, kind, name) => docs.find((doc) => doc.kind === kind && (!name || doc.metadata.name === name));
const workload = (docs) => resource(docs, "StatefulSet");
const pod = (docs) => workload(docs).spec.template.spec;
const container = (docs) => pod(docs).containers[0];

test("Uptime Kuma defaults provide a single persistent instance with matching services", (t) => {
  const chart = makeChart(t);
  const docs = chart.render();
  assert.deepEqual(docs.map((doc) => doc.kind).sort(), ["Service", "Service", "ServiceAccount", "StatefulSet"]);
  const sts = workload(docs);
  assert.equal(sts.spec.replicas, 1);
  assert.equal(container(docs).image, "docker.io/louislam/uptime-kuma:2.5.4");
  assert.equal(container(docs).ports[0].containerPort, 3001);
  assert.deepEqual(container(docs).env, [
    { name: "UPTIME_KUMA_PORT", value: "3001" }, { name: "DATA_DIR", value: "/app/data" },
  ]);
  assert.deepEqual(container(docs).volumeMounts, [{ name: "data", mountPath: "/app/data" }]);
  assert.equal(sts.spec.volumeClaimTemplates[0].spec.resources.requests.storage, "1Gi");
  assert.deepEqual(sts.spec.volumeClaimTemplates[0].spec.accessModes, ["ReadWriteOnce"]);
  const headless = resource(docs, "Service", sts.spec.serviceName);
  assert.equal(headless.spec.clusterIP, "None");
  const svc = resource(docs, "Service", "uptime-kuma");
  assert.equal(svc.spec.ports[0].targetPort, "http");
  for (const selector of [headless.spec.selector, svc.spec.selector, sts.spec.selector.matchLabels]) {
    for (const [key, value] of Object.entries(selector)) assert.equal(sts.spec.template.metadata.labels[key], value);
  }
  assert.equal(pod(docs).automountServiceAccountToken, false);
  assert.equal(resource(docs, "ServiceAccount").automountServiceAccountToken, false);
});

test("existing PVCs and ephemeral storage replace the claim template", (t) => {
  const chart = makeChart(t);
  const existing = chart.render({ persistence: { existingClaim: "{{ .Release.Name }}-data" } });
  assert.equal(workload(existing).spec.volumeClaimTemplates, undefined);
  assert.deepEqual(pod(existing).volumes, [{ name: "data", persistentVolumeClaim: { claimName: "uptime-kuma-data" } }]);
  const ephemeral = chart.render({ persistence: { enabled: false } });
  assert.equal(workload(ephemeral).spec.volumeClaimTemplates, undefined);
  assert.deepEqual(pod(ephemeral).volumes, [{ name: "data", emptyDir: {} }]);
});

test("StorageClass precedence and PVC settings follow the common library", (t) => {
  const chart = makeChart(t);
  for (const [values, expected] of [
    [{}, undefined],
    [{ global: { defaultStorageClassName: "default-fast" } }, "default-fast"],
    [{ global: { defaultStorageClassName: "default-fast" }, persistence: { storageClassName: "local" } }, "local"],
    [{ global: { storageClassName: "override" }, persistence: { storageClassName: "local" } }, "override"],
    [{ persistence: { storageClassName: "-" } }, ""],
  ]) {
    assert.equal(workload(chart.render(values)).spec.volumeClaimTemplates[0].spec.storageClassName, expected);
  }
  const docs = chart.render({ persistence: { size: "10Gi", annotations: { backup: "true" }, labels: { tier: "data" } } });
  const claim = workload(docs).spec.volumeClaimTemplates[0];
  assert.equal(claim.spec.resources.requests.storage, "10Gi");
  assert.equal(claim.metadata.annotations.backup, "true");
  assert.equal(claim.metadata.labels.tier, "data");
});

test("port and data path overrides configure the application as well as Kubernetes", (t) => {
  const docs = makeChart(t).render({ containerPorts: { http: 8080 }, service: { ports: { http: 80 } }, persistence: { mountPath: "/data", subPath: "kuma" } });
  assert.equal(container(docs).ports[0].containerPort, 8080);
  assert.deepEqual(container(docs).env, [{ name: "UPTIME_KUMA_PORT", value: "8080" }, { name: "DATA_DIR", value: "/data" }]);
  assert.deepEqual(container(docs).volumeMounts[0], { name: "data", mountPath: "/data", subPath: "kuma" });
  assert.equal(resource(docs, "Service", "uptime-kuma").spec.ports[0].port, 80);
  assert.equal(resource(docs, "Service", "uptime-kuma-headless").spec.ports[0].port, 8080);
});

test("Ingress uses status.example.com, named HTTP backend and the expected TLS Secret", (t) => {
  const chart = makeChart(t);
  const docs = chart.render({ ingress: { enabled: true, ingressClassName: "traefik", tls: true, annotations: { "cert-manager.io/cluster-issuer": "letsencrypt" } } });
  const ingress = resource(docs, "Ingress");
  assert.equal(ingress.apiVersion, "networking.k8s.io/v1");
  assert.equal(ingress.spec.ingressClassName, "traefik");
  assert.equal(ingress.spec.rules[0].host, "status.example.com");
  assert.equal(ingress.spec.rules[0].http.paths[0].path, "/");
  assert.deepEqual(ingress.spec.rules[0].http.paths[0].backend.service, { name: "uptime-kuma", port: { name: "http" } });
  assert.deepEqual(ingress.spec.tls, [{ hosts: ["status.example.com"], secretName: "status.example.com-tls" }]);
  assert.equal(resource(docs, "Secret"), undefined);
  const secrets = [{ name: "status.example.com-tls", certificate: "certificate", key: "key" }];
  assert.equal(resource(chart.render({ ingress: { secrets } }), "Secret"), undefined);
  const secret = resource(chart.render({ ingress: { enabled: true, secrets } }), "Secret");
  assert.equal(secret.type, "kubernetes.io/tls");
  assert.equal(Buffer.from(secret.data["tls.crt"], "base64").toString(), "certificate");
  const external = chart.render({ ingress: { enabled: true, extraTls: [{ hosts: ["status.example.com"], secretName: "external-cert" }] } });
  assert.equal(resource(external, "Ingress").spec.tls[0].secretName, "external-cert");
});

test("startup protects initialization and custom probes override defaults", (t) => {
  const chart = makeChart(t);
  const app = container(chart.render());
  for (const name of ["startupProbe", "livenessProbe", "readinessProbe"]) {
    assert.deepEqual(app[name].httpGet, { path: "/", port: "http" });
    assert.equal(app[name].enabled, undefined);
  }
  assert.equal(app.startupProbe.failureThreshold * app.startupProbe.periodSeconds, 600);
  const custom = container(chart.render({ startupProbe: { enabled: false }, customLivenessProbe: { tcpSocket: { port: "http" } }, readinessProbe: { enabled: false } }));
  assert.equal(custom.startupProbe, undefined);
  assert.equal(custom.readinessProbe, undefined);
  assert.deepEqual(custom.livenessProbe, { tcpSocket: { port: "http" } });
});

test("image overrides, environment sources, scheduling and security contexts render", (t) => {
  const docs = makeChart(t).render({
    global: { imageRegistry: "registry.example.com", imagePullSecrets: ["registry-secret"] },
    image: { repository: "monitoring/kuma", digest: "sha256:" + "a".repeat(64) },
    extraEnvVars: [{ name: "TZ", value: "UTC" }], extraEnvVarsCM: "kuma-config", extraEnvVarsSecret: "kuma-secret",
    nodeSelector: { role: "monitoring" }, tolerations: [{ operator: "Exists" }],
    podSecurityContext: { enabled: true }, containerSecurityContext: { enabled: true },
    serviceAccount: { create: false, name: "existing-account" }, resources: { requests: { memory: "256Mi" } },
  });
  assert.equal(container(docs).image, "registry.example.com/monitoring/kuma@sha256:" + "a".repeat(64));
  assert.deepEqual(pod(docs).imagePullSecrets, [{ name: "registry-secret" }]);
  assert.deepEqual(container(docs).env.at(-1), { name: "TZ", value: "UTC" });
  assert.deepEqual(container(docs).envFrom, [{ configMapRef: { name: "kuma-config" } }, { secretRef: { name: "kuma-secret" } }]);
  assert.deepEqual(pod(docs).nodeSelector, { role: "monitoring" });
  assert.deepEqual(pod(docs).tolerations, [{ operator: "Exists" }]);
  assert.equal(pod(docs).securityContext.fsGroup, 1000);
  assert.equal(container(docs).securityContext.runAsUser, 1000);
  assert.equal(container(docs).securityContext.enabled, undefined);
  assert.equal(pod(docs).serviceAccountName, "existing-account");
  assert.equal(resource(docs, "ServiceAccount"), undefined);
  assert.equal(container(docs).resources.requests.memory, "256Mi");
});

test("NodePort, LoadBalancer and disabled client Service retain correct headless networking", (t) => {
  const chart = makeChart(t);
  const nodePort = resource(chart.render({ service: { type: "NodePort", nodePorts: { http: 30301 } } }), "Service", "uptime-kuma");
  assert.equal(nodePort.spec.ports[0].nodePort, 30301);
  const lb = resource(chart.render({ service: { type: "LoadBalancer", loadBalancerClass: "example.com/lb", loadBalancerSourceRanges: ["10.0.0.0/8"] } }), "Service", "uptime-kuma");
  assert.equal(lb.spec.loadBalancerClass, "example.com/lb");
  assert.deepEqual(lb.spec.loadBalancerSourceRanges, ["10.0.0.0/8"]);
  const disabled = chart.render({ service: { enabled: false } });
  assert.equal(resource(disabled, "Service", "uptime-kuma"), undefined);
  assert.ok(resource(disabled, "Service", workload(disabled).spec.serviceName));
});

test("long names retain a distinct governing Service and custom labels stay consistent", (t) => {
  const docs = makeChart(t).render({ fullnameOverride: "k".repeat(80), namespaceOverride: "monitoring", commonLabels: { team: "ops" }, podLabels: { role: "monitor" } });
  const sts = workload(docs);
  for (const doc of docs) {
    assert.ok(doc.metadata.name.length <= 63);
    assert.equal(doc.metadata.namespace, "monitoring");
    assert.equal(doc.metadata.labels.team, "ops");
  }
  assert.notEqual(sts.metadata.name, sts.spec.serviceName);
  assert.ok(resource(docs, "Service", sts.spec.serviceName));
  assert.equal(sts.spec.template.metadata.labels.role, "monitor");
});

test("additional volumes, sidecars, init containers and extra objects render", (t) => {
  const docs = makeChart(t).render({
    extraVolumes: [{ name: "scratch", emptyDir: {} }],
    extraVolumeMounts: [{ name: "scratch", mountPath: "/scratch" }],
    initContainers: [{ name: "prepare", image: "busybox:1.36", command: ["true"] }],
    sidecars: [{ name: "helper", image: "busybox:1.36", command: ["sleep", "infinity"] }],
    extraDeploy: [{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "{{ .Release.Name }}-extra" }, data: { setting: "value" } }],
  });
  assert.deepEqual(pod(docs).volumes, [{ name: "scratch", emptyDir: {} }]);
  assert.equal(container(docs).volumeMounts[1].mountPath, "/scratch");
  assert.equal(pod(docs).initContainers[0].name, "prepare");
  assert.equal(pod(docs).containers[1].name, "helper");
  assert.equal(resource(docs, "ConfigMap").metadata.name, "uptime-kuma-extra");
});

test("invalid ports and conflicting configuration fail with actionable messages", (t) => {
  const chart = makeChart(t);
  for (const [values, message] of [
    [{ containerPorts: { http: 0 } }, /containerPorts.http must be an integer/],
    [{ containerPorts: { http: "oops" } }, /containerPorts.http must be an integer/],
    [{ service: { ports: { http: 65536 } } }, /service.ports.http must be an integer/],
    [{ ingress: { enabled: true }, service: { enabled: false } }, /service.enabled must be true/],
    [{ ingress: { enabled: true, tls: true, hostname: "" } }, /ingress.hostname must not be empty/],
    [{ persistence: { mountPath: "relative" } }, /persistence.mountPath must be an absolute path/],
    [{ extraEnvVars: [{ name: "DATA_DIR", value: "/other" }] }, /extraEnvVars must not override DATA_DIR/],
    [{ extraEnvVars: [{ name: "UPTIME_KUMA_PORT", value: "9000" }] }, /extraEnvVars must not override UPTIME_KUMA_PORT/],
  ]) {
    const result = chart.result(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
});

test("chart lints, packages, and renders the README values examples", (t) => {
  const chart = makeChart(t);
  execFileSync("helm", ["lint", chart.path, "--strict"], { stdio: "pipe" });
  const output = execFileSync("helm", ["package", chart.path, "-d", resolve(chart.path, "..")], { encoding: "utf8" });
  assert.match(output, /uptime-kuma-.*\.tgz/);
  const metadata = parse(readFileSync(join(chart.path, "Chart.yaml"), "utf8"));
  const values = parse(readFileSync(join(chart.path, "values.yaml"), "utf8"));
  assert.equal(metadata.appVersion, values.image.tag);
  assert.ok(metadata.annotations.images.includes(`${values.image.registry}/${values.image.repository}:${values.image.tag}`));
  assert.equal(metadata.dependencies[0].repository, "file://../common");
  const readme = readFileSync(join(chart.path, "README.md"), "utf8");
  for (const [, yaml] of readme.matchAll(/```yaml\n([\s\S]*?)```/g)) chart.render(parse(yaml));
  const notes = execFileSync("helm", ["install", "uptime-kuma", chart.path, "--dry-run=client", "--set", "ingress.enabled=true"], { encoding: "utf8", stdio: "pipe" });
  assert.match(notes, /http:\/\/status\.example\.com\//);
});
