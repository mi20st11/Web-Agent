// 打包成单文件 exe：把 Node 运行时、源码、界面 HTML 塞进一个可执行文件。
// 需要先 npm install（esbuild、postject 是 devDependencies）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const iconFlag = process.argv.indexOf('--icon');
const iconFile = iconFlag > -1 && process.argv[iconFlag + 1] ? path.resolve(process.argv[iconFlag + 1]) : path.join(buildDir, 'icon.ico');
const outFlag = process.argv.indexOf('--out');
const outFile = path.resolve(outFlag > -1 && process.argv[outFlag + 1]
  ? process.argv[outFlag + 1]
  : path.join(buildDir, 'Web Agent.exe'));

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}`);
};

// 1. 把界面塞成一个 ESM 模块，打包时会被一起内联
const assetFile = path.join(root, 'src', 'ui-asset.mjs');
const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');
fs.writeFileSync(assetFile, `// 由 build/build-exe.mjs 生成，不要手改\nexport const UI_HTML = ${JSON.stringify(html)};\n`);

// 2. 源码合成一个 CommonJS 文件（SEA 的主脚本）
const { build } = await import('esbuild');
await build({
  entryPoints: [path.join(root, 'web-agent.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(buildDir, 'bundle.cjs'),
  legalComments: 'none',
  logLevel: 'warning',
});
fs.rmSync(assetFile, { force: true });

// 3. 生成 SEA blob
const blob = path.join(buildDir, 'sea-prep.blob');
const seaConfig = path.join(buildDir, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(buildDir, 'bundle.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
}, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 4. 复制当前 node.exe，把 blob 注进去
fs.copyFileSync(process.execPath, outFile);

// 4. 换图标和版本信息（顺便把 node.exe 的原始图标盖掉）
if (fs.existsSync(iconFile)) {
  const { rcedit } = await import('rcedit');
  await rcedit(outFile, {
    icon: iconFile,
    'version-string': {
      ProductName: 'Web Agent',
      FileDescription: 'Web Agent',
      OriginalFilename: 'Web Agent.exe',
      InternalName: 'web-agent',
      LegalCopyright: 'AGPL-3.0',
    },
    'file-version': '0.2.0.0',
    'product-version': '0.2.0.0',
  });
}

// 5. 注入 SEA blob
run(process.execPath, [
  path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
  outFile,
  'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`\n已生成 ${outFile}（${mb} MB）`);
