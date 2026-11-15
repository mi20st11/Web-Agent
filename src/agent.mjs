// Agent 主循环：发消息 → 解析工具 → 执行 → 把结果发回去 → 直到没有工具调用。

import { EventEmitter } from 'node:events';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseToolCalls, formatToolResults } from './protocol.mjs';
import { createTools, capOutput, ToolError } from './tools.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { detectEnv } from './env.mjs';
import { PolicyError, createPolicy } from './policy.mjs';
import { createGit } from './git.mjs';
import { rememberWorkspace, workspaceStateDir, absorbLegacyState, saveConfig } from './config.mjs';

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 时间线卡片上只写一句"它要干什么"，不用把整段代码摊开。 */
function briefCall(call) {
  if (call.error) return '参数没看懂';
  if (call.name === 'shell') {
    const line = String(call.body || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
    return line.slice(0, 120);
  }
  const args = call.args || {};
  const value = args.path ?? args.url ?? args.question ?? args.query ?? '';
  return String(value).slice(0, 120);
}

export class Agent extends EventEmitter {
  constructor({
    site, policy = null, workspace = null, outDir = '',
    settings = {}, label = 'Web Agent',
  }) {
    super();
    this.site = site;
    this.policy = null;
    this.workspace = workspace ? path.resolve(workspace) : null;
    this.outDir = outDir;
    this.label = label;
    this.settings = {
      autoApprove: false,
      maxSteps: 30,
      replyTimeoutMs: 480_000,
      gitEnabled: false,
      promptProfile: 'auto',
      ...settings,
    };
    // 系统 / shell / Python 在启动时定下来，提示词和界面都用这一份
    this.env = settings?.env || detectEnv();
    this.timeline = [];
    this.seq = 0;
    this.busy = false;
    this.stopRequested = false;
    this.conversationStarted = false;
    this.error = null;
    this.pending = null;
    this.page = { ok: false, signedOut: false, hasEditor: false, storageBlocked: false, url: '', title: '' };
    this.connection = 'connecting';
    this.connectionDetail = '';
    this.clients = 0;
    this.recent = [];
    this.tools = null;
    this.prompt = '';
    if (this.workspace) this.#buildTooling(this.workspace, policy);
    this.pollTimer = setInterval(() => {
      // 界面没打开、也没有任务在跑时，不做无谓的页面探测
      if (!this.busy && this.clients <= 0) return;
      this.refreshPage().catch(() => {});
    }, 10_000);
    this.pollTimer.unref?.();
  }

  /** 工作区相关的三样东西一起重建：路径策略、工具表、提示词。 */
  #buildTooling(workspace, policy = null) {
    // 运行数据放在 ~/.web-agent/workspaces 下，工程目录保持干净
    const meta = workspaceStateDir(workspace);
    this.stateDir = meta;
    this.outDir = path.join(meta, 'out');
    this.policy = policy || createPolicy({
      workspace,
      logFile: path.join(meta, 'log.jsonl'),
    });
    this.git = createGit({ workspace, stateDir: meta });
    // 开关是上次留下的「开」时，先探一次 git 在哪：界面要显示版本，
    // 免得一直挂着「没找到 git」的标题。探测是异步的，探完再刷新一次。
    if (this.settings.gitEnabled) {
      this.git.probe().then(() => this.emit('change')).catch(() => {});
    }
    this.tools = createTools({
      workspace,
      policy: this.policy,
      askUser: (q) => this.askUser(q),
    });
    this.#buildPrompt();
  }

  /** 提示词里要写清这台机器上 Git 现在是什么状态，开关一变就重拼。 */
  #buildPrompt() {
    if (this.settings.instructions) {
      this.prompt = String(this.settings.instructions).trim();
      return;
    }
    this.prompt = buildSystemPrompt({
      workspace: this.workspace,
      toolsHelp: this.tools ? this.tools.describe() : '',
      git: this.git ? { enabled: Boolean(this.settings.gitEnabled), ...this.git.info } : null,
      env: this.env,
      profile: this.settings.promptProfile,
    });
  }

  id() { return `m${++this.seq}`; }

  push(item) {
    const entry = { id: this.id(), ts: Date.now(), ...item };
    this.timeline.push(entry);
    if (this.timeline.length > 500) this.timeline.splice(0, this.timeline.length - 500);
    this.emit('change');
    return entry;
  }

  snapshot() {
    return {
      status: this.error ? 'error' : this.busy ? 'busy' : 'idle',
      busy: this.busy,
      error: this.error,
      page: this.page,
      siteName: this.site?.name || '网页端',
      settings: this.settings,
      pending: this.pending?.view ?? null,
      workspace: this.workspace,
      needsWorkspace: !this.workspace,
      connection: this.connection,
      connectionDetail: this.connectionDetail,
      recentWorkspaces: this.recent,
      conversationStarted: this.conversationStarted,
      git: {
        enabled: Boolean(this.settings.gitEnabled),
        available: Boolean(this.git?.info.available),
      },
      env: {
        platform: this.env.platform,
        osLabel: this.env.osLabel,
        release: this.env.release,
        shell: this.env.shell,
        node: this.env.node,
        python: this.env.python ? this.env.python.version : '',
        promptProfile: this.settings.promptProfile || 'auto',
      },
      timeline: this.timeline,
    };
  }

  /** 切换工程目录：重建路径策略与工具，下一条消息按新目录开头。 */
  async setWorkspace(dir) {
    if (this.busy) throw new Error('正在跑任务，等它结束再换工作区');
    const abs = path.resolve(String(dir || '').trim());
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`不是文件夹：${abs}`);

    await absorbLegacyState(abs).catch(() => {});
    const meta = workspaceStateDir(abs);
    await fsp.mkdir(path.join(meta, 'out'), { recursive: true });

    // 每个工程可以自带一份措辞；放在工程里（这是用户自己写的文件，程序不创建）
    const custom = await fsp.readFile(path.join(abs, '.web-agent', 'instructions.md'), 'utf8').catch(() => '');
    this.settings.instructions = custom.trim();

    this.workspace = abs;
    this.#buildTooling(abs);
    // 换目录等于换上下文：下一条消息重新带引导语，避免模型还按旧路径干活。
    this.conversationStarted = false;
    this.recent = await rememberWorkspace(abs).catch(() => this.recent);
    this.push({ type: 'notice', text: `工作区换成 ${abs}。下一条消息按新目录来，建议先开新对话。` });
    return abs;
  }

  async refreshPage() {
    try {
      const next = await this.site.check();
      if (JSON.stringify(next) !== JSON.stringify(this.page)) {
        this.page = next;
        this.emit('change');
      }
      if (next.loadError) {
        this.setConnection('error', `页面没打开：${next.loadError}`);
        return next;
      }
      this.setConnection(
        next.storageBlocked ? 'blocked'
          : next.signedOut ? 'signed-out'
            : next.ok ? 'ready' : 'not-ready',
      );
      return next;
    } catch (err) {
      const text = err.message || String(err);
      // 页面正在导航、网络又不通时，求值会超时。别把协议层的原话甩给用户。
      this.setConnection('error', /超时|timeout/i.test(text) ? '页面没响应（网络断了？）' : text);
      throw err;
    }
  }

  setConnection(state, detail = '') {
    if (this.connection === state && this.connectionDetail === detail) return;
    this.connection = state;
    this.connectionDetail = detail;
    this.emit('change');
  }

  /** 界面有没有人在看：没人看就不轮询页面。 */
  setClients(n) {
    this.clients = Math.max(0, Number(n) || 0);
  }

  async setSettings(patch = {}) {
    if (typeof patch.autoApprove === 'boolean') this.settings.autoApprove = patch.autoApprove;
    if (Number.isFinite(patch.maxSteps)) this.settings.maxSteps = Math.min(80, Math.max(1, patch.maxSteps));
    if (typeof patch.gitEnabled === 'boolean' && patch.gitEnabled !== this.settings.gitEnabled) {
      if (patch.gitEnabled && this.git) {
        const probe = await this.git.ready();
        if (!probe.ok) {
          this.push({ type: 'notice', level: 'warn', text: `Git 快照没能启用：${probe.error}` });
          this.emit('change');
          return this.settings;
        }
      }
      this.settings.gitEnabled = patch.gitEnabled;
      this.gitNoticeShown = false;
      await saveConfig({ gitEnabled: patch.gitEnabled }).catch(() => {});
      if (this.workspace) this.#buildPrompt();
    }
    const profile = String(patch.promptProfile || '').toLowerCase();
    if (['auto', 'windows', 'linux'].includes(profile) && profile !== this.settings.promptProfile) {
      this.settings.promptProfile = profile;
      await saveConfig({ promptProfile: profile }).catch(() => {});
      if (this.workspace) this.#buildPrompt();
    }
    this.emit('change');
    return this.settings;
  }

  /** 工具动手之前存一次底；失败只提示一次，别每轮刷屏。 */
  async #checkpoint(label) {
    if (!this.settings.gitEnabled || !this.git) return null;
    const snap = await this.git.checkpoint(label || new Date().toISOString());
    if (!snap.ok) {
      if (!this.gitNoticeShown) {
        this.gitNoticeShown = true;
        this.push({ type: 'notice', level: 'warn', text: `Git 快照没成：${snap.error}` });
      }
      return null;
    }
    return { sha: snap.sha, at: Date.now() };
  }

  /** 发一轮用户消息，跑完整条工具链。HTTP 层不 await 这个。 */
  async send(text) {
    const message = String(text ?? '').trim();
    if (!message) return { ok: false, error: '消息是空的' };
    if (!this.workspace) return { ok: false, error: '先选一个工程文件夹' };
    if (this.busy) return { ok: false, error: '上一条还在处理中' };

    this.busy = true;
    this.error = null;
    this.stopRequested = false;
    this.push({ type: 'user', text: message });
    this.emit('change');

    try {
      await this.refreshPage();
      if (this.page.signedOut) {
        throw new Error(`${this.site?.name || '网页端'} 还没登录。请在 ${this.site?.name || '对话'} 窗口里登录后重发。`);
      }
      let payload = this.conversationStarted
        ? message
        : `${this.prompt}\n\n---\n\n${message}`;

      let steps = 0;
      let sentFirst = false;

      while (steps < this.settings.maxSteps) {
        if (this.stopRequested) break;
        const reply = await this.site.ask(payload, { timeoutMs: this.settings.replyTimeoutMs });
        if (this.stopRequested && !reply.trim()) break;
        this.conversationStarted = true;
        sentFirst = true;
        const calls = parseToolCalls(reply);
        // 先把"这条回答要动手"的样子拼好，存完底再一次性推给界面，
        // 免得卡片先出现、返回按钮再补一块。
        const git = calls.length ? await this.#checkpoint(new Date().toISOString()) : null;
        this.push({
          type: 'assistant',
          text: reply,
          calls: calls.map((call) => ({ name: call.name, arg: briefCall(call) })),
          git: git || null,
        });
        if (!calls.length) break;

        const results = [];
        for (const call of calls) {
          if (this.stopRequested) break;
          results.push(await this.runTool(call));
        }
        if (this.stopRequested) break;
        if (!results.length) break;
        // 快照是自动做的，网页端看不到；每轮结果前带一句，它才知道可以放心改。
        const snapNote = git ? `【Git 快照】动手之前已自动存底 ${git.sha.slice(0, 7)}，工程目录随时能整体退回这一刻。\n\n` : '';
        payload = snapNote + formatToolResults(results);
        steps += 1;
        this.emit('change');
      }

      if (this.stopRequested) {
        this.push({ type: 'notice', level: 'warn', text: '已停止。' });
      } else if (steps >= this.settings.maxSteps) {
        this.push({
          type: 'notice', level: 'warn',
          text: `达到最大步数 ${this.settings.maxSteps}，先停在这里。可以直接说“继续”。`,
        });
      } else if (!sentFirst) {
        throw new Error('没有收到任何回答');
      }
      return { ok: true };
    } catch (err) {
      this.error = err.message || String(err);
      this.push({ type: 'notice', level: 'error', text: this.error });
      return { ok: false, error: this.error };
    } finally {
      this.busy = false;
      if (this.pending) this.#settlePending(false, '');
      this.emit('change');
    }
  }

  async runTool(call) {
    const started = Date.now();
    const item = this.push({
      type: 'tool', name: call.name, status: 'running',
      args: call.args, bodyPreview: call.body.slice(0, 400), ms: 0, ok: true, output: '',
    });

    const finish = (patch) => {
      Object.assign(item, patch, { ms: Date.now() - started, status: patch.ok ? 'done' : 'error' });
      this.emit('change');
    };

    if (call.error) {
      finish({ ok: false, output: call.error });
      await this.policy.log({ type: 'tool', name: call.name, args: call.args, ok: false, error: call.error }).catch(() => {});
      return { name: call.name, ok: false, output: call.error, error: true };
    }

    // 危险命令先问人
    if (call.name === 'shell') {
      const danger = this.policy.isDangerous(call.body);
      if (danger.dangerous) {
        const allow = await this.requestApproval({
          kind: 'command',
          title: `要执行一条危险命令（${danger.reason}）`,
          detail: call.body,
        });
        if (!allow) {
          const msg = '用户拒绝了这条命令。换一个安全的做法，或问用户想怎么做。';
          finish({ ok: false, output: msg });
          await this.policy.log({ type: 'tool', name: call.name, ok: false, denied: true, command: call.body }).catch(() => {});
          return { name: call.name, ok: false, output: msg };
        }
      }
    }

    try {
      const result = await withTimeout(
        this.tools.run(call.name, { args: call.args, body: call.body }),
        10 * 60_000,
        '工具执行超过 10 分钟',
      );

      let output = result.output ?? '';
      let spill = null;
      if (output.length > 8000 && this.outDir) {
        spill = path.join(this.outDir, `${Date.now()}-${call.name}.txt`);
        await fsp.mkdir(this.outDir, { recursive: true });
        await fsp.writeFile(spill, output, 'utf8');
      }
      const toModel = capOutput(output) +
        (spill ? `\n\n（输出太长，完整内容保存在 ${path.relative(this.workspace, spill)}）` : '');

      finish({ ok: result.ok !== false, output: toModel, meta: result.meta ?? null });
      await this.policy.log({
        type: 'tool', name: call.name, args: call.args,
        ok: result.ok !== false, ms: Date.now() - started,
        output: capOutput(output, 2000),
      }).catch(() => {});

      return { name: call.name, ok: result.ok !== false, output: toModel, ms: Date.now() - started };
    } catch (err) {
      const message = err instanceof ToolError || err instanceof PolicyError
        ? err.message
        : `${err.name === 'AbortError' ? '操作超时' : err.message}`;
      finish({ ok: false, output: message });
      await this.policy.log({ type: 'tool', name: call.name, ok: false, ms: Date.now() - started, error: message }).catch(() => {});
      return { name: call.name, ok: false, output: message, ms: Date.now() - started };
    }
  }

  /* ---------------- 审批 / 提问 ---------------- */

  #settlePending(allow, text) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(p.kind === 'question' ? text : allow);
    this.emit('change');
  }

  #waitForUser({ kind, title, detail, timeoutMs }) {
    if (this.pending) this.#settlePending(false, '');
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = null;
          this.push({ type: 'notice', level: 'warn', text: '等待用户回应超时，已跳过。' });
          resolve(kind === 'question' ? '' : false);
        }
      }, timeoutMs);
      this.pending = {
        id, kind, title, detail, timer,
        resolve,
        view: { id, kind, title, detail },
      };
      this.emit('change');
    });
  }

  requestApproval({ title, detail }) {
    if (this.settings.autoApprove) return Promise.resolve(true);
    return this.#waitForUser({ kind: 'approval', title, detail, timeoutMs: 5 * 60_000 });
  }

  askUser(question) {
    return this.#waitForUser({
      kind: 'question', title: 'Agent 想问你', detail: question, timeoutMs: 10 * 60_000,
    });
  }

  respond({ id, allow, text }) {
    const p = this.pending;
    if (!p || p.id !== id) return { ok: false, error: '这个请求已经失效了' };
    this.#settlePending(!!allow, String(text ?? ''));
    return { ok: true };
  }

  /* ---------------- 控制 ---------------- */

  /** 把工程目录拨回某条回答动手之前。界面上就是那条消息下面的"回到这条之前"。 */
  async restore(id) {
    if (this.busy) return { ok: false, error: '正在跑任务，先停下再恢复' };
    if (!this.settings.gitEnabled) return { ok: false, error: '先打开左侧的 Git 快照' };
    if (!this.git) return { ok: false, error: '当前工作区还没有快照' };
    const item = this.timeline.find((t) => t.id === String(id || ''));
    const sha = item?.git?.sha;
    if (!sha) return { ok: false, error: '这条之前没有快照（开 Git 之前的老消息恢复不了）' };
    const result = await this.git.restore(sha);
    if (!result.ok) return { ok: false, error: `恢复没成功：${result.error}` };
    const short = this.git.short(sha);
    this.push({ type: 'notice', level: 'info', text: `工程目录已回到 ${short} 那一刻。` });
    return { ok: true, sha, short };
  }

  stop() {
    if (!this.busy) return false;
    this.stopRequested = true;
    if (this.pending) this.#settlePending(false, '');
    this.site.stop().catch(() => {});
    this.push({ type: 'notice', level: 'warn', text: '正在停止…' });
    return true;
  }

  async newChat() {
    if (this.busy) return { ok: false, error: '先停止当前任务' };
    if (this.pending) this.#settlePending(false, '');
    const ok = await this.site.newChat();
    this.timeline = [];
    this.conversationStarted = false;
    this.error = null;
    this.push({ type: 'notice', level: 'info', text: ok ? '新对话已开始。' : '没找到“新对话”按钮，刷新页面试试。' });
    return { ok };
  }

  dispose() {
    clearInterval(this.pollTimer);
    if (this.pending) this.#settlePending(false, '');
  }
}
