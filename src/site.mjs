// DeepSeek 网页适配层：注入消息、等回答结束、把回答还原成 markdown。
// 选择器来自旧 ChronoSync 在真实站点上验证过的版本，这里做了精简。

import { DEEPSEEK_URL } from './browser.mjs';

export class SiteError extends Error {
  constructor(message, code = 'SITE_ERROR') {
    super(message);
    this.name = 'SiteError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 注入到页面里执行的函数（必须自包含，不能引用外部变量）               */
/* ------------------------------------------------------------------ */

// 返回页面当前状态。轮询用，尽量便宜。
function pageProbe() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible);

  const editor =
    document.querySelector('textarea#chat-input') ||
    q('textarea') ||
    q('div[contenteditable="true"]');

  const editorValue = editor
    ? editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT' ? editor.value : editor.innerText
    : '';
  const isPrimaryCircle = (el) => {
    const c = String(el.className || '');
    return (/ds-button--primary/.test(c) && /ds-button--circle/.test(c)) ||
      (/(^|\s)primary(\s|$)/.test(c) && /(^|\s)circle(\s|$)/.test(c));
  };
  const circle = [...document.querySelectorAll('[role="button"]')].filter(visible).find(isPrimaryCircle);
  // 生成中：圆圈按钮变回可点（停止键），同时输入框是空的。
  const stop = [
    '[role="button"][aria-label*="停止"]',
    '[role="button"][aria-label*="Stop"]',
    'svg.icon-stop',
  ].some((sel) => q(sel)) || (!!circle && !/disabled/.test(String(circle.className)) && !editorValue.trim());

  const mdNodes = [...document.querySelectorAll('.ds-markdown, [class*="markdown"]')]
    .filter((el) => visible(el) && !el.closest('.ds-think-content, [class*="think-content"]'));
  // 去掉被其它候选包住的内层节点，只留最外层回答
  const roots = mdNodes.filter((el) => !mdNodes.some((other) => other !== el && other.contains(el)));
  const last = roots.sort(
    (a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom,
  ).at(-1) || null;

  let storageBlocked = false;
  try { window.localStorage.getItem('__web_agent'); } catch { storageBlocked = true; }

  return {
    url: location.href,
    storageBlocked,
    title: document.title,
    signedOut: /\/sign_in/.test(location.pathname) || !!document.querySelector('input[type="password"]'),
    hasEditor: !!editor,
    editorTag: editor ? editor.tagName : '',
    streaming: !!stop,
    messageCount: document.querySelectorAll('.ds-message').length,
    hasAnswer: !!last,
    answerLen: last ? last.textContent.length : 0,
    answerHead: last ? last.textContent.slice(0, 80) : '',
    answerBottom: last ? last.getBoundingClientRect().bottom : -1,
  };
}

// 清空输入框并聚焦。真正的“发送”由 Node 侧发可信按键完成。
function pageFocusEditor() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible);
  const editor =
    document.querySelector('textarea#chat-input') ||
    q('textarea') ||
    q('div[contenteditable="true"]');

  if (!editor) return { ok: false, reason: '页面上找不到输入框（可能还没登录或页面没加载完）' };
  if (editor.disabled || editor.readOnly) return { ok: false, reason: '输入框被禁用，可能还在生成上一条回答' };

  editor.focus();
  if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
    const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(editor, '');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let cleared = false;
    try { cleared = document.execCommand('delete'); } catch { cleared = false; }
    if (!cleared) editor.innerHTML = '';
  }
  return { ok: true };
}

// insertText 没生效时的兜底：用原生 setter 直接写。
function pageSetValue(text) {
  const visible = (el) => !!(el && el.getClientRects().length);
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible);
  const editor =
    document.querySelector('textarea#chat-input') ||
    q('textarea') ||
    q('div[contenteditable="true"]');
  if (!editor) return { ok: false };

  editor.focus();
  if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
    const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    editor.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = text;
    editor.appendChild(p);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  return { ok: true };
}

// 读输入框当前内容，用来确认文字进去了、或者已经清空。
function pageEditorValue() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible);
  const editor =
    document.querySelector('textarea#chat-input') ||
    q('textarea') ||
    q('div[contenteditable="true"]');
  if (!editor) return { ok: false, value: '' };
  return {
    ok: true,
    value: editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT' ? editor.value : editor.innerText,
  };
}

// 找发送按钮的坐标，由 Node 侧发真实鼠标事件。
function pageSendButton() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const isPrimaryCircle = (el) => {
    const c = String(el.className || '');
    return (/ds-button--primary/.test(c) && /ds-button--circle/.test(c)) ||
      (/(^|\s)primary(\s|$)/.test(c) && /(^|\s)circle(\s|$)/.test(c));
  };
  const all = [...document.querySelectorAll('[role="button"], button')].filter(visible);
  const btn =
    all.find((el) => /发送|Send/.test(el.getAttribute('aria-label') || '')) ||
    all.find(isPrimaryCircle);
  if (!btn) return { ok: false };

  const r = btn.getBoundingClientRect();
  return {
    ok: true,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    disabled: /disabled/.test(String(btn.className)) || btn.getAttribute('aria-disabled') === 'true',
  };
}

