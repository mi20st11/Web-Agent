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
function publicState(agent, browser, sites) {
  const s = agent.snapshot();
  return {
    ...s,
    browser: browser ? browser.get() : null,
    site: sites ? sites.get() : null,
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
const FAVICON = Buffer.from('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', 'base64');

export async function startServer({ agent, uiDir, uiHtml = null, port = 0, host = '127.0.0.1', onFocus, onWarm, browser = null, sites = null, version = '' }) {
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
      const payload = `event: state\ndata: ${JSON.stringify(publicState(agent, browser, sites))}\n\n`;
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

      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg' || url.pathname === '/favicon.png')) {
        res.writeHead(200, {
          'content-type': 'image/png',
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
        res.write(`event: state\ndata: ${JSON.stringify(publicState(agent, browser, sites))}\n\n`);
        sseClients.add(res);
        agent.setClients?.(sseClients.size);
        req.on('close', () => {
          sseClients.delete(res);
          agent.setClients?.(sseClients.size);
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, publicState(agent, browser, sites));
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
          try {
            await agent.setSettings(body);
            sendJson(res, 200, { ok: true, settings: agent.settings });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message || String(err) });
          }
          return;
        }

        if (url.pathname === '/api/restore') {
          const result = await agent.restore(String(body.id ?? ''));
          sendJson(res, result.ok ? 200 : 400, result);
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

        if (url.pathname === '/api/site') {
          try {
            if (!sites) throw new Error('这次启动不能切换网页端');
            const info = await sites.set(String(body.key ?? '').trim().toLowerCase());
            sendJson(res, 200, { ok: true, site: info });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message || String(err) });
          }
          return;
        }

        if (url.pathname === '/api/workspace') {
          try {
            const target = String(body.path ?? '').trim()
              || await pickFolder({ initial: agent.workspace || os.homedir() });
            if (!target) { sendJson(res, 200, { ok: true, cancelled: true }); return; }
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
          // 一定要带 error：界面把 “HTTP 200” 当兜底文案显示出来过一次。
          sendJson(res, 200, ok ? { ok: true } : { ok: false, error: '没找到对话窗口，在浏览器标签页里点一下' });
          return;
        }

        if (url.pathname === '/api/warm') {
          // 用户摸到浏览器下拉时先热另一个浏览器，切过去就是秒切；不热也不影响功能。
          sendJson(res, 200, { ok: true });
          if (onWarm) onWarm().catch(() => {});
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
