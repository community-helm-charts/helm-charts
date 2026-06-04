import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import releasePublishExecutor, {
  resolveReleasePublishPlan,
} from "../src/executors/release-publish.ts";

test("resolveReleasePublishPlan selects the versioned chart package and registry override", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "nx-helm-release-publish-"));
  mkdirSync(join(workspaceRoot, "charts", "ghost"), { recursive: true });
  mkdirSync(join(workspaceRoot, "dist"), { recursive: true });
  writeFileSync(join(workspaceRoot, "charts", "ghost", "Chart.yaml"), "apiVersion: v2\nname: ghost\nversion: 0.1.2\n");
  writeFileSync(join(workspaceRoot, "dist", "ghost-0.1.2.tgz"), "chart");

  assert.deepEqual(
    resolveReleasePublishPlan(
      {
        chartName: "ghost",
        chartRepository: "oci://ghcr.io/community-helm-charts",
        chartRoot: "charts/ghost",
        distDir: "dist",
        registry: "oci://example.invalid/charts",
      },
      workspaceRoot,
    ),
    {
      chartName: "ghost",
      chartPackage: join(workspaceRoot, "dist", "ghost-0.1.2.tgz"),
      chartRepository: "oci://example.invalid/charts",
      dryRun: false,
      version: "0.1.2",
    },
  );
});

test("releasePublishExecutor dry-run does not execute helm push", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "nx-helm-release-publish-dry-run-"));
  mkdirSync(join(workspaceRoot, "charts", "ghost"), { recursive: true });
  mkdirSync(join(workspaceRoot, "dist"), { recursive: true });
  writeFileSync(join(workspaceRoot, "charts", "ghost", "Chart.yaml"), "apiVersion: v2\nname: ghost\nversion: 0.1.2\n");
  writeFileSync(join(workspaceRoot, "dist", "ghost-0.1.2.tgz"), "chart");

  const calls = [];
  const result = await releasePublishExecutor(
    {
      chartName: "ghost",
      chartRepository: "oci://ghcr.io/community-helm-charts",
      chartRoot: "charts/ghost",
      distDir: "dist",
      dryRun: true,
    },
    { root: workspaceRoot },
    (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    },
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, []);
});

test("releasePublishExecutor dry-run does not require the chart package to exist", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "nx-helm-release-publish-dry-run-missing-"));
  mkdirSync(join(workspaceRoot, "charts", "ghost"), { recursive: true });
  writeFileSync(join(workspaceRoot, "charts", "ghost", "Chart.yaml"), "apiVersion: v2\nname: ghost\nversion: 0.1.2\n");

  const result = await releasePublishExecutor(
    {
      chartName: "ghost",
      chartRepository: "oci://ghcr.io/community-helm-charts",
      chartRoot: "charts/ghost",
      distDir: "dist",
      dryRun: true,
    },
    { root: workspaceRoot },
    () => {
      throw new Error("helm should not run during dry-run");
    },
  );

  assert.deepEqual(result, { success: true });
});

test("releasePublishExecutor executes helm push for the resolved package", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "nx-helm-release-publish-run-"));
  mkdirSync(join(workspaceRoot, "charts", "ghost"), { recursive: true });
  mkdirSync(join(workspaceRoot, "dist"), { recursive: true });
  writeFileSync(join(workspaceRoot, "charts", "ghost", "Chart.yaml"), "apiVersion: v2\nname: ghost\nversion: 0.1.2\n");
  writeFileSync(join(workspaceRoot, "dist", "ghost-0.1.2.tgz"), "chart");

  const calls = [];
  const result = await releasePublishExecutor(
    {
      chartName: "ghost",
      chartRepository: "oci://ghcr.io/community-helm-charts",
      chartRoot: "charts/ghost",
      distDir: "dist",
    },
    { root: workspaceRoot },
    (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    },
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, [
    [
      "helm",
      ["push", join(workspaceRoot, "dist", "ghost-0.1.2.tgz"), "oci://ghcr.io/community-helm-charts"],
    ],
  ]);
  assert.equal(readFileSync(join(workspaceRoot, "dist", "ghost-0.1.2.tgz"), "utf8"), "chart");
});
