// Git 快照：在工程目录外面养一个影子仓库，管两件事——
// 动文件之前存一次底；要后悔时回到某条回答之前。
// 工程目录里不落 .git，仓库数据放在 ~/.web-agent/workspaces/<工程>/git 下。

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_BUFFER = 32 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

// 体积大、回滚没意义的目录不进快照。这是影子仓库自己的 exclude，
// 不动工程目录里的 .gitignore。
const EXCLUDE = `# web-agent 快照排除
node_modules/
.git/
dist/
build/
.next/
target/
coverage/
*.log
`;

function firstLine(text) {
  return String(text || '').trim().split('\n').map((s) => s.trim()).find(Boolean) || '';
}

function run(args, { gitDir = '', workTree = '', timeout = TIMEOUT_MS } = {}) {
  const full = gitDir ? ['--git-dir', gitDir, '--work-tree', workTree, ...args] : args;
  return new Promise((resolve) => {
    execFile('git', full, {
      cwd: workTree || process.cwd(),
      timeout,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      const out = String(stdout || '');
      const err = String(stderr || '');
      if (error) {
        const message = error.code === 'ENOENT'
          ? '没找到 git 命令（先装 Git，再打开这个开关）'
          : (firstLine(err) || error.message);
        resolve({ ok: false, out, err: message });
        return;
      }
      resolve({ ok: true, out, err: firstLine(err) });
    });
  });
}

/**
 * 建一个绑定到某个工程目录的快照器。
 * 返回的每个方法都返回 { ok, error? }，不抛异常，方便直接回给界面。
 */
export function createGit({ workspace, stateDir }) {
  const workTree = workspace;
  const gitDir = path.join(stateDir, 'git');
  const info = { available: false, version: '', error: '', ready: false };
  let probed = null;
  let booting = null;

  const git = (args, opts = {}) => run(args, { gitDir, workTree, ...opts });

  async function probe() {
    if (probed) return probed;
    const r = await run(['--version']);
    probed = r.ok
      ? { ok: true, version: r.out.trim() }
      : { ok: false, error: firstLine(r.err) };
    info.available = probed.ok;
    info.version = probed.ok ? probed.version : '';
    info.error = probed.ok ? '' : probed.error;
    return probed;
  }

  async function boot() {
    const p = await probe();
    if (!p.ok) return p;
    await fsp.mkdir(gitDir, { recursive: true });
    const head = path.join(gitDir, 'HEAD');
    const hasRepo = await fsp.stat(head).then(() => true, () => false);
    if (!hasRepo) {
      const made = await git(['init', '--quiet']);
      if (!made.ok) return { ok: false, error: firstLine(made.err) };
      await git(['config', 'user.name', 'Web Agent']);
      await git(['config', 'user.email', 'web-agent@localhost']);
      await git(['config', 'commit.gpgsign', 'false']);
      await git(['config', 'core.autocrlf', 'false']);
      await fsp.writeFile(path.join(gitDir, 'info', 'exclude'), EXCLUDE);
    }
    info.ready = true;
    return { ok: true, version: p.version };
  }

  async function ready() {
    if (info.ready) return { ok: true, version: info.version };
    if (!booting) {
      booting = boot()
        .catch((err) => ({ ok: false, error: err.message || String(err) }))
        .finally(() => { booting = null; });
    }
    const r = await booting;
    if (!r.ok) info.error = r.error;
    return r;
  }

  /** 把当前工程目录整棵存一次底，返回提交号。 */
  async function checkpoint(label = 'snapshot') {
    const r = await ready();
    if (!r.ok) return r;
    const add = await git(['add', '-A']);
    if (!add.ok) return { ok: false, error: firstLine(add.err) };
    const commit = await git([
      'commit', '--quiet', '--allow-empty', '--no-verify', '-m', String(label).slice(0, 200),
    ]);
    if (!commit.ok) return { ok: false, error: firstLine(commit.err) };
    const head = await git(['rev-parse', 'HEAD']);
    if (!head.ok) return { ok: false, error: firstLine(head.err) };
    return { ok: true, sha: head.out.trim() };
  }

  /** 把工程目录拨回某个提交：已跟踪文件还原，快照之后新出现的文件删掉。 */
  async function restore(sha) {
    const target = String(sha || '').trim();
    if (!/^[0-9a-f]{7,64}$/i.test(target)) return { ok: false, error: '快照编号不对' };
    const r = await ready();
    if (!r.ok) return r;
    const reset = await git(['reset', '--hard', '--quiet', target]);
    if (!reset.ok) return { ok: false, error: firstLine(reset.err) };
    // -d 只清快照之后新冒出来的文件；不带 -x，被排除的目录（node_modules 等）不动
    const clean = await git(['clean', '-fd', '--quiet']);
    if (!clean.ok) return { ok: false, error: firstLine(clean.err) };
    return { ok: true, sha: target };
  }

  return {
    info,
    probe,
    ready,
    checkpoint,
    restore,
    short: (sha) => String(sha || '').slice(0, 7),
  };
}
