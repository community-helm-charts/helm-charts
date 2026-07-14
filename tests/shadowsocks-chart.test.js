import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("chart metadata pins shadowsocks-rust v1.24.0 and the local common dependency", () => {
  const chart = readFileSync(join(ROOT, "charts", "shadowsocks", "Chart.yaml"), "utf8");

  assert.match(chart, /^name: shadowsocks$/m);
  assert.match(chart, /^version: 1\.0\.0$/m);
  assert.match(chart, /^appVersion: "v1\.24\.0"$/m);
  assert.match(chart, /image: ghcr\.io\/shadowsocks\/ssserver-rust:v1\.24\.0/);
  assert.match(chart, /repository: file:\/\/\.\.\/common/);
  assert.match(chart, /version: 0\.2\.1/);
});
