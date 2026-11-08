// 本地 HTTP + SSE 服务：一个单页界面 + 几个 JSON 接口。
// 只绑 127.0.0.1；POST 要求自定义头，避免别的网页悄悄调本地接口。

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pickFolder } from './pick.mjs';

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 给界面看的精简状态：任何一段超长文本都截断，避免一次 SSE 推几 MB。 */
function publicState(agent, browser) {
  const s = agent.snapshot();
  return {
    ...s,
    browser: browser ? browser.get() : null,
    // 长会话只发最近一段，界面靠 id 复用节点，不需要每次全量重传
    timeline: s.timeline.slice(-300).map((item) => {
      if (item.type === 'tool') return { ...item, output: String(item.output || '').slice(0, 20_000) };
      if (item.type === 'assistant' || item.type === 'user') {
        return { ...item, text: String(item.text || '').slice(0, 60_000) };
      }
      return item;
    }),
  };
}

// 方形底 + 终端提示符：和侧栏的品牌标记同一套线条
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#131416"/>
  <path d="M12 11l4 4-4 4" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M19 19h3" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export async function startServer({ agent, uiDir, uiHtml = null, port = 0, host = '127.0.0.1', onFocus, browser = null, version = '' }) {
  const indexFile = path.join(uiDir, 'index.html');
  // 打包成单 exe 时没有 ui 目录，页面 HTML 在构建阶段内联进 bundle。
  const pageHtml = uiHtml || (await fsp.readFile(indexFile, 'utf8').catch(() => null));
  const sseClients = new Set();
  let scheduled = null;

  const broadcast = () => {
    if (scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      if (!sseClients.size) return;
      const payload = `event: state\ndata: ${JSON.stringify(publicState(agent, browser))}\n\n`;
      for (const res of sseClients) {
        try { res.write(payload); } catch { sseClients.delete(res); }
      }
    });
  };
  agent.on('change', broadcast);

  const heartbeat = setInterval(() => {
    for (const res of sseClients) {
      try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
    }
  }, 20_000);
  heartbeat.unref?.();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = pageHtml;
        if (!html) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('找不到 ui/index.html');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg')) {
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=86400',
        });
        res.end(FAVICON);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`event: state\ndata: ${JSON.stringify(publicState(agent, browser))}\n\n`);
        sseClients.add(res);
        agent.setClients?.(sseClients.size);
        req.on('close', () => {
          sseClients.delete(res);
          agent.setClients?.(sseClients.size);
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, publicState(agent, browser));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        const s = agent.snapshot();
        sendJson(res, 200, {
          ok: true,
          status: s.status,
          connection: s.connection,
          needsWorkspace: s.needsWorkspace,
          version,
          browser: browser ? browser.get() : null,
        });
        return;
      }

      if (req.method === 'POST') {
        // 自定义头会触发预检，别的站点无法跨域伪造
        if (req.headers['x-web-agent'] !== '1') {
          sendJson(res, 403, { ok: false, error: '缺少 x-web-agent 头' });
          return;
        }
        const raw = await readBody(req);
        let body = {};
        if (raw) {
          try { body = JSON.parse(raw); } catch {
            sendJson(res, 400, { ok: false, error: '不是合法 JSON' });
            return;
          }
        }

        if (url.pathname === '/api/send') {
          const text = String(body.text ?? '');
          if (!text.trim()) { sendJson(res, 400, { ok: false, error: '消息是空的' }); return; }
          if (agent.busy) { sendJson(res, 409, { ok: false, error: '上一条还在处理中' }); return; }
          agent.send(text).catch(() => {});
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url.pathname === '/api/stop') {
          sendJson(res, 200, { ok: agent.stop() });
          return;
        }

        if (url.pathname === '/api/respond') {
          sendJson(res, 200, agent.respond({
            id: String(body.id ?? ''),
            allow: !!body.allow,
            text: String(body.text ?? ''),
          }));
          return;
        }

        if (url.pathname === '/api/settings') {
          agent.setSettings(body);
          sendJson(res, 200, { ok: true, settings: agent.settings });
          return;
        }

        if (url.pathname === '/api/browser') {
          if (!browser) { sendJson(res, 400, { ok: false, error: '当前连接方式不能切换浏览器' }); return; }
          try {
            const info = await browser.set(String(body.name ?? '').trim().toLowerCase());
            sendJson(res, 200, { ok: true, browser: info });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message || String(err) });
          }
          return;
        }

        if (url.pathname === '/api/workspace') {
          try {
            const target = String(body.path ?? '').trim()
              || await pickFolder({ initial: agent.workspace || os.homedir() });
            if (!target) { sendJson(res, 200, { ok: false, cancelled: true }); return; }
            const workspace = await agent.setWorkspace(target);
            sendJson(res, 200, { ok: true, workspace, recent: agent.recent });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message || String(err) });
          }
          return;
        }

        if (url.pathname === '/api/new') {
          const r = await agent.newChat();
          sendJson(res, 200, r);
          return;
        }

        if (url.pathname === '/api/focus') {
          const ok = onFocus ? await onFocus() : false;
          sendJson(res, 200, { ok });
          return;
        }

        sendJson(res, 404, { ok: false, error: '没有这个接口' });
        return;
      }

      sendJson(res, 404, { ok: false, error: '没有这个页面' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.keepAliveTimeout = 65_000;

  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}/`,
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      for (const res of sseClients) {
        try { res.end(); } catch {}
      }
      sseClients.clear();
      server.close(() => resolve());
    }),
  };
}
