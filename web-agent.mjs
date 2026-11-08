#!/usr/bin/env node
// Web Agent 入口：先把界面开起来，再在后台连浏览器和 DeepSeek。
// 工程目录可以在界面里选，选完会记住，下次直接进来。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEEPSEEK_URL, attachPage, browserName, browserWsPath, closeBrowser, createTarget, defaultProfileDir, findBrowser,
  focusAppWindow, focusTarget, launchBrowser, listPages, openAppWindow,
} from './src/browser.mjs';
import { DeepSeekSite } from './src/site.mjs';
import { Agent } from './src/agent.mjs';
import { startServer } from './src/server.mjs';
import { absorbLegacyState, clearInstance, loadConfig, readInstance, saveConfig, writeInstance } from './src/config.mjs';
import { openLog, teeConsole } from './src/log.mjs';

const VERSION = '0.2.0';

function parseArgs(argv) {
  const opts = {
    workspace: '',
    workspaceGiven: false,
    port: 0,
    browser: '',
    profile: '',
    window: true,
    keepBrowser: false,
    noRecover: false,
    force: false,
    auto: false,
    headless: false,
    cdp: 0,
    url: DEEPSEEK_URL,
    match: '',
    maxSteps: 30,
  };
  const argvList = [...argv];
  const take = (i) => {
    const v = argvList[i];
    if (v == null || v.startsWith('--')) throw new Error(`参数缺少值：${argvList[i - 1]}`);
    return v;
  };
  for (let i = 0; i < argvList.length; i += 1) {
    let a = argvList[i];
    let inline = null;
    if (a.startsWith('--') && a.includes('=')) {
      const idx = a.indexOf('=');
      inline = a.slice(idx + 1);
      a = a.slice(0, idx);
    }
    const value = () => (inline != null ? inline : take(++i));
    switch (a) {
      case '--workspace': case '-w': opts.workspace = value(); opts.workspaceGiven = true; break;
      case '--port': opts.port = Number(value()); break;
      case '--browser': opts.browser = value(); break;
      case '--profile': opts.profile = value(); break;
      case '--no-window': opts.window = false; break;
      case '--no-pick': opts.pick = false; break; // 兼容旧参数，现在不再弹启动框
      case '--keep-browser': opts.keepBrowser = true; break;
      case '--no-recover': opts.noRecover = true; break;
      case '--force': opts.force = true; break;
      case '--auto': opts.auto = true; break;
      case '--headless': opts.headless = true; opts.window = false; break;
      case '--cdp': opts.cdp = Number(value()); break;
      case '--url': opts.url = value(); break;
      case '--match': opts.match = value(); break;
      case '--max-steps': opts.maxSteps = Number(value()); break;
      case '--help': case '-h': opts.help = true; break;
      case '--version': opts.version = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`不认识的参数：${a}`);
        opts.workspace = a;
        opts.workspaceGiven = true;
    }
  }
  return opts;
}

function help() {
  console.log(`Web Agent ${VERSION} — 用网页版 DeepSeek 当本机编程助手

用法：
  node web-agent.mjs [选项]

选项：
  -w, --workspace <dir>   直接指定工程目录（不给就在界面里选，会记住上次的）
      --port <n>          本地界面端口（默认随机）
      --browser <名字>    默认用 edge 还是 chrome（进界面后也能换），也可以给可执行文件路径
      --profile <dir>     浏览器 profile 目录（默认按浏览器分开存）
      --auto              自动批准危险命令（默认关闭）
      --no-window         不自动打开应用窗口
      --keep-browser      退出时保留浏览器
      --no-recover        浏览器关掉后不自动重开
      --force             忽略单实例检查，再开一个独立实例
      --headless          无头浏览器，仅调试用
      --cdp <port>        接入已有的调试端口，不自己启动浏览器
      --url <url>         覆盖 DeepSeek 地址（测试用）
      --match <substr>    用 URL 片段找页面（测试用）
  -h, --help              显示帮助

首次运行：先在界面里选一个工程目录，再到打开的 DeepSeek 窗口里登录一次。
登录态存在独立 profile 里，之后启动直接可用。`);
}

