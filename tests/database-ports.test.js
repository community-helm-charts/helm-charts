import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { parseAllDocuments } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const defaults = { redis: 6379, valkey: 6379, mysql: 3306, postgresql: 5432 };
let fixture;

before(() => {
  fixture = mkdtempSync(join(tmpdir(), "database-ports-"));
  for (const name of [...Object.keys(defaults), "ghost", "umami"]) {
    const path = join(fixture, name);
    cpSync(join(ROOT, "charts", name), path, { recursive: true });
    rmSync(join(path, "charts"), { recursive: true, force: true });
    mkdirSync(join(path, "charts"));
    execFileSync("helm", ["package", join(ROOT, "charts/common"), "-d", join(path, "charts")], { stdio: "pipe" });
  }
  for (const [parent, dependency] of [["ghost", "mysql"], ["umami", "postgresql"]]) {
    execFileSync("helm", ["package", join(fixture, dependency), "-d", join(fixture, parent, "charts")], { stdio: "pipe" });
  }
});

after(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

function result(name, values = {}) {
  return spawnSync("helm", ["template", "database", join(fixture, name), "-f", "-"], {
    encoding: "utf8", input: JSON.stringify(values),
  });
}

function render(name, values = {}) {
  const output = result(name, values);
  assert.equal(output.status, 0, output.stderr);
  return parseAllDocuments(output.stdout).map((doc) => {
    assert.deepEqual(doc.errors, []);
    return doc.toJSON();
  }).filter(Boolean);
}

for (const [name, defaultPort] of Object.entries(defaults)) {
  test(name + " synchronizes the server, probes and Service target with containerPorts", () => {
    for (const port of [defaultPort, 16380]) {
      const docs = render(name, { containerPorts: { [name]: port } });
      const container = docs.find((doc) => doc.kind === "StatefulSet").spec.template.spec.containers[0];
      const target = container.ports.find((entry) => entry.name === "tcp-" + name);
      assert.equal(target.containerPort, port);
      const servicePort = docs.find((doc) => doc.kind === "Service").spec.ports[0];
      assert.equal(servicePort.port, defaultPort);
      assert.equal(servicePort.targetPort, target.name);
      for (const probe of ["startupProbe", "livenessProbe", "readinessProbe"]) {
        assert.match(container[probe].exec.command.at(-1), new RegExp("-[pP] " + port + "(?: |$)"));
      }
      if (name === "mysql") assert.deepEqual(container.args, ["--port=" + port]);
      else if (name === "postgresql") assert.deepEqual(container.args, ["-p", String(port)]);
      else assert.match(container.args[0], new RegExp('set -- "\\$@" --port ' + port + "\n"));
      execFileSync("helm", ["lint", "--strict", join(fixture, name), "-f", "-"], {
        input: JSON.stringify({ containerPorts: { [name]: port } }), stdio: "pipe",
      });
    }
  });

  test(name + " preserves explicit command and args overrides", () => {
    const custom = { command: ["/bin/sh", "-ec"], args: ["echo custom"] };
    const docs = render(name, { ...custom, containerPorts: { [name]: 16380 } });
    const container = docs.find((doc) => doc.kind === "StatefulSet").spec.template.spec.containers[0];
    assert.deepEqual(container.command, custom.command);
    assert.deepEqual(container.args, custom.args);
    if (name === "mysql" || name === "postgresql") {
      const commandOnly = render(name, { command: custom.command });
      assert.equal(commandOnly.find((doc) => doc.kind === "StatefulSet").spec.template.spec.containers[0].args, undefined);
    }
  });

  test(name + " rejects invalid listening ports before rendering a workload", () => {
    for (const port of [0, -1, 65536, 6379.5, "invalid", "6379; echo injected"]) {
      const output = result(name, { containerPorts: { [name]: port } });
      assert.notEqual(output.status, 0, String(port));
      assert.match(output.stderr, new RegExp("containerPorts\\." + name + " must be an integer from 1 through 65535"));
    }
  });
}

for (const [parent, name] of [["ghost", "mysql"], ["umami", "postgresql"]]) {
  test(parent + " applies a custom listening port to its bundled database", () => {
    const docs = render(parent, { [name]: { containerPorts: { [name]: 16380 } } });
    const container = docs.filter((doc) => doc.kind === "StatefulSet")
      .flatMap((doc) => doc.spec.template.spec.containers).find((entry) => entry.name === name);
    assert.equal(container.ports[0].containerPort, 16380);
    assert.deepEqual(container.args, name === "mysql" ? ["--port=16380"] : ["-p", "16380"]);
    const service = docs.find((doc) => doc.kind === "Service" && doc.spec.ports.some((port) => port.name === "tcp-" + name));
    assert.equal(service.spec.ports[0].port, defaults[name]);
    assert.equal(service.spec.ports[0].targetPort, container.ports[0].name);
  });
}
