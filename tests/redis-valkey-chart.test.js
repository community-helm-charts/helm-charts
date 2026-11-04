import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");

function makeChart(t, name) {
  const dir = mkdtempSync(join(tmpdir(), name + "-non-root-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  cpSync(join(ROOT, "charts", name), path, { recursive: true });
  rmSync(join(path, "charts"), { recursive: true, force: true });
  mkdirSync(join(path, "charts"));
  execFileSync("helm", ["package", join(ROOT, "charts/common"), "-d", join(path, "charts")]);
  return {
    path,
    render(values = {}) {
      const output = execFileSync("helm", ["template", name, path, "--namespace", "default", "-f", "-"], {
        encoding: "utf8", input: JSON.stringify(values),
      });
      const docs = parseAllDocuments(output).map((doc) => {
        assert.deepEqual(doc.errors, []);
        return doc.toJSON();
      }).filter(Boolean);
      const statefulset = docs.find((doc) => doc.kind === "StatefulSet");
      const pod = statefulset.spec.template.spec;
      return { docs, statefulset, pod, container: pod.containers[0] };
    },
  };
}

for (const name of ["redis", "valkey"]) {
  test(name + " starts non-root with group access to a newly provisioned PVC", (t) => {
    const chart = makeChart(t, name);
    const { statefulset, pod, container } = chart.render();
    assert.equal(container.securityContext.runAsUser, 999);
    assert.equal(container.securityContext.runAsGroup, 1000);
    assert.equal(container.securityContext.runAsNonRoot, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(container.securityContext.capabilities, { drop: ["ALL"] });
    assert.deepEqual(container.securityContext.seccompProfile, { type: "RuntimeDefault" });
    assert.equal(pod.securityContext.fsGroup, container.securityContext.runAsGroup);
    assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.initContainers, undefined);
    assert.deepEqual(container.volumeMounts, [{ name: "data", mountPath: "/data" }]);
    const claim = statefulset.spec.volumeClaimTemplates[0];
    assert.equal(claim.metadata.name, "data");
    assert.deepEqual(claim.spec.accessModes, ["ReadWriteOnce"]);
    assert.equal(claim.spec.resources.requests.storage, "8Gi");
    execFileSync("helm", ["lint", "--strict", chart.path], { stdio: "pipe" });
  });

  test(name + " keeps configuration mounts and Secret authentication usable with non-root defaults", (t) => {
    const { docs, container } = makeChart(t, name).render({
      configuration: "appendonly yes\n",
      auth: { existingSecret: "database-auth", existingSecretPasswordKey: "password" },
    });
    const password = container.env.find((entry) => entry.name === name.toUpperCase() + "_PASSWORD");
    assert.deepEqual(password.valueFrom.secretKeyRef, { name: "database-auth", key: "password" });
    assert.equal(docs.some((doc) => doc.kind === "Secret"), false);
    assert.equal(docs.find((doc) => doc.kind === "ConfigMap").data[name + ".conf"], "appendonly yes\n");
    assert.ok(container.volumeMounts.some((mount) => mount.mountPath === "/etc/" + name && mount.readOnly));
    assert.equal(container.securityContext.runAsNonRoot, true);
  });

  test(name + " keeps non-root defaults when persistence is disabled", (t) => {
    const { statefulset, pod, container } = makeChart(t, name).render({
      persistence: { enabled: false },
    });
    assert.equal(statefulset.spec.volumeClaimTemplates, undefined);
    assert.deepEqual(pod.volumes, [{ name: "data", emptyDir: {} }]);
    assert.equal(pod.initContainers, undefined);
    assert.equal(pod.securityContext.fsGroup, 1000);
    assert.equal(container.securityContext.runAsUser, 999);
    assert.equal(container.securityContext.runAsNonRoot, true);
  });

  test(name + " honors explicit security settings for custom images", (t) => {
    const chart = makeChart(t, name);
    const { pod, container } = chart.render({
      podSecurityContext: { fsGroup: 2000, fsGroupChangePolicy: "Always" },
      containerSecurityContext: { runAsUser: 2001, runAsGroup: 2000 },
    });
    assert.equal(pod.securityContext.fsGroup, 2000);
    assert.equal(pod.securityContext.fsGroupChangePolicy, "Always");
    assert.equal(container.securityContext.runAsUser, 2001);
    assert.equal(container.securityContext.runAsGroup, 2000);
    const disabled = chart.render({
      podSecurityContext: { enabled: false },
      containerSecurityContext: { enabled: false },
    });
    assert.equal(disabled.pod.securityContext, undefined);
    assert.equal(disabled.container.securityContext, undefined);
  });
}
