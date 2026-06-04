import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExecutorContext } from "@nx/devkit";

import { parseChartYaml } from "../index.ts";

export interface ReleasePublishExecutorOptions {
  chartName?: string;
  chartRoot: string;
  distDir?: string;
  dryRun?: boolean;
  registry?: string;
  tag?: string;
  access?: string;
  otp?: number;
  firstRelease?: boolean;
  nxReleaseVersionData?: unknown;
  repository?: string;
}

export interface ReleasePublishPlan {
  chartName: string;
  chartPackage: string;
  repository: string;
  dryRun: boolean;
  version: string;
}

type HelmRunner = (command: string, args: string[], cwd: string) => Pick<SpawnSyncReturns<Buffer>, "error" | "status">;

function defaultHelmRunner(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}

export function resolveReleasePublishPlan(
  options: ReleasePublishExecutorOptions,
  workspaceRoot: string,
): ReleasePublishPlan {
  const chartYamlPath = join(workspaceRoot, options.chartRoot, "Chart.yaml");
  if (!existsSync(chartYamlPath)) {
    throw new Error(`Expected Chart.yaml to exist at ${chartYamlPath}`);
  }

  const chart = parseChartYaml(readFileSync(chartYamlPath, "utf8"));
  const chartName = options.chartName ?? chart.name;
  if (!chartName) {
    throw new Error(`${chartYamlPath} must declare a chart name`);
  }
  if (!chart.version) {
    throw new Error(`${chartYamlPath} must declare a chart version`);
  }

  const repository = options.registry ?? options.repository;
  if (!repository) {
    throw new Error(`A chart repository is required to publish ${chartName}`);
  }

  const distDir = options.distDir ?? "dist";
  const chartPackage = join(workspaceRoot, distDir, `${chartName}-${chart.version}.tgz`);
  const dryRun = Boolean(options.dryRun || process.env.NX_DRY_RUN === "true");
  if (!dryRun && !existsSync(chartPackage)) {
    throw new Error(`Expected packaged chart ${chartPackage} to exist before publishing`);
  }

  return {
    chartName,
    chartPackage,
    repository,
    dryRun,
    version: chart.version,
  };
}

export default async function releasePublishExecutor(
  options: ReleasePublishExecutorOptions,
  context: Pick<ExecutorContext, "root">,
  runHelm: HelmRunner = defaultHelmRunner,
) {
  const plan = resolveReleasePublishPlan(options, context.root);
  const args = ["push", plan.chartPackage, plan.repository];

  if (plan.dryRun) {
    console.log(`[dry-run] helm ${args.join(" ")}`);
    return { success: true };
  }

  const result = runHelm("helm", args, context.root);
  if (result.error) {
    throw result.error;
  }

  return { success: result.status === 0 };
}
