import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRPS_IMAGE = "ghcr.io/fatedier/frps:v0.70.1";
const HAS_PINNED_FRPS_IMAGE = spawnSync(
  "docker", ["image", "inspect", FRPS_IMAGE], { stdio: "ignore" },
).status === 0;

function makeFrpsChart() {
  const dir = mkdtempSync(join(tmpdir(), "frps-chart-"));
  const chart = join(dir, "frps");
  cpSync(join(ROOT, "charts", "frps"), chart, { recursive: true });
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
      ["template", "frps", chart, "--set-string", "auth.token=test-token", ...args],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  function renderResult(...args) {
    return spawnSync("helm", ["template", "frps", chart, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function notes(...args) {
    return execFileSync(
      "helm",
      ["install", "frps", chart, "--dry-run=client", ...args],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  return {
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
    notes,
    render,
    renderResult,
  };
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

function resourceDocument(manifest, kind) {
  return manifest.split(/^---$/m).find((doc) => doc.includes(`kind: ${kind}`));
}

function resourceDocumentByName(manifest, kind, name) {
  return manifest.split(/^---$/m).find((doc) => {
    const lines = doc.split("\n");
    return lines.includes(`kind: ${kind}`) && lines.includes(`  name: ${name}`);
  });
}

function resources(manifest) {
  return parseAllDocuments(manifest)
    .map((document) => document.toJS())
    .filter((resource) => resource);
}

function resourceByName(manifest, kind, name) {
  return resources(manifest).find(
    (resource) => resource.kind === kind && resource.metadata?.name === name,
  );
}

test("chart metadata pins frps v0.70.1 and the local common dependency", () => {
  const chart = readFileSync(join(ROOT, "charts", "frps", "Chart.yaml"), "utf8");
  assert.match(chart, /^name: frps$/m);
  assert.match(chart, /^version: 1\.0\.0$/m);
  assert.match(chart, /^appVersion: "v0\.70\.1"$/m);
  assert.match(chart, /image: ghcr\.io\/fatedier\/frps:v0\.70\.1/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
  assert.match(chart, /version: 0\.2\.1/);
});

test("default config becomes TOML with a file-backed token and no token plaintext", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render();
    assert.deepEqual(resourceNames(manifest, "ConfigMap"), ["frps-config"]);
    assert.deepEqual(resourceNames(manifest, "Secret"), ["frps-auth"]);
    assert.match(manifest, /frps\.toml: \|/);
    assert.match(manifest, /bindPort = 7000/);
    assert.match(manifest, /vhostHTTPPort = 8080/);
    assert.match(manifest, /vhostHTTPSPort = 8443/);
    assert.match(manifest, /\[auth\][\s\S]*method = "token"/);
    assert.match(manifest, /\[auth\.tokenSource\][\s\S]*type = "file"/);
    assert.match(manifest, /\[auth\.tokenSource\.file\][\s\S]*path = "\/etc\/frp\/token"/);
    assert.match(manifest, /stringData:\n\s+token: "test-token"/);
    const configMap = manifest.split(/^---$/m).find((doc) => doc.includes("kind: ConfigMap"));
    assert.ok(configMap);
    assert.doesNotMatch(configMap, /test-token/);
  } finally { chart.cleanup(); }
});

test("nested config maps, arrays, and object arrays become TOML", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render("-f", join(ROOT, "tests", "fixtures", "frps-nested-values.yaml"));
    assert.match(manifest, /\[transport\][\s\S]*maxPoolCount = 5/);
    assert.match(manifest, /\[transport\.tls\][\s\S]*force = true/);
    const allowPortBlock = manifest.match(/\[\[allowPorts\]\]([\s\S]*?)(?=\n\s*\[\[|\n\s*\[[^[]|$)/)?.[1];
    assert.ok(allowPortBlock);
    assert.match(allowPortBlock, /start = 2000/);
    assert.match(allowPortBlock, /end = 3000/);
    assert.match(manifest, /\[\[httpPlugins\]\][\s\S]*name = "user-manager"[\s\S]*ops = \["Login"\]/);
  } finally { chart.cleanup(); }
});

test("existing Secret takes precedence over the managed token", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set-string", "auth.token=ignored-token",
      "--set", "auth.existingSecret=shared-frps",
      "--set", "auth.existingSecretKey=credential",
    );
    assert.deepEqual(resourceNames(manifest, "Secret"), []);
    const deployment = resourceDocument(manifest, "Deployment");
    const deploymentResource = resourceByName(manifest, "Deployment", "frps");
    assert.ok(deployment);
    assert.ok(deploymentResource);
    assert.match(deployment, /checksum\/configmap: [a-f0-9]+/);
    assert.doesNotMatch(deployment, /checksum\/secret:/);
    const authVolume = deploymentResource.spec.template.spec.volumes.find(({ name }) => name === "auth");
    assert.deepEqual(authVolume?.secret, {
      items: [{ key: "credential", path: "token" }],
      secretName: "shared-frps",
    });
    assert.doesNotMatch(manifest, /ignored-token/);
  } finally { chart.cleanup(); }
});

test("existing Secret name and key remain Kubernetes strings", () => {
  const chart = makeFrpsChart();
  try {
    const deployment = resourceByName(chart.render(
      "--set-string", "auth.existingSecret=true",
      "--set-string", "auth.existingSecretKey=null",
    ), "Deployment", "frps");
    assert.ok(deployment);
    const authVolume = deployment.spec.template.spec.volumes.find(({ name }) => name === "auth");
    assert.ok(authVolume);
    assert.equal(authVolume.secret.secretName, "true");
    assert.equal(authVolume.secret.items[0].key, "null");
  } finally { chart.cleanup(); }
});

test("single-instance Deployment renders safe default server behavior", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render();
    const deployment = manifest.split(/^---$/m).find((doc) => doc.includes("kind: Deployment"));
    const deploymentResource = resourceByName(manifest, "Deployment", "frps");
    assert.ok(deployment);
    assert.ok(deploymentResource);
    const container = deploymentResource.spec.template.spec.containers[0];

    assert.deepEqual(resourceNames(manifest, "Deployment"), ["frps"]);
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), ["frps"]);
    assert.match(deployment, /replicas: 1/);
    assert.match(deployment, /strategy:\n\s+type: Recreate/);
    assert.match(deployment, /image: ghcr\.io\/fatedier\/frps:v0\.70\.1/);
    assert.match(deployment, /imagePullPolicy: "IfNotPresent"/);
    assert.match(deployment, /args:\n\s+- -c\n\s+- \/etc\/frp\/frps\.toml/);
    assert.match(deployment, /name: bind\n\s+containerPort: 7000\n\s+protocol: TCP/);
    assert.match(deployment, /name: vhost-http\n\s+containerPort: 8080\n\s+protocol: TCP/);
    assert.match(deployment, /name: vhost-https\n\s+containerPort: 8443\n\s+protocol: TCP/);
    assert.deepEqual(container.livenessProbe, {
      failureThreshold: 1,
      initialDelaySeconds: 10,
      periodSeconds: 10,
      successThreshold: 1,
      tcpSocket: { port: "bind" },
      timeoutSeconds: 5,
    });
    assert.deepEqual(container.readinessProbe, {
      failureThreshold: 3,
      initialDelaySeconds: 5,
      periodSeconds: 10,
      successThreshold: 1,
      tcpSocket: { port: "bind" },
      timeoutSeconds: 5,
    });
    assert.match(deployment, /mountPath: \/etc\/frp\/frps\.toml[\s\S]*subPath: frps\.toml[\s\S]*readOnly: true/);
    assert.match(deployment, /mountPath: \/etc\/frp\/token[\s\S]*subPath: token[\s\S]*readOnly: true/);
    assert.match(deployment, /configMap:[\s\S]*name: frps-config[\s\S]*items:[\s\S]*key: frps\.toml[\s\S]*path: frps\.toml/);
    const authVolume = deploymentResource.spec.template.spec.volumes.find(({ name }) => name === "auth");
    assert.deepEqual(authVolume?.secret, {
      items: [{ key: "token", path: "token" }],
      secretName: "frps-auth",
    });
    assert.match(deployment, /checksum\/configmap: [a-f0-9]+/);
    assert.match(deployment, /checksum\/secret: [a-f0-9]+/);
    assert.match(deployment, /automountServiceAccountToken: false/);
    assert.match(deployment, /requests:\n\s+cpu: 100m\n\s+ephemeral-storage: 50Mi\n\s+memory: 128Mi/);
    assert.match(deployment, /runAsUser: 1000/);
    assert.match(deployment, /runAsGroup: 1000/);
    assert.match(deployment, /runAsNonRoot: true/);
    assert.match(deployment, /allowPrivilegeEscalation: false/);
    assert.match(deployment, /readOnlyRootFilesystem: true/);
    assert.match(deployment, /type: RuntimeDefault/);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
    assert.doesNotMatch(deployment, /test-token/);
  } finally { chart.cleanup(); }
});

