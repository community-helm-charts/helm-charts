import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeCloudflaredChart() {
  const dir = mkdtempSync(join(tmpdir(), "cloudflared-chart-"));
  const chart = join(dir, "cloudflared");
  cpSync(join(ROOT, "charts", "cloudflared"), chart, { recursive: true });
  rmSync(join(chart, "charts"), { force: true, recursive: true });
  mkdirSync(join(chart, "charts"), { recursive: true });

  const output = execFileSync(
    "helm",
    ["package", join(ROOT, "charts", "common"), "--destination", join(chart, "charts")],
    { encoding: "utf8" },
  );
  assert.match(output, /common-.*\.tgz/);

  function render(...args) {
    return execFileSync(
      "helm",
      ["template", "cloudflared", chart, "--set-string", "auth.tunnelToken=test-token", ...args],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  function renderResult(...args) {
    return spawnSync("helm", ["template", "cloudflared", chart, ...args], {
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

test("chart metadata pins cloudflared 2026.7.2 and the local common dependency", () => {
  const chart = readFileSync(join(ROOT, "charts", "cloudflared", "Chart.yaml"), "utf8");

  assert.match(chart, /^name: cloudflared$/m);
  assert.match(chart, /^appVersion: "2026\.7\.2"$/m);
  assert.match(chart, /image: docker\.io\/cloudflare\/cloudflared:2026\.7\.2/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
  assert.match(chart, /version: 0\.2\.1/);
});

test("managed token renders a secure two-replica connector Deployment", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render();

    assert.deepEqual(resourceNames(manifest, "Deployment"), ["cloudflared"]);
    assert.deepEqual(resourceNames(manifest, "Secret"), ["cloudflared"]);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["cloudflared"]);
    assert.match(manifest, /replicas: 2/);
    assert.match(manifest, /image: docker\.io\/cloudflare\/cloudflared:2026\.7\.2/);
    assert.match(manifest, /stringData:\n\s+token: "test-token"/);
    assert.match(
      manifest,
      /name: TUNNEL_TOKEN[\s\S]*?secretKeyRef:[\s\S]*?name: cloudflared[\s\S]*?key: token/,
    );
    assert.match(manifest, /- tunnel\n\s+- --no-autoupdate\n\s+- --loglevel\n\s+- info/);
    assert.match(manifest, /- --metrics\n\s+- 0\.0\.0\.0:2000\n\s+- run/);
    assert.match(manifest, /name: metrics\n\s+containerPort: 2000/);
    assert.match(manifest, /livenessProbe:[\s\S]*?path: \/ready[\s\S]*?port: metrics/);
    assert.match(manifest, /readinessProbe:[\s\S]*?path: \/ready[\s\S]*?port: metrics/);
    assert.match(manifest, /automountServiceAccountToken: false/);
    assert.match(manifest, /name: net\.ipv4\.ping_group_range\n\s+value: 65532 65532/);
    assert.match(manifest, /runAsUser: 65532/);
    assert.match(manifest, /runAsNonRoot: true/);
    assert.match(manifest, /allowPrivilegeEscalation: false/);
  } finally {
    chart.cleanup();
  }
});

test("missing managed token fails before installation", () => {
  const chart = makeCloudflaredChart();
  try {
    const result = chart.renderResult();

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /auth\.tunnelToken must not be empty when auth\.existingSecret is empty/,
    );
  } finally {
    chart.cleanup();
  }
});
