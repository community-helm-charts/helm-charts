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

const DEFAULT_CHART_PATTERN = "charts/*/Chart.yaml";
const DEFAULT_INTERNAL_REPOSITORY = "oci://ghcr.io/community-helm-charts";
const DEFAULT_CHART_REPOSITORY = DEFAULT_INTERNAL_REPOSITORY;

export interface HelmPluginOptions {
  chartRepository?: string;
  internalRepository?: string;
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
  internalRepository?: string;
}

export interface VendorInternalDependenciesOptions {
  chartRoot: string;
  workspaceRoot: string;
  internalRepository?: string;
  distDir?: string;
  chartsDir?: string;
}

function workspacePath(context: Pick<CreateNodesContextV2 | CreateDependenciesContext, "workspaceRoot">, path: string) {
  return join(context.workspaceRoot, path);
}

function normalizeProjectsConfigurations(
  projectsConfigurations?: Record<string, ProjectConfiguration> | { projects?: Record<string, ProjectConfiguration> },
) {
  return ("projects" in (projectsConfigurations ?? {}) ? projectsConfigurations?.projects : projectsConfigurations) ?? {};
}

function chartOptions(options: HelmPluginOptions = {}) {
  return {
    chartRepository: options.chartRepository ?? DEFAULT_CHART_REPOSITORY,
    internalRepository: options.internalRepository ?? DEFAULT_INTERNAL_REPOSITORY,
  };
}

export function parseChartYaml(content: string): ChartYaml {
  return parse(content) ?? {};
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
  const { chartRepository, internalRepository } = chartOptions(options);

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
          internalRepository,
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
        command: `mkdir -p dist && helm package ${projectRoot} --destination dist`,
        cache: true,
        inputs: ["default", "^default", "{workspaceRoot}/pnpm-lock.yaml"],
        outputs: [`{workspaceRoot}/dist/${name}-*.tgz`],
        dependsOn: [{ dependencies: true, target: "package", params: "ignore" }, "dependency-build"],
      },
      publish: {
        command: `helm push dist/${name}-*.tgz ${chartRepository}`,
        cache: false,
        dependsOn: ["package"],
      },
      "nx-release-publish": {
        executor: "@community-helm-charts/nx-helm:release-publish",
        options: {
          chartName: name,
          chartRepository,
          chartRoot: projectRoot,
          distDir: "dist",
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
  internalRepository = DEFAULT_INTERNAL_REPOSITORY,
}: CreateHelmProjectDependenciesOptions) {
  return (chart.dependencies ?? [])
    .filter((dependency) => dependency.repository === internalRepository)
    .map((dependency) => {
      if (!dependency.name) {
        return null;
      }
      const target = chartNameToProjectName.get(dependency.name);
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
  internalRepository = DEFAULT_INTERNAL_REPOSITORY,
  distDir = "dist",
  chartsDir = dirname(chartRoot),
}: VendorInternalDependenciesOptions) {
  const chart = parseChartYaml(readFileSync(join(workspaceRoot, chartRoot, "Chart.yaml"), "utf8"));
  const internalDependencies = (chart.dependencies ?? []).filter(
    (dependency) => dependency.repository === internalRepository && dependency.name,
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

    const dependencyChartPath = join(workspaceRoot, chartsDir, dependencyName, "Chart.yaml");
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
  const { internalRepository } = chartOptions(options);
  const projectsConfigurations = normalizeProjectsConfigurations(context.projects);
  const projectsByRoot = new Map(Object.values(projectsConfigurations).map((project) => [project.root, project]));
  const chartNameToProjectName = new Map<string, string>();

  for (const project of projectsByRoot.values()) {
    const chartYamlPath = workspacePath(context, join(project.root, "Chart.yaml"));
    if (!existsSync(chartYamlPath)) {
      continue;
    }

    const chart = parseChartYaml(readFileSync(chartYamlPath, "utf8"));
    if (chart.name && project.name) {
      chartNameToProjectName.set(chart.name, project.name);
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
      internalRepository,
    })) {
      validateDependency(dependency, context);
      dependencies.push(dependency);
    }
  }

  return dependencies;
};
