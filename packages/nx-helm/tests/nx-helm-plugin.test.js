import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createHelmProjectConfiguration,
  createHelmProjectDependencies,
  createNodesV2,
  parseChartYaml,
  vendorInternalDependencies,
} from "../src/index.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "../..");

test("is configured as a workspace-local Nx native plugin without a CLI bin", () => {
  const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.executors, "./executors.json");
  assert.equal(packageJson.bin, undefined);
  assert.deepEqual(packageJson.exports["./release"], {
    types: "./dist/release.d.cts",
    require: "./dist/release.cjs",
    default: "./dist/release.cjs",
  });
  assert.equal(packageJson.files, undefined);
  assert.equal(packageJson.scripts.build, "rm -rf dist && tsc -p tsconfig.json");
  assert.equal(packageJson.scripts.test, "node --test tests/*.test.js");
  assert.equal(packageJson.scripts.prepack, undefined);

  const executorsJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "executors.json"), "utf8"));
  assert.equal(executorsJson.executors["dependency-build"].schema, "./schemas/dependency-build.json");
  assert.equal(executorsJson.executors["release-publish"].schema, "./schemas/release-publish.json");
  assert.equal(executorsJson.executors.version, undefined);
});

test("configures Nx release to version Helm charts", () => {
  const nxJson = JSON.parse(readFileSync(join(WORKSPACE_ROOT, "nx.json"), "utf8"));

  assert.deepEqual(nxJson.release, {
    projects: ["tag:type:helm-chart"],
    projectsRelationship: "independent",
    git: {
      commit: true,
      tag: true,
      push: false,
    },
    version: {
      conventionalCommits: true,
      fallbackCurrentVersionResolver: "disk",
      updateDependents: "auto",
      versionActions: "@community-helm-charts/nx-helm/release",
    },
    changelog: {
      workspaceChangelog: false,
      projectChangelogs: true,
      automaticFromRef: true,
    },
  });
});

test("creates an Nx project configuration for a Helm chart", () => {
  const chart = parseChartYaml(`
apiVersion: v2
name: ghost
description: A Ghost CMS Helm chart
version: 0.1.1
`);

  assert.deepEqual(createHelmProjectConfiguration("charts/ghost/Chart.yaml", chart), {
    root: "charts/ghost",
    name: "ghost",
    projectType: "application",
    tags: ["type:helm-chart"],
    metadata: {
      description: "A Ghost CMS Helm chart",
    },
    release: {
      version: {
        currentVersionResolver: "git-tag",
        fallbackCurrentVersionResolver: "disk",
        versionActions: "@community-helm-charts/nx-helm/release",
      },
    },
    targets: {
      "dependency-build": {
        executor: "@community-helm-charts/nx-helm:dependency-build",
        options: {
          chartRoot: "charts/ghost",
          distDir: "dist",
          internalRepository: "oci://ghcr.io/community-helm-charts",
        },
        cache: false,
        inputs: ["default", "{workspaceRoot}/pnpm-lock.yaml"],
        dependsOn: [{ dependencies: true, target: "package", params: "ignore" }],
      },
      lint: {
        command: "helm lint charts/ghost",
        cache: true,
        inputs: ["default", "^default", "{workspaceRoot}/pnpm-lock.yaml"],
        dependsOn: ["dependency-build"],
      },
      package: {
        command: "mkdir -p dist && helm package charts/ghost --destination dist",
        cache: true,
        inputs: ["default", "^default", "{workspaceRoot}/pnpm-lock.yaml"],
        outputs: ["{workspaceRoot}/dist/ghost-*.tgz"],
        dependsOn: [{ dependencies: true, target: "package", params: "ignore" }, "dependency-build"],
      },
      publish: {
        command: "helm push dist/ghost-*.tgz oci://ghcr.io/community-helm-charts",
        cache: false,
        dependsOn: ["package"],
      },
      "nx-release-publish": {
        executor: "@community-helm-charts/nx-helm:release-publish",
        options: {
          chartName: "ghost",
          chartRepository: "oci://ghcr.io/community-helm-charts",
          chartRoot: "charts/ghost",
          distDir: "dist",
        },
        cache: false,
        dependsOn: ["lint", "package"],
      },
    },
  });
});

