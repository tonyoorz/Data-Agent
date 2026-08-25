import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const QUALIFIED_PACKAGES = Object.freeze([
  { name: "vite", entrypoint: "bin/vite.js" },
  { name: "vitest", entrypoint: "vitest.mjs" },
]);

function dependencyFail(code, details = "") {
  const error = new Error(details ? `${code}:${details}` : code);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(filePath, errorCode) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    dependencyFail(errorCode, path.basename(filePath));
  }
}

function assertRegularFile(filePath, code, details) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    dependencyFail(code, details);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) dependencyFail(code, details);
}

function assertDirectory(filePath, code, details) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    dependencyFail(code, details);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) dependencyFail(code, details);
}

function isContained(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function canonicalDependencyMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([name, range]) => [String(name), String(range)])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function hashInstalledTree(nodeModulesRoot) {
  const entries = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!relativeDirectory && (entry.name === ".vite" || entry.name === ".cache")) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const realTarget = fs.realpathSync(filePath);
        if (!isContained(nodeModulesRoot, realTarget)) {
          dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_OUTSIDE_CHECKOUT", relative);
        }
        const realTargetRelative = relativePath(nodeModulesRoot, realTarget);
        if (
          realTargetRelative === ".vite"
          || realTargetRelative.startsWith(".vite/")
          || realTargetRelative === ".cache"
          || realTargetRelative.startsWith(".cache/")
        ) {
          dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_UNHASHED_SYMLINK", relative);
        }
        entries.push({ path: relative, type: "symlink", target: fs.readlinkSync(filePath) });
        continue;
      }
      if (entry.isDirectory()) {
        visit(filePath, relative);
        continue;
      }
      if (!entry.isFile()) dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_INVALID", relative);
      const content = fs.readFileSync(filePath);
      entries.push({ path: relative, type: "file", bytes: content.byteLength, sha256: sha256(content) });
    }
  };
  visit(nodeModulesRoot);
  if (!entries.length) dependencyFail("AGENT_QUALIFICATION_NODE_MODULES_MISSING", "empty");
  return {
    entryCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + (entry.bytes || 0), 0),
    treeSha256: sha256(JSON.stringify(entries)),
  };
}

function resolveLockedPackageRoot(nodeModulesRoot, realNodeModules, lockKey) {
  if (
    typeof lockKey !== "string"
    || !lockKey.startsWith("node_modules/")
    || lockKey.includes("\\")
    || lockKey.includes("\0")
  ) {
    dependencyFail("AGENT_QUALIFICATION_PACKAGE_LOCK_PATH_INVALID", String(lockKey));
  }
  const packageRoot = path.resolve(nodeModulesRoot, lockKey.slice("node_modules/".length));
  if (!isContained(path.resolve(nodeModulesRoot), packageRoot)) {
    dependencyFail("AGENT_QUALIFICATION_PACKAGE_LOCK_PATH_INVALID", lockKey);
  }
  let realPackageRoot;
  try {
    realPackageRoot = fs.realpathSync(packageRoot);
  } catch {
    dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_MISSING", lockKey);
  }
  if (!isContained(realNodeModules, realPackageRoot)) {
    dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_OUTSIDE_CHECKOUT", lockKey);
  }
  return packageRoot;
}

function validateLockedInstallation({ lock, manifest, nodeModulesRoot, realNodeModules }) {
  const lockRoot = lock.packages[""];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (JSON.stringify(canonicalDependencyMap(manifest[field])) !== JSON.stringify(canonicalDependencyMap(lockRoot[field]))) {
      dependencyFail("AGENT_QUALIFICATION_PACKAGE_LOCK_MANIFEST_MISMATCH", field);
    }
  }
  const directNames = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ]);
  for (const name of directNames) {
    const lockKey = `node_modules/${name}`;
    if (!lock.packages[lockKey]) {
      dependencyFail("AGENT_QUALIFICATION_PACKAGE_LOCK_ENTRY_INVALID", name);
    }
    resolveLockedPackageRoot(nodeModulesRoot, realNodeModules, lockKey);
  }
  let validatedPackageCount = 0;
  for (const [lockKey, lockPackage] of Object.entries(lock.packages)) {
    if (!lockKey.startsWith("node_modules/") || lockPackage?.link === true) continue;
    const packageName = lockKey.slice("node_modules/".length).split("/node_modules/").at(-1);
    const isDirect = directNames.has(packageName);
    if (lockPackage?.optional === true && !isDirect) continue;
    const packageRoot = resolveLockedPackageRoot(nodeModulesRoot, realNodeModules, lockKey);
    const packageJsonPath = path.join(packageRoot, "package.json");
    assertDirectory(packageRoot, "AGENT_QUALIFICATION_NODE_PACKAGE_MISSING", lockKey);
    assertRegularFile(packageJsonPath, "AGENT_QUALIFICATION_NODE_PACKAGE_INVALID", `${lockKey}/package.json`);
    const installed = readJson(packageJsonPath, "AGENT_QUALIFICATION_NODE_PACKAGE_INVALID");
    if (!isContained(realNodeModules, fs.realpathSync(packageJsonPath))) {
      dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_OUTSIDE_CHECKOUT", `${lockKey}/package.json`);
    }
    if (installed?.version !== lockPackage?.version) {
      dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_VERSION_MISMATCH", lockKey);
    }
    validatedPackageCount += 1;
  }
  return validatedPackageCount;
}