test("config port changes update TOML and matching Deployment ports", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set", "config.bindPort=7100",
      "--set", "config.vhostHTTPPort=8180",
      "--set", "config.vhostHTTPSPort=8543",
    );
    const deployment = resourceDocument(manifest, "Deployment");
    assert.ok(deployment);
    assert.match(manifest, /bindPort = 7100/);
    assert.match(manifest, /vhostHTTPPort = 8180/);
    assert.match(manifest, /vhostHTTPSPort = 8543/);
    assert.match(deployment, /name: bind\n\s+containerPort: 7100/);
    assert.match(deployment, /name: vhost-http\n\s+containerPort: 8180/);
    assert.match(deployment, /name: vhost-https\n\s+containerPort: 8543/);
  } finally { chart.cleanup(); }
});

test("string-form required ports become numeric TOML and matching Kubernetes integers", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set-string", "config.bindPort=7100",
      "--set-string", "config.vhostHTTPPort=8180",
      "--set-string", "config.vhostHTTPSPort=8543",
    );
    const configMap = resourceByName(manifest, "ConfigMap", "frps-config");
    const deployment = resourceByName(manifest, "Deployment", "frps");
    const externalService = resourceByName(manifest, "Service", "frps");
    const vhostService = resourceByName(manifest, "Service", "frps-vhost");
    assert.ok(configMap);
    assert.ok(deployment);
    assert.ok(externalService);
    assert.ok(vhostService);

    assert.match(configMap.data["frps.toml"], /^bindPort = 7100$/m);
    assert.match(configMap.data["frps.toml"], /^vhostHTTPPort = 8180$/m);
    assert.match(configMap.data["frps.toml"], /^vhostHTTPSPort = 8543$/m);
    assert.doesNotMatch(configMap.data["frps.toml"], /(?:bindPort|vhostHTTPPort|vhostHTTPSPort) = "/);
    assert.deepEqual(
      deployment.spec.template.spec.containers[0].ports.map(({ name, containerPort }) => [name, containerPort]),
      [["bind", 7100], ["vhost-http", 8180], ["vhost-https", 8543]],
    );
    assert.deepEqual(
      externalService.spec.ports.map(({ name, port }) => [name, port]),
      [["bind", 7100]],
    );
    assert.deepEqual(
      vhostService.spec.ports.map(({ name, port }) => [name, port]),
      [["http", 8180], ["https", 8543]],
    );
  } finally { chart.cleanup(); }
});

