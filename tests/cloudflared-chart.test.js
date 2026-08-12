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
  assert.match(chart, /version: 0\.2\.2/);
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

test("existing Secret is referenced without rendering a managed Secret or checksum", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set",
      "auth.existingSecret=shared-tunnel",
      "--set",
      "auth.existingSecretKey=credential",
    );

    assert.deepEqual(resourceNames(manifest, "Secret"), []);
    assert.match(
      manifest,
      /name: TUNNEL_TOKEN[\s\S]*?secretKeyRef:[\s\S]*?name: shared-tunnel[\s\S]*?key: credential/,
    );
    assert.doesNotMatch(manifest, /checksum\/secret:/);
    assert.doesNotMatch(manifest, /test-token/);
  } finally {
    chart.cleanup();
  }
});

test("existing Secret requires a non-empty key", () => {
  const chart = makeCloudflaredChart();
  try {
    const result = chart.renderResult(
      "--set",
      "auth.existingSecret=shared-tunnel",
      "--set-string",
      "auth.existingSecretKey=",
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /auth\.existingSecretKey must not be empty when auth\.existingSecret is set/,
    );
  } finally {
    chart.cleanup();
  }
});

for (const replicaCount of ["0", "1.5", "many"]) {
  test(`replicaCount rejects ${replicaCount}`, () => {
    const chart = makeCloudflaredChart();
    try {
      const result = chart.renderResult(
        "--set-string",
        "auth.tunnelToken=test-token",
        "--set-string",
        `replicaCount=${replicaCount}`,
      );

      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /replicaCount must be an integer greater than or equal to 1/,
      );
    } finally {
      chart.cleanup();
    }
  });
}

for (const metricsPort of ["0", "65536", "1.5", "many"]) {
  test(`metrics.port rejects ${metricsPort}`, () => {
    const chart = makeCloudflaredChart();
    try {
      const result = chart.renderResult(
        "--set-string",
        "auth.tunnelToken=test-token",
        "--set-string",
        `metrics.port=${metricsPort}`,
      );

      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /metrics\.port must be an integer from 1 through 65535/,
      );
    } finally {
      chart.cleanup();
    }
  });
}

test("managed token changes roll the Deployment without appearing in its pod spec", () => {
  const chart = makeCloudflaredChart();
  try {
    function deployment(manifest) {
      return manifest.split(/^---$/m).find((doc) => doc.includes("kind: Deployment"));
    }

    const first = deployment(chart.render("--set-string", "auth.tunnelToken=first-token"));
    const second = deployment(chart.render("--set-string", "auth.tunnelToken=second-token"));
    assert.ok(first);
    assert.ok(second);

    const firstChecksum = first.match(/checksum\/secret: ([a-f0-9]+)/)?.[1];
    const secondChecksum = second.match(/checksum\/secret: ([a-f0-9]+)/)?.[1];
    assert.ok(firstChecksum);
    assert.ok(secondChecksum);
    assert.notEqual(firstChecksum, secondChecksum);
    assert.doesNotMatch(first, /first-token/);
    assert.doesNotMatch(second, /second-token/);
  } finally {
    chart.cleanup();
  }
});

test("metrics Service is opt-in and targets the named metrics port", () => {
  const chart = makeCloudflaredChart();
  try {
    assert.deepEqual(resourceNames(chart.render(), "Service"), []);

    const manifest = chart.render(
      "--set",
      "metrics.service.enabled=true",
      "--set",
      "metrics.port=2100",
      "--set-string",
      "metrics.service.annotations.prometheus\\.io/scrape=true",
    );

    assert.deepEqual(resourceNames(manifest, "Service"), ["cloudflared-metrics"]);
    assert.match(manifest, /prometheus\.io\/scrape: "true"/);
    assert.match(manifest, /port: 2100\n\s+targetPort: metrics\n\s+protocol: TCP/);
    assert.match(manifest, /containerPort: 2100/);
    assert.match(manifest, /- 0\.0\.0\.0:2100/);
  } finally {
    chart.cleanup();
  }
});

