#!/usr/bin/env node
// Build self-contained bundles of the CLI for GitHub Releases.
//
// Each bundle is an archive with its own Node runtime, so a machine without Node
// (or with the wrong Node) can run `opper` from a GitHub release asset. This is
// what lets mise's `github:` backend install the CLI the same way it installs
// Ori, hey or basecamp: `mise use -g github:opper-ai/cli`, no npm involved.
//
//   opper-<os>-<arch>.tar.gz
//   └── opper-<os>-<arch>/
//       ├── bin/opper          POSIX launcher: exec lib/node lib/cli/dist/index.js
//       └── lib/
//           ├── node           the official Node binary for that platform
//           └── cli/           package.json, dist/, data/, LICENSE, node_modules (prod only)
// Windows uses a .zip with bin/opper.cmd and lib/node.exe. All bundles include
// lib/NODE-LICENSE from the official Node distribution.
//
// mise strips the single top-level directory and puts bin/ on PATH, and the
// os/arch tokens in the asset name are the ones it autodetects. `SHA256SUMS`
// beside the tarballs lets mise (and people) verify the download.
//
// The production dependency tree has no native modules, so one node_modules is
// copied into every bundle; the only platform-specific file is the Node binary.
//
// Build on Linux or macOS with tar, unzip and zip available.
// Usage (after `npm ci && npm run build`):
//   node scripts/build-bundles.mjs [--out dist-bundles] [--target linux-x64 ...]

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

// Node LTS line the bundles ship. Kept in one place so a bump is one line; the
// tarball checksums come from nodejs.org's SHASUMS256.txt at build time.
const NODE_VERSION = process.env.OPPER_BUNDLE_NODE_VERSION ?? "24.21.0";
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;

const TARGETS = [
  { id: "linux-x64", node: "linux-x64" },
  { id: "linux-arm64", node: "linux-arm64" },
  { id: "darwin-x64", node: "darwin-x64" },
  { id: "darwin-arm64", node: "darwin-arm64" },
  { id: "windows-x64", node: "win-x64", windows: true },
  { id: "windows-arm64", node: "win-arm64", windows: true },
];

const WINDOWS_LAUNCHER = [
  "@echo off",
  "setlocal",
  'if not defined OPPER_DISTRIBUTION set "OPPER_DISTRIBUTION=bundle"',
  '"%~dp0..\\lib\\node.exe" "%~dp0..\\lib\\cli\\dist\\index.js" %*',
  "exit /b %errorlevel%",
  "",
].join("\r\n");

const LAUNCHER = `#!/bin/sh
# Opper CLI launcher for the standalone bundle: runs the bundled Node on the
# bundled CLI. Resolves symlinks first so a link to this file (a mise shim, a
# ~/.local/bin symlink) still finds lib/ next to the real bin/.
self=$0
while [ -L "$self" ]; do
  dir=$(cd "$(dirname "$self")" && pwd)
  self=$(readlink "$self")
  case $self in
    /*) ;;
    *) self=$dir/$self ;;
  esac
done
root=$(cd "$(dirname "$self")/.." && pwd)
OPPER_DISTRIBUTION=\${OPPER_DISTRIBUTION:-bundle}
export OPPER_DISTRIBUTION
exec "$root/lib/node" "$root/lib/cli/dist/index.js" "$@"
`;

export function parseArgs(argv) {
  const options = { out: join(repo, "dist-bundles"), targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--target") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--out") options.out = resolve(value);
      else options.targets.push(value);
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.targets.length === 0) options.targets = TARGETS.map((t) => t.id);
  for (const id of options.targets) {
    if (!TARGETS.some((t) => t.id === id)) {
      throw new Error(`Unknown target ${id}. Known: ${TARGETS.map((t) => t.id).join(", ")}`);
    }
  }
  return options;
}

// Cross-platform staging is only valid for portable production dependencies.
// Fail explicitly if a future dependency needs a per-platform install instead.
export function assertPortableDependencies(lock, modules) {
  for (const [name, metadata] of Object.entries(lock.packages)) {
    if (metadata.dev) continue;
    if (metadata.os || metadata.cpu || metadata.hasInstallScript) {
      throw new Error(`${name}: platform-specific dependency or install script; stage dependencies per target`);
    }
  }
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".node")) throw new Error(`${path}: native addon; stage dependencies per target`);
    }
  }
  visit(modules);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Production node_modules, installed once from the lockfile into a staging
// directory so the developer's own node_modules (with dev dependencies and
// possibly a different platform's optional packages) never ends up in a bundle.
function stageProductionModules(staging) {
  const dir = join(staging, "modules");
  mkdirSync(dir, { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) cpSync(join(repo, file), join(dir, file));
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir });
  // .bin holds symlinks to dependency CLIs; nothing in the bundle runs them.
  rmSync(join(dir, "node_modules", ".bin"), { recursive: true, force: true });
  assertPortableDependencies(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")), join(dir, "node_modules"));
  return join(dir, "node_modules");
}

