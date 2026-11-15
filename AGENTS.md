# Web Agent

用网页版 DeepSeek / Gemini 当编程代理的本地工作台。Node 22+，零依赖。

- 入口 `web-agent.mjs`；代理循环 `src/agent.mjs`；站点适配 `src/site.mjs`、`src/gemini.mjs`；界面是单文件 `ui/index.html`。
- 测试：`npm run test:unit` 跑协议、路径策略、Git 快照；`npm test` 还要真浏览器，别在没浏览器时跑。
- 改动前先读 `docs/交接文档.md`：关键决策和已知脆弱点都在里面。

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles; the label strings are identical to the role names (`needs-triage` … `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