// 把最后一条回答克隆出来，代码块还原成 ``` 围栏，再取 innerText。
function pageExtract() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const mdNodes = [...document.querySelectorAll('.ds-markdown, [class*="markdown"]')]
    .filter((el) => visible(el) && !el.closest('.ds-think-content, [class*="think-content"]'));
  const roots = mdNodes.filter((el) => !mdNodes.some((other) => other !== el && other.contains(el)));
  const root = roots.sort(
    (a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom,
  ).at(-1);
  if (!root) return { text: '', ok: false };

  const fenceFor = (code) => {
    let max = 0;
    for (const m of code.matchAll(/`+/g)) max = Math.max(max, m[0].length);
    return '`'.repeat(Math.max(3, max + 1));
  };

  const clone = root.cloneNode(true);
  clone.querySelectorAll('.ds-think-content, [class*="think-content"]').forEach((n) => n.remove());
  clone.querySelectorAll('button, [role="button"]').forEach((n) => n.remove());

  clone.querySelectorAll('.md-code-block').forEach((block) => {
    const pre = block.querySelector('pre');
    const code = (pre ? pre.textContent : block.textContent).replace(/\n$/, '');
    let lang = block.querySelector('.md-code-block-banner-wrap .d2a24f03 span')?.textContent?.trim() || '';
    if (!lang) {
      const banner = block.querySelector('.md-code-block-banner-wrap');
      lang = (banner?.innerText || '').split('\n')[0].trim();
    }
    if (lang.length > 24 || /\s/.test(lang) || /复制|copy|下载|download/i.test(lang)) lang = '';
    const fence = fenceFor(code);
    const node = document.createElement('div');
    // 关键：普通 div 的 white-space 是 normal，innerText 会把 \n 折成空格。
    node.style.whiteSpace = 'pre-wrap';
    node.textContent = `\n${fence}${lang}\n${code}\n${fence}\n`;
    block.replaceWith(node);
  });

  // 没有 .md-code-block 包裹的裸 pre
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
  const btn = [...document.querySelectorAll('button, [role="button"], a')]
    .find((el) => visible(el) && /新对话|新建对话|New chat/i.test(el.innerText || ''));
  if (btn) {
    btn.click();
    return { clicked: true };
  }
  return { clicked: false };
}

function pageStop() {
  const visible = (el) => !!(el && el.getClientRects().length);
  const btn = [...document.querySelectorAll(
    '[role="button"][aria-label*="停止"], [role="button"][aria-label*="Stop"], button[aria-label*="停止"]',
  )].find(visible);
  if (!btn) return { stopped: false };
  btn.click();
  return { stopped: true };
}

/* ------------------------------------------------------------------ */

export class DeepSeekSite {
  constructor(cdp, { url = DEEPSEEK_URL, timeoutMs = 300_000 } = {}) {
    this.cdp = cdp;
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async probe() {
    const p = await this.cdp.evaluate(`(${pageProbe.toString()})()`);
    if (!p) throw new SiteError('页面没有响应');
    return p;
  }

  async check() {
    try {
      const p = await this.probe();
      return {
        ok: p.hasEditor && !p.signedOut,
        signedOut: p.signedOut,
        storageBlocked: p.storageBlocked,
        hasEditor: p.hasEditor,
        url: p.url,
        title: p.title,
      };
    } catch (err) {
      return { ok: false, signedOut: false, hasEditor: false, url: '', title: '', error: err.message };
    }
  }

  async ensureReady() {
    const p = await this.probe();
    if (p.signedOut) {
      throw new SiteError('DeepSeek 还没登录。请在弹出的 DeepSeek 窗口里登录，然后重试。', 'NOT_LOGGED_IN');
    }
    if (p.storageBlocked) {
      throw new SiteError(
        '这个浏览器 profile 禁用了网站数据（Cookie / localStorage），DeepSeek 页面加载不出来。' +
        '常见原因是 Edge 同步把账号里的“阻止所有 Cookie”同步了过来；关掉同步或换一个 profile 再试。',
        'STORAGE_BLOCKED',
      );
    }
    if (!p.hasEditor) {
      throw new SiteError('DeepSeek 页面没有输入框，可能没加载完。点“打开 DeepSeek”看一眼。', 'NO_EDITOR');
    }
    return p;
  }

  /** 等页面真正可用（加载中时 editor 可能还没出现）。已登录但没输入框就多等一会儿。 */
  async waitReady({ timeoutMs = 20_000, intervalMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.check();
      if (last.ok || last.signedOut) return last;
      await sleep(intervalMs);
    }
    return last;
  }

  /** 把文字写进输入框：优先用 CDP 的 insertText，像真人输入。 */
  async fill(text) {
    const focused = await this.cdp.evaluate(`(${pageFocusEditor.toString()})()`, { timeoutMs: 15_000 });
    if (!focused?.ok) throw new SiteError(focused?.reason || '找不到输入框', 'NO_EDITOR');

    await this.cdp.send('Input.insertText', { text }, { timeoutMs: 20_000 });
    await sleep(150);

    let value = await this.editorValue();
    if (!value.trim()) {
      await this.cdp.evaluate(`(${pageSetValue.toString()})(${JSON.stringify(text)})`, { timeoutMs: 10_000 });
      await sleep(150);
      value = await this.editorValue();
    }
    if (!value.trim()) throw new SiteError('文字没能写进输入框', 'FILL_FAILED');
  }

  async editorValue() {
    const r = await this.cdp.evaluate(`(${pageEditorValue.toString()})()`, { timeoutMs: 10_000 });
    return r?.value || '';
  }

  /** 真实 Enter：rawKeyDown + keyUp，网页会当作用户按下回车。 */
  async pressEnter() {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', text: '\r', unmodifiedText: '\r', ...base,
    });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** 兜底：用真实鼠标点发送按钮。 */
  async clickSend() {
    let btn = null;
    try {
      btn = await this.cdp.evaluate(`(${pageSendButton.toString()})()`, { timeoutMs: 10_000 });
    } catch {
      return false;
    }
    if (!btn?.ok) return false;
    const { x, y } = btn;
    const mouse = { x, y, button: 'left', clickCount: 1 };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse, buttons: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
    return true;
  }

  /** 消息是否真的发出去了：生成中 / 消息数增加 / 地址变了。 */
  async waitAccepted(before, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const p = await this.probe();
      if (p.streaming) return true;
      if (p.messageCount > before.messageCount) return true;
      if (p.url !== before.url) return true;
      await sleep(200);
    }
    return false;
  }


  /** 发一条消息，并等新回答稳定下来。返回回答的 markdown。 */
  async ask(text, { timeoutMs = this.timeoutMs } = {}) {
    const before = await this.ensureReady();
    await this.fill(text);
    await this.pressEnter();
    let accepted = await this.waitAccepted(before, 8_000);
    if (!accepted) {
      await this.clickSend();
      accepted = await this.waitAccepted(before, 8_000);
    }
    if (!accepted) {
      throw new SiteError('消息没有发出去（输入框里的字还在，或页面一直没变化）', 'SEND_FAILED');
    }

    const started = Date.now();
    let lastLen = -1;
    let lastChangeAt = Date.now();
    let candidate = null;
    let sawStreaming = false;

    while (Date.now() - started < timeoutMs) {
      // 开头密一点，抓第一段字；后面放慢，别一直打页面
      await sleep(Date.now() - started < 4_000 ? 300 : 550);
      const p = await this.probe();
      if (p.signedOut) throw new SiteError('登录状态丢了，请重新登录 DeepSeek。', 'NOT_LOGGED_IN');
      if (!p.hasAnswer || p.answerLen === 0) continue;

      const sameAsBefore =
        p.answerLen === before.answerLen &&
        p.answerHead === before.answerHead &&
        p.messageCount === before.messageCount;
      if (sameAsBefore) continue;

      if (p.streaming) sawStreaming = true;
      if (p.answerLen !== lastLen) {
        lastLen = p.answerLen;
        lastChangeAt = Date.now();
      }

      // 生成按钮变回“可点” + 文本安静一会儿 = 这一轮说完了。
      // 见过流式输出的，900ms 安静就够；一直没检测到流式的（比如秒回），多等一点再确认。
      const quietMs = Date.now() - lastChangeAt;
      if (!p.streaming && quietMs >= (sawStreaming ? 900 : 1_600)) {
        candidate = p;
        break;
      }
    }

    if (!candidate) {
      throw new SiteError(`等了 ${Math.round(timeoutMs / 1000)} 秒还没等到回答。可以点停止，或刷新 DeepSeek 页面。`, 'TIMEOUT');
    }

    const out = await this.cdp.evaluate(`(${pageExtract.toString()})()`);
    if (!out?.ok || !out.text) {
      throw new SiteError('回答提取为空，可能是页面结构变了。', 'EXTRACT_EMPTY');
    }
    return out.text;
  }

  async newChat() {
    const r = await this.cdp.evaluate(`(${pageNewChat.toString()})()`);
    if (r?.clicked) {
      await sleep(600);
      return true;
    }
    await this.cdp.send('Page.navigate', { url: this.url });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await sleep(300);
      const p = await this.probe().catch(() => null);
      if (p?.hasEditor) return true;
    }
    return false;
  }

  async stop() {
    try {
      const r = await this.cdp.evaluate(`(${pageStop.toString()})()`);
      return !!r?.stopped;
    } catch {
      return false;
    }
  }

  async focus() {
    try {
      await this.cdp.send('Page.bringToFront', {});
      return true;
    } catch {
      return false;
    }
  }
}