test("marks library charts as Nx library projects", () => {
  const chart = parseChartYaml(`
apiVersion: v2
name: common
description: Shared helpers
type: library
version: 0.1.0
`);

  const project = createHelmProjectConfiguration("charts/common/Chart.yaml", chart);

  assert.equal(project.projectType, "library");
  assert.deepEqual(project.tags, ["type:helm-chart", "helm:library"]);
});

test("createNodesV2 returns one Nx project result per Chart.yaml file", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "nx-helm-"));
  const chartDir = join(workspaceRoot, "charts", "common");
  mkdirSync(chartDir, { recursive: true });
  writeFileSync(join(chartDir, "Chart.yaml"), `
apiVersion: v2
name: common
description: Shared helpers
type: library
version: 0.1.0
`);

  const [, createNodes] = createNodesV2;

  assert.deepEqual(
    await createNodes(["charts/common/Chart.yaml"], {}, { workspaceRoot, nxJsonConfiguration: {} }),
    [
      [
        "charts/common/Chart.yaml",
        {
          projects: {
            "charts/common": createHelmProjectConfiguration(
              "charts/common/Chart.yaml",
              parseChartYaml(`
apiVersion: v2
name: common
description: Shared helpers
type: library
version: 0.1.0
`),
            ),
          },
        },
      ],
    ],
  );
});

test("vendors packaged internal dependencies into the chart dependency directory", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "nx-helm-vendor-"));
  mkdirSync(join(workspaceRoot, "charts", "common"), { recursive: true });
  mkdirSync(join(workspaceRoot, "charts", "mysql"), { recursive: true });
  mkdirSync(join(workspaceRoot, "dist"), { recursive: true });
  writeFileSync(join(workspaceRoot, "charts", "common", "Chart.yaml"), `
apiVersion: v2
name: common
version: 0.1.0
`);
  writeFileSync(join(workspaceRoot, "charts", "mysql", "Chart.yaml"), `
apiVersion: v2
name: mysql
version: 1.0.0
dependencies:
- name: common
  repository: oci://ghcr.io/community-helm-charts
  version: 0.x.x
`);
  writeFileSync(join(workspaceRoot, "dist", "common-0.1.0.tgz"), "package");

  const result = vendorInternalDependencies({
    chartRoot: "charts/mysql",
    workspaceRoot,
    internalRepository: "oci://ghcr.io/community-helm-charts",
    distDir: "dist",
  });

  const vendoredPackage = join(workspaceRoot, "charts", "mysql", "charts", "common-0.1.0.tgz");
  assert.deepEqual(result, {
    chartRoot: "charts/mysql",
    copied: ["common-0.1.0.tgz"],
  });
  assert.equal(existsSync(vendoredPackage), true);
  assert.equal(readFileSync(vendoredPackage, "utf8"), "package");
});

test("creates static Nx graph dependencies for internal Helm dependencies", () => {
  const chart = parseChartYaml(`
apiVersion: v2
name: ghost
dependencies:
- name: common
  repository: oci://ghcr.io/community-helm-charts
  version: 0.x.x
- condition: mysql.enabled
  name: mysql
  repository: oci://ghcr.io/community-helm-charts
  version: 1.x.x
- name: external
  repository: https://example.invalid/charts
  version: 1.x.x
`);

  assert.deepEqual(
    createHelmProjectDependencies({
      projectName: "ghost",
      sourceFile: "charts/ghost/Chart.yaml",
      chart,
      chartNameToProjectName: new Map([
        ["common", "common"],
        ["ghost", "ghost"],
        ["mysql", "mysql"],
      ]),
      internalRepository: "oci://ghcr.io/community-helm-charts",
    }),
    [
      {
        source: "ghost",
        target: "common",
        sourceFile: "charts/ghost/Chart.yaml",
        type: "static",
      },
      {
        source: "ghost",
        target: "mysql",
        sourceFile: "charts/ghost/Chart.yaml",
        type: "static",
      },
    ],
  );
});
