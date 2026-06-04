import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

function apiResource(name, kind) {
  return {
    name,
    singularName: "",
    namespaced: true,
    kind,
    verbs: ["get", "list", "create", "update", "patch", "delete"],
  };
}

async function withFakeKubeApi(fn) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    res.setHeader("content-type", "application/json");

    if (pathname === "/version") {
      res.end(JSON.stringify({ major: "1", minor: "30", gitVersion: "v1.30.0" }));
      return;
    }

    if (pathname === "/api") {
      res.end(JSON.stringify({ kind: "APIVersions", versions: ["v1"], serverAddressByClientCIDRs: [] }));
      return;
    }

    if (pathname === "/api/v1") {
      res.end(
        JSON.stringify({
          kind: "APIResourceList",
          groupVersion: "v1",
          resources: [apiResource("serviceaccounts", "ServiceAccount"), apiResource("services", "Service")],
        }),
      );
      return;
    }

    if (pathname === "/apis") {
      res.end(
        JSON.stringify({
          kind: "APIGroupList",
          groups: [
            {
              name: "apps",
              versions: [{ groupVersion: "apps/v1", version: "v1" }],
              preferredVersion: { groupVersion: "apps/v1", version: "v1" },
            },
          ],
        }),
      );
      return;
    }

    if (pathname === "/apis/apps/v1") {
      res.end(
        JSON.stringify({
          kind: "APIResourceList",
          groupVersion: "apps/v1",
          resources: [apiResource("statefulsets", "StatefulSet")],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function makeOpenListChart() {
  const dir = mkdtempSync(join(tmpdir(), "openlist-chart-"));
  const chart = join(dir, "openlist");
  cpSync(join(ROOT, "charts", "openlist"), chart, { recursive: true });
  rmSync(join(chart, "charts"), { force: true, recursive: true });
  mkdirSync(join(chart, "charts"), { recursive: true });

  const commonOutput = execFileSync("helm", ["package", join(ROOT, "charts", "common"), "--destination", join(chart, "charts")], {
    encoding: "utf8",
  });
  assert.match(commonOutput, /common-.*\.tgz/);

  function render(...args) {
    return execFileSync("helm", ["template", "openlist", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function notes(...args) {
    return withFakeKubeApi(async (apiServer) => {
      const { stdout } = await execFileAsync(
        "helm",
        [
          "install",
          "openlist",
          chart,
          "--namespace",
          "default",
          "--dry-run=client",
          "--debug",
          "--disable-openapi-validation",
          "--kube-apiserver",
          apiServer,
          ...args,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, KUBECONFIG: "/tmp/nonexistent-kubeconfig" },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return stdout;
    });
  }

  function cleanup() {
    rmSync(dir, { force: true, recursive: true });
  }

  return { cleanup, notes, render };
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

test("default render creates a single StatefulSet with OpenList compose defaults", () => {
  const chart = makeOpenListChart();
  try {
    const manifest = chart.render();

    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["openlist"]);
    assert.deepEqual(resourceNames(manifest, "Service"), ["openlist"]);
    assert.deepEqual(resourceNames(manifest, "StatefulSet"), ["openlist"]);
    assert.deepEqual(resourceNames(manifest, "PersistentVolumeClaim"), []);
    assert.match(manifest, /replicas: 1/);
    assert.match(manifest, /image: docker\.io\/openlistteam\/openlist:v4\.2\.1/);
    assert.match(manifest, /serviceAccountName: openlist/);
    assert.match(manifest, /- name: UMASK\n\s+value: "022"/);
    assert.match(manifest, /- name: TZ\n\s+value: "Asia\/Shanghai"/);
    assert.match(manifest, /- name: http\n\s+containerPort: 5244\n\s+protocol: TCP/);
    assert.match(manifest, /- name: https\n\s+containerPort: 5245\n\s+protocol: TCP/);
    assert.match(manifest, /securityContext:\n\s+fsGroup: 1001/);
    assert.match(manifest, /securityContext:\n\s+allowPrivilegeEscalation: false[\s\S]*?runAsGroup: 1001[\s\S]*?runAsNonRoot: true[\s\S]*?runAsUser: 1001/);
    assert.match(manifest, /name: data/);
    assert.match(manifest, /mountPath: \/opt\/openlist\/data/);
    assert.match(manifest, /storage: "5Gi"/);
    assert.doesNotMatch(manifest, /\n      volumes:\n  volumeClaimTemplates:/);
  } finally {
    chart.cleanup();
  }
});

test("persistence can inherit the global default storageClassName", () => {
  const chart = makeOpenListChart();
  try {
    const manifest = chart.render("--set", "global.defaultStorageClassName=standard");

    assert.match(manifest, /storageClassName: standard/);
  } finally {
    chart.cleanup();
  }
});

test("probe values render through the StatefulSet", () => {
  const chart = makeOpenListChart();
  try {
    const manifest = chart.render(
      "--set",
      "startupProbe.enabled=true",
      "--set",
      "livenessProbe.httpGet.path=/custom-live",
      "--set",
      "readinessProbe.httpGet.path=/custom-ready",
    );

    assert.match(manifest, /startupProbe:[\s\S]*?httpGet:[\s\S]*?path: \/\n\s+port: http/);
    assert.match(manifest, /livenessProbe:[\s\S]*?httpGet:[\s\S]*?path: \/custom-live\n\s+port: http/);
    assert.match(manifest, /readinessProbe:[\s\S]*?httpGet:[\s\S]*?path: \/custom-ready\n\s+port: http/);
  } finally {
    chart.cleanup();
  }
});

test("custom probes override default probe values", () => {
  const chart = makeOpenListChart();
  try {
    const manifest = chart.render(
      "--set",
      "livenessProbe.httpGet.path=/default-live",
      "--set",
      "customLivenessProbe.exec.command[0]=true",
    );

    assert.match(manifest, /livenessProbe:\n\s+exec:\n\s+command:\n\s+- true/);
    assert.doesNotMatch(manifest, /path: \/default-live/);
    assert.doesNotMatch(manifest, /livenessProbe:\n\s+httpGet:/);
  } finally {
    chart.cleanup();
  }
});

test("replicaCount is not a supported value and the StatefulSet stays single replica", () => {
  const chart = makeOpenListChart();
  try {
    const manifest = chart.render("--set", "replicaCount=2");

    assert.deepEqual(resourceNames(manifest, "StatefulSet"), ["openlist"]);
    assert.match(manifest, /replicas: 1/);
    assert.doesNotMatch(manifest, /replicas: 2/);
  } finally {
    chart.cleanup();
  }
});

test("ingress uses Bitnami-style hostname and ingressClassName values", () => {
  const chart = makeOpenListChart();
  try {
    const manifest = chart.render(
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hostname=openlist.example.com",
      "--set",
      "ingress.ingressClassName=traefik",
    );

    assert.deepEqual(resourceNames(manifest, "Ingress"), ["openlist"]);
    assert.match(manifest, /ingressClassName: "traefik"/);
    assert.match(manifest, /host: "openlist\.example\.com"/);
    assert.match(manifest, /path: "\/"/);
    assert.match(manifest, /pathType: ImplementationSpecific/);
  } finally {
    chart.cleanup();
  }
});

test("ingress supports Bitnami-style extra hosts, extra paths, and TLS", () => {
  const chart = makeOpenListChart();
  try {
    const manifest = chart.render(
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hostname=openlist.example.com",
      "--set",
      "ingress.extraHosts[0].name=api.openlist.example.com",
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
      "ingress.extraTls[0].hosts[0]=api.openlist.example.com",
      "--set",
      "ingress.extraTls[0].secretName=api-openlist-tls",
    );

    assert.deepEqual(resourceNames(manifest, "Ingress"), ["openlist"]);
    assert.match(manifest, /host: "api\.openlist\.example\.com"/);
    assert.match(manifest, /path: \/redirect/);
    assert.match(manifest, /name: redirector/);
    assert.match(manifest, /secretName: openlist\.example\.com-tls/);
    assert.match(manifest, /secretName: api-openlist-tls/);
  } finally {
    chart.cleanup();
  }
});

test("notes include admin account recovery commands", async () => {
  const chart = makeOpenListChart();
  try {
    const notes = await chart.notes();

    assert.match(notes, /The default admin username is:\n\n  admin/);
    assert.match(notes, /password is stored as a hash and cannot be recovered/);
    assert.match(notes, /kubectl exec --namespace default openlist-0 -- sh -lc 'cd \/opt\/openlist && \.\/openlist admin'/);
    assert.match(notes, /kubectl exec --namespace default openlist-0 -- sh -lc 'cd \/opt\/openlist && \.\/openlist admin random'/);
    assert.match(notes, /kubectl exec --namespace default openlist-0 -- sh -lc 'cd \/opt\/openlist && \.\/openlist admin set NEW_PASSWORD'/);
  } finally {
    chart.cleanup();
  }
});
