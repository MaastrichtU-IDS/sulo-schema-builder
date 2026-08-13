/**
 * Builds a standalone desktop binary of the API: built frontend + resources
 * (incl. the ROBOT jar) bundled in as pkg assets, no separate Docker/nginx.
 *
 * Usage:
 *   node scripts/package-desktop.mjs [pkg-target]   # default: current platform
 *
 * `pkg-target` is one of the entries in package.json's `pkg.targets`
 * (e.g. node22-macos-arm64). Runs from the api/ directory.
 *
 * better-sqlite3 is a native addon: the copy in node_modules/ has to be
 * compiled against the *packaged* Node's ABI (pkg embeds its own Node
 * runtime, independent of whatever Node built/runs this script), which is
 * almost always a different ABI than the one used for local dev/tests. This
 * script rebuilds it for the target ABI before packaging, then always
 * rebuilds it back for the ambient Node afterwards — including on failure —
 * so a packaging run never leaves the local dev/test environment broken.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..');
const repoRoot = resolve(apiRoot, '..');
const frontendRoot = resolve(repoRoot, 'frontend');

const ROBOT_VERSION = '1.9.7';
const ROBOT_JAR_PATH = resolve(apiRoot, 'resources', 'robot.jar');

// Full Node version pkg-fetch currently resolves each major to, for
// node-gyp's --target (which needs an exact semver, not just "22"). Update
// this if a `pkg` run reports fetching a different patch version.
const NODE_FULL_VERSION = { node22: '22.23.2' };
const PKG_PLATFORM_TO_NODE = { macos: 'darwin', linux: 'linux', win: 'win32' };

const CURRENT_TARGET = {
  darwin: { arm64: 'node22-macos-arm64', x64: 'node22-macos-x64' },
  linux: { x64: 'node22-linux-x64' },
  win32: { x64: 'node22-win-x64' },
}[process.platform]?.[process.arch];

const target = process.argv[2] ?? CURRENT_TARGET;
if (!target) {
  console.error(`No default pkg target for ${process.platform}/${process.arch} — pass one explicitly.`);
  process.exit(1);
}

const [, nodeMajor, pkgPlatform, arch] = target.match(/^(node\d+)-([a-z]+)-(\w+)$/) ?? [];
if (!nodeMajor || !NODE_FULL_VERSION[nodeMajor]) {
  console.error(`Don't know the full Node version for "${nodeMajor}" — add it to NODE_FULL_VERSION.`);
  process.exit(1);
}
const nodeFullVersion = NODE_FULL_VERSION[nodeMajor];
const nodePlatform = PKG_PLATFORM_TO_NODE[pkgPlatform] ?? pkgPlatform;

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function rebuildBetterSqlite3(nodeTarget) {
  rmSync(resolve(apiRoot, 'node_modules', 'better-sqlite3', 'build'), { recursive: true, force: true });
  rmSync(resolve(apiRoot, 'node_modules', 'better-sqlite3', 'prebuilds'), { recursive: true, force: true });
  const args = ['rebuild', 'better-sqlite3'];
  if (nodeTarget) {
    args.push(
      `--target=${nodeTarget}`, `--target_arch=${arch}`, `--target_platform=${nodePlatform}`,
      '--runtime=node', '--update-binary',
    );
  }
  run('npm', args, apiRoot);
}

console.log('--- building frontend ---');
run('npm', ['run', 'build'], frontendRoot);
rmSync(resolve(apiRoot, 'public'), { recursive: true, force: true });
cpSync(resolve(frontendRoot, 'dist'), resolve(apiRoot, 'public'), { recursive: true });

console.log('--- fetching ROBOT jar (if missing) ---');
mkdirSync(dirname(ROBOT_JAR_PATH), { recursive: true });
if (!existsSync(ROBOT_JAR_PATH)) {
  run('curl', [
    '-fL', '-o', ROBOT_JAR_PATH,
    `https://github.com/ontodev/robot/releases/download/v${ROBOT_VERSION}/robot.jar`,
  ], apiRoot);
} else {
  console.log(`already present: ${ROBOT_JAR_PATH}`);
}

console.log('--- building api ---');
run('npm', ['run', 'build'], apiRoot);

try {
  console.log(`--- rebuilding better-sqlite3 for ${nodeFullVersion} (${nodePlatform}/${arch}) ---`);
  rebuildBetterSqlite3(nodeFullVersion);

  console.log(`--- packaging (${target}) ---`);
  run('npx', ['pkg', 'dist/index.js', '-t', target, '--config', 'package.json', '--out-path', 'pkg-dist'], apiRoot);

  console.log(`Done: api/pkg-dist/`);
} finally {
  console.log('--- restoring better-sqlite3 for local dev/test ---');
  rebuildBetterSqlite3(null);
}