export function inspectCheckoutNodeDependencies(root, packages = QUALIFIED_PACKAGES) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const packageJsonPath = path.join(resolvedRoot, "package.json");
  const packageLockPath = path.join(resolvedRoot, "package-lock.json");
  const nodeModulesRoot = path.join(resolvedRoot, "node_modules");
  assertRegularFile(packageJsonPath, "AGENT_QUALIFICATION_PACKAGE_MANIFEST_INVALID", "package.json");
  assertRegularFile(packageLockPath, "AGENT_QUALIFICATION_PACKAGE_LOCK_INVALID", "package-lock.json");
  assertDirectory(nodeModulesRoot, "AGENT_QUALIFICATION_NODE_MODULES_MISSING", "node_modules");

  const realRoot = fs.realpathSync(resolvedRoot);
  const realNodeModules = fs.realpathSync(nodeModulesRoot);
  if (!isContained(realRoot, realNodeModules)) {
    dependencyFail("AGENT_QUALIFICATION_NODE_MODULES_OUTSIDE_CHECKOUT");
  }

  const manifest = readJson(packageJsonPath, "AGENT_QUALIFICATION_PACKAGE_MANIFEST_INVALID");
  const lockBytes = fs.readFileSync(packageLockPath);
  const lock = readJson(packageLockPath, "AGENT_QUALIFICATION_PACKAGE_LOCK_INVALID");
  if (lock?.lockfileVersion !== 3 || !lock?.packages || typeof lock.packages !== "object") {
    dependencyFail("AGENT_QUALIFICATION_PACKAGE_LOCK_INVALID", "lockfileVersion");
  }
  const lockRoot = lock.packages[""];
  if (!lockRoot || typeof lockRoot !== "object") {
    dependencyFail("AGENT_QUALIFICATION_PACKAGE_LOCK_INVALID", "root");
  }
  const validatedPackageCount = validateLockedInstallation({
    lock,
    manifest,
    nodeModulesRoot,
    realNodeModules,
  });

  const inspectedPackages = packages.map(({ name, entrypoint }) => {
    const manifestRange = manifest.devDependencies?.[name] || manifest.dependencies?.[name];
    const lockedRange = lockRoot.devDependencies?.[name] || lockRoot.dependencies?.[name];
    if (!manifestRange || manifestRange !== lockedRange) {
      dependencyFail("AGENT_QUALIFICATION_PACKAGE_LOCK_MANIFEST_MISMATCH", name);
    }
    const lockKey = `node_modules/${name}`;
    const lockPackage = lock.packages[lockKey];
    if (
      !lockPackage
      || typeof lockPackage.version !== "string"
      || !/^sha512-[A-Za-z0-9+/=]+$/u.test(String(lockPackage.integrity || ""))
    ) {
      dependencyFail("AGENT_QUALIFICATION_PACKAGE_LOCK_ENTRY_INVALID", name);
    }

    const packageRoot = path.join(nodeModulesRoot, ...name.split("/"));
    const installedPackageJsonPath = path.join(packageRoot, "package.json");
    const entrypointPath = path.join(packageRoot, ...entrypoint.split("/"));
    assertDirectory(packageRoot, "AGENT_QUALIFICATION_NODE_PACKAGE_MISSING", name);
    assertRegularFile(installedPackageJsonPath, "AGENT_QUALIFICATION_NODE_PACKAGE_INVALID", `${name}/package.json`);
    assertRegularFile(entrypointPath, "AGENT_QUALIFICATION_NODE_PACKAGE_INVALID", `${name}/${entrypoint}`);
    const realPackageRoot = fs.realpathSync(packageRoot);
    const realPackageJson = fs.realpathSync(installedPackageJsonPath);
    const realEntrypoint = fs.realpathSync(entrypointPath);
    if (
      !isContained(realNodeModules, realPackageRoot)
      || !isContained(realNodeModules, realPackageJson)
      || !isContained(realNodeModules, realEntrypoint)
    ) {
      dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_OUTSIDE_CHECKOUT", name);
    }

    const installedManifest = readJson(
      installedPackageJsonPath,
      "AGENT_QUALIFICATION_NODE_PACKAGE_INVALID",
    );
    if (installedManifest?.version !== lockPackage.version) {
      dependencyFail("AGENT_QUALIFICATION_NODE_PACKAGE_VERSION_MISMATCH", name);
    }
    return {
      name,
      version: installedManifest.version,
      integrity: lockPackage.integrity,
      packageJsonSha256: sha256(fs.readFileSync(installedPackageJsonPath)),
      entrypointSha256: sha256(fs.readFileSync(entrypointPath)),
      packageJsonPath: relativePath(resolvedRoot, installedPackageJsonPath),
      entrypointPath: relativePath(resolvedRoot, entrypointPath),
    };
  });

  return {
    packageLock: {
      path: "package-lock.json",
      lockfileVersion: 3,
      sha256: sha256(lockBytes),
    },
    installedTree: {
      validatedPackageCount,
      ...hashInstalledTree(realNodeModules),
    },
    packages: inspectedPackages,
  };
}

export function resolveCheckoutPackageEntrypoint(root, packageName, relativeEntrypoint) {
  const state = inspectCheckoutNodeDependencies(root, [
    { name: packageName, entrypoint: relativeEntrypoint },
  ]);
  return path.join(path.resolve(root || process.cwd()), ...state.packages[0].entrypointPath.split("/"));
}
