import type { ExecutorContext } from "@nx/devkit";

import { vendorInternalDependencies } from "../index.ts";

export interface DependencyBuildExecutorOptions {
  chartRoot: string;
  distDir?: string;
  internalRepository?: string;
}

export default async function dependencyBuildExecutor(options: DependencyBuildExecutorOptions, context: ExecutorContext) {
  const result = vendorInternalDependencies({
    chartRoot: options.chartRoot,
    distDir: options.distDir,
    internalRepository: options.internalRepository,
    workspaceRoot: context.root,
  });

  if (result.copied.length === 0) {
    console.log(`${result.chartRoot}: no internal dependencies`);
  } else {
    console.log(`${result.chartRoot}: vendored ${result.copied.join(", ")}`);
  }

  return { success: true };
}
