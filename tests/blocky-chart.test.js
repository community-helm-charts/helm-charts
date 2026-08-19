import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeBlockyChart() {
  const dir = mkdtempSync(join(tmpdir(), "blocky-chart-"));
  const chart = join(dir, "blocky");
  cpSync(join(ROOT, "charts", "blocky"), chart, { recursive: true });
  rmSync(join(chart, "charts"), { force: true, recursive: true });
  mkdirSync(join(chart, "charts"), { recursive: true });

  const output = execFileSync(
    "helm",
    ["package", join(ROOT, "charts", "common"), "--destination", join(chart, "charts")],
    { encoding: "utf8" },
  );
  assert.match(output, /common-.*\.tgz/);

  function render(...args) {
    return execFileSync("helm", ["template", "blocky", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function renderResult(...args) {
    return spawnSync("helm", ["template", "blocky", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function cleanup() {
    rmSync(dir, { force: true, recursive: true });
  }

  return { chart, cleanup, render, renderResult };
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

function resource(manifest, kind) {
  return manifest
    .split(/^---$/m)
    .find((doc) => doc.split("\n").some((line) => line === `kind: ${kind}`));
}

test("chart metadata pins Blocky v0.34.0 and the local common dependency", () => {
  const chart = readFileSync(join(ROOT, "charts", "blocky", "Chart.yaml"), "utf8");

  assert.match(chart, /^name: blocky$/m);
  assert.match(chart, /^appVersion: "v0\.34\.0"$/m);
  assert.match(chart, /image: ghcr\.io\/0xerr0r\/blocky:v0\.34\.0/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
});

test("default render creates a plain HTTP Blocky deployment with resolver discovery", () => {
  const chart = makeBlockyChart();
  try {
    const manifest = chart.render();
    const deployment = resource(manifest, "Deployment");
    const service = resource(manifest, "Service");

    assert.deepEqual(resourceNames(manifest, "Deployment"), ["blocky"]);
    assert.deepEqual(resourceNames(manifest, "ConfigMap"), ["blocky-config"]);
    assert.deepEqual(resourceNames(manifest, "Service"), ["blocky"]);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["blocky"]);
    assert.deepEqual(resourceNames(manifest, "Ingress"), []);
    assert.deepEqual(resourceNames(manifest, "Certificate"), []);
    assert.ok(deployment);
    assert.ok(service);
    assert.match(deployment, /image: ghcr\.io\/0xerr0r\/blocky:v0\.34\.0/);
    assert.match(deployment, /name: BLOCKY_CONFIG_FILE\n\s+value: \/app\/config/);
    assert.match(deployment, /name: configure-upstreams[\s\S]*?\/etc\/resolv\.conf/);
    assert.match(deployment, /containerPort: 4000[\s\S]*?protocol: TCP/);
    assert.match(service, /name: http\n\s+port: 4000\n\s+targetPort: http/);
    const configMap = resource(manifest, "ConfigMap");
    assert.match(configMap, /specialUseDomains:\n\s+enable: false/);
    assert.doesNotMatch(service, /serversscheme|serverstransport|https/i);
    assert.doesNotMatch(deployment, /tls-crt|tls-key|dnsproxy-tls|\/certs/);
  } finally {
    chart.cleanup();
  }
});

test("default probes use HTTP DoH healthcheck.blocky queries", () => {
  const chart = makeBlockyChart();
  try {
    const deployment = resource(chart.render(), "Deployment");
    assert.ok(deployment);

    const query = "AAABAAABAAAAAAAAC2hlYWx0aGNoZWNrBmJsb2NreQAAAQAB";
    for (const probe of ["livenessProbe", "readinessProbe", "startupProbe"]) {
      assert.match(
        deployment,
        new RegExp(`${probe}:[\\s\\S]*?httpGet:[\\s\\S]*?scheme: HTTP[\\s\\S]*?port: http[\\s\\S]*?path: "\\/dns-query\\?dns=${query}"`),
      );
    }
    assert.equal(
      (deployment.match(/name: Accept\n\s+value: application\/dns-message/g) || []).length,
      3,
    );
    assert.doesNotMatch(deployment, /exec:[\s\S]*?healthcheck/);
  } finally {
    chart.cleanup();
  }
});

test("Ingress terminates TLS through an annotated Secret while the Service remains HTTP", () => {
  const chart = makeBlockyChart();
  try {
    const manifest = chart.render(
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hostname=dns.huangxudong.com",
      "--set",
      "ingress.tls=true",
      "--set-string",
      "ingress.annotations.cert-manager\\.io/cluster-issuer=letsencrypt-prod",
    );
    const ingress = resource(manifest, "Ingress");
    const service = resource(manifest, "Service");

    assert.ok(ingress);
    assert.ok(service);
    assert.deepEqual(resourceNames(manifest, "Certificate"), []);
    assert.match(ingress, /host: "dns\.huangxudong\.com"/);
    assert.match(ingress, /path: "\/dns-query"\n\s+pathType: Exact/);
    assert.match(ingress, /name: blocky\n\s+port:\n\s+name: http/);
    assert.match(ingress, /secretName: dns-huangxudong-com-tls/);
    assert.match(ingress, /cert-manager\.io\/cluster-issuer: letsencrypt-prod/);
    assert.doesNotMatch(manifest, /kind: ServersTransport/);
    assert.doesNotMatch(service, /serversscheme|serverstransport|https/i);
  } finally {
    chart.cleanup();
  }
});

test("explicit upstreams are rendered and take precedence over resolver discovery", () => {
  const chart = makeBlockyChart();
  try {
    const manifest = chart.render(
      "--set-string",
      "blocky.upstreams[0]=10.43.0.10:53",
      "--set-string",
      "blocky.upstreams[1]=tcp:10.43.0.11:53",
    );
    const configMap = resource(manifest, "ConfigMap");
    assert.ok(configMap);
    assert.match(configMap, /10-upstreams\.yml: \|[\s\S]*?- "10\.43\.0\.10:53"/);
    assert.match(configMap, /- "tcp:10\.43\.0\.11:53"/);
  } finally {
    chart.cleanup();
  }
});

test("additional native configuration and complete probe overrides render", () => {
  const chart = makeBlockyChart();
  try {
    const manifest = chart.render(
      "--set",
      "blocky.config.log.level=debug",
      "--set",
      "livenessProbe.enabled=false",
      "--set",
      "customReadinessProbe.exec.command[0]=/app/blocky",
      "--set",
      "customReadinessProbe.exec.command[1]=--version",
      "--set",
      "startupProbe.enabled=false",
    );
    const configMap = resource(manifest, "ConfigMap");
    const deployment = resource(manifest, "Deployment");
    assert.ok(configMap);
    assert.ok(deployment);
    assert.match(configMap, /log:\n\s+level: debug/);
    assert.doesNotMatch(deployment, /livenessProbe:/);
    assert.match(deployment, /readinessProbe:\n\s+exec:\n\s+command:\n\s+- \/app\/blocky\n\s+- --version/);
    assert.doesNotMatch(deployment, /startupProbe:/);
  } finally {
    chart.cleanup();
  }
});

test("configuration changes roll the Deployment", () => {
  const chart = makeBlockyChart();
  try {
    const first = resource(chart.render("--set", "blocky.config.log.level=info"), "Deployment");
    const second = resource(chart.render("--set", "blocky.config.log.level=debug"), "Deployment");
    const firstChecksum = first?.match(/checksum\/configmap: ([a-f0-9]+)/)?.[1];
    const secondChecksum = second?.match(/checksum\/configmap: ([a-f0-9]+)/)?.[1];
    assert.ok(firstChecksum);
    assert.ok(secondChecksum);
    assert.notEqual(firstChecksum, secondChecksum);
  } finally {
    chart.cleanup();
  }
});

test("invalid configurations fail with actionable messages", () => {
  const chart = makeBlockyChart();
  try {
    const cases = [
      {
        args: ["--set-string", "blocky.httpPort=zero"],
        message: /blocky\.httpPort must be an integer from 1 through 65535/,
      },
      {
        args: ["--set-string", "blocky.dohPath=dns-query"],
        message: /blocky\.dohPath must be an absolute path/,
      },
      {
        args: ["--set", "podDnsUpstream.enabled=false"],
        message: /blocky\.upstreams must not be empty/,
      },
      {
        args: ["--set", "blocky.config.ports.http=8000"],
        message: /blocky\.config\.ports is chart-managed/,
      },
    ];

    for (const { args, message } of cases) {
      const result = chart.renderResult(...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
  } finally {
    chart.cleanup();
  }
});

test("helm lint accepts the chart", () => {
  const chart = makeBlockyChart();
  try {
    const output = execFileSync("helm", ["lint", chart.chart], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /1 chart\(s\) linted, 0 chart\(s\) failed/);
  } finally {
    chart.cleanup();
  }
});
