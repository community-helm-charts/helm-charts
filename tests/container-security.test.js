import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import test, { after, before } from "node:test";
import { parse, parseAllDocuments } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const names = readdirSync(join(ROOT, "charts"));
const applications = names.filter((name) => parse(readFileSync(join(ROOT, "charts", name, "Chart.yaml"), "utf8")).type !== "library");
let fixture;

before(() => {
  fixture = mkdtempSync(join(tmpdir(), "chart-security-"));
  for (const name of names) {
    const source = join(ROOT, "charts", name);
    cpSync(source, join(fixture, name), {
      recursive: true,
      filter: (path) => !relative(source, path).split(sep).includes("charts") && basename(path) !== "Chart.lock",
    });
  }
  const built = new Set();
  function build(name) {
    if (built.has(name)) return;
    const chart = join(fixture, name);
    const metadata = parse(readFileSync(join(chart, "Chart.yaml"), "utf8"));
    for (const dependency of metadata.dependencies ?? []) {
      build(dependency.name);
      mkdirSync(join(chart, "charts"), { recursive: true });
      execFileSync("helm", ["package", join(fixture, dependency.name), "-d", join(chart, "charts")], { stdio: "pipe" });
    }
    built.add(name);
  }
  for (const name of names) build(name);
});

after(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

function render(name, values = {}) {
  const required = name === "frps" ? { auth: { token: "test-token" } }
    : name === "cloudflared" ? { auth: { tunnelToken: "test-token" } } : {};
  const output = execFileSync("helm", ["template", name, join(fixture, name), "--namespace", "default", "-f", "-"], {
    encoding: "utf8", input: JSON.stringify({ ...required, ...values }),
  });
  return parseAllDocuments(output).map((doc) => {
    assert.deepEqual(doc.errors, []);
    return doc.toJSON();
  }).filter(Boolean);
}

const workloads = (docs) => docs.filter((doc) => doc.spec?.template?.spec);
const containers = (docs) => workloads(docs).flatMap((doc) => {
  const pod = doc.spec.template.spec;
  return [...(pod.initContainers ?? []), ...pod.containers];
});

function assertHardened(container) {
  const context = container.securityContext;
  assert.ok(context, container.name + " must have an explicit security context");
  assert.equal(context.enabled, undefined);
  assert.equal(context.allowPrivilegeEscalation, false, container.name);
  assert.deepEqual(context.capabilities.drop, ["ALL"], container.name);
  assert.equal(context.seccompProfile.type, "RuntimeDefault", container.name);
  if (context.runAsUser !== 0) assert.equal(context.runAsNonRoot, true, container.name);
}

for (const name of applications) {
  test(name + " hardens every chart-owned container by default", () => {
    const docs = render(name);
    const all = containers(docs);
    assert.ok(all.length > 0);
    for (const container of all) assertHardened(container);
    execFileSync("helm", ["lint", "--strict", join(fixture, name), "-f", "-"], {
      input: JSON.stringify(name === "frps" ? { auth: { token: "test-token" } }
        : name === "cloudflared" ? { auth: { tunnelToken: "test-token" } } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
  });
}

test("Ghost optional services, hook Jobs and initialization containers inherit security settings", () => {
  const values = {
    trafficAnalytics: { enabled: true, tinybird: {
      trackerToken: "test", adminToken: "test", workspaceId: "test", deploy: { enabled: true },
    } },
    activitypub: { enabled: true },
  };
  const docs = render("ghost", values);
  const all = containers(docs);
  for (const name of ["wait-for-database", "activitypub-migrate", "activitypub", "activitypub-db-init", "sync-tinybird-files", "tinybird-deploy", "traffic-analytics"]) {
    const container = all.find((entry) => entry.name === name);
    assert.ok(container, name);
    assertHardened(container);
    assert.equal(container.securityContext.runAsUser, 1000, name);
  }
  const job = workloads(docs).find((doc) => doc.metadata.name === "ghost-tinybird-deploy");
  assert.equal(job.spec.template.spec.securityContext.fsGroup, 1000);
  const analytics = workloads(docs).find((doc) => doc.metadata.name === "ghost-traffic-analytics");
  assert.equal(analytics.spec.template.spec.securityContext.fsGroup, 1000);
  const disabled = render("ghost", {
    ...values,
    ghost: { containerSecurityContext: { enabled: false } },
    activitypub: { enabled: true, containerSecurityContext: { enabled: false } },
    trafficAnalytics: { ...values.trafficAnalytics, containerSecurityContext: { enabled: false } },
  });
  for (const container of containers(disabled).filter((entry) => entry.name !== "mysql")) {
    assert.equal(container.securityContext, undefined, container.name);
  }
});

test("new database PVCs use each default image's service group", () => {
  for (const [name, uid, gid] of [["postgresql", 70, 70], ["mysql", 999, 999]]) {
    const pod = workloads(render(name))[0].spec.template.spec;
    assert.equal(pod.containers[0].securityContext.runAsUser, uid);
    assert.equal(pod.containers[0].securityContext.runAsGroup, gid);
    assert.equal(pod.securityContext.fsGroup, gid);
    assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
  }
});

test("Shadowsocks starts as nobody without an additional privilege-changing argument", () => {
  const container = containers(render("shadowsocks"))[0];
  assert.equal(container.securityContext.runAsUser, 65534);
  assert.equal(container.securityContext.runAsGroup, 65534);
  assert.equal(container.args[0], "ssserver");
  assert.ok(!container.args.includes("-a"));
  assert.ok(!container.args.includes("--user"));
});

test("Uptime Kuma permits ICMP ping monitors with only NET_RAW added", () => {
  const container = containers(render("uptime-kuma"))[0];
  assert.equal(container.securityContext.runAsUser, 1000);
  assert.equal(container.securityContext.runAsNonRoot, true);
  assert.deepEqual(container.securityContext.capabilities, { drop: ["ALL"], add: ["NET_RAW"] });
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
});
