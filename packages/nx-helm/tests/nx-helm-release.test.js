import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const releaseModule = require("../src/release.cts");
const HelmVersionActions = releaseModule.default ?? releaseModule;

class MemoryTree {
  root = "";
  #files;

  constructor(files) {
    this.#files = new Map(Object.entries(files));
  }

  read(path, encoding) {
    const value = this.#files.get(path);
    if (value === undefined) {
      return null;
    }
    return encoding ? value : Buffer.from(value);
  }

  write(path, content) {
    this.#files.set(path, String(content));
  }

  exists(path) {
    return this.#files.has(path);
  }
}

function createActions(projectName, projectRoot) {
  return new HelmVersionActions(
    { name: "helm", projects: [projectName], projectsRelationship: "independent" },
    {
      name: projectName,
      type: "app",
      data: {
        root: projectRoot,
      },
    },
    {
      adjustSemverBumpsForZeroMajorVersion: false,
      applyPreidToDependents: false,
      currentVersionResolver: "git-tag",
      currentVersionResolverMetadata: {},
      fallbackCurrentVersionResolver: "disk",
      manifestRootsToUpdate: [],
      preserveLocalDependencyProtocols: true,
      preserveMatchingDependencyRanges: true,
      specifierSource: "conventional-commits",
      updateDependents: "auto",
      versionActionsOptions: {},
      versionPrefix: "auto",
    },
  );
}

test("HelmVersionActions reads and updates Chart.yaml versions", async () => {
  const chartYaml = [
    "apiVersion: v2",
    "name: ghost",
    "keywords:",
    "  - cms",
    "  - blog",
    "version: 0.1.1",
    "",
  ].join("\n");
  const tree = new MemoryTree({
    "charts/ghost/Chart.yaml": chartYaml,
  });
  const actions = createActions("ghost", "charts/ghost");

  assert.deepEqual(await actions.readCurrentVersionFromSourceManifest(tree), {
    currentVersion: "0.1.1",
    manifestPath: "charts/ghost/Chart.yaml",
  });

  assert.deepEqual(await actions.updateProjectVersion(tree, "0.2.0"), [
    "✍️  Updated charts/ghost/Chart.yaml version to 0.2.0",
  ]);
  assert.equal(
    tree.read("charts/ghost/Chart.yaml", "utf8"),
    chartYaml.replace("version: 0.1.1", "version: 0.2.0"),
  );
});

test("HelmVersionActions updates Chart.yaml dependency versions", async () => {
  const ghostChartYaml = [
    "apiVersion: v2",
    "name: ghost",
    "version: 0.1.1",
    "dependencies:",
    "  - name: common",
    "    repository: oci://ghcr.io/community-helm-charts",
    "    version: 0.x.x",
    "",
  ].join("\n");
  const tree = new MemoryTree({
    "charts/common/Chart.yaml": "apiVersion: v2\nname: common\nversion: 0.1.0\n",
    "charts/ghost/Chart.yaml": ghostChartYaml,
  });
  const actions = createActions("ghost", "charts/ghost");
  const projectGraph = {
    nodes: {
      common: {
        name: "common",
        type: "lib",
        data: {
          root: "charts/common",
        },
      },
      ghost: {
        name: "ghost",
        type: "app",
        data: {
          root: "charts/ghost",
        },
      },
    },
    dependencies: {
      ghost: [{ source: "ghost", target: "common", type: "static" }],
    },
  };

  assert.deepEqual(await actions.readCurrentVersionOfDependency(tree, projectGraph, "common"), {
    currentVersion: "0.x.x",
    dependencyCollection: "dependencies",
  });

  assert.deepEqual(await actions.updateProjectDependencies(tree, projectGraph, { common: "0.2.0" }), [
    "✍️  Updated charts/ghost/Chart.yaml dependency common to 0.2.0",
  ]);
  assert.equal(
    tree.read("charts/ghost/Chart.yaml", "utf8"),
    ghostChartYaml.replace("version: 0.x.x", "version: 0.2.0"),
  );
});
