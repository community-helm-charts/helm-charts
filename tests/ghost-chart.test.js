import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, parseAllDocuments } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeGhostChart() {
  const dir = mkdtempSync(join(tmpdir(), "ghost-chart-"));
  const chart = join(dir, "ghost");
  const mysql = join(dir, "mysql");
  cpSync(join(ROOT, "charts", "ghost"), chart, { recursive: true });
  cpSync(join(ROOT, "charts", "mysql"), mysql, { recursive: true });
  rmSync(join(chart, "charts"), { force: true, recursive: true });
  rmSync(join(mysql, "charts"), { force: true, recursive: true });
  mkdirSync(join(chart, "charts"), { recursive: true });
  mkdirSync(join(mysql, "charts"), { recursive: true });

  const commonOutput = execFileSync("helm", ["package", join(ROOT, "charts", "common"), "--destination", join(chart, "charts")], {
    encoding: "utf8",
  });
  assert.match(commonOutput, /common-.*\.tgz/);
  cpSync(join(chart, "charts"), join(mysql, "charts"), { recursive: true });

  const mysqlOutput = execFileSync("helm", ["package", mysql, "--destination", join(chart, "charts")], {
    encoding: "utf8",
  });
  assert.match(mysqlOutput, /mysql-.*\.tgz/);

  function render(...args) {
    return execFileSync("helm", ["template", "ghost", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  function cleanup() {
    rmSync(dir, { force: true, recursive: true });
  }

  function result(values = {}) {
    return spawnSync("helm", ["template", "ghost", chart, "-f", "-"], {
      encoding: "utf8", input: JSON.stringify(values), maxBuffer: 10 * 1024 * 1024,
    });
  }

  function documents(values = {}) {
    const output = result(values);
    assert.equal(output.status, 0, output.stderr);
    return parseAllDocuments(output.stdout).map((doc) => {
      assert.deepEqual(doc.errors, []);
      return doc.toJSON();
    }).filter(Boolean);
  }

  return { cleanup, render, result, documents };
}

function resourceNames(manifest, kind) {
  return manifest
    .split(/^---$/m)
    .map((doc) => {
      const lines = doc.split("\n");
      if (!lines.some((line) => line === `kind: ${kind}`)) {
        return "";
      }
      const name = lines.find((line) => line.startsWith("  name: "));
      return name ? name.replace("  name: ", "").trim().replaceAll('"', "") : "";
    })
    .filter(Boolean)
    .sort();
}

function resourceDocument(manifest, kind, name) {
  return manifest.split(/^---$/m).find((doc) => {
    const lines = doc.split("\n");
    return lines.some((line) => line === `kind: ${kind}`) && lines.some((line) => line === `  name: ${name}`);
  });
}

test("ghost.config values flatten into the generated Secret", () => {
  const chart = makeGhostChart();
  try {
    const manifest = chart.render(
      "--set",
      "ghost.config.url=https://blog.example.com",
      "--set",
      "ghost.config.mail.options.host=smtp.example.com",
      "--set",
      "ghost.config.mail.transport=SMTP",
    );

    assert.match(manifest, /url: "https:\/\/blog\.example\.com"/);
    assert.match(manifest, /mail__options__host: "smtp\.example\.com"/);
    assert.match(manifest, /mail__transport: "SMTP"/);
  } finally {
    chart.cleanup();
  }
});

test("ghost.enabled=false keeps MySQL while omitting Ghost workload and Service", () => {
  const chart = makeGhostChart();
  try {
    const manifest = chart.render("--set", "ghost.enabled=false", "--set", "ingress.enabled=false");

    assert.deepEqual(resourceNames(manifest, "StatefulSet"), ["ghost-mysql"]);
    assert.deepEqual(resourceNames(manifest, "PersistentVolumeClaim"), ["ghost-content"]);
    assert.deepEqual(resourceNames(manifest, "Ingress"), []);
    assert.ok(resourceNames(manifest, "Service").includes("ghost-mysql"));
    assert.ok(!resourceNames(manifest, "Service").includes("ghost"));
  } finally {
    chart.cleanup();
  }
});

test("ingress can route side services without the Ghost backend", () => {
  const chart = makeGhostChart();
  try {
    const manifest = chart.render(
      "--set",
      "ghost.enabled=false",
      "--set",
      "trafficAnalytics.enabled=true",
      "--set",
      "ingress.hostname=blog.example.com",
      "--set",
      "ingress.ingressClassName=traefik",
    );

    assert.deepEqual(resourceNames(manifest, "StatefulSet"), ["ghost-mysql"]);
    assert.match(manifest, /ingressClassName: "traefik"/);
    assert.match(manifest, /path: "\/\.ghost\/analytics\/api\/v1\/page_hit"/);
    assert.match(manifest, /name: ghost-traffic-analytics/);
    assert.match(manifest, /traefik\.ingress\.kubernetes\.io\/router\.middlewares/);
    assert.doesNotMatch(manifest, /nginx\.ingress\.kubernetes\.io\/rewrite-target/);
    assert.doesNotMatch(manifest, new RegExp('path: "/"[\\s\\S]*?name: ghost\\n\\s+port:\\n\\s+name: http'));
  } finally {
    chart.cleanup();
  }
});

test("primary ingress uses Bitnami-style ingressClassName and extra host values", () => {
  const chart = makeGhostChart();
  try {
    const manifest = chart.render(
      "--set",
      "ingress.hostname=blog.example.com",
      "--set",
      "ingress.ingressClassName=nginx",
      "--set",
      "ingress.extraHosts[0].name=admin.example.com",
      "--set",
      "ingress.extraHosts[0].path=/admin",
      "--set",
      "ingress.extraHosts[0].pathType=Prefix",
    );

    assert.deepEqual(resourceNames(manifest, "Ingress"), ["ghost"]);
    assert.match(manifest, /ingressClassName: "nginx"/);
    assert.match(manifest, /host: "blog\.example\.com"/);
    assert.match(manifest, /pathType: ImplementationSpecific/);
    assert.match(manifest, /host: "admin\.example\.com"/);
    assert.match(manifest, /path: "\/admin"/);
  } finally {
    chart.cleanup();
  }
});

test("analytics updates release persistent storage before replacing the pod", () => {
  const chart = makeGhostChart();
  try {
    for (const [args, strategy] of [
      [[], "Recreate"],
      [["--set", "trafficAnalytics.persistence.existingClaim=analytics-data"], "Recreate"],
      [["--set", "trafficAnalytics.persistence.enabled=false"], "RollingUpdate"],
    ]) {
      const manifest = chart.render("--set", "trafficAnalytics.enabled=true", ...args);
      const deployment = parse(resourceDocument(manifest, "Deployment", "ghost-traffic-analytics"));
      assert.equal(deployment.spec.strategy.type, strategy);
      assert.equal(deployment.spec.replicas, 1);
    }
  } finally {
    chart.cleanup();
  }
});

test("ActivityPub runs as a native sidecar behind the Ghost Service", () => {
  const chart = makeGhostChart();
  try {
    const manifest = chart.render(
      "--set",
      "activitypub.enabled=true",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hostname=blog.example.com",
      "--set",
      "activitypub.customLivenessProbe.tcpSocket.port=http",
      "--set",
      "activitypub.customReadinessProbe.httpGet.path=/ping",
      "--set",
      "activitypub.customReadinessProbe.httpGet.port=http",
      "--set-json",
      "activitypub.startupProbe=null",
    );

    assert.ok(!resourceNames(manifest, "Deployment").includes("ghost-activitypub"));
    assert.ok(!resourceNames(manifest, "Service").includes("ghost-activitypub"));

    const statefulSet = resourceDocument(manifest, "StatefulSet", "ghost");
    assert.ok(statefulSet);
    assert.match(statefulSet, /- name: activitypub-migrate/);
    assert.match(statefulSet, /- name: activitypub\n[\s\S]*?restartPolicy: Always/);
    assert.match(statefulSet, /startupProbe:\n\s+httpGet:\n\s+path: \/ping\n\s+port: activitypub/);
    assert.match(statefulSet, /mountPath: \/opt\/activitypub\/content/);

    const service = resourceDocument(manifest, "Service", "ghost");
    assert.ok(service);
    assert.match(service, /- name: activitypub\n\s+port: 8080\n\s+targetPort: 8080/);
    assert.match(statefulSet, /livenessProbe:\n\s+tcpSocket:\n\s+port: 8080/);
    assert.match(statefulSet, /readinessProbe:\n\s+httpGet:\n\s+path: \/ping\n\s+port: 8080/);

    const ingress = resourceDocument(manifest, "Ingress", "ghost-activitypub");
    assert.ok(ingress);
    assert.match(ingress, /service:\n\s+name: ghost\n\s+port:\n\s+name: activitypub/);
  } finally {
    chart.cleanup();
  }
});

const resource = (docs, kind, name) => docs.find((doc) => doc.kind === kind && doc.metadata.name === name);
const appPod = (docs, name = "ghost") => resource(docs, "StatefulSet", name).spec.template.spec;
const env = (container, name) => container.env.find((entry) => entry.name === name);
const mysqlConsumers = (pod) => [...pod.containers, ...pod.initContainers].filter((entry) =>
  ["ghost", "wait-for-database", "activitypub-migrate", "activitypub"].includes(entry.name));
const passwordEnv = (container) => env(container, container.name === "ghost" ? "database__connection__password"
  : container.name === "wait-for-database" ? "MYSQL_PWD" : "MYSQL_PASSWORD");

test("Ghost and ActivityPub share the bundled MySQL credentials and configured Service port", (t) => {
  const chart = makeGhostChart();
  t.after(chart.cleanup);
  const docs = chart.documents({ activitypub: { enabled: true }, mysql: {
    fullnameOverride: "blog-mysql", service: { ports: { mysql: 33306 } },
    auth: { username: "publisher", database: "blog", existingSecret: "mysql-credentials", existingSecretPasswordKey: "user-password", existingSecretRootPasswordKey: "root-password" },
  } });
  const config = resource(docs, "Secret", "ghost").stringData;
  assert.equal(config.database__connection__host, "blog-mysql");
  assert.equal(config.database__connection__port, "33306");
  assert.equal(config.database__connection__user, "publisher");
  assert.equal(config.database__connection__database, "blog");
  assert.equal(config.database__connection__password, undefined);
  for (const consumer of mysqlConsumers(appPod(docs))) {
    assert.deepEqual(passwordEnv(consumer).valueFrom.secretKeyRef, { name: "mysql-credentials", key: "user-password" });
    if (consumer.name !== "ghost") {
      assert.equal(env(consumer, consumer.name === "wait-for-database" ? "DATABASE_HOST" : "MYSQL_HOST").value, "blog-mysql");
      assert.equal(env(consumer, consumer.name === "wait-for-database" ? "DATABASE_PORT" : "MYSQL_PORT").value, "33306");
    }
  }
  const job = resource(docs, "Job", "ghost-activitypub-db-init");
  assert.deepEqual(env(job.spec.template.spec.containers[0], "MYSQL_PWD").valueFrom.secretKeyRef, { name: "mysql-credentials", key: "root-password" });
  assert.equal(resource(docs, "Secret", "blog-mysql"), undefined);
});

test("internal MySQL password Secret retains the mysql name and key", (t) => {
  const chart = makeGhostChart();
  t.after(chart.cleanup);
  const docs = chart.documents();
  const ref = passwordEnv(appPod(docs).containers[0]).valueFrom.secretKeyRef;
  assert.deepEqual(ref, { name: "ghost-mysql", key: "mysql-password" });
  assert.ok(resource(docs, "Secret", ref.name).data[ref.key]);
});

test("external MySQL creates one shared password Secret and preserves its suffix for long names", (t) => {
  const chart = makeGhostChart();
  t.after(chart.cleanup);
  const password = "test p@ss:/?#%+ $()'\"中文";
  for (const name of ["ghost", "g".repeat(63)]) {
    const docs = chart.documents({
      fullnameOverride: name, mysql: { enabled: false }, activitypub: { enabled: true },
      externalMysql: { host: "mysql.example.com", port: 33306, username: "publisher", database: "blog", password, secretKey: "raw-password" },
    });
    const secretName = `${name.slice(0, 48)}-external-mysql`;
    assert.ok(secretName.length <= 63);
    assert.equal(Buffer.from(resource(docs, "Secret", secretName).data["raw-password"], "base64").toString(), password);
    assert.equal(docs.filter((doc) => doc.kind === "StatefulSet").length, 1);
    const pod = appPod(docs, name);
    for (const consumer of mysqlConsumers(pod)) {
      assert.deepEqual(passwordEnv(consumer).valueFrom.secretKeyRef, { name: secretName, key: "raw-password" });
    }
    const config = resource(docs, "Secret", name).stringData;
    assert.equal(config.database__connection__host, "mysql.example.com");
    assert.equal(config.database__connection__port, "33306");
    assert.equal(config.database__connection__user, "publisher");
    assert.equal(config.database__connection__database, "blog");
    assert.equal(config.database__connection__password, undefined);
    assert.ok(!JSON.stringify(pod).includes(password));
    assert.ok(!docs.some((doc) => doc.kind === "Job"));
  }
});

test("external MySQL existing Secrets, TLS options and password rollouts work together", (t) => {
  const chart = makeGhostChart();
  t.after(chart.cleanup);
  const values = { mysql: { enabled: false }, activitypub: { enabled: true },
    externalMysql: { host: "mysql.example.com", existingSecret: "external-mysql", secretKey: "password" },
    ghost: { config: { database: { connection: { ssl: { rejectUnauthorized: true } } } } },
  };
  const docs = chart.documents(values);
  for (const consumer of mysqlConsumers(appPod(docs))) {
    assert.deepEqual(passwordEnv(consumer).valueFrom.secretKeyRef, { name: "external-mysql", key: "password" });
  }
  assert.equal(resource(docs, "Secret", "ghost-external-mysql"), undefined);
  assert.equal(resource(docs, "Secret", "ghost").stringData.database__connection__ssl__rejectUnauthorized, "true");
  const checksum = (documents) => resource(documents, "StatefulSet", "ghost").spec.template.metadata.annotations["checksum/mysql"];
  const initial = chart.documents({ mysql: { enabled: false }, externalMysql: { host: "mysql.example.com", password: "test-initial-password" } });
  const rotated = chart.documents({ mysql: { enabled: false }, externalMysql: { host: "mysql.example.com", password: "test-rotated-password" } });
  assert.notEqual(checksum(initial), checksum(rotated));
});

test("invalid or conflicting MySQL configuration fails with the current values names", (t) => {
  const chart = makeGhostChart();
  t.after(chart.cleanup);
  for (const [values, message] of [
    [{ mysql: { enabled: false }, externalMysql: { password: "test-password" } }, /externalMysql.host is required/],
    [{ mysql: { enabled: false }, externalMysql: { host: "mysql.example.com", password: "test-password", existingSecret: "mysql" } }, /set only one/],
    [{ externalMysql: { host: "mysql.example.com" } }, /externalMysql.*require mysql.enabled=false/],
    [{ mysql: { service: { enabled: false } } }, /mysql.service.enabled must be true/],
    [{ mysql: { namespaceOverride: "other" } }, /must match the Ghost namespace/],
    [{ mysql: { enabled: false }, externalMysql: { host: "mysql.example.com", password: "test-password", port: 0 } }, /MySQL service port must be an integer/],
    [{ ghost: { config: { database: { connection: { password: "test-password" } } } } }, /use mysql.auth or externalMysql/],
  ]) {
    const result = chart.result(values);
    assert.notEqual(result.status, 0, JSON.stringify(values));
    assert.match(result.stderr, message);
  }
});

test("every Ghost README values example renders", (t) => {
  const chart = makeGhostChart();
  t.after(chart.cleanup);
  const readme = readFileSync(join(ROOT, "charts/ghost/README.md"), "utf8");
  const examples = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)];
  assert.ok(examples.length >= 4);
  for (const [, values] of examples) chart.documents(parse(values));
});
