import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeOpenVikingChart() {
  const dir = mkdtempSync(join(tmpdir(), "openviking-chart-"));
  const chart = join(dir, "openviking");
  cpSync(join(ROOT, "charts", "openviking"), chart, { recursive: true });
  rmSync(join(chart, "charts"), { force: true, recursive: true });
  mkdirSync(join(chart, "charts"), { recursive: true });

  const commonOutput = execFileSync("helm", ["package", join(ROOT, "charts", "common"), "--destination", join(chart, "charts")], {
    encoding: "utf8",
  });
  assert.match(commonOutput, /common-.*\.tgz/);

  function render(...args) {
    return execFileSync("helm", ["template", "openviking", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
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

test("default render stores ov.conf in a Secret and mounts it into a StatefulSet", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render(
      "--set",
      "config.server.root_api_key=test-root-key",
      "--set",
      "config.embedding.dense.api_key=test-embedding-key",
      "--set",
      "config.vlm.api_key=test-vlm-key",
    );

    assert.deepEqual(resourceNames(manifest, "ConfigMap"), []);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["openviking"]);
    assert.deepEqual(resourceNames(manifest, "Secret"), ["openviking-config"]);
    assert.deepEqual(resourceNames(manifest, "StatefulSet"), ["openviking"]);
    assert.match(manifest, /image: ghcr\.io\/volcengine\/openviking:v0\.3\.17/);
    assert.match(manifest, /stringData:\n\s+ov\.conf: \|/);
    assert.match(manifest, /"agfs": \{\n\s+"backend": "local"\n\s+\}/);
    assert.match(manifest, /"vectordb": \{\n\s+"backend": "local"\n\s+\}/);
    assert.match(manifest, /"workspace": "\.\/data"/);
    assert.match(manifest, /"root_api_key": "test-root-key"/);
    assert.doesNotMatch(manifest, /"max_concurrent"/);
    assert.doesNotMatch(manifest, /"temperature"/);
    assert.doesNotMatch(manifest, /"max_retries"/);
    assert.doesNotMatch(manifest, /"thinking"/);
    assert.match(manifest, /serviceAccountName: openviking/);
    assert.match(manifest, /secret:\n\s+secretName: openviking-config/);
    assert.match(manifest, /mountPath: \/app\/\.openviking\/ov\.conf/);
    assert.match(manifest, /subPath: ov\.conf/);
    assert.doesNotMatch(manifest, /OPENVIKING_CONFIG_FILE/);
  } finally {
    chart.cleanup();
  }
});

test("default config uses shell-style environment placeholders", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render();

    assert.match(manifest, /"root_api_key": "\$\{ROOT_API_KEY\}"/);
    assert.match(manifest, /"api_key": "\$\{EMBEDDING_API_KEY\}"/);
    assert.match(manifest, /"api_key": "\$\{VLM_API_KEY\}"/);
    assert.doesNotMatch(manifest, /\{\$[A-Z_]+\}/);
  } finally {
    chart.cleanup();
  }
});

test("existing config Secret is referenced without rendering the chart-managed Secret", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render("--set", "config.existingSecret=shared-openviking-config", "--set", "config.existingSecretKey=custom.conf");

    assert.deepEqual(resourceNames(manifest, "Secret"), []);
    assert.match(manifest, /secret:\n\s+secretName: shared-openviking-config/);
    assert.match(manifest, /key: custom\.conf\n\s+path: ov\.conf/);
    assert.match(manifest, /mountPath: \/app\/\.openviking\/ov\.conf/);
    assert.match(manifest, /subPath: ov\.conf/);
  } finally {
    chart.cleanup();
  }
});

test("default persistence uses a StatefulSet volumeClaimTemplate", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render("--set", "persistence.storageClassName=fast-ssd");

    assert.deepEqual(resourceNames(manifest, "PersistentVolumeClaim"), []);
    assert.match(manifest, /volumeClaimTemplates:/);
    assert.match(manifest, /name: data/);
    assert.match(manifest, /storage: "10Gi"/);
    assert.match(manifest, /storageClassName: fast-ssd/);
    assert.match(manifest, /mountPath: \/app\/data/);
  } finally {
    chart.cleanup();
  }
});

