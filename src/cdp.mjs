// 极简 Chrome DevTools Protocol 客户端。只依赖 Node 24 自带的 WebSocket。
// 页面级 ws 连接即可满足本项目全部需求（Runtime.evaluate / Page.navigate / 截图）。

export class CDP {
  /** @param {string} url @returns {Promise<CDP>} */
  static connect(url, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error(`连接 CDP 超时：${url}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CDP(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`连接 CDP 失败：${url}`));
      }, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener('message', (event) => this.#receive(event));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP 连接已关闭'));
      }
      this.pending.clear();
      this.#emit('__close', {});
    });
    // 不监听 error 会导致未捕获异常；具体错误由 close / pending reject 表达。
    ws.addEventListener('error', () => {});
  }

  #receive(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = new Error(`${msg.error.message}${msg.error.data ? `：${msg.error.data}` : ''}`);
        err.code = msg.error.code;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) this.#emit(msg.method, msg.params ?? {});
  }

  #emit(method, params) {
    for (const fn of this.handlers.get(method) ?? []) {
      try { fn(params); } catch { /* 监听器异常不能影响协议读取 */ }
    }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }

  send(method, params = {}, { timeoutMs = 45_000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** 在页面里求值。表达式必须是一个返回 JSON 可序列化值的表达式。 */
  async evaluate(expression, { timeoutMs = 45_000 } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, { timeoutMs });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      const text = d.exception?.description || d.text || '页面脚本抛错';
      throw new Error(text.split('\n')[0]);
    }
    return result.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}
