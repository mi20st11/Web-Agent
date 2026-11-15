// Gemini 网页端（gemini.google.com）适配。
// 页面是 Angular + Quill 富文本编辑器，且开启 Trusted Types：
// 不能用 innerHTML 清空/写入，兜底一律走 DOM API 或 execCommand。

import { GEMINI_URL } from './browser.mjs';
import { ChatSite } from './site.mjs';

/* ------------------------------------------------------------------ */
/* 注入到页面里执行的函数（必须自包含，不能引用外部变量）               */
/* ------------------------------------------------------------------ */

function pageProbe() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible);

  // Quill 的 .ql-clipboard 也是 contenteditable，但不可见，必须过滤。
  const editor =
    q('div.ql-editor[contenteditable="true"]') ||
    q('rich-textarea [contenteditable="true"]') ||
    q('div[contenteditable="true"]');

  const editorValue = editor ? editor.innerText : '';

  const stop = [
    'button[aria-label*="停止"]',
    'button[aria-label*="Stop"]',
    '[data-test-id="stop-button"]',
    'mat-icon[fonticon="stop"]',
  ].some((sel) => q(sel));

  const responses = [...document.querySelectorAll('model-response')].filter(visible);
  const last = responses.sort(
    (a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom,
  ).at(-1) || null;
  const answer = last
    ? (last.querySelector('.model-response-text, .markdown') || last)
    : null;

  // 浏览器自己的错误页（断网 / 代理不通）不能当成“页面没好”，得说清楚。
  const errCode = document.querySelector('#main-frame-error .error-code, .error-code');
  // 导航失败时目标地址是 chrome-error://，而页面里的文档可能是 about:blank，
  // 两种都算“没打开”，否则会被误判成 Cookie 被禁。
  const blankDoc = location.href === 'about:blank';
  const loadError = (location.href.startsWith('chrome-error://') || errCode || blankDoc)
    ? ((errCode?.textContent || '').trim().split(/\s+/)[0] || (blankDoc ? '页面没加载出来' : 'ERR_FAILED'))
    : '';

  let storageBlocked = false;
  try { window.localStorage.getItem('__web_agent'); } catch { storageBlocked = true; }

  // 未登录时页面上有 Google 登录入口；已登录时是账号头像菜单。
  const signIn = q('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"]') ||
    [...document.querySelectorAll('button, a')].find(
      (el) => visible(el) && /^(登录|Sign in)$/i.test((el.innerText || '').trim()),
    );

  return {
    url: location.href,
    storageBlocked: storageBlocked && !loadError,
    loadError,
    title: document.title,
    signedOut: !!signIn,
    hasEditor: !!editor,
    editorTag: editor ? editor.tagName : '',
    streaming: !!stop,
    messageCount: responses.length,
    hasAnswer: !!last,
    answerLen: answer ? answer.textContent.length : 0,
    answerHead: answer ? answer.textContent.slice(0, 80) : '',
    answerBottom: last ? last.getBoundingClientRect().bottom : -1,
  };
}

// 清空输入框并聚焦。Gemini 有 Trusted Types，innerHTML 会直接抛错。
function pageFocusEditor() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible);
  const editor =
    q('div.ql-editor[contenteditable="true"]') ||
    q('rich-textarea [contenteditable="true"]') ||
    q('div[contenteditable="true"]');
  if (!editor) return { ok: false, reason: '页面上找不到输入框（可能还没登录或页面没加载完）' };

  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  let cleared = false;
  try { cleared = document.execCommand('delete'); } catch { cleared = false; }
  if (!cleared || (editor.innerText || '').trim()) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    editor.replaceChildren(p);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }
  return { ok: true };
}

// insertText 没生效时的兜底。先试试 execCommand（Quill 会当成真实输入），
// 再不行才直接拼 DOM；不能碰 innerHTML。
function pageSetValue(text) {
  const visible = (el) => !!(el && el.getClientRects().length);
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible);
  const editor =
    q('div.ql-editor[contenteditable="true"]') ||
    q('rich-textarea [contenteditable="true"]') ||
    q('div[contenteditable="true"]');
  if (!editor) return { ok: false };

  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  try { document.execCommand('delete'); } catch { /* 后面兜底 */ }

  let inserted = false;
  try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }

  if (!inserted || !(editor.innerText || '').trim()) {
    editor.replaceChildren();
    for (const line of String(text).split('\n')) {
      const p = document.createElement('p');
      if (line) p.textContent = line;
      else p.appendChild(document.createElement('br'));
      editor.appendChild(p);
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  return { ok: true };
}

function pageEditorValue() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible);
  const editor =
    q('div.ql-editor[contenteditable="true"]') ||
    q('rich-textarea [contenteditable="true"]') ||
    q('div[contenteditable="true"]');
  if (!editor) return { ok: false, value: '' };
  return { ok: true, value: editor.innerText };
}

function pageSendButton() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const all = [...document.querySelectorAll('button')].filter(visible);
  const btn =
    all.find((el) => /发送|Send/i.test(el.getAttribute('aria-label') || '')) ||
    all.find((el) => el.getAttribute('data-test-id') === 'send-button');
  if (!btn) return { ok: false };

  const r = btn.getBoundingClientRect();
  return {
    ok: true,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true',
  };
}

