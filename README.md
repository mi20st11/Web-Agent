# Web Agent是什么？
Web Agent是一个用网页版AI模型来代替API模型，也就是说不需要token、不需要API就能编程！！！
不是反代，用的是浏览器CDP自动化，不过DeepSeek的规定里明文禁止CDP和反代，但是CDP至少会比反代的封号概率低了很多很多。
**支持Edge和Chrome浏览器**

Web Agent会开一个独立的浏览器窗口访问 chat.deepseek.com ，网页版模型会根据Web Agent自带的提示词（CDP实现），在输出回答里写代码、对应工具，然后Web Agent来安装网页版AI输出来执行，执行结果自动发个网页版AI，直至网页版AI给出完毕指令即停止

## 需要

- Node.js 22 或更新（用到内置 `WebSocket` 和 `fetch`）
- Windows 10/11。（后续加入Liunx版本）
- 一个能登录 DeepSeek 的账号
- Edge 或 Chrome。程序用自己的 profile，不影响你平时的浏览器

## 开始
直接下载源码和下载Releases的封装exe都可以
首次启动会开两个窗口：

1. **网页版AI（目前仅DeepSeek）**：在里面登录一次。登录态存在 `~/.web-agent/browser-profile`，Chrome 是 `~/.web-agent/chrome-profile`
2. **Web Agent**：左边是工作区和状态，中间是对话和工具调用

输入要在**Web Agent里输入**，会自动粘贴到网页版AI。
## 工具

模型通过代码块调用工具，一轮可以调用多个：

````text
```tool
write {"path":"src/hello.js"}
export const hello = () => 'hi';
```
````

| 工具 | 作用 |
| --- | --- |
| `shell` | 在工作区跑命令。Windows 用 PowerShell，其它平台用 bash |
| `read` | 读文本文件，支持 `offset` / `limit` |
| `write` | 整文件写入，写前自动备份 |
| `edit` | 用 `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` 块做精确替换 |
| `list` | 列目录树 |
| `fetch` | 抓 http(s) 页面，HTML 转文本 |
| `ask` | 反过来问用户一个问题 |

首行是工具名和可选的一行 JSON 参数，其余是正文。解析器还认两种写法：围栏直接写工具名（正文就是命令），或者没有块标签但首行正好是工具名。普通代码块不会执行。

## 安全边界

- 文件工具只能访问工作区。路径先 realpath 再判断，`..` 和符号链接逃逸会被拒绝。
- 危险命令默认弹审批：递归删除、格式化、改注册表、`git reset --hard` 之类。拒绝后模型会收到结果，自己换办法。
- 备份、完整输出和调用记录在 `~/.web-agent/workspaces/<目录名-短哈希>/`，工程目录里只有模型写的文件。
- 工具输出超过 8000 字符（工具再多也不会超过8000字符吧......）会截断，全文落在 `out/` 里。
- 网页内容按不可信数据处理。

它能让网页版AI在你机器上跑命令。别把不想被读到的密钥放进工作区！

## 换浏览器

侧栏的下拉可以在 Edge 和 Chrome 之间切换。切换时先连新浏览器、开新窗口，确认能用再关旧的，中途界面不会消失。选择记在 `~/.web-agent/config.json`。

Chrome 136 以后不允许默认 profile 开调试端口，所以用隔离 profile。第一次切过去要登录一次，之后一直记住。

同一时间只运行一个实例。重复启动会把已有界面叫到前面，要并行请加 `--force`。

## 参数

| 参数 | 说明 |
| --- | --- |
| `-w, --workspace <dir>` | 工程目录。不给就用上次的，没有就在界面里选 |
| `--port <n>` | 界面端口，默认随机 |
| `--browser <edge\|chrome>` | 选浏览器，默认 Edge |
| `--auto` | 自动批准危险命令。默认关，会停下来问你 |
| `--no-window` | 不自动打开界面窗口，只打印地址 |
| `--force` | 忽略单实例检查 |
| `--profile <dir>` | 换一个浏览器 profile |
| `--keep-browser` | 退出时保留浏览器窗口 |
| `--no-recover` | 浏览器被关掉后不自动重开 |
| `--cdp <port>` | 接入已经开着调试端口的浏览器 |
| `-h, --help` | 全部参数 |

## 测试

```bash
npm test          # 协议、路径策略、真实 CDP 端到端
npm run test:unit # 只跑不启浏览器的部分
```

现在是 20 个用例：协议 13、路径策略 5、端到端 2。端到端会开一个无头浏览器，对着 `test/mock-deepseek.html` 跑完“解析工具 → 写文件 → 回传结果”和“危险命令被拒绝”两条链路。

## 目录

```text
web-agent.mjs        入口：参数、启动浏览器、起服务
src/cdp.mjs          CDP 客户端（Node 内置 WebSocket）
src/browser.mjs      找浏览器、启动、连页面、切换
src/site.mjs         DeepSeek 页面适配：发送、等待、提取
src/agent.mjs        任务循环、审批、时间线、切换工作区
src/pick.mjs         原生文件夹选择框（Windows）
src/config.mjs       记住工作区和浏览器，管状态目录
src/log.mjs          运行日志
src/tools.mjs        七个工具
src/protocol.mjs     工具块解析与结果格式化
src/policy.mjs       工作区边界、危险命令、备份
src/exec.mjs         shell 执行
src/server.mjs       本地 HTTP 与 SSE
src/prompt.mjs       系统提示词
ui/index.html        单文件界面，无构建
test/                单元测试和端到端
build/               打包单 exe 的脚本
```

## 已知限制

- 依赖 DeepSeek 网页的 DOM，改版可能让发送或提取失效。选择器都在 `src/site.mjs`。
- 一次只跑一个任务。
- 退出时默认关掉自己启动的浏览器，`--keep-browser` 可以保留。
- Edge 登录微软账号后，同步可能把“阻止所有 Cookie”带到专用 profile，导致 DeepSeek 白屏。启动参数带了 `--disable-sync`；仍然白屏就删掉 profile 目录重新登录。
- 默认提示词在 `src/prompt.mjs`。想换措辞可以写 `<工作区>/.web-agent/instructions.md`，会整段替换，程序不会替你创建这个文件。
- `~/.web-agent/workspaces/` 随时可以整个删掉，只丢备份和调用记录。

## 灵感来源？

依旧阿基米德但是是上厕所突然想出来的，做了一半刷刷抖音发现也有同样想法的，且已经做完并上传GitHub（YaoGaoChaoLe/EAgent），我看了一下和我的差不多但是思路感觉么有这位老师做的好，然后我就借鉴了它的思路重做的我的项目，大概用了九千万token就做出来了，因为DSH加了几个省token的插件而且还用的中转站的DeepSeek V4.1 ，所以才花了将近三块。

## 怎么说
网页版AI肯定是比不过API的，这点是不个否认的，不过对于钱包空空的学生，还是很有用哒。
以后有时间会更新迭代加入更多功能（学生上学时间忙，见谅......）
博客：blog.wumist.top
联系我：w2274194310@outlook.com

## 许可证

 任何人都可以复制和分发原样副本。
 本许可证文件的内容，但不允许更改。