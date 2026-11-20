import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse, parseAllDocuments } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");

function makeChart(t) {
  const dir = mkdtempSync(join(tmpdir(), "new-api-chart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["new-api", "postgresql", "valkey"]) {
    const chart = join(dir, name);
    cpSync(join(ROOT, "charts", name), chart, { recursive: true });
    rmSync(join(chart, "charts"), { recursive: true, force: true });
    mkdirSync(join(chart, "charts"));
    execFileSync("helm", ["package", join(ROOT, "charts/common"), "-d", join(chart, "charts")]);
  }
  for (const name of ["postgresql", "valkey"]) {
    execFileSync("helm", ["package", join(dir, name), "-d", join(dir, "new-api/charts")]);
  }
  const path = join(dir, "new-api");
  return {
    path,
    result(values = {}) {
      return spawnSync("helm", ["template", "new-api", path, "--namespace", "default", "-f", "-"], {
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
const statefulset = (docs, role = "master") => docs.find((doc) => doc.kind === "StatefulSet" && doc.metadata.labels["new-api-role"] === role && doc.spec.template.spec.containers.some((entry) => entry.name === "new-api"));
const container = (docs, role = "master") => statefulset(docs, role).spec.template.spec.containers[0];
const env = (docs, name, role = "master") => container(docs, role).env.find((entry) => entry.name === name);
const decode = (value) => Buffer.from(value, "base64").toString();

test("New API defaults use PostgreSQL and Valkey without application persistent storage or file logs", (t) => {
  const chart = makeChart(t);
  const docs = chart.render();
  const app = container(docs);
  const pod = statefulset(docs).spec.template.spec;
  assert.equal(statefulset(docs).metadata.name, "new-api-master");
  assert.equal(statefulset(docs).spec.replicas, 1);
  assert.equal(statefulset(docs).spec.serviceName, "new-api-master-headless");
  assert.equal(statefulset(docs).spec.updateStrategy.type, "RollingUpdate");
  assert.equal(statefulset(docs).spec.strategy, undefined);
  assert.equal(statefulset(docs).spec.podManagementPolicy, "OrderedReady");
  assert.equal(statefulset(docs).spec.volumeClaimTemplates, undefined);
  assert.equal(statefulset(docs, "slave"), undefined);
  assert.equal(resource(docs, "Service", "new-api-slave"), undefined);
  assert.equal(resource(docs, "Deployment"), undefined);
  assert.equal(env(docs, "NODE_TYPE").value, "master");
  assert.equal(env(docs, "SYNC_FREQUENCY").value, "60");
  assert.equal(env(docs, "BATCH_UPDATE_ENABLED").value, "true");
  assert.equal(env(docs, "BATCH_UPDATE_INTERVAL").value, "5");
  assert.equal(env(docs, "ERROR_LOG_ENABLED").value, "false");
  assert.equal(env(docs, "MEMORY_CACHE_ENABLED").value, "false");
  assert.equal(env(docs, "TZ").value, "UTC");
  assert.match(app.image, /^docker.io\/calciumion\/new-api:v\d/);
  assert.deepEqual(app.args.slice(1), ["--", "/new-api", "--port=3000", "--log-dir="]);
  assert.equal(app.securityContext.runAsNonRoot, true);
  assert.equal(app.securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.volumes, [{ name: "tmp", emptyDir: {} }]);
  assert.deepEqual(app.volumeMounts, [{ name: "tmp", mountPath: "/tmp" }]);
  assert.equal(docs.some((doc) => doc.kind === "PersistentVolumeClaim"), false);
  for (const [name, envName, passwordEnv, port] of [
    ["postgresql", "NEW_API_DB_PASSWORD", "POSTGRES_PASSWORD", "5432"],
    ["valkey", "NEW_API_VALKEY_PASSWORD", "VALKEY_PASSWORD", "6379"],
  ]) {
    const db = resource(docs, "StatefulSet", `new-api-${name}`);
    assert.equal(db.spec.volumeClaimTemplates[0].spec.resources.requests.storage, "8Gi");
    const ref = env(docs, envName).valueFrom.secretKeyRef;
    assert.equal(ref.name, `new-api-${name}`);
    assert.deepEqual(ref, db.spec.template.spec.containers[0].env.find((v) => v.name === passwordEnv).valueFrom.secretKeyRef);
    assert.ok(decode(resource(docs, "Secret", ref.name).data[ref.key]));
    const prefix = name === "postgresql" ? "NEW_API_DB" : "NEW_API_VALKEY";
    assert.equal(env(docs, `${prefix}_HOST`).value, `new-api-${name}.default.svc.cluster.local`);
    assert.equal(env(docs, `${prefix}_PORT`).value, port);
  }
  for (const key of ["session-secret", "crypto-secret"]) {
    assert.equal(decode(resource(docs, "Secret", "new-api").data[key]).length, 64);
  }
  assert.deepEqual(env(docs, "SESSION_SECRET").valueFrom.secretKeyRef, { name: "new-api", key: "session-secret" });
  assert.deepEqual(env(docs, "CRYPTO_SECRET").valueFrom.secretKeyRef, { name: "new-api", key: "crypto-secret" });
  for (const name of ["startupProbe", "readinessProbe", "livenessProbe"]) {
    assert.deepEqual(app[name].httpGet, { path: "/api/status", port: "http" });
  }
  assert.equal(resource(docs, "Ingress"), undefined);
  assert.equal(resource(docs, "Service", "new-api").spec.ports[0].port, 80);
  execFileSync("helm", ["lint", "--strict", chart.path], { stdio: "pipe" });
});

const selects = (service, workload) => Object.entries(service.spec.selector).every(([key, value]) => workload.spec.template.metadata.labels[key] === value);

test("slave nodes share credentials, wait for the master and receive role-specific traffic", (t) => {
  const chart = makeChart(t);
  const docs = chart.render({ slave: { enabled: true, replicaCount: 2 }, config: { syncFrequency: 30, batchUpdateEnabled: false, batchUpdateInterval: 2, errorLogEnabled: true, memoryCacheEnabled: true, timezone: "Asia/Shanghai" } });
  const master = statefulset(docs), slave = statefulset(docs, "slave");
  assert.equal(master.spec.replicas, 1);
  assert.equal(slave.spec.replicas, 2);
  assert.equal(env(docs, "NODE_TYPE", "master").value, "master");
  assert.equal(env(docs, "NODE_TYPE", "slave").value, "slave");
  for (const role of ["master", "slave"]) {
    const workload = statefulset(docs, role), app = container(docs, role);
    assert.equal(env(docs, "SYNC_FREQUENCY", role).value, "30");
    assert.equal(env(docs, "BATCH_UPDATE_ENABLED", role).value, "false");
    assert.equal(env(docs, "BATCH_UPDATE_INTERVAL", role).value, "2");
    assert.equal(env(docs, "ERROR_LOG_ENABLED", role).value, "true");
    assert.equal(env(docs, "MEMORY_CACHE_ENABLED", role).value, "true");
    assert.equal(env(docs, "TZ", role).value, "Asia/Shanghai");
    assert.deepEqual(env(docs, "NODE_NAME", role).valueFrom, { fieldRef: { fieldPath: "metadata.name" } });
    assert.ok(app.args.includes("--log-dir="));
    assert.equal(workload.spec.volumeClaimTemplates, undefined);
    assert.deepEqual(workload.spec.template.spec.volumes, [{ name: "tmp", emptyDir: {} }]);
    const governing = resource(docs, "Service", workload.spec.serviceName);
    assert.equal(governing.spec.clusterIP, "None");
    assert.equal(governing.spec.publishNotReadyAddresses, true);
    assert.ok(selects(governing, workload));
    assert.ok(!selects(governing, statefulset(docs, role === "master" ? "slave" : "master")));
  }
  for (const key of ["SESSION_SECRET", "CRYPTO_SECRET", "NEW_API_DB_HOST", "NEW_API_DB_PORT", "NEW_API_DB_USER", "NEW_API_DB_NAME", "NEW_API_DB_PASSWORD", "NEW_API_VALKEY_HOST", "NEW_API_VALKEY_PORT", "NEW_API_VALKEY_PASSWORD"]) {
    assert.deepEqual(env(docs, key, "master"), env(docs, key, "slave"));
  }
  const publicService = resource(docs, "Service", "new-api");
  assert.ok(selects(publicService, master));
  assert.ok(selects(publicService, slave));
  for (const role of ["master", "slave"]) {
    const service = resource(docs, "Service", `new-api-${role}`);
    assert.ok(selects(service, statefulset(docs, role)));
    assert.ok(!selects(service, statefulset(docs, role === "master" ? "slave" : "master")));
  }
  const wait = slave.spec.template.spec.initContainers[0];
  assert.equal(wait.name, "wait-for-master");
  assert.deepEqual(wait.securityContext, container(docs, "slave").securityContext);
  assert.equal(wait.env[0].value, "http://new-api-master-0.new-api-master-headless.default.svc.cluster.local:3000");
  assert.match(wait.args[0], /success.*true/);
  assert.equal(master.spec.template.spec.initContainers, undefined);
  execFileSync("helm", ["lint", "--strict", chart.path, "--set", "slave.enabled=true"], { stdio: "pipe" });
});

test("slave settings override shared environment and resources without changing the master", (t) => {
  const docs = makeChart(t).render({
    config: { errorLogEnabled: true },
    extraEnvVars: [{ name: "RELAY_TIMEOUT", value: "60" }],
    resources: { requests: { cpu: "100m", memory: "128Mi" } },
    slave: { enabled: true, frontendBaseUrl: "https://admin.example.com", extraEnvVars: [{ name: "RELAY_TIMEOUT", value: "120" }], resources: { requests: { cpu: "200m", memory: "256Mi" } }, updateStrategy: { rollingUpdate: { partition: 2 } } },
  });
  assert.equal(env(docs, "RELAY_TIMEOUT", "master").value, "60");
  assert.equal(env(docs, "RELAY_TIMEOUT", "slave").value, "120");
  assert.equal(container(docs, "slave").env.filter((v) => v.name === "RELAY_TIMEOUT").length, 1);
  assert.equal(env(docs, "ERROR_LOG_ENABLED", "slave").value, "true");
  assert.equal(env(docs, "FRONTEND_BASE_URL", "master"), undefined);
  assert.equal(env(docs, "FRONTEND_BASE_URL", "slave").value, "https://admin.example.com");
  assert.equal(container(docs, "master").resources.requests.memory, "128Mi");
  assert.equal(container(docs, "slave").resources.requests.memory, "256Mi");
  assert.equal(statefulset(docs).spec.updateStrategy.rollingUpdate, undefined);
  assert.deepEqual(statefulset(docs, "slave").spec.updateStrategy, { type: "RollingUpdate", rollingUpdate: { partition: 2 } });
});

test("master/slave names stay distinct and headless Services remain available without client Services", (t) => {
  const chart = makeChart(t);
  for (const fullname of ["gateway", "a".repeat(63)]) {
    const docs = chart.render({ fullnameOverride: fullname, slave: { enabled: true }, service: { enabled: false }, updateStrategy: { type: "OnDelete" } });
    const services = docs.filter((doc) => doc.kind === "Service" && doc.spec.ports.some((port) => port.name === "http"));
    assert.equal(services.length, 2);
    assert.equal(new Set(services.map((doc) => doc.metadata.name)).size, 2);
    for (const role of ["master", "slave"]) {
      const workload = statefulset(docs, role);
      assert.ok(workload.metadata.name.endsWith(`-${role}`));
      assert.equal(workload.spec.updateStrategy.type, "OnDelete");
      assert.ok(workload.spec.serviceName.endsWith(`-${role}-headless`));
      assert.ok(workload.spec.serviceName.length <= 63);
      assert.ok(selects(resource(docs, "Service", workload.spec.serviceName), workload));
    }
  }
});

function runStartup(docs, overrides = {}) {
  const app = container(docs);
  const variables = Object.fromEntries(app.env.filter((v) => v.value !== undefined).map((v) => [v.name, v.value]));
  const code = "process.stdout.write(JSON.stringify({sql:process.env.SQL_DSN,valkey:process.env.REDIS_CONN_STRING,args:process.argv.slice(1)}))";
  return JSON.parse(execFileSync(app.command[0], [...app.command.slice(1), app.args[0], "--", process.execPath, "-e", code, "--", ...app.args.slice(3)], {
    encoding: "utf8", env: { ...process.env, ...variables, ...overrides },
  }));
}

test("startup safely encodes raw database and Valkey credentials and preserves arguments", (t) => {
  const docs = makeChart(t).render({
    postgresql: { auth: { username: "user @:+", database: "db /?中文" } },
    args: ["--log-dir=", "literal $() ' argument"],
  });
  const password = "p@ss:/?#%+ $()'\"中文\nend";
  const result = runStartup(docs, { NEW_API_DB_PASSWORD: password, NEW_API_VALKEY_PASSWORD: password });
  const pg = new URL(result.sql), valkey = new URL(result.valkey);
  assert.equal(decodeURIComponent(pg.username), "user @:+");
  assert.equal(decodeURIComponent(pg.password), password);
  assert.equal(decodeURIComponent(pg.pathname.slice(1)), "db /?中文");
  assert.equal(pg.searchParams.get("sslmode"), "disable");
  assert.equal(decodeURIComponent(valkey.password), password);
  assert.equal(valkey.hostname, "new-api-valkey.default.svc.cluster.local");
  assert.deepEqual(result.args, ["--port=3000", "--log-dir=", "literal $() ' argument"]);
});

test("bundled services respect custom names, ports, namespaces and existing Secrets", (t) => {
  const docs = makeChart(t).render({
    namespaceOverride: "gateway", clusterDomain: "example.internal",
    global: { postgresql: {
      fullnameOverride: "gateway-db", auth: { username: "gateway", database: "requests", existingSecret: "pg-auth", existingSecretPasswordKey: "password" },
      service: { ports: { postgresql: 5433 } },
    } },
    postgresql: { namespaceOverride: "gateway" },
    valkey: { namespaceOverride: "gateway", fullnameOverride: "gateway-valkey", service: { ports: { valkey: 6380 } }, auth: { existingSecret: "valkey-auth", existingSecretPasswordKey: "password" } },
    config: { existingSecret: "gateway-auth", sessionSecretKey: "session", cryptoSecretKey: "crypto" },
  });
  assert.equal(env(docs, "NEW_API_DB_HOST").value, "gateway-db.gateway.svc.example.internal");
  assert.equal(env(docs, "NEW_API_DB_PORT").value, "5433");
  assert.equal(env(docs, "NEW_API_DB_USER").value, "gateway");
  assert.equal(env(docs, "NEW_API_DB_NAME").value, "requests");
  assert.equal(env(docs, "NEW_API_VALKEY_HOST").value, "gateway-valkey.gateway.svc.example.internal");
  assert.equal(env(docs, "NEW_API_VALKEY_PORT").value, "6380");
  for (const [name, secret, key] of [["NEW_API_DB_PASSWORD", "pg-auth", "password"], ["NEW_API_VALKEY_PASSWORD", "valkey-auth", "password"], ["SESSION_SECRET", "gateway-auth", "session"], ["CRYPTO_SECRET", "gateway-auth", "crypto"]]) {
    assert.deepEqual(env(docs, name).valueFrom.secretKeyRef, { name: secret, key });
  }
  assert.equal(docs.filter((doc) => doc.kind === "Secret").length, 0);
});

test("external PostgreSQL and Valkey URLs stay in Secrets and pass through unchanged", (t) => {
  const chart = makeChart(t);
  const sqlUrl = new URL("postgresql://db.example.com:5432/newapi?sslmode=require");
  const valkeyUrl = new URL("rediss://valkey.example.com:6380/2");
  for (const url of [sqlUrl, valkeyUrl]) {
    url.username = "test-user";
    url.password = `test-${randomUUID()}@pass`;
  }
  const sql = sqlUrl.toString(), valkey = valkeyUrl.toString();
  const values = {
    postgresql: { enabled: false }, valkey: { enabled: false }, externalPostgresql: { url: sql }, externalValkey: { url: valkey },
    config: { sessionSecret: "stable-session", cryptoSecret: "stable-crypto" },
  };
  const docs = chart.render(values);
  assert.equal(docs.filter((doc) => doc.kind === "StatefulSet").length, 1);
  assert.equal(decode(resource(docs, "Secret", "new-api").data["session-secret"]), values.config.sessionSecret);
  assert.equal(decode(resource(docs, "Secret", "new-api").data["crypto-secret"]), values.config.cryptoSecret);
  for (const [name, secret, key, value] of [["SQL_DSN", "new-api-external-postgresql", "sql-dsn", sql], ["REDIS_CONN_STRING", "new-api-external-valkey", "valkey-url", valkey]]) {
    assert.deepEqual(env(docs, name).valueFrom.secretKeyRef, { name: secret, key });
    assert.equal(decode(resource(docs, "Secret", secret).data[key]), value);
    assert.ok(!JSON.stringify(statefulset(docs)).includes(value));
  }
  const result = runStartup(docs, { SQL_DSN: sql, REDIS_CONN_STRING: valkey });
  assert.equal(result.sql, sql);
  assert.equal(result.valkey, valkey);
  const checksum = (d) => statefulset(d).spec.template.metadata.annotations["checksum/config"];
  assert.equal(checksum(docs), checksum(chart.render(values)));
  for (const change of [{ config: { ...values.config, sessionSecret: "rotated-session" } }, { config: { ...values.config, cryptoSecret: "rotated-crypto" } }, { externalPostgresql: { url: sql + "&application_name=new-api" } }, { externalValkey: { url: valkey + "?pool_size=20" } }]) {
    assert.notEqual(checksum(docs), checksum(chart.render({ ...values, ...change })));
  }
});

test("external Secrets need no managed credentials or database workloads", (t) => {
  const docs = makeChart(t).render({
    postgresql: { enabled: false }, valkey: { enabled: false },
    externalPostgresql: { existingSecret: "db", secretKey: "dsn" }, externalValkey: { existingSecret: "valkey", secretKey: "url" },
    config: { existingSecret: "auth" },
  });
  assert.equal(docs.filter((doc) => ["Secret", "PersistentVolumeClaim"].includes(doc.kind)).length, 0);
  assert.deepEqual(env(docs, "SQL_DSN").valueFrom.secretKeyRef, { name: "db", key: "dsn" });
  assert.deepEqual(env(docs, "REDIS_CONN_STRING").valueFrom.secretKeyRef, { name: "valkey", key: "url" });
});

test("external PostgreSQL, Valkey and application Secret references are shared by both roles", (t) => {
  const docs = makeChart(t).render({
    slave: { enabled: true }, postgresql: { enabled: false }, valkey: { enabled: false },
    externalPostgresql: { existingSecret: "external-pg", secretKey: "url" },
    externalValkey: { existingSecret: "external-valkey", secretKey: "url" },
    config: { existingSecret: "application-auth", sessionSecretKey: "session", cryptoSecretKey: "crypto" },
  });
  assert.equal(docs.filter((doc) => doc.kind === "StatefulSet").length, 2);
  assert.equal(docs.filter((doc) => ["Secret", "PersistentVolumeClaim"].includes(doc.kind)).length, 0);
  for (const name of ["SQL_DSN", "REDIS_CONN_STRING", "SESSION_SECRET", "CRYPTO_SECRET"]) {
    assert.deepEqual(env(docs, name, "slave"), env(docs, name, "master"));
  }
  assert.deepEqual(env(docs, "SESSION_SECRET").valueFrom.secretKeyRef, { name: "application-auth", key: "session" });
  assert.deepEqual(env(docs, "CRYPTO_SECRET").valueFrom.secretKeyRef, { name: "application-auth", key: "crypto" });
});

test("external Secret names retain their suffixes for custom and long fullnames", (t) => {
  const chart = makeChart(t);
  for (const fullname of ["gateway", "a".repeat(63)]) {
    const docs = chart.render({
      fullnameOverride: fullname,
      postgresql: { enabled: false }, valkey: { enabled: false },
      externalPostgresql: { url: "postgresql://db/newapi", secretKey: "postgresql-url" },
      externalValkey: { url: "redis://valkey/0", secretKey: "connection-url" },
    });
    assert.equal(env(docs, "SESSION_SECRET").valueFrom.secretKeyRef.name, fullname);
    assert.equal(env(docs, "CRYPTO_SECRET").valueFrom.secretKeyRef.name, fullname);
    assert.ok(resource(docs, "Secret", fullname).data["session-secret"]);
    for (const [name, suffix, limit, key] of [
      ["SQL_DSN", "external-postgresql", 43, "postgresql-url"],
      ["REDIS_CONN_STRING", "external-valkey", 47, "connection-url"],
    ]) {
      const expectedName = `${fullname.slice(0, limit)}-${suffix}`;
      const ref = env(docs, name).valueFrom.secretKeyRef;
      assert.deepEqual(ref, { name: expectedName, key });
      assert.ok(resource(docs, "Secret", expectedName).data[key]);
      assert.ok(expectedName.length <= 63);
    }
  }
});

test("mixed external and bundled services and passwordless Valkey generate the correct URLs", (t) => {
  const chart = makeChart(t);
  const sql = "postgresql://db/newapi", valkey = "redis://external-valkey/3";
  const externalDb = chart.render({ postgresql: { enabled: false }, externalPostgresql: { url: sql }, valkey: { auth: { enabled: false } } });
  assert.equal(env(externalDb, "NEW_API_VALKEY_PASSWORD"), undefined);
  const result = runStartup(externalDb, { SQL_DSN: sql });
  assert.equal(result.sql, sql);
  assert.equal(result.valkey, "redis://new-api-valkey.default.svc.cluster.local:6379/0");
  const externalValkey = chart.render({ valkey: { enabled: false }, externalValkey: { url: valkey } });
  const other = runStartup(externalValkey, { NEW_API_DB_PASSWORD: "secret", REDIS_CONN_STRING: valkey });
  assert.equal(other.valkey, valkey);
  assert.equal(new URL(other.sql).hostname, "new-api-postgresql.default.svc.cluster.local");
});

test("Ingress, port overrides and pod customization work together", (t) => {
  const docs = makeChart(t).render({
    fullnameOverride: "gateway", containerPorts: { http: 8080 },
    service: { type: "NodePort", ports: { http: 8081 }, nodePorts: { http: 30080 } },
    ingress: { enabled: true, hostname: "api.example.com", tls: true, ingressClassName: "nginx" },
    config: { errorLogEnabled: true },
    extraEnvVars: [{ name: "RELAY_TIMEOUT", value: "90" }],
    extraVolumes: [{ name: "config", configMap: { name: "gateway-config" } }],
    extraVolumeMounts: [{ name: "config", mountPath: "/config", readOnly: true }],
    podLabels: { team: "platform" }, resources: { requests: { cpu: "100m", memory: "128Mi" } },
  });
  const app = container(docs), svc = resource(docs, "Service", "gateway"), ingress = resource(docs, "Ingress");
  assert.ok(app.args.includes("--port=8080"));
  assert.equal(app.ports[0].containerPort, 8080);
  assert.equal(svc.spec.ports[0].port, 8081);
  assert.equal(svc.spec.ports[0].nodePort, 30080);
  assert.deepEqual(ingress.spec.rules[0].http.paths[0].backend.service, { name: "gateway", port: { name: "http" } });
  assert.equal(ingress.spec.tls[0].secretName, "api.example.com-tls");
  assert.equal(app.volumeMounts[1].mountPath, "/config");
  assert.equal(statefulset(docs).spec.template.spec.volumes[1].name, "config");
  assert.equal(app.resources.requests.memory, "128Mi");
  assert.equal(env(docs, "ERROR_LOG_ENABLED").value, "true");
  assert.equal(env(docs, "RELAY_TIMEOUT").value, "90");
  for (const selector of [svc.spec.selector, statefulset(docs).spec.selector.matchLabels]) {
    for (const [key, value] of Object.entries(selector)) assert.equal(statefulset(docs).spec.template.metadata.labels[key], value);
  }
});

test("invalid service, authentication and routing configurations fail clearly", (t) => {
  const chart = makeChart(t);
  for (const [values, message] of [
    [{ postgresql: { enabled: false } }, /externalPostgresql.url.*required/],
    [{ valkey: { enabled: false } }, /externalValkey.url.*required/],
    [{ externalPostgresql: { url: "postgresql://db/newapi" } }, /require postgresql.enabled=false/],
    [{ externalValkey: { existingSecret: "valkey" } }, /require valkey.enabled=false/],
    [{ postgresql: { enabled: false }, externalPostgresql: { url: "mysql://db/newapi" } }, /PostgreSQL connection URL/],
    [{ valkey: { enabled: false }, externalValkey: { url: "http://valkey" } }, /redis:\/\/ or rediss:\/\//],
    [{ postgresql: { enabled: false }, externalPostgresql: { url: "postgresql://db/newapi", existingSecret: "db" } }, /set only one/],
    [{ valkey: { enabled: false }, externalValkey: { url: "redis://valkey", existingSecret: "valkey" } }, /set only one/],
    [{ postgresql: { service: { enabled: false } } }, /postgresql.service.enabled must be true/],
    [{ valkey: { service: { enabled: false } } }, /valkey.service.enabled must be true/],
    [{ postgresql: { namespaceOverride: "other" } }, /must match the New API namespace/],
    [{ valkey: { namespaceOverride: "other" } }, /must match the New API namespace/],
    [{ postgresql: { auth: { trustAuthentication: true } } }, /trustAuthentication is not supported/],
    [{ config: { existingSecret: "auth", sessionSecret: "session" } }, /cannot be combined/],
    [{ config: { existingSecret: "auth", cryptoSecret: "crypto" } }, /cannot be combined/],
    [{ config: { cryptoSecretKey: "session-secret" } }, /must be non-empty and different/],
    [{ config: { sessionSecret: "random_string" } }, /must not be the upstream placeholder/],
    [{ containerPorts: { http: 65536 } }, /containerPorts.http must be an integer/],
    [{ service: { enabled: false }, ingress: { enabled: true } }, /service.enabled must be true/],
    [{ ingress: { enabled: true, tls: true, hostname: "" } }, /ingress.hostname must not be empty/],
    [{ extraEnvVars: [{ name: "SQL_DSN", value: "override" }] }, /must not override/],
    [{ extraEnvVars: [{ name: "NODE_TYPE", value: "slave" }] }, /must not override/],
    [{ slave: { enabled: true, extraEnvVars: [{ name: "SESSION_SECRET", value: "override" }] } }, /must not override/],
    [{ slave: { enabled: true, replicaCount: -1 } }, /slave.replicaCount must be a non-negative integer/],
    [{ config: { syncFrequency: 0 } }, /config.syncFrequency must be a positive integer/],
    [{ config: { batchUpdateInterval: 0 } }, /config.batchUpdateInterval must be a positive integer/],
    [{ config: { batchUpdateEnabled: "true" } }, /config.batchUpdateEnabled must be a boolean/],
    [{ config: { errorLogEnabled: "true" } }, /config.errorLogEnabled must be a boolean/],
    [{ config: { memoryCacheEnabled: 1 } }, /config.memoryCacheEnabled must be a boolean/],
    [{ config: { timezone: "" } }, /config.timezone must be a non-empty string/],
    [{ config: { timezone: 8 } }, /config.timezone must be a non-empty string/],
    [{ extraEnvVars: [{ name: "ERROR_LOG_ENABLED", value: "true" }] }, /must not override/],
    [{ slave: { extraEnvVars: [{ name: "MEMORY_CACHE_ENABLED", value: "true" }] } }, /must not override/],
    [{ extraEnvVars: [{ name: "TZ", value: "UTC" }] }, /must not override/],
    [{ extraEnvVars: [{ name: "BATCH_UPDATE_ENABLED", value: "true" }] }, /must not override/],
    [{ slave: { extraEnvVars: [{ name: "BATCH_UPDATE_INTERVAL", value: "3" }] } }, /must not override/],
    [{ podManagementPolicy: "invalid" }, /podManagementPolicy must be OrderedReady or Parallel/],
    [{ updateStrategy: { type: "Recreate" } }, /updateStrategy.type must be RollingUpdate or OnDelete/],
    [{ slave: { updateStrategy: { type: "Recreate" } } }, /updateStrategy.type must be RollingUpdate or OnDelete/],
  ]) {
    const result = chart.result(values);
    assert.notEqual(result.status, 0, JSON.stringify(values));
    assert.match(result.stderr, message);
  }
});

test("the chart packages and every README values example renders", (t) => {
  const chart = makeChart(t);
  const readme = readFileSync(join(ROOT, "charts/new-api/README.md"), "utf8");
  const examples = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)];
  assert.ok(examples.length >= 4);
  for (const [, values] of examples) chart.render(parse(values));
  const metadata = parse(readFileSync(join(chart.path, "Chart.yaml"), "utf8"));
  const output = join(chart.path, "..");
  execFileSync("helm", ["package", chart.path, "-d", output], { stdio: "pipe" });
  execFileSync("helm", ["template", "packaged", join(output, `new-api-${metadata.version}.tgz`)], { stdio: "pipe" });
});