// 把最后一条回答克隆出来，代码块还原成 ``` 围栏，再取 innerText。
function pageExtract() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const responses = [...document.querySelectorAll('model-response')].filter(visible);
  const last = responses.sort(
    (a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom,
  ).at(-1);
  if (!last) return { text: '', ok: false };

  const root = [...last.querySelectorAll('.markdown')].filter(visible).at(-1) ||
    [...last.querySelectorAll('.model-response-text')].filter(visible).at(-1) ||
    last;

  const fenceFor = (code) => {
    let max = 0;
    for (const m of code.matchAll(/`+/g)) max = Math.max(max, m[0].length);
    return '`'.repeat(Math.max(3, max + 1));
  };

  const clone = root.cloneNode(true);
  clone.querySelectorAll(
    'model-thoughts, .thoughts, .thinking, sources-list, .sources-list, .response-footer, follow-up, .follow-up-container, button, [role="button"], mat-icon',
  ).forEach((n) => n.remove());

  // Gemini 的代码块是 <code-block> 自定义元素：语言在头部，正文在 <pre><code>。
  clone.querySelectorAll('code-block').forEach((block) => {
    const pre = block.querySelector('pre');
    const code = (pre ? pre.textContent : block.textContent).replace(/\n$/, '');
    const header = block.querySelector('.code-block-decoration, .code-block-header, header');
    let lang = (header?.innerText || '').split('\n')[0].trim();
    if (
      lang.length > 24 || /\s/.test(lang) ||
      /复制|copy|下载|download|代码|code/i.test(lang)
    ) lang = '';
    const fence = fenceFor(code);
    const node = document.createElement('div');
    node.style.whiteSpace = 'pre-wrap';
    node.textContent = `\n${fence}${lang}\n${code}\n${fence}\n`;
    block.replaceWith(node);
  });

  // 没有 <code-block> 包裹的裸 pre
  clone.querySelectorAll('pre').forEach((pre) => {
    const code = pre.textContent.replace(/\n$/, '');
    if (code.trim().startsWith('```')) return;
    const fence = fenceFor(code);
    const node = document.createElement('div');
    node.style.whiteSpace = 'pre-wrap';
    node.textContent = `\n${fence}\n${code}\n${fence}\n`;
    pre.replaceWith(node);
  });

  // innerText 需要节点在文档里才有正确的块级换行；放到屏幕外算一次布局。
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:900px;visibility:visible;';
  host.appendChild(clone);
  document.body.appendChild(host);
  let text = '';
  try {
    text = clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    host.remove();
  }
  return { ok: true, text, len: root.textContent.length };
}

function pageNewChat() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const btn = [...document.querySelectorAll('button, [role="button"], a')].find((el) => {
    if (!visible(el)) return false;
    const label = el.getAttribute('aria-label') || '';
    return /新对话|发起新对话|New chat|New conversation/i.test(`${label} ${el.innerText || ''}`);
  });
  if (btn) {
    btn.click();
    return { clicked: true };
  }
  return { clicked: false };
}

function pageStop() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const btn = [...document.querySelectorAll('button, [role="button"]')].find(
    (el) => visible(el) && /停止|Stop/i.test(el.getAttribute('aria-label') || ''),
  );
  if (!btn) return { stopped: false };
  btn.click();
  return { stopped: true };
}

// Quill 用 CDP insertText 时每行都要几百毫秒（40 行要两三秒），
// 直接按行拼好 DOM 再派发一次 input，几十毫秒就写完；发出去的正文与原文字一致。
function pageInsertText(text) {
  const visible = (el) => !!(el && el.getClientRects().length);
  const editor =
    [...document.querySelectorAll('div.ql-editor[contenteditable="true"]')].find(visible) ||
    [...document.querySelectorAll('rich-textarea [contenteditable="true"]')].find(visible) ||
    [...document.querySelectorAll('div[contenteditable="true"]')].find(visible);
  if (!editor) return { ok: false, reason: '找不到输入框' };
  if (!text) return { ok: true };

  editor.focus();
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) {
    const p = document.createElement('p');
    if (line) p.textContent = line;
    else p.appendChild(document.createElement('br')); // 空行
    frag.appendChild(p);
  }
  editor.replaceChildren(frag);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  return { ok: true };
}

const geminiPages = {
  probe: pageProbe,
  focusEditor: pageFocusEditor,
  setValue: pageSetValue,
  editorValue: pageEditorValue,
  insertText: pageInsertText,
  sendButton: pageSendButton,
  extract: pageExtract,
  newChat: pageNewChat,
  stop: pageStop,
};

export class GeminiSite extends ChatSite {
  constructor(cdp, { url = GEMINI_URL, timeoutMs = 300_000 } = {}) {
    super(cdp, { url, timeoutMs, name: 'Gemini' });
    this.cookieDomain = 'google.com';
    // Gemini 有时先占位、十几秒后才出字，空回答的容忍时间要长一点。
    this.emptyGraceMs = 25_000;
    this.pages = geminiPages;
  }

  /** Quill 逐行插入太慢，整段直接建 DOM。 */
  async typeInto(text) {
    const r = await this.cdp
      .evaluate(`(${this.pages.insertText.toString()})(${JSON.stringify(text)})`, { timeoutMs: 20_000 })
      .catch(() => null);
    if (!r?.ok) await super.typeInto(text);
  }
}