test("generated TOML passes the pinned frps v0.70.1 verifier", {
  skip: HAS_PINNED_FRPS_IMAGE ? false : `${FRPS_IMAGE} is not available locally`,
}, () => {
  const chart = makeFrpsChart();
  const configDir = mkdtempSync(join(tmpdir(), "frps-config-"));
  try {
    const manifest = chart.render(
      "--set-string", "config.bindPort=7100",
      "--set-string", "config.vhostHTTPPort=8180",
      "--set-string", "config.vhostHTTPSPort=8543",
    );
    const configMap = resourceByName(manifest, "ConfigMap", "frps-config");
    assert.ok(configMap);
    writeFileSync(join(configDir, "frps.toml"), configMap.data["frps.toml"]);
    writeFileSync(join(configDir, "token"), "test-token\n");

    const result = spawnSync(
      "docker",
      [
        "run", "--rm",
        "--volume", `${configDir}:/etc/frp:ro`,
        FRPS_IMAGE,
        "verify", "--config", "/etc/frp/frps.toml",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(`${result.stdout}${result.stderr}`, /syntax is ok/);
  } finally {
    chart.cleanup();
    rmSync(configDir, { force: true, recursive: true });
  }
});

test("config and managed token changes update only their Deployment checksum", () => {
  const chart = makeFrpsChart();
  try {
    const base = resourceDocument(chart.render("--set-string", "auth.token=first-token"), "Deployment");
    const configChanged = resourceDocument(chart.render(
      "--set-string", "auth.token=first-token",
      "--set", "config.vhostHTTPPort=8180",
    ), "Deployment");
    const tokenChanged = resourceDocument(chart.render("--set-string", "auth.token=second-token"), "Deployment");
    assert.ok(base);
    assert.ok(configChanged);
    assert.ok(tokenChanged);

    const baseConfig = base.match(/checksum\/configmap: ([a-f0-9]+)/)?.[1];
    const changedConfig = configChanged.match(/checksum\/configmap: ([a-f0-9]+)/)?.[1];
    const tokenConfig = tokenChanged.match(/checksum\/configmap: ([a-f0-9]+)/)?.[1];
    const baseSecret = base.match(/checksum\/secret: ([a-f0-9]+)/)?.[1];
    const configSecret = configChanged.match(/checksum\/secret: ([a-f0-9]+)/)?.[1];
    const changedSecret = tokenChanged.match(/checksum\/secret: ([a-f0-9]+)/)?.[1];
    assert.ok(baseConfig);
    assert.ok(changedConfig);
    assert.ok(tokenConfig);
    assert.ok(baseSecret);
    assert.ok(configSecret);
    assert.ok(changedSecret);
    assert.notEqual(baseConfig, changedConfig);
    assert.equal(baseConfig, tokenConfig);
    assert.equal(baseSecret, configSecret);
    assert.notEqual(baseSecret, changedSecret);
    assert.doesNotMatch(base, /first-token/);
    assert.doesNotMatch(configChanged, /first-token/);
    assert.doesNotMatch(tokenChanged, /second-token/);
  } finally { chart.cleanup(); }
});

test("pod extension and ServiceAccount settings render observable Kubernetes fields", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set", "image.registry=registry.example.com",
      "--set", "image.repository=network/frps",
      "--set", "image.tag=custom",
      "--set", "image.pullPolicy=Always",
      "--set", "image.pullSecrets[0]=registry-key",
      "--set", "command[0]=/bin/sh",
      "--set-string", "args[0]=-ec",
      "--set-string", "args[1]=frps --version",
      "--set", "customLivenessProbe.exec.command[0]=frps",
      "--set", "customLivenessProbe.exec.command[1]=--version",
      "--set", "customReadinessProbe.httpGet.path=/ready",
      "--set", "customReadinessProbe.httpGet.port=bind",
      "--set", "resources.requests.cpu=25m",
      "--set", "resources.limits.memory=256Mi",
      "--set", "commonLabels.owner=platform",
      "--set", "podLabels.role=edge",
      "--set-string", "commonAnnotations.example\\.com/common=yes",
      "--set-string", "podAnnotations.example\\.com/pod=present",
      "--set", "extraEnvVars[0].name=FRPS_MODE",
      "--set-string", "extraEnvVars[0].value=edge",
      "--set", "extraEnvVarsCM=frps-env",
      "--set", "extraEnvVarsSecret=frps-env-secret",
      "--set", "priorityClassName=critical",
      "--set", "schedulerName=custom-scheduler",
      "--set", "terminationGracePeriodSeconds=45",
      "--set", "hostAliases[0].ip=192.0.2.10",
      "--set", "hostAliases[0].hostnames[0]=frps.internal",
      "--set", "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=zone",
      "--set", "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=Exists",
      "--set", "nodeSelector.role=edge",
      "--set", "tolerations[0].operator=Exists",
      "--set", "topologySpreadConstraints[0].maxSkew=1",
      "--set", "topologySpreadConstraints[0].topologyKey=zone",
      "--set", "topologySpreadConstraints[0].whenUnsatisfiable=DoNotSchedule",
      "--set", "topologySpreadConstraints[0].labelSelector.matchLabels.role=edge",
      "--set", "extraVolumes[0].name=scratch",
      "--set", "extraVolumes[0].emptyDir.sizeLimit=32Mi",
      "--set", "extraVolumeMounts[0].name=scratch",
      "--set", "extraVolumeMounts[0].mountPath=/scratch",
      "--set", "initContainers[0].name=prepare",
      "--set", "initContainers[0].image=busybox:1.36",
      "--set-string", "initContainers[0].command[0]=true",
      "--set", "sidecars[0].name=observer",
      "--set", "sidecars[0].image=busybox:1.36",
      "--set", "serviceAccount.name=frps-runtime",
      "--set", "serviceAccount.automountServiceAccountToken=true",
      "--set-string", "serviceAccount.annotations.example\\.com/service-account=present",
      "--set", "automountServiceAccountToken=true",
    );
    const deployment = resourceDocument(manifest, "Deployment");
    const serviceAccount = resourceDocument(manifest, "ServiceAccount");
    assert.ok(deployment);
    assert.ok(serviceAccount);

    assert.match(deployment, /image: registry\.example\.com\/network\/frps:custom/);
    assert.match(deployment, /imagePullPolicy: "Always"/);
    assert.match(deployment, /imagePullSecrets:\n\s+- name: registry-key/);
    assert.match(deployment, /command:\n\s+- \/bin\/sh/);
    assert.match(deployment, /args:\n\s+- -ec\n\s+- frps --version/);
    assert.match(deployment, /livenessProbe:\n\s+exec:\n\s+command:\n\s+- frps\n\s+- --version/);
    assert.match(deployment, /readinessProbe:\n\s+httpGet:\n\s+path: \/ready\n\s+port: bind/);
    assert.match(deployment, /limits:\n\s+memory: 256Mi[\s\S]*requests:\n\s+cpu: 25m/);
    assert.match(deployment, /owner: platform/);
    assert.match(deployment, /role: edge/);
    assert.match(deployment, /example\.com\/common: "yes"/);
    assert.match(deployment, /example\.com\/pod: present/);
    assert.match(deployment, /env:\n\s+- name: FRPS_MODE\n\s+value: edge/);
    assert.match(deployment, /envFrom:[\s\S]*configMapRef:\n\s+name: frps-env[\s\S]*secretRef:\n\s+name: frps-env-secret/);
    assert.match(deployment, /priorityClassName: "critical"/);
    assert.match(deployment, /schedulerName: "custom-scheduler"/);
    assert.match(deployment, /terminationGracePeriodSeconds: 45/);
    assert.match(deployment, /hostAliases:[\s\S]*frps\.internal[\s\S]*ip: 192\.0\.2\.10/);
    assert.match(deployment, /affinity:[\s\S]*key: zone[\s\S]*operator: Exists/);
    assert.match(deployment, /nodeSelector:\n\s+role: edge/);
    assert.match(deployment, /tolerations:\n\s+- operator: Exists/);
    assert.match(deployment, /topologySpreadConstraints:[\s\S]*maxSkew: 1[\s\S]*topologyKey: zone/);
    assert.match(deployment, /mountPath: \/scratch/);
    assert.match(deployment, /emptyDir:[\s\S]*sizeLimit: 32Mi[\s\S]*name: scratch/);
    assert.match(deployment, /initContainers:[\s\S]*image: busybox:1\.36[\s\S]*name: prepare/);
    assert.match(deployment, /image: busybox:1\.36\n\s+name: observer/);
    assert.match(deployment, /serviceAccountName: frps-runtime/);
    assert.match(deployment, /automountServiceAccountToken: true/);
    assert.match(serviceAccount, /name: frps-runtime/);
    assert.match(serviceAccount, /example\.com\/common: "yes"/);
    assert.match(serviceAccount, /example\.com\/service-account: present/);
    assert.match(serviceAccount, /automountServiceAccountToken: true/);
  } finally { chart.cleanup(); }
});

