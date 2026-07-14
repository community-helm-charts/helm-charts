import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeShadowsocksChart() {
  const dir = mkdtempSync(join(tmpdir(), "shadowsocks-chart-"));
  const chart = join(dir, "shadowsocks");
  cpSync(join(ROOT, "charts", "shadowsocks"), chart, { recursive: true });
  rmSync(join(chart, "charts"), { force: true, recursive: true });
  mkdirSync(join(chart, "charts"), { recursive: true });

  const commonOutput = execFileSync("helm", ["package", join(ROOT, "charts", "common"), "--destination", join(chart, "charts")], {
    encoding: "utf8",
  });
  assert.match(commonOutput, /common-.*\.tgz/);

  function render(...args) {
    return execFileSync("helm", ["template", "shadowsocks", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function renderResult(...args) {
    return spawnSync("helm", ["template", "shadowsocks", chart, ...args], {
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
      if (!lines.some((line) => line === `kind: ${kind}`)) {
        return "";
      }
      const name = lines.find((line) => line.startsWith("  name: "));
      return name ? name.replace("  name: ", "").trim().replaceAll('"', "") : "";
    })
    .filter(Boolean)
    .sort();
}

test("chart metadata pins shadowsocks-rust v1.24.0 and the local common dependency", () => {
  const chart = readFileSync(join(ROOT, "charts", "shadowsocks", "Chart.yaml"), "utf8");

  assert.match(chart, /^name: shadowsocks$/m);
  assert.match(chart, /^version: 1\.0\.0$/m);
  assert.match(chart, /^appVersion: "v1\.24\.0"$/m);
  assert.match(chart, /image: ghcr\.io\/shadowsocks\/ssserver-rust:v1\.24\.0/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
  assert.match(chart, /version: 0\.2\.1/);
});

test("default render creates a host-networked Shadowsocks DaemonSet and TCP/UDP Service", () => {
  const chart = makeShadowsocksChart();
  try {
    const manifest = chart.render();

    assert.deepEqual(resourceNames(manifest, "ConfigMap"), ["shadowsocks-config"]);
    assert.deepEqual(resourceNames(manifest, "Secret"), ["shadowsocks-auth"]);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["shadowsocks"]);
    assert.deepEqual(resourceNames(manifest, "DaemonSet"), ["shadowsocks"]);
    assert.deepEqual(resourceNames(manifest, "Service"), ["shadowsocks"]);
    assert.match(manifest, /image: ghcr\.io\/shadowsocks\/ssserver-rust:v1\.24\.0/);
    assert.match(manifest, /hostNetwork: true/);
    assert.match(manifest, /dnsPolicy: Default/);
    assert.match(manifest, /"server": "::"/);
    assert.match(manifest, /"server_port": 8388/);
    assert.match(manifest, /"method": "aes-256-gcm"/);
    assert.match(manifest, /"fast_open": true/);
    assert.match(manifest, /"mode": "tcp_and_udp"/);
    assert.match(manifest, /"password": "\$\{SHADOWSOCKS_PASSWORD\}"/);
    assert.match(manifest, /stringData:\n\s+password: "changeme"/);
    assert.match(
      manifest,
      /name: SHADOWSOCKS_PASSWORD[\s\S]*?secretKeyRef:[\s\S]*?name: shadowsocks-auth[\s\S]*?key: password/,
    );
    assert.match(manifest, /mountPath: \/etc\/shadowsocks-rust\/config\.json/);
    assert.match(manifest, /- name: tcp\n\s+containerPort: 8388\n\s+protocol: TCP/);
    assert.match(manifest, /- name: udp\n\s+containerPort: 8388\n\s+protocol: UDP/);
    assert.match(manifest, /livenessProbe:\n\s+tcpSocket:\n\s+port: tcp/);
    assert.match(manifest, /readinessProbe:\n\s+tcpSocket:\n\s+port: tcp/);
    assert.match(manifest, /internalTrafficPolicy: Local/);
    assert.match(manifest, /- name: tcp\n\s+port: 8388\n\s+targetPort: tcp\n\s+protocol: TCP/);
    assert.match(manifest, /- name: udp\n\s+port: 8388\n\s+targetPort: udp\n\s+protocol: UDP/);
  } finally {
    chart.cleanup();
  }
});

test("config values map directly to JSON and server_port drives workload and Service ports", () => {
  const chart = makeShadowsocksChart();
  try {
    const manifest = chart.render(
      "--set",
      "config.server_port=9443",
      "--set",
      "config.udp_timeout=300",
      "--set",
      "config.outbound_bind_addr=192.0.2.10",
    );

    assert.match(manifest, /"server_port": 9443/);
    assert.match(manifest, /"udp_timeout": 300/);
    assert.match(manifest, /"outbound_bind_addr": "192\.0\.2\.10"/);
    assert.match(manifest, /- name: tcp\n\s+containerPort: 9443\n\s+protocol: TCP/);
    assert.match(manifest, /- name: udp\n\s+containerPort: 9443\n\s+protocol: UDP/);
    assert.match(manifest, /- name: tcp\n\s+port: 9443\n\s+targetPort: tcp\n\s+protocol: TCP/);
    assert.match(manifest, /- name: udp\n\s+port: 9443\n\s+targetPort: udp\n\s+protocol: UDP/);
    assert.doesNotMatch(manifest, /8388/);
  } finally {
    chart.cleanup();
  }
});

test("existing Secret is referenced without rendering the chart-managed Secret", () => {
  const chart = makeShadowsocksChart();
  try {
    const manifest = chart.render(
      "--set",
      "auth.existingSecret=shared-shadowsocks",
      "--set",
      "auth.existingSecretPasswordKey=credential",
    );

    assert.deepEqual(resourceNames(manifest, "Secret"), []);
    assert.match(
      manifest,
      /name: SHADOWSOCKS_PASSWORD[\s\S]*?secretKeyRef:[\s\S]*?name: shared-shadowsocks[\s\S]*?key: credential/,
    );
    assert.doesNotMatch(manifest, /checksum\/secret:/);
  } finally {
    chart.cleanup();
  }
});

test("chart-managed Secret always uses its password key", () => {
  const chart = makeShadowsocksChart();
  try {
    const manifest = chart.render("--set", "auth.existingSecretPasswordKey=credential");

    assert.deepEqual(resourceNames(manifest, "Secret"), ["shadowsocks-auth"]);
    assert.match(
      manifest,
      /name: SHADOWSOCKS_PASSWORD[\s\S]*?secretKeyRef:[\s\S]*?name: shadowsocks-auth[\s\S]*?key: password/,
    );
    assert.doesNotMatch(manifest, /key: credential/);
  } finally {
    chart.cleanup();
  }
});

test("plaintext config.password is rejected", () => {
  const chart = makeShadowsocksChart();
  try {
    const result = chart.renderResult("--set-string", "config.password=plaintext");

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config\.password is reserved; configure auth\.password or auth\.existingSecret/);
  } finally {
    chart.cleanup();
  }
});

test("invalid config.server_port values are rejected", () => {
  const chart = makeShadowsocksChart();
  try {
    for (const value of ["0", "65536", "not-a-port"]) {
      const result = chart.renderResult("--set-string", `config.server_port=${value}`);

      assert.notEqual(result.status, 0, `server port ${value} should fail`);
      assert.match(result.stderr, /config\.server_port must be an integer from 1 through 65535/);
    }
  } finally {
    chart.cleanup();
  }
});

test("empty managed password is rejected", () => {
  const chart = makeShadowsocksChart();
  try {
    const result = chart.renderResult("--set-string", "auth.password=");

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /auth\.password must not be empty when auth\.existingSecret is empty/);
  } finally {
    chart.cleanup();
  }
});

test("empty external Secret key is rejected", () => {
  const chart = makeShadowsocksChart();
  try {
    const result = chart.renderResult(
      "--set",
      "auth.existingSecret=shared-shadowsocks",
      "--set-string",
      "auth.existingSecretPasswordKey=",
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /auth\.existingSecretPasswordKey must not be empty when auth\.existingSecret is set/,
    );
  } finally {
    chart.cleanup();
  }
});

test("README documents password handling, networking, and external Secret rotation", () => {
  const readme = readFileSync(join(ROOT, "charts", "shadowsocks", "README.md"), "utf8");

  assert.match(readme, /changeme/);
  assert.match(readme, /auth\.existingSecret/);
  assert.match(readme, /SHADOWSOCKS_PASSWORD/);
  assert.match(readme, /config\.\*/);
  assert.match(readme, /hostNetwork/);
  assert.match(readme, /TCP/);
  assert.match(readme, /UDP/);
  assert.match(readme, /kubectl rollout restart daemonset/);
});
