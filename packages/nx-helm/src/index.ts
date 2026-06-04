import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  DependencyType,
  type CreateDependencies,
  type CreateDependenciesContext,
  type CreateNodesContextV2,
  type CreateNodesV2,
  type ProjectConfiguration,
  validateDependency,
} from "@nx/devkit";
import { parse } from "yaml";

export const DEFAULT_CHART_PATTERN = "charts/*/Chart.yaml";
export const DEFAULT_REPOSITORY = "oci://ghcr.io/community-helm-charts";
const FILE_REPOSITORY_PREFIX = "file://";

export interface HelmPluginOptions {
  repository?: string;
}

export interface ChartDependency {
  name?: string;
  repository?: string;
  version?: string;
}

export interface ChartYaml {
  name?: string;
  description?: string;
  type?: string;
  version?: string;
  dependencies?: ChartDependency[];
}

interface CreateHelmProjectDependenciesOptions {
  projectName: string;
  sourceFile: string;
  chart: ChartYaml;
  chartNameToProjectName: Map<string, string>;
  chartRootToProjectName?: Map<string, string>;
}

export interface VendorInternalDependenciesOptions {
  chartRoot: string;
  workspaceRoot: string;
  distDir?: string;
  chartsDir?: string;
}

function workspacePath(context: Pick<CreateNodesContextV2 | CreateDependenciesContext, "workspaceRoot">, path: string) {
  return join(context.workspaceRoot, path);
}

function normalizeWorkspacePath(filePath: string) {
  return filePath.split(/[\\/]+/).join("/");
}

function normalizeProjectsConfigurations(
  projectsConfigurations?: Record<string, ProjectConfiguration> | { projects?: Record<string, ProjectConfiguration> },
) {
  return ("projects" in (projectsConfigurations ?? {}) ? projectsConfigurations?.projects : projectsConfigurations) ?? {};
}

function chartOptions(options: HelmPluginOptions = {}) {
  return {
    repository: options.repository ?? DEFAULT_REPOSITORY,
  };
}

export function parseChartYaml(content: string): ChartYaml {
  return parse(content) ?? {};
}

export function isLocalChartRepository(repository?: string) {
  return Boolean(repository?.startsWith(FILE_REPOSITORY_PREFIX));
}

export function localChartRoot(sourceRoot: string, repository?: string) {
  if (!isLocalChartRepository(repository)) {
    return null;
  }

  const repositoryPath = repository?.slice(FILE_REPOSITORY_PREFIX.length);
  if (!repositoryPath || repositoryPath.startsWith("/")) {
    return null;
  }

  return normalizeWorkspacePath(join(sourceRoot, repositoryPath));
}

export function isInternalChartDependency(dependency: ChartDependency, sourceRoot: string) {
  return localChartRoot(sourceRoot, dependency.repository) !== null;
}

export function createHelmProjectConfiguration(
  chartYamlPath: string,
  chart: ChartYaml,
  options: HelmPluginOptions = {},
): ProjectConfiguration {
  const projectRoot = dirname(chartYamlPath);
  const name = chart.name;
  if (!name) {
    throw new Error(`${chartYamlPath} must declare a chart name`);
  }

  const isLibrary = chart.type === "library";
  const { repository } = chartOptions(options);

  return {
    root: projectRoot,
    name,
    projectType: isLibrary ? "library" : "application",
    tags: isLibrary ? ["type:helm-chart", "helm:library"] : ["type:helm-chart"],
    metadata: {
      description: chart.description ?? `${name} Helm chart`,
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
          chartRoot: projectRoot,
          distDir: "dist",
        },
        cache: false,
        inputs: ["default", "{workspaceRoot}/pnpm-lock.yaml"],
        dependsOn: [{ dependencies: true, target: "package", params: "ignore" }],
      },
      lint: {
        command: `helm lint ${projectRoot}`,
        cache: true,
        inputs: ["default", "^default", "{workspaceRoot}/pnpm-lock.yaml"],
        dependsOn: ["dependency-build"],
      },
      package: {
        executor: "@community-helm-charts/nx-helm:package",
        options: {
          chartRoot: projectRoot,
          distDir: "dist",
          repository,
        },
        cache: true,
        inputs: ["default", "^default", "{workspaceRoot}/pnpm-lock.yaml"],
        outputs: [`{workspaceRoot}/dist/${name}-*.tgz`],
        dependsOn: [{ dependencies: true, target: "package", params: "ignore" }, "dependency-build"],
      },
      publish: {
        command: `helm push dist/${name}-*.tgz ${repository}`,
        cache: false,
        dependsOn: ["package"],
      },
      "nx-release-publish": {
        executor: "@community-helm-charts/nx-helm:release-publish",
        options: {
          chartName: name,
          chartRoot: projectRoot,
          distDir: "dist",
          repository,
        },
        cache: false,
        dependsOn: ["lint", "package"],
      },
    },
  };
}