test("ServiceAccount creation can be disabled and an existing name selected", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set", "serviceAccount.create=false",
      "--set", "serviceAccount.name=shared-runtime",
    );
    assert.deepEqual(resourceNames(manifest, "ServiceAccount"), []);
    assert.match(resourceDocument(manifest, "Deployment"), /serviceAccountName: shared-runtime/);
  } finally { chart.cleanup(); }
});

test("container security context overrides replace chart defaults", () => {
  const chart = makeFrpsChart();
  try {
    const deployment = resourceByName(chart.render(
      "--set", "containerSecurityContext.runAsUser=2000",
      "--set", "containerSecurityContext.runAsGroup=2000",
      "--set", "containerSecurityContext.runAsNonRoot=false",
      "--set", "containerSecurityContext.readOnlyRootFilesystem=false",
      "--set", "containerSecurityContext.allowPrivilegeEscalation=true",
      "--set", "containerSecurityContext.capabilities.drop={NET_RAW}",
      "--set", "containerSecurityContext.seccompProfile.type=Unconfined",
    ), "Deployment", "frps");
    assert.ok(deployment);
    assert.deepEqual(deployment.spec.template.spec.containers[0].securityContext, {
      allowPrivilegeEscalation: true,
      capabilities: { drop: ["NET_RAW"] },
      readOnlyRootFilesystem: false,
      runAsGroup: 2000,
      runAsNonRoot: false,
      runAsUser: 2000,
      seccompProfile: { type: "Unconfined" },
    });
  } finally { chart.cleanup(); }
});

