import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

  return { cleanup, render };
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
      "ghost.config.database.connection.host=mysql.example.svc.cluster.local",
      "--set",
      "ghost.config.mail.transport=SMTP",
    );

    assert.match(manifest, /url: "https:\/\/blog\.example\.com"/);
    assert.match(manifest, /database__connection__host: "mysql\.example\.svc\.cluster\.local"/);
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
