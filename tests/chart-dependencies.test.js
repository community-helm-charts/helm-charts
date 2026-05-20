import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const INTERNAL_REPOSITORY = "oci://ghcr.io/community-helm-charts";

function chartFile(chartName, file = "Chart.yaml") {
  return join(ROOT, "charts", chartName, file);
}

function chartVersion(chartName) {
  const content = readFileSync(chartFile(chartName), "utf8");
  const match = content.match(/^version:\s*"?([^"\n]+)"?\s*$/m);
  assert.ok(match, `${chartName} Chart.yaml has a version`);
  return match[1];
}

function dependencyBlocks(content) {
  const dependenciesStart = content.search(/^dependencies:\s*$/m);
  if (dependenciesStart === -1) {
    return [];
  }

  const tail = content.slice(dependenciesStart);
  const nextTopLevel = tail.slice("dependencies:\n".length).search(/^[^\s-][^:\n]*:\s*/m);
  const section = nextTopLevel === -1 ? tail : tail.slice(0, "dependencies:\n".length + nextTopLevel);
  return section
    .split(/\n(?=- )/)
    .slice(1)
    .map((block) => Object.fromEntries([...block.matchAll(/^\s*(?:-\s*)?([A-Za-z0-9_]+):\s*(.+?)\s*$/gm)].map(([, key, value]) => [key, value.replace(/^"|"$/g, "")])));
}

function internalDependencies(chartName, file = "Chart.yaml") {
  const path = chartFile(chartName, file);
  if (!existsSync(path)) {
    return [];
  }
  return dependencyBlocks(readFileSync(path, "utf8")).filter((dependency) => dependency.repository === INTERNAL_REPOSITORY);
}

test("internal chart dependency ranges match the referenced chart major version", () => {
  const chartNames = readdirSync(join(ROOT, "charts"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const mismatches = [];
  for (const chartName of chartNames) {
    for (const dependency of internalDependencies(chartName)) {
      const targetVersion = chartVersion(dependency.name);
      const expectedRange = `${targetVersion.split(".")[0]}.x.x`;
      if (dependency.version !== expectedRange) {
        mismatches.push(`${chartName} -> ${dependency.name}: expected ${expectedRange}, got ${dependency.version}`);
      }
    }
  }

  assert.deepEqual(mismatches, []);
});

test("internal Chart.lock entries match the current referenced chart versions", () => {
  const chartNames = readdirSync(join(ROOT, "charts"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const mismatches = [];
  for (const chartName of chartNames) {
    const expectedDependencies = internalDependencies(chartName);
    if (expectedDependencies.length === 0) {
      continue;
    }

    const expectedByName = new Map(expectedDependencies.map((dependency) => [dependency.name, dependency]));
    const lockedByName = new Map(internalDependencies(chartName, "Chart.lock").map((dependency) => [dependency.name, dependency.version]));
    for (const dependency of expectedDependencies) {
      const expectedVersion = chartVersion(dependency.name);
      const lockedVersion = lockedByName.get(dependency.name);
      if (lockedVersion !== expectedVersion) {
        mismatches.push(`${chartName} -> ${dependency.name}: expected lock ${expectedVersion}, got ${lockedVersion || "missing"}`);
      }
    }
    for (const lockedDependency of lockedByName.keys()) {
      if (!expectedByName.has(lockedDependency)) {
        mismatches.push(`${chartName} -> ${lockedDependency}: unexpected internal lock entry`);
      }
    }
  }

  assert.deepEqual(mismatches, []);
});