test("two Services separate client connections from virtual-host traffic", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render();
    const externalService = resourceDocumentByName(manifest, "Service", "frps");
    const vhostService = resourceDocumentByName(manifest, "Service", "frps-vhost");
    const deployment = resourceDocument(manifest, "Deployment");
    assert.ok(externalService);
    assert.ok(vhostService);
    assert.ok(deployment);

    assert.deepEqual(resourceNames(manifest, "Service"), ["frps", "frps-vhost"]);
    assert.match(externalService, /type: LoadBalancer/);
    assert.match(externalService, /- name: bind\n\s+port: 7000\n\s+targetPort: bind\n\s+protocol: TCP/);
    assert.doesNotMatch(externalService, /name: http|name: https/);
    assert.match(vhostService, /type: ClusterIP/);
    assert.match(vhostService, /- name: http\n\s+port: 8080\n\s+targetPort: vhost-http/);
    assert.match(vhostService, /- name: https\n\s+port: 8443\n\s+targetPort: vhost-https/);
    assert.doesNotMatch(vhostService, /name: bind/);
    const deploymentResource = resourceByName(manifest, "Deployment", "frps");
    const externalServiceResource = resourceByName(manifest, "Service", "frps");
    const vhostServiceResource = resourceByName(manifest, "Service", "frps-vhost");
    assert.ok(deploymentResource);
    assert.ok(externalServiceResource);
    assert.ok(vhostServiceResource);
    assert.deepEqual(externalServiceResource.spec.selector, deploymentResource.spec.selector.matchLabels);
    assert.deepEqual(vhostServiceResource.spec.selector, deploymentResource.spec.selector.matchLabels);
    for (const [key, value] of Object.entries(deploymentResource.spec.selector.matchLabels)) {
      assert.equal(deploymentResource.spec.template.metadata.labels[key], value);
    }
  } finally { chart.cleanup(); }
});

test("reserved custom labels cannot change workload or Service selectors", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "-f", join(ROOT, "tests", "fixtures", "frps-reserved-labels-values.yaml"),
    );
    const deployment = resourceByName(manifest, "Deployment", "frps");
    const externalService = resourceByName(manifest, "Service", "frps");
    const vhostService = resourceByName(manifest, "Service", "frps-vhost");
    assert.ok(deployment);
    assert.ok(externalService);
    assert.ok(vhostService);

    const expectedSelector = {
      "app.kubernetes.io/component": "frps",
      "app.kubernetes.io/instance": "frps",
      "app.kubernetes.io/name": "frps",
    };
    assert.deepEqual(deployment.spec.selector.matchLabels, expectedSelector);
    assert.deepEqual(externalService.spec.selector, expectedSelector);
    assert.deepEqual(vhostService.spec.selector, expectedSelector);
    assert.deepEqual(
      Object.fromEntries(Object.keys(expectedSelector).map((key) => [key, deployment.spec.template.metadata.labels[key]])),
      expectedSelector,
    );
    assert.equal(deployment.spec.template.metadata.labels.role, "edge");
    assert.equal(deployment.metadata.labels.owner, "platform");
  } finally { chart.cleanup(); }
});

