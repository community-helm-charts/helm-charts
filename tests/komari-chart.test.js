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

test("server persistence inherits the global default StorageClass", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render("--set", "global.defaultStorageClassName=fast");
    assert.match(manifest, /storageClassName: fast/);
  } finally {
    chart.cleanup();
  }
});

test("server ingress, probes, and scheduling values render", () => {
  const chart = makeKomariChart();
  try {
    const manifest = chart.render(
      "--set",
      "server.ingress.enabled=true",
      "--set",
      "server.ingress.hostname=monitor.example.com",
      "--set",
      "server.ingress.ingressClassName=traefik",
      "--set",
      "server.startupProbe.enabled=true",
      "--set",
      "server.customLivenessProbe.exec.command[0]=true",
      "--set",
      "server.nodeSelector.role=monitoring",
      "--set",
      "server.tolerations[0].operator=Exists",
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
      "--set",
      "server.image.registry=registry.example.com",
      "--set",
      "server.image.repository=observability/komari",
      "--set",
      "server.image.tag=custom",
    );
    assert.match(manifest, /image: registry\.example\.com\/observability\/komari:custom/);
  } finally {
    chart.cleanup();
  }
});
