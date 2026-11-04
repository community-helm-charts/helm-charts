import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");

function makeChart(t) {
  const dir = mkdtempSync(join(tmpdir(), "umami-chart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["umami", "postgresql"]) {
    const chart = join(dir, name);
    cpSync(join(ROOT, "charts", name), chart, { recursive: true });
    rmSync(join(chart, "charts"), { recursive: true, force: true });
    mkdirSync(join(chart, "charts"));
    execFileSync("helm", ["package", join(ROOT, "charts/common"), "-d", join(chart, "charts")]);
  }
  execFileSync("helm", ["package", join(dir, "postgresql"), "-d", join(dir, "umami/charts")]);
  const path = join(dir, "umami");
  return {
    path,
    result(values = {}) {
      return spawnSync("helm", ["template", "umami", path, "--namespace", "default", "-f", "-"], {
        encoding: "utf8", input: JSON.stringify(values),
      });
    },
    render(values = {}) {
      const result = this.result(values);
      assert.equal(result.status, 0, result.stderr);
      return parseAllDocuments(result.stdout).map((doc) => {
        assert.deepEqual(doc.errors, []);
        return doc.toJSON();
      }).filter(Boolean);
    },
  };
}

const resource = (docs, kind, name) => docs.find((doc) => doc.kind === kind && (!name || doc.metadata.name === name));
const deployment = (docs) => resource(docs, "Deployment");
const container = (docs) => deployment(docs).spec.template.spec.containers[0];
const env = (docs, name) => container(docs).env.find((entry) => entry.name === name);
const decode = (value) => Buffer.from(value, "base64").toString();

test("Umami defaults connect to the bundled persistent PostgreSQL with a shared password Secret", (t) => {
  const chart = makeChart(t);
  const docs = chart.render();
  const app = deployment(docs);
  const db = resource(docs, "StatefulSet", "umami-postgresql");
  assert.equal(app.spec.replicas, 1);
  assert.equal(container(docs).image, "ghcr.io/umami-software/umami:3.4.1");
  assert.equal(container(docs).ports[0].containerPort, 3000);
  assert.equal(env(docs, "PORT").value, "3000");
  assert.equal(env(docs, "HOSTNAME").value, "0.0.0.0");
  assert.equal(env(docs, "UMAMI_DB_HOST").value, "umami-postgresql.default.svc.cluster.local");
  assert.equal(env(docs, "UMAMI_DB_PORT").value, "5432");
  assert.equal(env(docs, "UMAMI_DB_USER").value, "umami");
  assert.equal(env(docs, "UMAMI_DB_NAME").value, "umami");
  const passwordRef = env(docs, "UMAMI_DB_PASSWORD").valueFrom.secretKeyRef;
  const dbPassword = db.spec.template.spec.containers[0].env.find((entry) => entry.name === "POSTGRES_PASSWORD");
  assert.deepEqual(passwordRef, dbPassword.valueFrom.secretKeyRef);
  assert.ok(decode(resource(docs, "Secret", passwordRef.name).data[passwordRef.key]));
  assert.equal(db.spec.volumeClaimTemplates[0].spec.resources.requests.storage, "8Gi");
  assert.equal(decode(resource(docs, "Secret", "umami-app").data["app-secret"]).length, 64);
  assert.equal(app.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(container(docs).securityContext.runAsNonRoot, true);
  assert.equal(resource(docs, "Ingress"), undefined);
  const svc = resource(docs, "Service", "umami");
  assert.equal(svc.spec.ports[0].port, 80);
  assert.equal(svc.spec.ports[0].targetPort, "http");
  for (const selector of [svc.spec.selector, app.spec.selector.matchLabels]) {
    for (const [key, value] of Object.entries(selector)) assert.equal(app.spec.template.metadata.labels[key], value);
  }
  for (const probe of ["startupProbe", "livenessProbe", "readinessProbe"]) {
    assert.deepEqual(container(docs)[probe].httpGet, { path: "/api/heartbeat", port: "http" });
  }
  assert.deepEqual(container(docs).args.slice(1), ["--", "sh", "scripts/start-docker.sh"]);
  execFileSync("helm", ["lint", "--strict", chart.path], { stdio: "pipe" });
});

test("bundled database respects global overrides and existing password Secret keys", (t) => {
  const docs = makeChart(t).render({
    namespaceOverride: "analytics",
    clusterDomain: "example.internal",
    global: { postgresql: {
      fullnameOverride: "analytics-db",
      auth: { username: "collector", database: "events", existingSecret: "database-credentials", existingSecretPasswordKey: "password" },
      service: { ports: { postgresql: 5433 } },
    } },
    postgresql: { namespaceOverride: "analytics" },
    appSecret: { existingSecret: "app-credentials", key: "signing" },
  });
  assert.equal(env(docs, "UMAMI_DB_HOST").value, "analytics-db.analytics.svc.example.internal");
  assert.equal(env(docs, "UMAMI_DB_PORT").value, "5433");
  assert.equal(env(docs, "UMAMI_DB_USER").value, "collector");
  assert.equal(env(docs, "UMAMI_DB_NAME").value, "events");
  assert.deepEqual(env(docs, "UMAMI_DB_PASSWORD").valueFrom.secretKeyRef, { name: "database-credentials", key: "password" });
  assert.deepEqual(env(docs, "APP_SECRET").valueFrom.secretKeyRef, { name: "app-credentials", key: "signing" });
  assert.equal(docs.filter((doc) => doc.kind === "Secret").length, 0);
  assert.equal(resource(docs, "Service", "analytics-db").spec.ports[0].port, 5433);
});

test("bundled database startup encodes credentials and preserves command arguments", (t) => {
  const docs = makeChart(t).render({
    postgresql: { auth: { username: "user @:+", database: "events /?" } },
    command: ["node"],
    args: ["-e", "process.stdout.write(JSON.stringify({url: process.env.DATABASE_URL, arg: process.argv[1]}))", "literal $() ' argument"],
  });
  const app = container(docs);
  const processEnv = Object.fromEntries(app.env.filter((entry) => entry.value !== undefined).map((entry) => [entry.name, entry.value]));
  const password = "p@ss:/?#%+ $()'\"中文";
  const result = JSON.parse(execFileSync(app.command[0], [...app.command.slice(1), ...app.args], {
    encoding: "utf8", env: { ...process.env, ...processEnv, UMAMI_DB_PASSWORD: password },
  }));
  const url = new URL(result.url);
  assert.equal(decodeURIComponent(url.username), "user @:+");
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "events /?");
  assert.equal(url.hostname, "umami-postgresql.default.svc.cluster.local");
  assert.equal(result.arg, "literal $() ' argument");
});

test("external PostgreSQL URL is kept in a Secret and changes roll the application", (t) => {
  const chart = makeChart(t);
  const url = "postgresql://user:p%40ss@db.example.com:5432/events?sslmode=require";
  const values = { postgresql: { enabled: false }, database: { url }, appSecret: { value: "stable-signing-secret" } };
  const docs = chart.render(values);
  assert.equal(resource(docs, "StatefulSet"), undefined);
  assert.deepEqual(env(docs, "DATABASE_URL").valueFrom.secretKeyRef, { name: "umami-database", key: "database-url" });
  assert.equal(decode(resource(docs, "Secret", "umami-database").data["database-url"]), url);
  assert.equal(decode(resource(docs, "Secret", "umami-app").data["app-secret"]), "stable-signing-secret");
  assert.equal(container(docs).command, undefined);
  assert.equal(container(docs).args, undefined);
  assert.ok(!JSON.stringify(deployment(docs)).includes(url));
  const checksum = (rendered) => deployment(rendered).spec.template.metadata.annotations["checksum/config"];
  assert.equal(checksum(docs), checksum(chart.render(values)));
  assert.notEqual(checksum(docs), checksum(chart.render({ ...values, appSecret: { value: "rotated-signing-secret" } })));
  assert.notEqual(checksum(docs), checksum(chart.render({ ...values, database: { url: url + "&connection_limit=10" } })));
});

test("external Secret references create no database or application credentials", (t) => {
  const docs = makeChart(t).render({
    postgresql: { enabled: false },
    database: { existingSecret: "external-db", secretKey: "url" },
    appSecret: { existingSecret: "external-app", key: "signing" },
  });
  assert.deepEqual(env(docs, "DATABASE_URL").valueFrom.secretKeyRef, { name: "external-db", key: "url" });
  assert.deepEqual(env(docs, "APP_SECRET").valueFrom.secretKeyRef, { name: "external-app", key: "signing" });
  assert.equal(docs.filter((doc) => ["Secret", "StatefulSet", "PersistentVolumeClaim"].includes(doc.kind)).length, 0);
});

test("Ingress TLS, custom HTTP ports and service selectors route to Umami", (t) => {
  const docs = makeChart(t).render({
    fullnameOverride: "analytics",
    containerPorts: { http: 8080 },
    service: { type: "NodePort", ports: { http: 8081 }, nodePorts: { http: 30080 } },
    ingress: { enabled: true, ingressClassName: "nginx", hostname: "analytics.example.com", tls: true },
    podLabels: { team: "platform" },
  });
  assert.equal(env(docs, "PORT").value, "8080");
  assert.equal(container(docs).ports[0].containerPort, 8080);
  const svc = resource(docs, "Service", "analytics");
  assert.equal(svc.spec.ports[0].port, 8081);
  assert.equal(svc.spec.ports[0].nodePort, 30080);
  const ingress = resource(docs, "Ingress");
  assert.equal(ingress.spec.ingressClassName, "nginx");
  assert.deepEqual(ingress.spec.rules[0].http.paths[0].backend.service, { name: "analytics", port: { name: "http" } });
  assert.deepEqual(ingress.spec.tls, [{ hosts: ["analytics.example.com"], secretName: "analytics.example.com-tls" }]);
  for (const [key, value] of Object.entries(svc.spec.selector)) {
    assert.equal(deployment(docs).spec.template.metadata.labels[key], value);
  }
});

test("image, resources, scheduling and environment customizations reach the pod", (t) => {
  const docs = makeChart(t).render({
    replicaCount: 2,
    global: { imageRegistry: "registry.example.com", imagePullSecrets: ["registry-credentials"] },
    image: { digest: "sha256:abc123" },
    nodeSelector: { pool: "analytics" },
    tolerations: [{ key: "analytics", operator: "Exists" }],
    resources: { requests: { cpu: "100m", memory: "256Mi" } },
    extraEnvVars: [{ name: "DISABLE_TELEMETRY", value: "1" }],
    extraEnvVarsCM: "umami-settings",
    extraEnvVarsSecret: "umami-extra-secrets",
    customReadinessProbe: { tcpSocket: { port: "http" } },
    serviceAccount: { create: false, name: "analytics-account" },
  });
  const pod = deployment(docs).spec.template.spec;
  assert.equal(deployment(docs).spec.replicas, 2);
  assert.equal(container(docs).image, "registry.example.com/umami-software/umami@sha256:abc123");
  assert.deepEqual(pod.imagePullSecrets, [{ name: "registry-credentials" }]);
  assert.deepEqual(pod.nodeSelector, { pool: "analytics" });
  assert.equal(pod.tolerations[0].key, "analytics");
  assert.equal(container(docs).resources.requests.memory, "256Mi");
  assert.equal(env(docs, "DISABLE_TELEMETRY").value, "1");
  assert.deepEqual(container(docs).envFrom, [{ configMapRef: { name: "umami-settings" } }, { secretRef: { name: "umami-extra-secrets" } }]);
  assert.deepEqual(container(docs).readinessProbe, { tcpSocket: { port: "http" } });
  assert.equal(pod.serviceAccountName, "analytics-account");
  assert.equal(resource(docs, "ServiceAccount", "umami"), undefined);
});

test("invalid database, port, ingress and environment combinations fail clearly", (t) => {
  const chart = makeChart(t);
  for (const [values, message] of [
    [{ postgresql: { enabled: false } }, /database.url.*required/],
    [{ database: { url: "postgresql://user:pass@db/events" } }, /require postgresql.enabled=false/],
    [{ postgresql: { enabled: false }, database: { url: "mysql:\/\/db/events" } }, /PostgreSQL connection URL/],
    [{ postgresql: { enabled: false }, database: { url: "postgresql://db/events", existingSecret: "db" } }, /set only one/],
    [{ postgresql: { service: { enabled: false } } }, /postgresql.service.enabled must be true/],
    [{ postgresql: { auth: { trustAuthentication: true } } }, /trustAuthentication is not supported/],
    [{ postgresql: { namespaceOverride: "other" } }, /must match the Umami namespace/],
    [{ appSecret: { value: "secret", existingSecret: "app" } }, /set only one/],
    [{ containerPorts: { http: 0 } }, /containerPorts.http must be an integer/],
    [{ service: { enabled: false }, ingress: { enabled: true } }, /service.enabled must be true/],
    [{ ingress: { enabled: true, tls: true, hostname: "" } }, /ingress.hostname must not be empty/],
    [{ extraEnvVars: [{ name: "DATABASE_URL", value: "override" }] }, /must not override/],
  ]) {
    const result = chart.result(values);
    assert.notEqual(result.status, 0, JSON.stringify(values));
    assert.match(result.stderr, message);
  }
});