test("default resources use the medium preset", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render();

    assert.match(manifest, /resources:\n\s+limits:\n\s+cpu: 750m\n\s+ephemeral-storage: 2Gi\n\s+memory: 1536Mi\n\s+requests:\n\s+cpu: 500m\n\s+ephemeral-storage: 50Mi\n\s+memory: 1024Mi/);
  } finally {
    chart.cleanup();
  }
});

test("persistence can inherit the global default storageClassName", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render("--set", "global.defaultStorageClassName=standard");

    assert.match(manifest, /storageClassName: standard/);
  } finally {
    chart.cleanup();
  }
});

test("probes are fixed in the StatefulSet and are not configurable through values", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render(
      "--set",
      "startupProbe.enabled=true",
      "--set",
      "livenessProbe.httpGet.path=/custom-live",
      "--set",
      "readinessProbe.httpGet.path=/custom-ready",
      "--set",
      "customLivenessProbe.httpGet.path=/custom-live",
      "--set",
      "customReadinessProbe.httpGet.path=/custom-ready",
    );

    assert.doesNotMatch(manifest, /startupProbe:/);
    assert.match(manifest, /livenessProbe:\n\s+httpGet:\n\s+path: \/health\n\s+port: http\n\s+initialDelaySeconds: 30\n\s+periodSeconds: 30\n\s+timeoutSeconds: 5\n\s+failureThreshold: 3\n\s+successThreshold: 1/);
    assert.match(manifest, /readinessProbe:\n\s+httpGet:\n\s+path: \/ready\n\s+port: http\n\s+initialDelaySeconds: 15\n\s+periodSeconds: 10\n\s+timeoutSeconds: 5\n\s+failureThreshold: 3\n\s+successThreshold: 1/);
    assert.doesNotMatch(manifest, /custom-live|custom-ready/);
  } finally {
    chart.cleanup();
  }
});

test("replicaCount is not a supported value and the StatefulSet stays single replica", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render("--set", "replicaCount=2");

    assert.deepEqual(resourceNames(manifest, "StatefulSet"), ["openviking"]);
    assert.match(manifest, /replicas: 1/);
    assert.doesNotMatch(manifest, /replicas: 2/);
  } finally {
    chart.cleanup();
  }
});

test("ingress uses Bitnami-style hostname and ingressClassName values", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render(
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hostname=openviking.example.com",
      "--set",
      "ingress.ingressClassName=traefik",
    );

    assert.deepEqual(resourceNames(manifest, "Ingress"), ["openviking"]);
    assert.match(manifest, /ingressClassName: "traefik"/);
    assert.match(manifest, /host: "openviking\.example\.com"/);
    assert.match(manifest, /path: "\/"/);
    assert.match(manifest, /pathType: ImplementationSpecific/);
  } finally {
    chart.cleanup();
  }
});

test("ingress supports Bitnami-style extra hosts, extra paths, and TLS", () => {
  const chart = makeOpenVikingChart();
  try {
    const manifest = chart.render(
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hostname=openviking.example.com",
      "--set",
      "ingress.pathType=ImplementationSpecific",
      "--set",
      "ingress.extraHosts[0].name=api.openviking.example.com",
      "--set",
      "ingress.extraHosts[0].path=/api",
      "--set",
      "ingress.extraHosts[0].pathType=Prefix",
      "--set",
      "ingress.extraPaths[0].path=/redirect",
      "--set",
      "ingress.extraPaths[0].pathType=Prefix",
      "--set",
      "ingress.extraPaths[0].backend.service.name=redirector",
      "--set",
      "ingress.extraPaths[0].backend.service.port.name=http",
      "--set",
      "ingress.tls=true",
      "--set",
      "ingress.extraTls[0].hosts[0]=api.openviking.example.com",
      "--set",
      "ingress.extraTls[0].secretName=api-openviking-tls",
    );

    assert.deepEqual(resourceNames(manifest, "Ingress"), ["openviking"]);
    assert.match(manifest, /host: "api\.openviking\.example\.com"/);
    assert.match(manifest, /path: \/redirect/);
    assert.match(manifest, /name: redirector/);
    assert.match(manifest, /secretName: openviking\.example\.com-tls/);
    assert.match(manifest, /secretName: api-openviking-tls/);
  } finally {
    chart.cleanup();
  }
});