export function createHelmProjectDependencies({
  projectName,
  sourceFile,
  chart,
  chartNameToProjectName,
  chartRootToProjectName,
}: CreateHelmProjectDependenciesOptions) {
  const sourceRoot = dirname(sourceFile);

  return (chart.dependencies ?? [])
    .map((dependency) => {
      if (!dependency.name) {
        return null;
      }

      const localRoot = localChartRoot(sourceRoot, dependency.repository);
      if (!localRoot) {
        return null;
      }

      const target = chartRootToProjectName?.get(localRoot) ?? chartNameToProjectName.get(dependency.name) ?? null;
      return target ? {
        source: projectName,
        target,
        sourceFile,
        type: DependencyType.static,
      } : null;
    })
    .filter((dependency) => dependency !== null);
}

export function vendorInternalDependencies({
  chartRoot,
  workspaceRoot,
  distDir = "dist",
  chartsDir = dirname(chartRoot),
}: VendorInternalDependenciesOptions) {
  const chart = parseChartYaml(readFileSync(join(workspaceRoot, chartRoot, "Chart.yaml"), "utf8"));
  const internalDependencies = (chart.dependencies ?? []).filter(
    (dependency) => isInternalChartDependency(dependency, chartRoot) && dependency.name,
  );
  const copied: string[] = [];

  if (internalDependencies.length === 0) {
    return { chartRoot, copied };
  }

  const dependencyOutputDir = join(workspaceRoot, chartRoot, "charts");
  mkdirSync(dependencyOutputDir, { recursive: true });
  for (const file of readdirSync(dependencyOutputDir)) {
    if (file.endsWith(".tgz")) {
      rmSync(join(dependencyOutputDir, file));
    }
  }

  for (const dependency of internalDependencies) {
    const dependencyName = dependency.name;
    if (!dependencyName) {
      continue;
    }

    const dependencyRoot = localChartRoot(chartRoot, dependency.repository) ?? normalizeWorkspacePath(join(chartsDir, dependencyName));
    const dependencyChartPath = join(workspaceRoot, dependencyRoot, "Chart.yaml");
    if (!existsSync(dependencyChartPath)) {
      throw new Error(`Internal dependency ${dependencyName} does not have a local Chart.yaml at ${dependencyChartPath}`);
    }

    const dependencyChart = parseChartYaml(readFileSync(dependencyChartPath, "utf8"));
    if (!dependencyChart.version) {
      throw new Error(`Internal dependency ${dependencyName} does not declare a chart version`);
    }

    const dependencyPackage = join(workspaceRoot, distDir, `${dependencyName}-${dependencyChart.version}.tgz`);
    if (!existsSync(dependencyPackage)) {
      throw new Error(`Expected packaged dependency ${dependencyPackage} to exist`);
    }

    const outputPackage = join(dependencyOutputDir, basename(dependencyPackage));
    copyFileSync(dependencyPackage, outputPackage);
    copied.push(basename(outputPackage));
  }

  return { chartRoot, copied };
}

export const createNodesV2: CreateNodesV2<HelmPluginOptions> = [
  DEFAULT_CHART_PATTERN,
  async (chartYamlPaths, options, context) => {
    const results = [];
    for (const chartYamlPath of chartYamlPaths) {
      const chart = parseChartYaml(readFileSync(workspacePath(context, chartYamlPath), "utf8"));
      const projectRoot = dirname(chartYamlPath);
      results.push([
        chartYamlPath,
        {
          projects: {
            [projectRoot]: createHelmProjectConfiguration(chartYamlPath, chart, options),
          },
        },
      ] as const);
    }
    return results;
  },
];

export const createNodes = createNodesV2;

export const createDependencies: CreateDependencies<HelmPluginOptions> = (options, context) => {
  const projectsConfigurations = normalizeProjectsConfigurations(context.projects);
  const projectsByRoot = new Map(Object.values(projectsConfigurations).map((project) => [project.root, project]));
  const chartNameToProjectName = new Map<string, string>();
  const chartRootToProjectName = new Map<string, string>();

  for (const project of projectsByRoot.values()) {
    const chartYamlPath = workspacePath(context, join(project.root, "Chart.yaml"));
    if (!existsSync(chartYamlPath)) {
      continue;
    }

    const chart = parseChartYaml(readFileSync(chartYamlPath, "utf8"));
    if (chart.name && project.name) {
      chartNameToProjectName.set(chart.name, project.name);
      chartRootToProjectName.set(normalizeWorkspacePath(project.root), project.name);
    }
  }

  const dependencies = [];
  for (const project of projectsByRoot.values()) {
    const sourceFile = join(project.root, "Chart.yaml");
    const chartYamlPath = workspacePath(context, sourceFile);
    if (!existsSync(chartYamlPath) || !project.name) {
      continue;
    }

    const chart = parseChartYaml(readFileSync(chartYamlPath, "utf8"));
    for (const dependency of createHelmProjectDependencies({
      projectName: project.name,
      sourceFile,
      chart,
      chartNameToProjectName,
      chartRootToProjectName,
    })) {
      validateDependency(dependency, context);
      dependencies.push(dependency);
    }
  }

  return dependencies;
};
