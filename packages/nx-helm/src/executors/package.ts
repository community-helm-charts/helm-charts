import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ExecutorContext } from "@nx/devkit";
import { isMap, isSeq, parseDocument } from "yaml";

import {
  DEFAULT_REPOSITORY,
  isInternalChartDependency,
  type ChartDependency,
} from "../index.ts";

export interface PackageExecutorOptions {
  chartRoot: string;
  distDir?: string;
  repository?: string;
}

type HelmRunner = (command: string, args: string[], cwd: string) => Pick<SpawnSyncReturns<Buffer>, "error" | "status">;

function defaultHelmRunner(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}

function rewriteInternalDependencyRepositories(
  chartYamlPath: string,
  chartRoot: string,
  repository: string,
) {
  const source = readFileSync(chartYamlPath, "utf8");
  const document = parseDocument(source);
  const dependencies = document.get("dependencies", true);
  if (!isSeq(dependencies)) {
    return false;
  }

  let changed = false;
  for (const item of dependencies.items) {
    if (!isMap(item)) {
      continue;
    }

    const dependency: ChartDependency = {
      name: String(item.get("name") ?? ""),
      repository: String(item.get("repository") ?? ""),
      version: String(item.get("version") ?? ""),
    };

    if (!isInternalChartDependency(dependency, chartRoot)) {
      continue;
    }

    item.set("repository", repository);
    changed = true;
  }

  if (changed) {
    writeFileSync(chartYamlPath, document.toString());
  }

  return changed;
}

export default async function packageExecutor(
  options: PackageExecutorOptions,
  context: Pick<ExecutorContext, "root">,
  runHelm: HelmRunner = defaultHelmRunner,
) {
  const chartRoot = options.chartRoot;
  const sourceChartRoot = join(context.root, chartRoot);
  const sourceChartYaml = join(sourceChartRoot, "Chart.yaml");
  if (!existsSync(sourceChartYaml)) {
    throw new Error(`Expected Chart.yaml to exist at ${sourceChartYaml}`);
  }

  const distDir = join(context.root, options.distDir ?? "dist");
  mkdirSync(distDir, { recursive: true });

  const tempRoot = mkdtempSync(join(tmpdir(), "nx-helm-package-"));
  const tempChartRoot = join(tempRoot, basename(chartRoot));
  try {
    cpSync(sourceChartRoot, tempChartRoot, { recursive: true });
    rewriteInternalDependencyRepositories(
      join(tempChartRoot, "Chart.yaml"),
      chartRoot,
      options.repository ?? DEFAULT_REPOSITORY,
    );

    const args = ["package", tempChartRoot, "--destination", distDir];
    const result = runHelm("helm", args, context.root);
    if (result.error) {
      throw result.error;
    }

    return { success: result.status === 0 };
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}
