const path = require("node:path");
const { isMap, isSeq, parseDocument } = require("yaml");
const { VersionActions } = require("nx/release");

const CHART_YAML = "Chart.yaml";

interface TreeLike {
  read(path: string, encoding: BufferEncoding): string | null;
  write(path: string, content: string): void;
  exists(path: string): boolean;
}

interface ProjectGraphLike {
  nodes: Record<string, { data?: { root?: string } }>;
}

interface YamlSequenceLike {
  items: unknown[];
}

interface YamlMapLike {
  get(key: string, keepScalar?: boolean): unknown;
}

interface YamlScalarLike {
  range?: [number, number, number];
}

function normalizePath(filePath: string) {
  return filePath.split(path.sep).join("/");
}

function chartManifestPath(projectRoot: string) {
  return normalizePath(path.join(projectRoot, CHART_YAML));
}

function readText(tree: TreeLike, filePath: string) {
  const content = tree.read(filePath, "utf8");
  if (content === null) {
    throw new Error(`Could not read ${filePath}`);
  }
  return content;
}

function readChartDocument(tree: TreeLike, filePath: string) {
  return parseDocument(readText(tree, filePath));
}

function scalarValueRange(node: unknown, source: string, description: string) {
  const range = (node as YamlScalarLike | null)?.range;
  if (!range) {
    throw new Error(`Could not locate ${description} in Chart.yaml`);
  }

  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) {
    throw new Error(`Invalid source range for ${description} in Chart.yaml`);
  }

  return [start, end] as const;
}

function replaceRanges(source: string, replacements: { start: number; end: number; value: string }[]) {
  return [...replacements]
    .sort((a, b) => b.start - a.start)
    .reduce((content, replacement) => {
      return `${content.slice(0, replacement.start)}${replacement.value}${content.slice(replacement.end)}`;
    }, source);
}

function readChartName(tree: TreeLike, projectGraph: ProjectGraphLike, projectName: string) {
  const root = projectGraph.nodes[projectName]?.data?.root;
  if (!root) {
    return projectName;
  }

  const manifestPath = chartManifestPath(root);
  if (!tree.exists(manifestPath)) {
    return projectName;
  }

  return String(readChartDocument(tree, manifestPath).get("name") ?? projectName);
}

function findDependency(document: { get(key: string, keepScalar?: boolean): unknown }, dependencyName: string) {
  const dependencies = document.get("dependencies", true);
  if (!isSeq(dependencies)) {
    return null;
  }

  for (const item of (dependencies as YamlSequenceLike).items) {
    if (!isMap(item)) {
      continue;
    }

    const dependency = item as YamlMapLike;
    if (String(dependency.get("name") ?? "") === dependencyName) {
      return dependency;
    }
  }

  return null;
}

class HelmVersionActions extends VersionActions {
  validManifestFilenames = [CHART_YAML];

  get manifestPath() {
    return chartManifestPath(this.projectGraphNode.data.root);
  }

  async readCurrentVersionFromSourceManifest(tree: TreeLike) {
    const document = readChartDocument(tree, this.manifestPath);
    const currentVersion = document.get("version");

    if (!currentVersion) {
      return null;
    }

    return {
      currentVersion: String(currentVersion),
      manifestPath: this.manifestPath,
    };
  }

  async readCurrentVersionFromRegistry() {
    return null;
  }

  async readCurrentVersionOfDependency(
    tree: TreeLike,
    projectGraph: ProjectGraphLike,
    dependencyProjectName: string,
  ) {
    const document = readChartDocument(tree, this.manifestPath);
    const dependencyName = readChartName(tree, projectGraph, dependencyProjectName);
    const dependency = findDependency(document, dependencyName);

    return {
      currentVersion: dependency ? String(dependency.get("version") ?? "") : null,
      dependencyCollection: dependency ? "dependencies" : null,
    };
  }

  async updateProjectVersion(tree: TreeLike, newVersion: string) {
    const source = readText(tree, this.manifestPath);
    const document = parseDocument(source);
    const versionNode = document.get("version", true);
    const [start, end] = scalarValueRange(versionNode, source, "root version");

    tree.write(this.manifestPath, replaceRanges(source, [{ start, end, value: newVersion }]));

    return [`✍️  Updated ${this.manifestPath} version to ${newVersion}`];
  }

  async updateProjectDependencies(
    tree: TreeLike,
    projectGraph: ProjectGraphLike,
    dependenciesToUpdate: Record<string, string>,
  ) {
    const entries = Object.entries(dependenciesToUpdate);
    if (entries.length === 0) {
      return [];
    }

    const source = readText(tree, this.manifestPath);
    const document = parseDocument(source);
    const logMessages: string[] = [];
    const replacements: { start: number; end: number; value: string }[] = [];

    for (const [dependencyProjectName, newVersion] of entries) {
      const dependencyName = readChartName(tree, projectGraph, dependencyProjectName);
      const dependency = findDependency(document, dependencyName);
      if (!dependency) {
        continue;
      }

      const versionNode = dependency.get("version", true);
      const [start, end] = scalarValueRange(versionNode, source, `${dependencyName} dependency version`);
      replacements.push({ start, end, value: newVersion });
      logMessages.push(`✍️  Updated ${this.manifestPath} dependency ${dependencyName} to ${newVersion}`);
    }

    if (replacements.length > 0) {
      tree.write(this.manifestPath, replaceRanges(source, replacements));
    }

    return logMessages;
  }
}

module.exports = HelmVersionActions;
