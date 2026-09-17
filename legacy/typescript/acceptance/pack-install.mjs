import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { exec } from './live-harness.mjs';

const root = await mkdtemp('/private/tmp/hb-installed-');
const stage = join(root, 'package'), installed = join(root, 'installed');
await mkdir(stage);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const path of ['package.json', ...manifest.files]) {
  await mkdir(dirname(join(stage, path)), { recursive: true });
  await cp(resolve(path), join(stage, path), { recursive: true });
}
// Only owned product documentation enters this artifact; preserve the working README.
await writeFile(join(stage, 'README.md'), (await readFile('docs/operations.md', 'utf8')).replaceAll('](implementation/', '](docs/implementation/'));
// The integrity receipt accompanies the tarball; it cannot contain its own hash.
await rm(join(stage, 'docs/implementation/final-artifact.json'), { force: true });
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
const npm = '/opt/homebrew/Cellar/node/26.5.0/libexec/lib/node_modules/npm/bin/npm-cli.js';
const packed = JSON.parse((await exec(process.execPath, [npm, 'pack', '--ignore-scripts', '--json'], { cwd: stage, env })).stdout)[0];
await exec(process.execPath, [npm, 'install', '--prefix', installed, '--omit=dev', '--cache', '/private/tmp/herdr-broker-issue13/npm-cache', join(stage, packed.filename)], { env, maxBuffer: 1048576 });
const record = { at: new Date().toISOString(), node: process.versions.node, platform: process.platform, arch: process.arch, root, executable: join(installed, 'node_modules/.bin/herdr-broker'), tarball: join(stage, packed.filename), integrity: packed.integrity, files: packed.files.map(file => file.path), package: manifest.name, version: manifest.version };
await writeFile(join(root, 'installation.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
