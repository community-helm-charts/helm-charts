import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "chart-versioner");

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "chart-versioner-"));

  function git(...args) {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  git("init");
  git("config", "user.name", "Test Bot");
  git("config", "user.email", "test@example.com");

  function commitAll(message) {
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  }

  function chart(name, version = "0.0.0") {
    const chartDir = join(repo, "charts", name);
    execFileSync("mkdir", ["-p", chartDir]);
    writeFileSync(
      join(chartDir, "Chart.yaml"),
      `apiVersion: v2\nname: ${name}\nversion: ${version}\n`,
      "utf8",
    );
    return chartDir;
  }

  function runVersioner(...args) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      assert.fail(`chart-versioner failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    return result;
  }

  function cleanup() {
    rmSync(repo, { force: true, recursive: true });
  }

  return { chart, cleanup, commitAll, git, repo, runVersioner };
}

test("write bumps fix commits to patch", () => {
  const ctx = makeRepo();
  try {
    const redis = ctx.chart("redis");
    const base = ctx.commitAll("chore: initial charts");
    writeFileSync(join(redis, "values.yaml"), "enabled: true\n", "utf8");
    ctx.commitAll("fix: adjust redis defaults");

    const output = join(ctx.repo, "plan.json");
    const result = ctx.runVersioner("write", "--base", base, "--head", "HEAD", "--output", output);

    assert.match(result.stdout, /redis/);
    assert.match(readFileSync(join(redis, "Chart.yaml"), "utf8"), /version: 0\.0\.1/);
    const plan = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(plan.changed_charts, ["redis"]);
    assert.equal(plan.charts[0].bump, "patch");
    assert.equal(plan.charts[0].next_version, "0.0.1");
  } finally {
    ctx.cleanup();
  }
});

test("write bumps feat commits to minor for each changed chart", () => {
  const ctx = makeRepo();
  try {
    const redis = ctx.chart("redis");
    const postgresql = ctx.chart("postgresql");
    const base = ctx.commitAll("chore: initial charts");
    writeFileSync(join(redis, "values.yaml"), "enabled: true\n", "utf8");
    writeFileSync(join(postgresql, "values.yaml"), "enabled: true\n", "utf8");
    ctx.commitAll("feat: add database defaults");

    ctx.runVersioner("write", "--base", base, "--head", "HEAD");

    assert.match(readFileSync(join(redis, "Chart.yaml"), "utf8"), /version: 0\.1\.0/);
    assert.match(readFileSync(join(postgresql, "Chart.yaml"), "utf8"), /version: 0\.1\.0/);
  } finally {
    ctx.cleanup();
  }
});

test("chart changes without release commits are ignored", () => {
  const ctx = makeRepo();
  try {
    const redis = ctx.chart("redis");
    const base = ctx.commitAll("chore: initial charts");
    writeFileSync(join(redis, "values.yaml"), "enabled: true\n", "utf8");
    ctx.commitAll("chore: adjust redis defaults");

    const result = ctx.runVersioner("plan", "--base", base, "--head", "HEAD");
    const plan = JSON.parse(result.stdout);

    assert.deepEqual(plan.changed_charts, []);
    assert.deepEqual(plan.charts, []);
  } finally {
    ctx.cleanup();
  }
});

test("feat bang bumps major", () => {
  const ctx = makeRepo();
  try {
    const redis = ctx.chart("redis");
    const base = ctx.commitAll("chore: initial charts");
    writeFileSync(join(redis, "values.yaml"), "enabled: true\n", "utf8");
    ctx.commitAll("feat!: adjust redis defaults");

    ctx.runVersioner("write", "--base", base, "--head", "HEAD");

    assert.match(readFileSync(join(redis, "Chart.yaml"), "utf8"), /version: 1\.0\.0/);
  } finally {
    ctx.cleanup();
  }
});

test("fix bang bumps major", () => {
  const ctx = makeRepo();
  try {
    const redis = ctx.chart("redis");
    const base = ctx.commitAll("chore: initial charts");
    writeFileSync(join(redis, "values.yaml"), "enabled: true\n", "utf8");
    ctx.commitAll("fix!: adjust redis defaults");

    ctx.runVersioner("write", "--base", base, "--head", "HEAD");

    assert.match(readFileSync(join(redis, "Chart.yaml"), "utf8"), /version: 1\.0\.0/);
  } finally {
    ctx.cleanup();
  }
});

test("breaking change body without bang does not bump major", () => {
  const ctx = makeRepo();
  try {
    const redis = ctx.chart("redis");
    const base = ctx.commitAll("chore: initial charts");
    writeFileSync(join(redis, "values.yaml"), "enabled: true\n", "utf8");
    ctx.git("add", ".");
    ctx.git("commit", "-m", "fix: adjust redis defaults", "-m", "BREAKING CHANGE: changes redis defaults");

    ctx.runVersioner("write", "--base", base, "--head", "HEAD");

    assert.match(readFileSync(join(redis, "Chart.yaml"), "utf8"), /version: 0\.0\.1/);
  } finally {
    ctx.cleanup();
  }
});

test("readme-only chart changes are ignored", () => {
  const ctx = makeRepo();
  try {
    const redis = ctx.chart("redis");
    const base = ctx.commitAll("chore: initial charts");
    writeFileSync(join(redis, "README.md"), "# Redis\n", "utf8");
    ctx.commitAll("docs: update redis readme");

    const result = ctx.runVersioner("plan", "--base", base, "--head", "HEAD");
    const plan = JSON.parse(result.stdout);

    assert.deepEqual(plan.changed_charts, []);
    assert.deepEqual(plan.charts, []);
  } finally {
    ctx.cleanup();
  }
});

test("existing expected chart version is not bumped twice", () => {
  const ctx = makeRepo();
  try {
    const redis = ctx.chart("redis");
    const base = ctx.commitAll("chore: initial charts");
    writeFileSync(join(redis, "values.yaml"), "enabled: true\n", "utf8");
    writeFileSync(join(redis, "Chart.yaml"), "apiVersion: v2\nname: redis\nversion: 0.0.1\n", "utf8");
    ctx.commitAll("fix: adjust redis defaults");

    ctx.runVersioner("write", "--base", base, "--head", "HEAD");

    assert.match(readFileSync(join(redis, "Chart.yaml"), "utf8"), /version: 0\.0\.1/);
  } finally {
    ctx.cleanup();
  }
});