test("name overrides cannot change selectors for a fixed workload identity", () => {
  const chart = makeFrpsChart();
  try {
    const firstManifest = chart.render(
      "--set", "fullnameOverride=stable-frps",
      "--set", "nameOverride=first-name",
    );
    const secondManifest = chart.render(
      "--set", "fullnameOverride=stable-frps",
      "--set", "nameOverride=second-name",
    );
    const firstDeployment = resourceByName(firstManifest, "Deployment", "stable-frps");
    const secondDeployment = resourceByName(secondManifest, "Deployment", "stable-frps");
    assert.ok(firstDeployment);
    assert.ok(secondDeployment);
    assert.deepEqual(firstDeployment.spec.selector.matchLabels, secondDeployment.spec.selector.matchLabels);

    for (const manifest of [firstManifest, secondManifest]) {
      const deployment = resourceByName(manifest, "Deployment", "stable-frps");
      const externalService = resourceByName(manifest, "Service", "stable-frps");
      const vhostService = resourceByName(manifest, "Service", "stable-frps-vhost");
      assert.ok(deployment);
      assert.ok(externalService);
      assert.ok(vhostService);
      assert.deepEqual(externalService.spec.selector, deployment.spec.selector.matchLabels);
      assert.deepEqual(vhostService.spec.selector, deployment.spec.selector.matchLabels);
      for (const [key, value] of Object.entries(deployment.spec.selector.matchLabels)) {
        assert.equal(deployment.spec.template.metadata.labels[key], value);
      }
    }
  } finally { chart.cleanup(); }
});

test("extra proxy ports render only in the external Service", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set", "service.extraPorts[0].name=tcp-proxy",
      "--set", "service.extraPorts[0].port=6000",
      "--set", "service.extraPorts[0].targetPort=6000",
      "--set", "service.extraPorts[0].protocol=TCP",
      "--set", "service.extraPorts[1].name=udp-proxy",
      "--set", "service.extraPorts[1].port=7002",
      "--set", "service.extraPorts[1].targetPort=7002",
      "--set", "service.extraPorts[1].protocol=UDP",
    );
    const externalService = resourceDocumentByName(manifest, "Service", "frps");
    const vhostService = resourceDocumentByName(manifest, "Service", "frps-vhost");
    assert.ok(externalService);
    assert.ok(vhostService);

    assert.match(externalService, /- name: tcp-proxy\n\s+port: 6000\n\s+protocol: TCP\n\s+targetPort: 6000/);
    assert.match(externalService, /- name: udp-proxy\n\s+port: 7002\n\s+protocol: UDP\n\s+targetPort: 7002/);
    assert.doesNotMatch(vhostService, /name: tcp-proxy|name: udp-proxy|port: 6000|port: 7002/);
  } finally { chart.cleanup(); }
});

test("Service policies remain scoped to their respective traffic classes", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set-string", "service.annotations.example\\.com/external=present",
      "--set", "service.labels.exposure=public",
      "--set", "service.internalTrafficPolicy=Local",
      "--set", "service.externalTrafficPolicy=Local",
      "--set", "service.loadBalancerClass=example.com/lb",
      "--set", "service.loadBalancerIP=192.0.2.10",
      "--set", "service.loadBalancerSourceRanges[0]=198.51.100.0/24",
      "--set", "service.sessionAffinity=ClientIP",
      "--set", "service.sessionAffinityConfig.clientIP.timeoutSeconds=10800",
      "--set", "service.ipFamilyPolicy=PreferDualStack",
      "--set", "service.ipFamilies[0]=IPv4",
      "--set", "service.ipFamilies[1]=IPv6",
      "--set-string", "vhostService.annotations.example\\.com/internal=present",
      "--set", "vhostService.labels.exposure=private",
      "--set", "vhostService.internalTrafficPolicy=Local",
      "--set", "vhostService.sessionAffinity=ClientIP",
      "--set", "vhostService.sessionAffinityConfig.clientIP.timeoutSeconds=600",
      "--set", "vhostService.ipFamilyPolicy=SingleStack",
      "--set", "vhostService.ipFamilies[0]=IPv4",
    );
    const externalService = resourceDocumentByName(manifest, "Service", "frps");
    const vhostService = resourceDocumentByName(manifest, "Service", "frps-vhost");
    assert.ok(externalService);
    assert.ok(vhostService);

    assert.match(externalService, /example\.com\/external: present/);
    assert.match(externalService, /exposure: public/);
    assert.match(externalService, /internalTrafficPolicy: Local/);
    assert.match(externalService, /externalTrafficPolicy: "Local"/);
    assert.match(externalService, /loadBalancerClass: example\.com\/lb/);
    assert.match(externalService, /loadBalancerIP: 192\.0\.2\.10/);
    assert.match(externalService, /loadBalancerSourceRanges:\n\s+- 198\.51\.100\.0\/24/);
    assert.match(externalService, /sessionAffinity: ClientIP/);
    assert.match(externalService, /sessionAffinityConfig:\n\s+clientIP:\n\s+timeoutSeconds: 10800/);
    assert.match(externalService, /ipFamilyPolicy: PreferDualStack/);
    assert.match(externalService, /ipFamilies:\n\s+- IPv4\n\s+- IPv6/);
    assert.doesNotMatch(externalService, /example\.com\/internal|exposure: private|timeoutSeconds: 600|ipFamilyPolicy: SingleStack/);

    assert.match(vhostService, /example\.com\/internal: present/);
    assert.match(vhostService, /exposure: private/);
    assert.match(vhostService, /internalTrafficPolicy: Local/);
    assert.match(vhostService, /sessionAffinity: ClientIP/);
    assert.match(vhostService, /sessionAffinityConfig:\n\s+clientIP:\n\s+timeoutSeconds: 600/);
    assert.match(vhostService, /ipFamilyPolicy: SingleStack/);
    assert.match(vhostService, /ipFamilies:\n\s+- IPv4/);
    assert.doesNotMatch(vhostService, /externalTrafficPolicy|loadBalancerClass|loadBalancerIP|loadBalancerSourceRanges|example\.com\/external|exposure: public|timeoutSeconds: 10800|PreferDualStack/);
  } finally { chart.cleanup(); }
});

