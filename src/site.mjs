// 网页对话站点的公共流程：注入消息、等回答结束、把回答还原成 markdown。
// 每个站点只提供一组注入到页面里执行的函数（pages），流程本身共用。
// 选择器来自在真实站点上验证过的版本，这里做了精简。

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
/* DeepSeek：注入到页面里执行的函数（必须自包含，不能引用外部变量）     */
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

  // 网页端自己停住时，回答下面会挂一个「继续生成」。它在 = 没在生成，
  // 而且这是唯一可靠的“停住了”信号 —— streaming 要以它为准。
  // 只认最后一条回答下方的那一个，历史消息里的旧按钮不算。
  const labelOf = (el) =>
    `${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`.replace(/\s+/g, ' ').trim();
  const lastTop = last ? last.getBoundingClientRect().top - 4 : -Infinity;
  const continueAvailable = [...document.querySelectorAll('[role="button"], button, .ds-button, [class*="ds-button--"]')]
    .some((el) => visible(el) && el.getBoundingClientRect().top >= lastTop && /继续生成|继续回答|continue generating/i.test(labelOf(el)));

  let storageBlocked = false;
  try { window.localStorage.getItem('__web_agent'); } catch { storageBlocked = true; }

  // 浏览器自己的错误页（断网 / 代理不通）单独报，别当成 Cookie 被禁。
  const errCode = document.querySelector('#main-frame-error .error-code, .error-code');
  // 导航失败时目标地址是 chrome-error://，而页面里的文档可能是 about:blank，
  // 两种都算“没打开”，否则会被误判成 Cookie 被禁。
  const blankDoc = location.href === 'about:blank';
  const loadError = (location.href.startsWith('chrome-error://') || errCode || blankDoc)
    ? ((errCode?.textContent || '').trim().split(/\s+/)[0] || (blankDoc ? '页面没加载出来' : 'ERR_FAILED'))
    : '';

  return {
    url: location.href,
    storageBlocked: storageBlocked && !loadError,
    loadError,
    title: document.title,
    signedOut: /\/sign_in/.test(location.pathname) || !!document.querySelector('input[type="password"]'),
    hasEditor: !!editor,
    editorTag: editor ? editor.tagName : '',
    streaming: !!stop && !continueAvailable,
    messageCount: document.querySelectorAll('.ds-message').length,
    hasAnswer: !!last,
    continueAvailable,
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

function pageContinue() {
  // DeepSeek 的按钮是 div.ds-button（没有 role="button"），文字在子 span 里。
  // 所以按 class 找，再把命中的嵌套节点收成最外层那个可点区域。
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width >= 4 && r.height >= 4 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const label = (el) =>
    `${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`.replace(/\s+/g, ' ').trim();
  // 只要最后一条回答下面的那个按钮：历史消息里留着的「继续生成」不能点。
  const mdNodes = [...document.querySelectorAll('.ds-markdown, [class*="markdown"]')].filter(
    (el) => visible(el) && !el.closest('.ds-think-content, [class*="think-content"]'),
  );
  const roots = mdNodes.filter((el) => !mdNodes.some((other) => other !== el && other.contains(el)));
  const last = roots.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom).at(-1) || null;
  const lastTop = last ? last.getBoundingClientRect().top - 4 : -Infinity;

  const hits = [...document.querySelectorAll('[role="button"], button, .ds-button, [class*="ds-button--"]')].filter(
    (el) => visible(el) && el.getBoundingClientRect().top >= lastTop && /继续生成|继续回答|continue generating/i.test(label(el)),
  );
  const outer = hits.filter((el) => !hits.some((o) => o !== el && o.contains(el)));
  const btn = outer.find(
    (el) => !/disabled/i.test(String(el.className)) && el.getAttribute('aria-disabled') !== 'true',
  );
  if (!btn) return { ok: false };
  const r = btn.getBoundingClientRect();
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

const deepseekPages = {
  probe: pageProbe,
  focusEditor: pageFocusEditor,
  setValue: pageSetValue,
  editorValue: pageEditorValue,
  sendButton: pageSendButton,
  extract: pageExtract,
  newChat: pageNewChat,
  stop: pageStop,
  continue: pageContinue,
};

/* ------------------------------------------------------------------ */
/* 公共流程                                                            */
/* ------------------------------------------------------------------ */

export class ChatSite {
  constructor(cdp, { url = '', timeoutMs = 300_000, name = '网页端' } = {}) {
    this.cdp = cdp;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.name = name;
    this.emptyGraceMs = 0; // >0 时：新消息已经出现但一直没有正文，等这么久就报错，别干等到超时
    this.continueIdleMs = 10_000; // 回答安静这么久还没有“继续生成”，才算这一轮真的结束
    this.continueTries = 3; // 一轮最多替用户点几次「继续生成」，防止死循环
    this.cookieDomain = ''; // 登录态会话 Cookie 的域（子类填），用来把登录钉成持久 Cookie
    this.sessionPinned = false;
    this.pages = null;
  }

  async probe() {
    // 页面正在导航、网络又不通时，求值可能一直挂着；别让一次探测拖住整个状态更新。
    const p = await this.cdp.evaluate(`(${this.pages.probe.toString()})()`, { timeoutMs: 8_000 });
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
        loadError: p.loadError || '',
        hasEditor: p.hasEditor,
        url: p.url,
        title: p.title,
      };
    } catch (err) {
      const text = err.message || String(err);
      // 页面在导航、网络不通时求值会超时：当成“页面没响应”，别把协议层的报错直接抛给用户。
      return { ok: false, signedOut: false, hasEditor: false, url: '', title: '', error: text, loadError: /超时|timeout/i.test(text) ? '页面没响应（网络断了？）' : '' };
    }
  }

  async ensureReady() {
    const p = await this.probe();
    if (p.signedOut) {
      throw new SiteError(`${this.name} 还没登录。请在弹出的 ${this.name} 窗口里登录，然后重试。`, 'NOT_LOGGED_IN');
    }    if (p.loadError) {
      throw new SiteError(
        `${this.name} 页面没打开（${p.loadError}）。网络或代理恢复后会自动重试。`,
        'PAGE_ERROR',
      );
    }
    if (p.storageBlocked) {
      throw new SiteError(
        `这个浏览器 profile 禁用了网站数据（Cookie / localStorage），${this.name} 页面加载不出来。` +
        '常见原因是 Edge 同步把账号里的“阻止所有 Cookie”同步了过来；关掉同步或换一个 profile 再试。',
        'STORAGE_BLOCKED',
      );
    }
    if (!p.hasEditor) {
      throw new SiteError(`${this.name} 页面没有输入框，可能没加载完。点“打开 ${this.name} 窗口”看一眼。`, 'NO_EDITOR');
    }
    await this.pinSession();
    return p;
  }

  /**
   * 把网页端的“会话 Cookie”改写成持久 Cookie（30 天）。
   * DeepSeek / Google 的登录态都是 session cookie：浏览器一关就没了，
   * 而我们要一遍遍关它（退出、换浏览器、崩溃恢复），于是动不动就“自己退出登录”。
   * 这里登录成功后把同值重设一次，之后进程重启也还在。
   */
  async pinSession() {
    if (this.sessionPinned || !this.cookieDomain) return;
    this.sessionPinned = true;
    try {
      const res = await this.cdp.send('Storage.getCookies', {}, { timeoutMs: 5_000 });
      const cookies = res?.cookies || [];
      const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
      let pinned = 0;
      for (const c of cookies) {
        const host = String(c.domain || '').replace(/^\./, '');
        if (!host.endsWith(this.cookieDomain) || !c.session) continue;
        const params = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          expires,
        };
        if (c.sameSite && c.sameSite !== 'None') {
          params.sameSite = c.sameSite;
        } else if (c.sameSite === 'None') {
          params.sameSite = 'None';
          params.secure = true;
        }
        const ok = await this.cdp.send('Network.setCookie', params, { timeoutMs: 5_000 }).catch(() => null);
        if (ok?.success !== false) pinned += 1;
      }
    } catch { /* 设不上就算了，不影响这一轮 */ }  }

  /** 等页面真正可用（加载中时 editor 可能还没出现）。已登录但没输入框就多等一会儿。 */
  async waitReady({ timeoutMs = 20_000, intervalMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let reloadedAt = 0;
    while (Date.now() < deadline) {
      last = await this.check();
      if (last.ok || last.signedOut) return last;
      // 浏览器错误页（断网 / 代理没开）定期重载：网络回来了自己就接上，不用用户重开窗口。
      if (last.loadError && Date.now() - reloadedAt > 3_000) {
        reloadedAt = Date.now();
        this.cdp.send('Page.reload', { ignoreCache: true }, { timeoutMs: 5_000 }).catch(() => {});
      }
      await sleep(intervalMs);
    }
    return last;
  }

  /** 把文字写进输入框：优先用 CDP 的 insertText，像真人输入。 */
  async fill(text) {
    const focused = await this.cdp.evaluate(`(${this.pages.focusEditor.toString()})()`, { timeoutMs: 15_000 });
    if (!focused?.ok) throw new SiteError(focused?.reason || '找不到输入框', 'NO_EDITOR');

    await this.typeInto(text);
    await sleep(150);

    let value = await this.editorValue();
    if (!value.trim()) {
      await this.cdp.evaluate(`(${this.pages.setValue.toString()})(${JSON.stringify(text)})`, { timeoutMs: 10_000 });
      await sleep(150);
      value = await this.editorValue();
    }
    if (!value.trim()) throw new SiteError('文字没能写进输入框', 'FILL_FAILED');
  }

  /** 把文字塞进输入框。子类可以换成更快的写法。 */
  async typeInto(text) {
    await this.cdp.send('Input.insertText', { text }, { timeoutMs: 20_000 });
  }

  async editorValue() {
    const r = await this.cdp.evaluate(`(${this.pages.editorValue.toString()})()`, { timeoutMs: 10_000 });
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
      btn = await this.cdp.evaluate(`(${this.pages.sendButton.toString()})()`, { timeoutMs: 10_000 });
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

  /**
   * DeepSeek 有时会自己停下（断流、限流、页面发愣），回答底下留一个「继续生成」。
   * 找到就用真实鼠标点它，返回是否点到了。
   */
  async clickContinue() {
    if (!this.pages?.continue) return false;
    let btn = null;
    try {
      btn = await this.cdp.evaluate(`(${this.pages.continue.toString()})()`, { timeoutMs: 5_000 });
    } catch {
      return false;
    }
    if (!btn?.ok) return false;
    const { x, y } = btn;
    const mouse = { x, y, button: 'left', clickCount: 1 };
    try {
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse, buttons: 1 });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
      return true;
    } catch {
      return false;
    }
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
    // 回车一般立刻发出去；有的页面把回车当换行，别干等——1.5 秒还没动静就点发送按钮。
    let accepted = await this.waitAccepted(before, 1_500);
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
    let lastActivityAt = Date.now();
    let continued = 0;
    let candidate = null;
    let sawStreaming = false;
    let emptySince = 0;

    while (Date.now() - started < timeoutMs) {
      // 开头密一点，抓第一段字；后面放慢，别一直打页面
      await sleep(Date.now() - started < 4_000 ? 300 : 550);
      const p = await this.probe();
      if (p.signedOut) throw new SiteError(`登录状态丢了，请重新登录 ${this.name}。`, 'NOT_LOGGED_IN');
      if (!p.hasAnswer || p.answerLen === 0) {
        // 新回答已经出现却没有正文：多半是用户点了停止，或页面没渲染出来
        if (this.emptyGraceMs && p.messageCount > before.messageCount && !p.streaming) {
          if (!emptySince) emptySince = Date.now();
          if (Date.now() - emptySince >= this.emptyGraceMs) {
            throw new SiteError('回答是空的（可能被停止了，或页面没渲染出来）。', 'EXTRACT_EMPTY');
          }
        } else {
          emptySince = 0;
        }
        continue;
      }
      emptySince = 0;

      const sameAsBefore =
        p.answerLen === before.answerLen &&
        p.answerHead === before.answerHead &&
        p.messageCount === before.messageCount;
      if (sameAsBefore) continue;

      if (p.streaming) {
        sawStreaming = true;
        lastActivityAt = Date.now();
      }
      if (p.answerLen !== lastLen) {
        lastLen = p.answerLen;
        lastChangeAt = Date.now();
        lastActivityAt = Date.now();
      }

      // 网页端有时会自己停住，回答下面挂一个「继续生成」。探测里已经看到它了，
      // 就直接点（最多 3 次），别等流式判定的状态。
      if (p.continueAvailable && continued < this.continueTries && (await this.clickContinue())) {
        continued += 1;
        lastChangeAt = Date.now();
        lastActivityAt = Date.now();
        sawStreaming = true;
        emptySince = 0;
        await sleep(600);
        continue;
      }

      // 生成按钮变回“可点” + 文本安静一会儿 = 这一轮像是说完了。
      // 见过流式输出的，900ms 安静就够；一直没检测到流式的（比如秒回），多等一点再确认。
      const quietMs = Date.now() - lastChangeAt;
      const idleMs = Date.now() - lastActivityAt;
      const quiet = !p.streaming && quietMs >= (sawStreaming ? 900 : 1_600);
      // 安静满 10 秒、页面上也没有「继续生成」，才算这一轮真的结束；
      // 不满 10 秒就继续盯着，免得网页端过一会儿才停住、我们却已经走了。
      if (quiet && idleMs >= this.continueIdleMs) {
        candidate = p;
        break;
      }
    }

    if (!candidate) {
      throw new SiteError(`等了 ${Math.round(timeoutMs / 1000)} 秒还没等到回答。可以点停止，或刷新 ${this.name} 页面。`, 'TIMEOUT');
    }

    const out = await this.cdp.evaluate(`(${this.pages.extract.toString()})()`);
    if (!out?.ok || !out.text) {
      throw new SiteError('回答提取为空，可能是页面结构变了。', 'EXTRACT_EMPTY');
    }
    return out.text;
  }

  async newChat() {
    const r = await this.cdp.evaluate(`(${this.pages.newChat.toString()})()`);
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
      const r = await this.cdp.evaluate(`(${this.pages.stop.toString()})()`);
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

export class DeepSeekSite extends ChatSite {
  constructor(cdp, { url = DEEPSEEK_URL, timeoutMs = 300_000 } = {}) {
    super(cdp, { url, timeoutMs, name: 'DeepSeek' });
    this.cookieDomain = 'deepseek.com';
    this.pages = deepseekPages;
  }
}
