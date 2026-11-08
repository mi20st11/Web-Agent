// 工具协议解析。
//
// 模型这样写：
//   ```tool
//   shell
//   Get-ChildItem
//   ```
// 第一行是工具名，可跟一行 JSON 参数，其余是 body。
// 兼容 DeepSeek 把语言标记弄丢的情况：只要代码块第一行是已知工具名，也算调用。

import { TOOL_NAMES } from './tools.mjs';

const TOOL_SET = new Set(TOOL_NAMES);
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;

function firstLineInfo(body) {
  const line = body.split('\n', 1)[0].trim();
  const m = line.match(/^([a-zA-Z_][\w-]*)(?:\s+(\{.*\}))?\s*$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!TOOL_SET.has(name)) return null;
  return { name, argsText: m[2] || '' };
}

/**
 * @param {string} markdown
 * @returns {Array<{name:string,args:object,body:string,raw:string,error?:string}>}
 */
export function parseToolCalls(markdown) {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const calls = [];

  for (let i = 0; i < lines.length; i += 1) {
    const open = lines[i].match(FENCE_RE);
    if (!open) continue;
    const char = open[1][0];
    const len = open[1].length;
    const info = open[2].toLowerCase();

    let j = i + 1;
    const closeRe = new RegExp(`^ {0,3}\\${char}{${len},}\\s*$`);
    while (j < lines.length && !closeRe.test(lines[j])) j += 1;
    if (j >= lines.length) break; // 没闭合：回答还没写完或格式坏了，交给超时/重试

    const body = lines.slice(i + 1, j).join('\n');
    const head = firstLineInfo(body);
    const infoIsTool = TOOL_SET.has(info);
    const infoLooksLikeTool = info === 'tool' || info === 'tools' || info === '' || infoIsTool;

    if (infoLooksLikeTool) {
      // 两种写法都收：
      //   ```tool + 首行 shell ...        （提示词示范的写法）
      //   ```shell + 正文就是命令          （DeepSeek 常见的偷懒写法）
      let name = '';
      let argsText = '';
      let rest = body;
      if (head) {
        name = head.name;
        argsText = head.argsText;
        rest = body.split('\n').slice(1).join('\n');
      } else if (infoIsTool) {
        name = info;
      }
      if (name) {
        let args = {};
        let error;
        if (argsText) {
          try {
            const parsed = JSON.parse(argsText);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              error = '参数必须是一个 JSON 对象';
            } else {
              args = parsed;
            }
          } catch {
            error = `参数不是合法 JSON：${argsText.slice(0, 120)}`;
          }
        }
        calls.push({
          name,
          args,
          body: rest,
          raw: lines.slice(i, j + 1).join('\n'),
          ...(error ? { error } : {}),
        });
      }
    }
    i = j;
  }
  return calls;
}

/** 把一轮工具结果拼成回传给模型的消息。 */
export function formatToolResults(results) {
  const blocks = results.map((r, idx) => {
    const mark = r.ok ? '成功' : '失败';
    const extra = r.ms != null ? `，${(r.ms / 1000).toFixed(1)}s` : '';
    const head = r.error
      ? `[${idx + 1}] ${r.name} → 参数错误`
      : `[${idx + 1}] ${r.name} → ${mark}${extra}`;
    return `${head}\n${r.output}`;
  });
  return `【工具结果】\n\n${blocks.join('\n\n--------\n\n')}\n\n【请继续】`;
}

export function formatToolError(name, message) {
  return `${name} → 失败\n${message}`;
}