test("Ingress is absent by default", () => {
  const chart = makeFrpsChart();
  try {
    assert.deepEqual(resourceNames(chart.render(), "Ingress"), []);
  } finally { chart.cleanup(); }
});

test("Ingress terminates TLS and routes chart-owned hosts to the HTTP vhost Service", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set", "ingress.enabled=true",
      "--set", "ingress.hostname=frps.example.com",
      "--set", "ingress.ingressClassName=nginx",
      "--set", "ingress.path=/tunnels",
      "--set", "ingress.pathType=Prefix",
      "--set", "ingress.tls=true",
      "--set", "ingress.extraHosts[0].name=api.frps.example.com",
      "--set", "ingress.extraHosts[0].path=/api",
      "--set", "ingress.extraHosts[0].pathType=Prefix",
      "--set", "ingress.extraTls[0].hosts[0]=api.frps.example.com",
      "--set", "ingress.extraTls[0].secretName=api-frps-tls",
      "--set", "ingress.secrets[0].name=api-frps-tls",
      "--set-string", "ingress.secrets[0].certificate=certificate",
      "--set-string", "ingress.secrets[0].key=private-key",
    );
    const ingress = resourceDocument(manifest, "Ingress");
    const tlsSecret = resourceDocumentByName(manifest, "Secret", "api-frps-tls");
    assert.ok(ingress);
    assert.ok(tlsSecret);

    assert.match(ingress, /ingressClassName: "nginx"/);
    assert.match(ingress, /host: "frps\.example\.com"[\s\S]*path: "\/tunnels"[\s\S]*name: frps-vhost[\s\S]*name: http/);
    assert.match(ingress, /host: "api\.frps\.example\.com"[\s\S]*path: "\/api"[\s\S]*name: frps-vhost[\s\S]*name: http/);
    assert.match(ingress, /secretName: frps\.example\.com-tls/);
    assert.match(ingress, /secretName: api-frps-tls/);
    assert.doesNotMatch(ingress, /backend:[\s\S]*?service:[\s\S]*?name: frps\n/);
    assert.doesNotMatch(ingress, /backend:[\s\S]*?port:[\s\S]*?(?:name: https|number: 8443)/);
    assert.match(tlsSecret, /type: kubernetes\.io\/tls/);
    assert.match(tlsSecret, /tls\.crt: "Y2VydGlmaWNhdGU="/);
    assert.match(tlsSecret, /tls\.key: "cHJpdmF0ZS1rZXk="/);
  } finally { chart.cleanup(); }
});

test("Ingress preserves user-supplied extra paths and rules", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set", "ingress.enabled=true",
      "--set", "ingress.extraPaths[0].path=/redirect",
      "--set", "ingress.extraPaths[0].pathType=Prefix",
      "--set", "ingress.extraPaths[0].backend.service.name=redirector",
      "--set", "ingress.extraPaths[0].backend.service.port.name=http",
      "--set", "ingress.extraRules[0].host=custom.frps.example.com",
      "--set", "ingress.extraRules[0].http.paths[0].path=/custom",
      "--set", "ingress.extraRules[0].http.paths[0].pathType=Prefix",
      "--set", "ingress.extraRules[0].http.paths[0].backend.service.name=custom-backend",
      "--set", "ingress.extraRules[0].http.paths[0].backend.service.port.number=9000",
    );
    const ingress = resourceDocument(manifest, "Ingress");
    assert.ok(ingress);

    assert.match(ingress, /name: redirector[\s\S]*name: http[\s\S]*path: \/redirect/);
    assert.match(ingress, /host: custom\.frps\.example\.com[\s\S]*name: custom-backend[\s\S]*number: 9000[\s\S]*path: \/custom/);
  } finally { chart.cleanup(); }
});

test("extraDeploy renders arbitrary resources with release and chart context", () => {
  const chart = makeFrpsChart();
  try {
    const manifest = chart.render(
      "--set-string",
      "extraDeploy[0]=apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-extra\ndata:\n  chart: {{ .Chart.Name }}",
    );
    const configMap = resourceDocumentByName(manifest, "ConfigMap", "frps-extra");
    assert.ok(configMap);
    assert.match(configMap, /chart: frps/);
  } finally { chart.cleanup(); }
});

