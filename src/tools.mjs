// 工具层。协议：代码块第一行是工具名，可跟一行 JSON 参数，其余是 body。
// 每个工具只做一件事，返回给人看的纯文本。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runShell } from './exec.mjs';

export const TOOL_NAMES = ['shell', 'read', 'write', 'edit', 'list', 'fetch', 'ask'];

export const TOOL_HELP = {
  shell: 'shell {"timeout":120}\n<要执行的命令>',
  read: 'read {"path":"src/a.js","offset":1,"limit":200}',
  write: 'write {"path":"src/a.js"}\n<完整文件内容>',
  edit: 'edit {"path":"src/a.js"}\n<<<<<<< SEARCH\n原文\n=======\n新文\n>>>>>>> REPLACE',
  list: 'list {"path":".","depth":2}',
  fetch: 'fetch {"url":"https://example.com"}',
  ask: 'ask\n<要问用户的问题>',
};

const SKIP_DIRS = new Set(['.git', 'node_modules', '.web-agent', 'dist', 'build', '.next', 'target']);

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

export function capOutput(text, limit = 8000) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  const head = s.slice(0, limit - 1500);
  const tail = s.slice(-1200);
  return `${head}\n\n…（中间省略 ${s.length - head.length - tail.length} 字符）…\n\n${tail}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseEditBlocks(body) {
  const blocks = [];
  const re = /<{7} SEARCH\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7} REPLACE/g;
  let m;
  while ((m = re.exec(body))) blocks.push({ search: m[1], replace: m[2] });
  return blocks;
}

export function applyEdits(original, blocks) {
  let text = original;
  const applied = [];
  for (const { search, replace } of blocks) {
    if (!search) throw new ToolError('edit 的 SEARCH 段不能为空');
    let hay = text;
    let needle = search;
    if (!hay.includes(needle)) {
      // 模型看到的换行可能被规范化过，两种行尾都试一次
      const alt = hay.includes('\r\n')
        ? search.replace(/\r?\n/g, '\r\n')
        : search.replace(/\r\n/g, '\n');
      if (!hay.includes(alt)) {
        throw new ToolError(`找不到要替换的原文（逐字匹配失败）：\n${search.slice(0, 160)}`);
      }
      needle = alt;
    }
    const first = text.indexOf(needle);
    if (text.indexOf(needle, first + 1) !== -1) {
      throw new ToolError('SEARCH 段在文件里出现了不止一次，请多带几行上下文让它唯一。');
    }
    text = text.slice(0, first) + replace + text.slice(first + needle.length);
    applied.push(search.split('\n')[0].slice(0, 60));
  }
  return { text, applied };
}

/**
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {ReturnType<import('./policy.mjs').createPolicy>} opts.policy
 * @param {(q:string)=>Promise<string>} [opts.askUser]
 * @param {import('./site.mjs').DeepSeekSite} [opts.site]
 */
export function createTools({ workspace, policy, askUser, site }) {
  const tools = {
    async shell({ args, body }) {
      const command = (body ?? '').trim();
      if (!command) throw new ToolError('shell 的 body 是空命令');
      const timeoutSec = Number(args.timeout) > 0 ? Number(args.timeout) : 120;
      const r = await runShell(command, {
        cwd: workspace,
        timeoutMs: Math.min(timeoutSec, 600) * 1000,
      });
      const parts = [];
      if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
      if (r.timedOut) parts.push(`[超时] 命令超过 ${timeoutSec} 秒，已终止`);
      if (r.code !== 0 && r.code != null) parts.push(`[退出码 ${r.code}]`);
      return {
        output: parts.join('\n\n') || '(命令没有输出)',
        meta: { exitCode: r.code, ms: r.ms },
        ok: r.code === 0 && !r.timedOut,
      };
    },

    async read({ args }) {
      const abs = policy.resolveInside(args.path);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) throw new ToolError(`文件不存在：${args.path}`);
      if (!st.isFile()) throw new ToolError(`不是文件：${args.path}`);
      if (st.size > 2 * 1024 * 1024) throw new ToolError(`文件太大（${fmtBytes(st.size)}），用 shell 分段读`);
      const raw = await fsp.readFile(abs, 'utf8');
      if (raw.includes('\u0000')) throw new ToolError('看起来是二进制文件');
      const lines = raw.split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const rel = policy.relative(abs);
      const head = `--- ${rel}（第 ${offset}-${Math.min(lines.length, offset - 1 + slice.length)} 行，共 ${lines.length} 行）---`;
      const tail = offset - 1 + slice.length < lines.length
        ? `\n…（还有 ${lines.length - offset + 1 - slice.length} 行，用 offset=${offset + slice.length} 继续）`
        : '';
      return { output: `${head}\n${slice.join('\n')}${tail}`, meta: { bytes: st.size, lines: lines.length } };
    },

    async write({ args, body }) {
      const abs = policy.resolveInside(args.path);
      const st = await fsp.stat(abs).catch(() => null);
      if (st?.isDirectory()) throw new ToolError('目标是目录，不能 write');
      const backup = await policy.backup(abs);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const content = body ?? '';
      await fsp.writeFile(abs, content, 'utf8');
      const rel = policy.relative(abs);
      return {
        output: `已写入 ${rel}（${fmtBytes(Buffer.byteLength(content))}）` +
          (backup ? `\n旧版本备份：${path.relative(workspace, backup)}` : ''),
        meta: { bytes: Buffer.byteLength(content), backup },
      };
    },

    async edit({ args, body }) {
      const abs = policy.resolveInside(args.path);
      const original = await fsp.readFile(abs, 'utf8').catch(() => null);
      if (original == null) throw new ToolError(`文件不存在：${args.path}`);
      const blocks = parseEditBlocks(body ?? '');
      if (!blocks.length) {
        throw new ToolError('edit 里没有找到 <<<<<<< SEARCH / ======= / >>>>>>> REPLACE 段落');
      }
      const { text, applied } = applyEdits(original, blocks);
      if (text === original) throw new ToolError('替换前后内容一样，什么都没改');
      const backup = await policy.backup(abs);
      await fsp.writeFile(abs, text, 'utf8');
      return {
        output: `已修改 ${policy.relative(abs)}（${applied.length} 处）` +
          (backup ? `\n旧版本备份：${path.relative(workspace, backup)}` : ''),
        meta: { edits: applied.length, backup },
      };
    },

    async list({ args }) {
      const abs = policy.resolveInside(args.path ?? '.', { allowRoot: true });
      const depth = Math.min(5, Math.max(1, Number(args.depth) || 2));
      const out = [];
      let total = 0;
      async function walk(dir, level) {
        if (total >= 400) return;
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (total >= 400) return;
          if (SKIP_DIRS.has(e.name)) continue;
          const full = path.join(dir, e.name);
          const rel = path.relative(workspace, full).split(path.sep).join('/');
          if (e.isDirectory()) {
            out.push(`${rel}/`);
            total += 1;
            if (level < depth) await walk(full, level + 1);
          } else {
            const st = await fsp.stat(full).catch(() => null);
            out.push(`${rel}  ${st ? fmtBytes(st.size) : ''}`);
            total += 1;
          }
        }
      }
      if (!(await fsp.stat(abs)).isDirectory()) throw new ToolError('list 的目标不是目录');
      await walk(abs, 0);
      return {
        output: out.join('\n') || '(空目录)',
        meta: { entries: out.length, truncated: total >= 400 },
      };
    },

    async fetch({ args }) {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new ToolError('只支持 http(s) URL');
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; WebAgent/0.1)' },
      });
      const raw = await res.text();
      const type = res.headers.get('content-type') || '';
      let text;
      if (/json/i.test(type)) {
        try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { text = raw; }
      } else if (/html/i.test(type) || /^\s*</.test(raw)) {
        text = htmlToText(raw);
      } else {
        text = raw;
      }
      return {
        output: `HTTP ${res.status} ${res.statusText}\n${text.slice(0, 30_000)}`,
        meta: { status: res.status, bytes: raw.length, contentType: type },
        ok: res.ok,
      };
    },

    async ask({ args, body }) {
      const question = String(args.question || body || '').trim();
      if (!question) throw new ToolError('ask 缺少问题内容');
      if (!askUser) throw new ToolError('当前没有可用的用户界面，无法提问');
      const answer = await askUser(question);
      return { output: answer ? `用户回答：${answer}` : '用户没有回答（跳过）' };
    },
  };

  return {
    names: TOOL_NAMES,
    async run(name, { args = {}, body = '' } = {}) {
      const tool = tools[name];
      if (!tool) throw new ToolError(`未知工具：${name}`);
      return await tool({ args, body });
    },
    describe() {
      return Object.entries(TOOL_HELP).map(([k, v]) => `- ${k}：${v.split('\n')[0]}`).join('\n');
    },
  };
}
