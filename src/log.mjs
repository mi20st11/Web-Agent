// 运行日志：把控制台输出同时写进 ~/.web-agent/app.log。
// 程序意外退出时，日志里至少能看到它最后在做什么。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_BYTES = 2 * 1024 * 1024;

export function appLogPath() {
  return path.join(os.homedir(), '.web-agent', 'app.log');
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 打开日志：超过 2MB 就滚成 app.log.1，只留一份旧的。 */
export function openLog(file = appLogPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* 第一次运行 */ }

  const write = (line) => {
    try {
      fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    } catch { /* 日志写不进去也不能影响主流程 */ }
  };
  write(`${stamp()} --- 启动 ---`);
  return { file, write };
}

/** 接管 console.log / console.error，让它们同时落盘。 */
export function teeConsole(log) {
  for (const [name, level] of [['log', 'LOG'], ['error', 'ERR'], ['warn', 'WRN']]) {
    const original = console[name].bind(console);
    console[name] = (...args) => {
      original(...args);
      const text = args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ');
      log.write(`${stamp()} ${level} ${text}`);
    };
  }
}