test("metrics Service renders optional networking settings", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set",
      "metrics.service.enabled=true",
      "--set-string",
      "metrics.service.clusterIP=None",
      "--set",
      "metrics.service.internalTrafficPolicy=Local",
      "--set",
      "metrics.service.sessionAffinity=ClientIP",
      "--set",
      "metrics.service.sessionAffinityConfig.clientIP.timeoutSeconds=10800",
      "--set",
      "metrics.service.ipFamilyPolicy=SingleStack",
      "--set",
      "metrics.service.ipFamilies[0]=IPv4",
      "--set",
      "metrics.service.extraPorts[0].name=debug",
      "--set",
      "metrics.service.extraPorts[0].port=2001",
      "--set",
      "metrics.service.extraPorts[0].targetPort=metrics",
      "--set",
      "metrics.service.extraPorts[0].protocol=TCP",
    );

    assert.match(manifest, /clusterIP: "None"/);
    assert.match(manifest, /internalTrafficPolicy: Local/);
    assert.match(manifest, /sessionAffinity: ClientIP/);
    assert.match(manifest, /timeoutSeconds: 10800/);
    assert.match(manifest, /ipFamilyPolicy: SingleStack/);
    assert.match(manifest, /ipFamilies:\n\s+- IPv4/);
    assert.match(
      manifest,
      /- name: debug\n\s+port: 2001\n\s+protocol: TCP\n\s+targetPort: metrics/,
    );
  } finally {
    chart.cleanup();
  }
});

test("connector image, generated args, probes, resources, scheduling, and environment are configurable", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set",
      "image.registry=registry.example.com",
      "--set",
      "image.repository=network/cloudflared",
      "--set",
      "image.tag=custom",
      "--set",
      "tunnel.logLevel=debug",
      "--set-string",
      "tunnel.extraArgs[0]=--protocol",
      "--set-string",
      "tunnel.extraArgs[1]=http2",
      "--set",
      "livenessProbe.enabled=false",
      "--set",
      "customReadinessProbe.exec.command[0]=cloudflared",
      "--set",
      "customReadinessProbe.exec.command[1]=version",
      "--set",
      "resources.requests.cpu=25m",
      "--set",
      "nodeSelector.role=edge",
      "--set",
      "tolerations[0].operator=Exists",
      "--set",
      "priorityClassName=high-priority",
      "--set",
      "schedulerName=custom-scheduler",
      "--set",
      "terminationGracePeriodSeconds=30",
      "--set",
      "extraEnvVars[0].name=EDGE_IP_VERSION",
      "--set-string",
      "extraEnvVars[0].value=4",
    );

    assert.match(manifest, /image: registry\.example\.com\/network\/cloudflared:custom/);
    assert.match(manifest, /- debug/);
    assert.match(manifest, /- "--protocol"\n\s+- "http2"\n\s+- run/);
    assert.doesNotMatch(manifest, /livenessProbe:/);
    assert.match(
      manifest,
      /readinessProbe:\n\s+exec:\n\s+command:\n\s+- cloudflared\n\s+- version/,
    );
    assert.match(manifest, /requests:\n\s+cpu: 25m/);
    assert.match(manifest, /nodeSelector:\n\s+role: edge/);
    assert.match(manifest, /tolerations:\n\s+- operator: Exists/);
    assert.match(manifest, /priorityClassName: "high-priority"/);
    assert.match(manifest, /schedulerName: "custom-scheduler"/);
    assert.match(manifest, /terminationGracePeriodSeconds: 30/);
    assert.match(manifest, /name: EDGE_IP_VERSION\n\s+value: "4"/);
  } finally {
    chart.cleanup();
  }
});

test("connector metadata, ServiceAccount annotations, and envFrom render", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set",
      "podLabels.role=connector",
      "--set-string",
      "podAnnotations.example\\.com/restarted=now",
      "--set-string",
      "commonAnnotations.example\\.com/common=shared",
      "--set-string",
      "serviceAccount.annotations.example\\.com/account=restricted",
      "--set",
      "extraEnvVarsCM=cloudflared-env",
      "--set",
      "extraEnvVarsSecret=cloudflared-secret-env",
    );

    assert.match(manifest, /role: connector/);
    assert.match(manifest, /example\.com\/restarted: now/);
    assert.match(manifest, /example\.com\/common: shared/);
    assert.match(manifest, /example\.com\/account: restricted/);
    assert.match(manifest, /configMapRef:\n\s+name: cloudflared-env/);
    assert.match(manifest, /secretRef:\n\s+name: cloudflared-secret-env/);
  } finally {
    chart.cleanup();
  }
});

