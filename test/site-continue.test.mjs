import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSite, DeepSeekSite } from '../src/site.mjs';

/** 造一个够 pageContinue 用的假元素：矩形、class、文字、aria、父子关系。 */
function node({ cls = '', text = '', x = 0, y = 0, w = 0, h = 0, parent = null }) {
  const el = {
    className: cls,
    innerText: text,
    textContent: text,
    parent,
    getBoundingClientRect: () => ({ x, y, left: x, top: y, width: w, height: h }),
    getAttribute: (name) => (name === 'aria-label' ? null : name === 'aria-disabled' ? null : null),
    closest: () => null,
    contains(other) {
      for (let p = other; p; p = p.parent) if (p === el) return true;
      return false;
    },
  };
  return el;
}

/** 在假 document 上跑真实的 pageContinue：DeepSeek 的按钮是 div.ds-button，没有 role。 */
function runContinue({ buttons = [], marks = [] } = {}) {
  const site = new DeepSeekSite({ evaluate: async () => null, send: async () => ({}) });
  globalThis.document = {
    querySelectorAll(sel) {
      if (String(sel).includes('markdown')) return marks;
      return buttons;
    },
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  try {
    return site.pages.continue();
  } finally {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
}

test('认得出 DeepSeek 的 div.ds-button「继续生成」（没有 role=button，点最外层）', () => {
  const outer = node({ cls: 'ds-button ds-button--outlinedNeutral ds-button--capsule', text: '继续生成', x: 916, y: 465, w: 96, h: 32 });
  const bg = node({ cls: 'ds-button__background', x: 916, y: 465, w: 96, h: 32, parent: outer });
  const content = node({ cls: 'ds-button__content', text: '继续生成', x: 942, y: 470, w: 56, h: 22, parent: outer });
  const other = node({ cls: 'ds-button ds-button--outlinedNeutral', text: '重新生成', x: 700, y: 465, w: 84, h: 32 });
  assert.deepEqual(runContinue({ buttons: [bg, content, other, outer] }), { ok: true, x: 964, y: 481 });
});

test('只认最后一条回答下面的按钮，历史消息里的旧「继续生成」不点', () => {
  const lastMsg = node({ cls: 'ds-markdown ds-assistant-message-main-content', x: 20, y: 300, w: 700, h: 200 });
  const stale = node({ cls: 'ds-button ds-button--outlinedNeutral', text: '继续生成', x: 900, y: 120, w: 84, h: 32 });
  const fresh = node({ cls: 'ds-button ds-button--outlinedNeutral', text: '继续生成', x: 900, y: 520, w: 84, h: 32 });
  assert.deepEqual(runContinue({ buttons: [stale, fresh], marks: [lastMsg] }), { ok: true, x: 942, y: 536 });
});

test('「停止生成」「重新生成」都不算，禁用态也不点', () => {
  assert.equal(runContinue({ buttons: [node({ cls: 'ds-button', text: '停止生成', x: 1, y: 1, w: 84, h: 32 })] }).ok, false);
  assert.equal(runContinue({ buttons: [node({ cls: 'ds-button', text: '重新生成', x: 1, y: 1, w: 84, h: 32 })] }).ok, false);
  assert.equal(runContinue({ buttons: [node({ cls: 'ds-button ds-button--disabled', text: '继续生成', x: 1, y: 1, w: 84, h: 32 })] }).ok, false);
});

function fakeCdp(button) {
  const sent = [];
  return {
    sent,
    async evaluate(source) {
      // clickContinue 会把 site.pages.continue 的源码拼进去；用标记认出来
      if (source.includes('__CONT__')) return button;
      return null;
    },
    async send(method, params) {
      sent.push({ method, params });
      return {};
    },
  };
}

const site = (cdp, pages) => {
  const s = new ChatSite(cdp, { name: '测试' });
  s.pages = pages;
  return s;
};

test('找不到继续按钮时返回 false，也不发鼠标事件', async () => {
  const cdp = fakeCdp({ ok: false });
  const s = site(cdp, { continue: function pageContinue() { /* __CONT__ */ } });
  assert.equal(await s.clickContinue(), false);
  assert.equal(cdp.sent.length, 0);
});

test('找到按钮就用真实鼠标点它的中心', async () => {
  const cdp = fakeCdp({ ok: true, x: 120, y: 240 });
  const s = site(cdp, { continue: function pageContinue() { /* __CONT__ */ } });
  assert.equal(await s.clickContinue(), true);
  const kinds = cdp.sent.map((e) => e.method);
  assert.deepEqual(kinds, [
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
  ]);
  const pressed = cdp.sent[1].params;
  assert.equal(pressed.type, 'mousePressed');
  assert.equal(pressed.x, 120);
  assert.equal(pressed.y, 240);
  assert.equal(cdp.sent[2].params.type, 'mouseReleased');
});

test('站点没实现 continue 时安静跳过（Gemini 没有这个按钮）', async () => {
  const cdp = fakeCdp({ ok: true, x: 1, y: 2 });
  const s = site(cdp, { probe: function pageProbe() {} });
  assert.equal(await s.clickContinue(), false);
  assert.equal(cdp.sent.length, 0);
});

test('页面求值抛错时当作没找到，不中断整轮回答', async () => {
  const cdp = {
    sent: [],
    async evaluate() { throw new Error('CDP 连接已关闭'); },
    async send() { throw new Error('不该走到这里'); },
  };
  const s = site(cdp, { continue: function pageContinue() { /* __CONT__ */ } });
  assert.equal(await s.clickContinue(), false);
});