async function fetchNodeChecksums() {
  const text = (await download(`${NODE_DIST}/SHASUMS256.txt`)).toString("utf8");
  const sums = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (match) sums.set(match[2], match[1]);
  }
  if (sums.size === 0) throw new Error(`No checksums parsed from ${NODE_DIST}/SHASUMS256.txt`);
  return sums;
}

// The official Node tarball for one platform, verified, reduced to its `node`
// binary. Everything else in it (npm, headers, docs) stays out of the bundle:
// agents that need npm or npx find the user's own, as they do today.
async function nodeBinary(target, staging, checksums) {
  const name = `node-v${NODE_VERSION}-${target.node}`;
  const archive = `${name}.${target.windows ? "zip" : "tar.gz"}`;
  const expected = checksums.get(archive);
  if (!expected) throw new Error(`${archive} is not listed in SHASUMS256.txt`);
  const archivePath = join(staging, archive);
  if (!existsSync(archivePath)) writeFileSync(archivePath, await download(`${NODE_DIST}/${archive}`));
  const actual = sha256(archivePath);
  if (actual !== expected) throw new Error(`${archive}: sha256 ${actual} does not match nodejs.org (${expected})`);
  const extracted = join(staging, name);
  rmSync(extracted, { recursive: true, force: true });
  if (target.windows) {
    run("unzip", ["-q", archivePath, `${name}/node.exe`, `${name}/LICENSE`, "-d", staging]);
  } else {
    run("tar", ["-xzf", archivePath, "-C", staging, `${name}/bin/node`, `${name}/LICENSE`]);
  }
  const binary = target.windows ? join(extracted, "node.exe") : join(extracted, "bin", "node");
  if (!existsSync(binary)) throw new Error(`${archive} did not contain the Node binary`);
  return { binary, license: join(extracted, "LICENSE") };
}

function assemble(target, out, modules, node) {
  const name = `opper-${target.id}`;
  const root = join(out, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "lib", "cli"), { recursive: true });

  const launcher = join(root, "bin", target.windows ? "opper.cmd" : "opper");
  writeFileSync(launcher, target.windows ? WINDOWS_LAUNCHER : LAUNCHER);
  chmodSync(launcher, 0o755);

  const runtime = join(root, "lib", target.windows ? "node.exe" : "node");
  cpSync(node.binary, runtime);
  chmodSync(runtime, 0o755);
  cpSync(node.license, join(root, "lib", "NODE-LICENSE"));

  const cli = join(root, "lib", "cli");
  for (const entry of ["package.json", "LICENSE", "README.md"]) cpSync(join(repo, entry), join(cli, entry));
  for (const entry of ["dist", "data"]) cpSync(join(repo, entry), join(cli, entry), { recursive: true });
  cpSync(modules, join(cli, "node_modules"), { recursive: true, verbatimSymlinks: true });

  const tarball = join(out, `${name}.${target.windows ? "zip" : "tar.gz"}`);
  rmSync(tarball, { force: true });
  // COPYFILE_DISABLE keeps macOS from adding ._ metadata files when this runs
  // on a Mac; the release workflow builds on Linux.
  if (target.windows) run("zip", ["-qr", tarball, name], { cwd: out });
  else run("tar", ["-czf", tarball, "-C", out, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  rmSync(root, { recursive: true, force: true });
  return tarball;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(repo, "dist", "index.js"))) {
    throw new Error("dist/index.js is missing. Run `npm run build` first.");
  }
  mkdirSync(options.out, { recursive: true });

  const staging = mkdtempSync(join(tmpdir(), "opper-bundles-"));
  try {
    console.log(`Bundling @opperai/cli ${pkg.version} with Node v${NODE_VERSION}`);
    const modules = stageProductionModules(staging);
    const checksums = await fetchNodeChecksums();

    for (const id of options.targets) {
      const target = TARGETS.find((t) => t.id === id);
      const node = await nodeBinary(target, staging, checksums);
      const tarball = assemble(target, options.out, modules, node);
      const megabytes = (statSync(tarball).size / 1024 / 1024).toFixed(1);
      console.log(`  ${tarball} (${megabytes} MB)`);
    }

    // One checksum file for every archive present in the output directory, in
    // the `sha256sum -c` format, so a partial rebuild (--target) refreshes the
    // file rather than dropping the other platforms' lines.
    const lines = readdirSync(options.out)
      .filter((file) => /^opper-.+\.(tar\.gz|zip)$/.test(file))
      .sort()
      .map((file) => `${sha256(join(options.out, file))}  ${file}`);
    writeFileSync(join(options.out, "SHA256SUMS"), lines.join("\n") + "\n");
    console.log(`  ${join(options.out, "SHA256SUMS")}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