test("connector volumes, init containers, and sidecars render", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set",
      "extraVolumes[0].name=cache",
      "--set",
      "extraVolumes[0].emptyDir.medium=Memory",
      "--set",
      "extraVolumeMounts[0].name=cache",
      "--set",
      "extraVolumeMounts[0].mountPath=/cache",
      "--set",
      "initContainers[0].name=init",
      "--set",
      "initContainers[0].image=busybox:1.36",
      "--set-string",
      "initContainers[0].command[0]=true",
      "--set",
      "sidecars[0].name=sidecar",
      "--set",
      "sidecars[0].image=busybox:1.36",
      "--set-string",
      "sidecars[0].command[0]=sleep",
      "--set-string",
      "sidecars[0].command[1]=infinity",
    );

    assert.match(manifest, /initContainers:\n\s+- command:\n\s+- "true"/);
    assert.match(manifest, /name: init/);
    assert.match(manifest, /- command:\n\s+- sleep\n\s+- infinity[\s\S]*?name: sidecar/);
    assert.match(manifest, /mountPath: \/cache\n\s+name: cache/);
    assert.match(manifest, /emptyDir:\n\s+medium: Memory\n\s+name: cache/);
  } finally {
    chart.cleanup();
  }
});

test("host aliases, affinity, topology spread, and extraDeploy render", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set",
      "hostAliases[0].ip=127.0.0.1",
      "--set",
      "hostAliases[0].hostnames[0]=example.internal",
      "--set",
      "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=role",
      "--set",
      "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=In",
      "--set",
      "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=edge",
      "--set",
      "topologySpreadConstraints[0].maxSkew=1",
      "--set",
      "topologySpreadConstraints[0].topologyKey=kubernetes.io/hostname",
      "--set",
      "topologySpreadConstraints[0].whenUnsatisfiable=ScheduleAnyway",
      "--set",
      "extraDeploy[0].apiVersion=v1",
      "--set",
      "extraDeploy[0].kind=ConfigMap",
      "--set",
      "extraDeploy[0].metadata.name=cloudflared-extra",
      "--set",
      "extraDeploy[0].data.mode=remote",
    );

    assert.deepEqual(resourceNames(manifest, "ConfigMap"), ["cloudflared-extra"]);
    assert.match(manifest, /hostAliases:\n\s+- hostnames:\n\s+- example\.internal\n\s+ip: 127\.0\.0\.1/);
    assert.match(manifest, /nodeAffinity:[\s\S]*?key: role[\s\S]*?values:\n\s+- edge/);
    assert.match(
      manifest,
      /topologySpreadConstraints:\n\s+- maxSkew: 1\n\s+topologyKey: kubernetes\.io\/hostname\n\s+whenUnsatisfiable: ScheduleAnyway/,
    );
  } finally {
    chart.cleanup();
  }
});

test("full command and args overrides replace generated process settings", () => {
  const chart = makeCloudflaredChart();
  try {
    const manifest = chart.render(
      "--set",
      "command[0]=/bin/sh",
      "--set-string",
      "args[0]=-ec",
      "--set-string",
      "args[1]=cloudflared version",
    );

    assert.match(manifest, /command:\n\s+- \/bin\/sh/);
    assert.match(manifest, /args:\n\s+- -ec\n\s+- cloudflared version/);
    assert.doesNotMatch(manifest, /- --no-autoupdate/);
  } finally {
    chart.cleanup();
  }
});

test("README documents remote management, credentials, availability, metrics, and rotation", () => {
  const readme = readFileSync(join(ROOT, "charts", "cloudflared", "README.md"), "utf8");

  assert.match(readme, /remotely managed/i);
  assert.match(readme, /auth\.tunnelToken/);
  assert.match(readme, /auth\.existingSecret/);
  assert.match(readme, /Helm release metadata/);
  assert.match(readme, /replicaCount/);
  assert.match(readme, /\/ready/);
  assert.match(readme, /metrics\.service\.enabled/);
  assert.match(readme, /kubectl rollout restart deployment/);
  assert.match(readme, /\.svc\.cluster\.local/);
});
