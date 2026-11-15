// 打包成轻量 exe：只嵌程序本体（约 100 KB），不带 Node 运行时。
// 运行前要求系统已装 Node.js 22+，见 README。
// 用 Windows 自带的 csc.exe 编译 build/launcher.cs。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, 'build');
const stageDir = path.join(buildDir, '.stage');
const zipFile = path.join(buildDir, 'payload.zip');
fs.mkdirSync(buildDir, { recursive: true });

const iconFlag = process.argv.indexOf('--icon');
const iconFile = iconFlag > -1 && process.argv[iconFlag + 1] ? path.resolve(process.argv[iconFlag + 1]) : path.join(buildDir, 'icon.ico');
const outFlag = process.argv.indexOf('--out');
const outFile = path.resolve(outFlag > -1 && process.argv[outFlag + 1]
  ? process.argv[outFlag + 1]
  : path.join(buildDir, 'Web Agent.exe'));

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}`);
};

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
};

// 1. 收集运行时真正用到的文件：入口、src、ui
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
fs.copyFileSync(path.join(root, 'web-agent.mjs'), path.join(stageDir, 'web-agent.mjs'));
copyDir(path.join(root, 'src'), path.join(stageDir, 'src'));
copyDir(path.join(root, 'ui'), path.join(stageDir, 'ui'));
fs.rmSync(path.join(stageDir, 'src', 'ui-asset.mjs'), { force: true });
// 缓存目录版本号取自 build/launcher.cs，换版本时两边一起改。

// 2. 压缩成 payload
fs.rmSync(zipFile, { force: true });
const ps = `Compress-Archive -Path '${path.join(stageDir, '*').replace(/'/g, "''")}' -DestinationPath '${zipFile.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`;
run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);

// 3. 编译启动器
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) throw new Error(`找不到 csc.exe：${csc}`);

const args = [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  `/out:${outFile}`,
  `/resource:${zipFile},payload.zip`,
  '/reference:System.IO.Compression.dll',
  '/reference:System.Windows.Forms.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
];
if (fs.existsSync(iconFile)) args.push(`/win32icon:${iconFile}`);
args.push(path.join(buildDir, 'launcher.cs'));
run(csc, args);

// 4. 收拾中间产物
fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(zipFile, { force: true });

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`\n已生成 ${outFile}（${kb} KB，需要系统已装 Node.js 22+）`);