async function main() {
  const log = openLog();
  teeConsole(log);
  console.log(`argv ${process.argv.slice(2).join(' ') || '（无参数）'}`);

  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return; }
  if (opts.version) { console.log(VERSION); return; }

  // 工作区优先级：命令行 > 上次用过的 > 先空着（界面里选）
  let workspace = null;
  if (opts.workspaceGiven) {
    const abs = path.resolve(opts.workspace);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isDirectory()) throw new Error(`工作区不是目录：${abs}`);
    workspace = abs;
  } else {
    const cfg = await loadConfig();
    const last = cfg.lastWorkspace;
    const st = last ? fs.statSync(last, { throwIfNoEntry: false }) : null;
    if (st?.isDirectory()) workspace = last;
  }

  // 旧版本在工程里留下的 .web-agent（只含运行数据）搬走后清掉
  if (workspace) await absorbLegacyState(workspace).catch(() => {});
  const instructionsFile = workspace ? path.join(workspace, '.web-agent', 'instructions.md') : '';
  const instructions = instructionsFile && fs.existsSync(instructionsFile)
    ? fs.readFileSync(instructionsFile, 'utf8').trim()
    : '';

  // 浏览器先定位好，界面可以先开，连接在后台慢慢来。
  // 用户可以在界面里换浏览器；换的时候会关掉当前窗口，用新 profile 重连。
  const stored = await loadConfig();
  const info = {
    name: '',
    exe: '',
    profileDir: '',
    canSwitch: !opts.cdp && !opts.profile,
    switching: false,
  };
  if (!opts.cdp) {
    try {
      info.exe = findBrowser(opts.browser || stored.browser || 'edge');
    } catch (err) {
      // 上次选的浏览器被卸载了：退回 Edge，别在启动时卡死
      if (opts.browser || !stored.browser) throw err;
      info.exe = findBrowser('edge');
    }
    info.name = browserName(info.exe);
    info.profileDir = opts.profile
      ? path.resolve(opts.profile)
      : defaultProfileDir(info.name);
  }

  // 连接完成前先用一个占位站点，界面照样能打开、选目录
  const placeholder = {
    async check() {
      return { ok: false, signedOut: false, hasEditor: false, storageBlocked: false, url: '', title: '' };
    },
    async ask() { throw new Error('还没连上 DeepSeek'); },
    async stop() {},
    async newChat() { return false; },
    async focus() { return false; },
  };

  if (opts.browser && info.name) await saveConfig({ browser: info.name }).catch(() => {});

  const agent = new Agent({
    site: placeholder,
    workspace,
    settings: { autoApprove: opts.auto, maxSteps: opts.maxSteps, instructions },
  });
  const savedConfig = stored;
  // 只列还存在的目录：删掉的工程不该留在“最近用过”里点出错
  agent.recent = (Array.isArray(savedConfig.recent) ? savedConfig.recent : [])
    .filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory());

  // 打包成单 exe 后没有模块路径，界面 HTML 已经内联，uiDir 只作兜底。
  let here = process.cwd();
  try { here = path.dirname(fileURLToPath(import.meta.url)); } catch { /* 单 exe 环境 */ }
  const uiDir = path.join(here, 'ui');
  const runtime = { launched: null, port: 0, wsPath: '', match: '' };

  const browserState = () => ({
    name: info.name,
    profileDir: info.profileDir,
    canSwitch: info.canSwitch,
    switching: info.switching,
  });

  // 同一时间只跑一个：第二次启动把已有界面调出来，避免两个实例抢同一个浏览器 profile
  if (!opts.force) {
    const prev = await readInstance().catch(() => null);
    if (prev?.pid && prev.url && prev.version === VERSION) {
      const alive = await fetch(`${prev.url}api/health`, { signal: AbortSignal.timeout(1500) })
        .then((r) => r.ok).catch(() => false);
      if (alive) {
        const prevName = prev.browser || info.name;
        const prevExe = opts.cdp ? '' : (() => { try { return findBrowser(prevName); } catch { return ''; } })();
        const prevDir = prev.profileDir || (prevExe ? defaultProfileDir(browserName(prevExe)) : '');
        if (opts.window && !opts.headless && prevExe && prevDir) {
          openAppWindow({ exe: prevExe, profileDir: prevDir, url: prev.url });
        }
        console.log(`\n  Web Agent 已经在跑：${prev.url}`);
        console.log('  已经把这个界面调出来了。要再开一个独立实例，加 --force。\n');
        return;
      }
    }
  }

  let uiHtml = null;
  try {
    ({ UI_HTML: uiHtml } = await import('./src/ui-asset.mjs'));
  } catch {
    // 源码运行时没有这个文件，照常从 ui/index.html 读
  }

  const server = await startServer({
    agent,
    uiDir,
    uiHtml,
    port: opts.port,
    browser: {
      get: browserState,
      set: (name) => switchBrowser(name),
    },
    version: VERSION,
    onFocus: () => focusTarget({
      port: runtime.port,
      wsPath: runtime.wsPath,
      urlIncludes: runtime.match,
    }),
  });

  console.log(`\n  Web Agent ${VERSION}`);
  console.log(`  工作区  ${agent.workspace || '（还没选，进界面里选）'}`);
  console.log(`  界面    ${server.url}`);
  console.log(`  浏览器  ${opts.cdp ? `接入已有端口 ${opts.cdp}` : info.name}${info.profileDir ? ` · ${info.profileDir}` : ''}`);
  console.log(`  日志    ${log.file}`);
  console.log('  退出    Ctrl+C\n');

  await writeInstance({
    port: server.port,
    url: server.url,
    browser: info.name,
    profileDir: info.profileDir,
    version: VERSION,
  }).catch(() => {});

  if (opts.window && !opts.headless && !info.profileDir) {
    console.log('  提示    接入的是已有浏览器，请手动打开上面的界面地址');
  }

  let closing = false;
  let recovering = false;
  let uiWindowShown = false;
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

  // 浏览器进程没了（用户关窗口、浏览器崩溃）时，自己把连接拉回来。
  const recover = async (reason) => {
    if (closing || recovering || opts.noRecover) return;
    recovering = true;
    try {
      const match = runtime.match || 'chat.deepseek.com';
      // Chrome 启动器会先退出、真正的浏览器进程稍后才接手端口。
      // 多等几秒再判断，避免把“进程交接”误当成崩溃、重复开窗口。
      let hasPage = false;
      for (let i = 0; i < 10 && !hasPage; i++) {
        const pages = await listPages(runtime.port).catch(() => null);
        hasPage = !!pages?.some((p) => (p.url || '').includes(match));
        if (!hasPage) await sleep(500);
      }
      if (hasPage) return;
      console.warn(`  浏览器不可用（${reason}），正在恢复…`);
      agent.push({ type: 'notice', text: '浏览器窗口关掉了，正在重新打开…' });
      agent.setConnection('connecting', '正在重新打开浏览器');
      for (let i = 0; i < 3 && !closing; i++) {
        await sleep(1200 * (i + 1));
        while (agent.busy && !closing) await sleep(2000); // 别在任务中途换页面
        try {
          uiWindowShown = false;
          await connect();
          return;
        } catch (err) {
          console.warn(`  恢复失败：${err.message}`);
        }
      }
      agent.setConnection('error', '浏览器反复退出，请重启程序');
    } finally {
      recovering = false;
    }
  };

  const watch = (launch) => {
    const proc = launch?.proc;
    if (!proc) return;
    proc.once('exit', () => {
      if (closing || runtime.launched?.proc !== proc) return;
      setTimeout(() => recover('浏览器进程退出'), 1200);
    });
  };

  const connect = async () => {
    agent.setConnection('connecting');
    let port;
    let wsPath;
    if (opts.cdp) {
      port = opts.cdp;
      wsPath = await browserWsPath(port);
      if (!wsPath) throw new Error(`端口 ${port} 上没有可用的 DevTools 接口`);
    } else {
      const launch = await launchBrowser({
        exe: info.exe,
        profileDir: info.profileDir,
        url: opts.url,
        headless: opts.headless,
      });
      runtime.launched = launch;
      watch(launch);
      port = launch.port;
      wsPath = launch.wsPath;
    }
    runtime.port = port;
    runtime.wsPath = wsPath;
    runtime.match = opts.match || (opts.url.includes('deepseek.com') ? 'chat.deepseek.com' : '');

    // 浏览器实例起来之后再开应用窗口：同一 profile 下会复用这个实例，
    // 不会出现“后开的窗口没有调试端口”的问题。
    if (opts.window && !opts.headless && info.profileDir && !uiWindowShown) {
      openAppWindow({ exe: info.exe, profileDir: info.profileDir, url: server.url });
      uiWindowShown = true;
    }

    let cdp = await attachPage(port, { urlIncludes: runtime.match, timeoutMs: 8000 });
    if (!cdp && !opts.cdp) {
      await createTarget({ port, wsPath, url: opts.url }).catch(() => {});
      cdp = await attachPage(port, { urlIncludes: runtime.match, timeoutMs: 15_000 });
    }
    if (!cdp) throw new Error('没找到 DeepSeek 页面，可以在浏览器里手动打开 https://chat.deepseek.com/ 再试');

    agent.site = new DeepSeekSite(cdp, { url: opts.url });
    const page = await agent.site.waitReady({ timeoutMs: 20_000 }).catch(() => null);
    await agent.refreshPage().catch(() => {});

    if (opts.window && !opts.headless) {
      await focusAppWindow({ port, url: server.url }).catch(() => {});
    }

    if (page?.storageBlocked) {
      console.log('  注意    浏览器禁用了网站数据，DeepSeek 可能加载不出来（检查 Cookie 设置）');
    } else if (page?.signedOut) {
      console.log('  登录    未登录 —— 请在打开的 DeepSeek 窗口里登录');
    } else if (page?.ok) {
      console.log('  登录    已连接');
    }
  };

  /** 运行时换浏览器：关掉当前窗口，用新 profile 重新连。 */
  const switchBrowser = async (raw) => {
    const name = String(raw || '').toLowerCase();
    if (!['edge', 'chrome'].includes(name)) throw new Error('只支持 edge 或 chrome');
    if (!info.canSwitch) throw new Error('启动时用 --profile 或 --cdp 指定了连接方式，运行时不能换浏览器');
    if (agent.busy) throw new Error('任务还在跑，跑完再换');
    if (info.switching) throw new Error('正在切换，稍等一下');
    if (name === info.name && runtime.launched) return browserState();

    info.switching = true;
    agent.emit('change');
    agent.setConnection('connecting', `正在切换到 ${name === 'chrome' ? 'Chrome' : 'Edge'}`);
    const old = runtime.launched;
    const before = {
      exe: info.exe, name: info.name, profileDir: info.profileDir,
      port: runtime.port, wsPath: runtime.wsPath, match: runtime.match,
    };
    runtime.launched = null; // 先摘掉，避免旧进程退出触发自动恢复
    uiWindowShown = false;
    try {
      info.exe = findBrowser(name);
      info.name = browserName(info.exe);
      info.profileDir = defaultProfileDir(info.name);
      await saveConfig({ browser: info.name });
      // 先把新浏览器接上、新窗口打开，再关旧的：中间不会出现“一个窗口都没有”的空档
      await connect();
      // 换过去以后旧窗口就没用了；即使不是本进程启动的（上次崩溃留下的）也一起关掉
      if (old && !opts.keepBrowser) {
        await closeBrowser({ port: old.port, wsPath: old.wsPath, proc: old.proc }).catch(() => {});
      }
      await writeInstance({
        port: server.port,
        url: server.url,
        browser: info.name,
        profileDir: info.profileDir,
        version: VERSION,
      }).catch(() => {});
      info.switching = false;
      if (agent.page?.signedOut) {
        agent.push({
          type: 'notice',
          text: `${name === 'chrome' ? 'Chrome' : 'Edge'} 还没登录 DeepSeek：在弹出的窗口里登录一次，之后会记住。`,
        });
      }
      return browserState();
    } catch (err) {
      // 新浏览器没接上：回到原来那个（进程还活着），别把用户丢在空窗口上
      info.exe = before.exe;
      info.name = before.name;
      info.profileDir = before.profileDir;
      runtime.launched = old;
      runtime.port = before.port;
      runtime.wsPath = before.wsPath;
      runtime.match = before.match;
      agent.setConnection('error', `切换到 ${name} 失败：${err.message}`);
      agent.push({ type: 'notice', text: `切换到 ${name} 失败：${err.message}` });
      throw err;
    } finally {
      info.switching = false;
      agent.emit('change'); // 新窗口可能在切换中途就打开了，补一次推送把下拉解锁
    }
  };

  connect().catch((err) => {
    agent.setConnection('error', err.message || String(err));
    console.error(`\n  连接失败：${err.message}\n`);
  });

  const shutdown = async (code = 0, why = '') => {
    if (closing) return;
    closing = true;
    await clearInstance().catch(() => {});
    log.write(`退出 code=${code}${why ? ` ${why}` : ''}`);
    console.log(`\n  正在退出…${why ? `（${why}）` : ''}`);
    agent.dispose();
    await server.close().catch(() => {});
    if (runtime.launched?.spawned && !opts.keepBrowser) {
      await closeBrowser({
        port: runtime.launched.port,
        wsPath: runtime.launched.wsPath,
        proc: runtime.launched.proc,
      });
    }
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0, 'Ctrl+C'));
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('SIGHUP', () => shutdown(0, 'SIGHUP'));
  process.on('exit', (code) => log.write(`进程结束 code=${code}`));
  // 单条链路出错不该带走整个程序：记下来、在界面提示，然后继续服务。
  process.on('unhandledRejection', (err) => {
    console.error('未处理的异步错误', err);
    agent.push({ type: 'notice', text: `内部错误：${err?.message || err}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('未捕获的异常', err);
    agent.push({ type: 'notice', text: `内部错误：${err?.message || err}` });
  });
}

main().catch((err) => {
  console.error(`\n  启动失败：${err.message}\n`);
  if (process.env.WEB_AGENT_DEBUG) console.error(err);
  process.exit(1);
});