test("rejects invalid authentication and server configuration values", () => {
  const chart = makeFrpsChart();
  try {
    const invalidCases = [
      [["-f", join(ROOT, "tests", "fixtures", "frps-auth-root-not-map.yaml")], /auth must be a map/],
      [["-f", join(ROOT, "tests", "fixtures", "frps-auth-token-not-string.yaml")], /auth\.token must be a string/],
      [["-f", join(ROOT, "tests", "fixtures", "frps-auth-secret-not-string.yaml")], /auth\.existingSecret must be a string/],
      [["-f", join(ROOT, "tests", "fixtures", "frps-auth-secret-key-not-string.yaml")], /auth\.existingSecretKey must be a string/],
      [[], /auth\.token must not be empty when auth\.existingSecret is empty/],
      [["--set", "auth.existingSecret=shared", "--set-string", "auth.existingSecretKey="], /auth\.existingSecretKey must not be empty when auth\.existingSecret is set/],
      [["-f", join(ROOT, "tests", "fixtures", "frps-config-not-map.yaml")], /config must be a map/],
      [["--set-string", "auth.token=test", "--set-string", "config.bindPort=0"], /config\.bindPort must be an integer from 1 through 65535/],
      [["--set-string", "auth.token=test", "--set-string", "config.vhostHTTPPort=65536"], /config\.vhostHTTPPort must be an integer from 1 through 65535/],
      [["--set-string", "auth.token=test", "--set-string", "config.vhostHTTPSPort=1.5"], /config\.vhostHTTPSPort must be an integer from 1 through 65535/],
      [["--set-string", "auth.token=test", "--set-string", "config.bindPort=many"], /config\.bindPort must be an integer from 1 through 65535/],
      [["--set-string", "auth.token=test", "--set-string", "config.vhostHTTPPort=8e3"], /config\.vhostHTTPPort must be an integer from 1 through 65535/],
      [["--set-string", "auth.token=test", "--set", "config.vhostHTTPPort=7000"], /config\.bindPort, config\.vhostHTTPPort, and config\.vhostHTTPSPort must be unique/],
      [["-f", join(ROOT, "tests", "fixtures", "frps-auth-not-map.yaml")], /config\.auth must be a map/],
      [["--set-string", "auth.token=test", "--set-string", "config.auth.token=unsafe"], /config\.auth\.token is managed by the chart and must not be set/],
      [["--set-string", "auth.token=test", "--set", "config.auth.tokenSource.type=file"], /config\.auth\.tokenSource is managed by the chart and must not be set/],
      [["--set-string", "auth.token=test", "--set", "config.auth.method=oidc"], /config\.auth\.method must be token when set/],
    ];

    for (const [args, expected] of invalidCases) {
      const result = chart.renderResult(...args);
      assert.notEqual(result.status, 0, `expected Helm render to fail for ${args.join(" ")}`);
      assert.match(result.stderr, expected);
    }
  } finally { chart.cleanup(); }
});

test("NOTES provide connection and inspection instructions", () => {
  const chart = makeFrpsChart();
  try {
    const notes = chart.notes("--set-string", "auth.token=test-token");
    assert.match(notes, /kubectl get service frps/);
    assert.match(notes, /frps-vhost\.default\.svc\.cluster\.local:8080/);
    assert.match(notes, /frps-vhost\.default\.svc\.cluster\.local:8443/);
    assert.match(notes, /kubectl get pods/);
    assert.match(notes, /kubectl logs deployment\/frps/);

    const existingSecretNotes = chart.notes(
      "--set", "auth.existingSecret=shared-frps",
    );
    assert.match(existingSecretNotes, /^     kubectl rollout restart deployment\/frps$/m);
  } finally { chart.cleanup(); }
});

test("NOTES cover NodePort, ClusterIP, Ingress, and namespace branches", () => {
  const chart = makeFrpsChart();
  try {
    const nodePortNotes = chart.notes(
      "--namespace", "edge",
      "--set-string", "auth.token=test-token",
      "--set", "service.type=NodePort",
    );
    assert.match(nodePortNotes, /primary Service is a NodePort/);
    assert.match(nodePortNotes, /kubectl get service frps -n edge/);
    assert.match(nodePortNotes, /kubectl get nodes -o wide/);
    assert.match(nodePortNotes, /frps-vhost\.edge\.svc\.cluster\.local:8080/);

    const clusterIPIngressNotes = chart.notes(
      "--namespace", "release-namespace",
      "--set-string", "auth.token=test-token",
      "--set", "namespaceOverride=runtime",
      "--set", "service.type=ClusterIP",
      "--set", "ingress.enabled=true",
      "--set", "ingress.hostname=tunnels.example.com",
      "--set", "ingress.path=/frp",
      "--set", "ingress.tls=true",
    );
    assert.match(clusterIPIngressNotes, /primary Service is a ClusterIP Service/);
    assert.match(clusterIPIngressNotes, /frps\.runtime\.svc\.cluster\.local:7000/);
    assert.match(clusterIPIngressNotes, /kubectl port-forward -n runtime service\/frps 7000:7000/);
    assert.match(clusterIPIngressNotes, /https:\/\/tunnels\.example\.com\/frp/);

    const externalSecretNotes = chart.notes(
      "--namespace", "edge",
      "--set", "auth.existingSecret=shared-frps",
    );
    assert.match(externalSecretNotes, /^     kubectl rollout restart deployment\/frps -n edge$/m);
  } finally { chart.cleanup(); }
});
