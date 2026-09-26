# tasks — 后台任务面板与工具

给 OpenCode 增加后台任务的管理能力，分两侧：

|侧|入口|面向|
|-|-|-|
|终端|会话侧栏的 Tasks 板块、`/tasks` 弹窗|人|
|服务端|`task` 工具（list / status / output / kill）|模型|

两侧共用同一套 shell API，不会互相干扰。

## 安装

这是 OpenCode v2 的本地目录插件：把目录放进插件目录即可自动加载。

```bash
git clone https://github.com/kncatl/opencode-plugin-tasks.git \
  ~/.config/opencode/plugins/tasks
```

若仓库与插件目录分开（例如仓库放在 Windows 盘、由 WSL 的 OpenCode 使用），
用符号链接让插件目录指向仓库：

```bash
ln -s /path/to/opencode-plugin-tasks ~/.config/opencode/plugins/tasks
```

依赖（`@opencode/plugin/tui`、`@opentui/*`、`solid-js`）由 OpenCode 运行时解析，
无需安装 `node_modules`。`opencode plugin list` 应显示 `tasks  local`。

\---

## 一、终端侧

* **侧栏板块**：大窗口或最大化时显示，在 Context、MCP 之后追加 Tasks，列出本会话
（含子代理会话）正在运行的后台任务。
* **`/tasks` 命令**：打开与 `/plugins`、`/mcp` 同级的弹窗。

弹窗快捷键：

|按键|作用|
|-|-|
|`↑` / `↓`（或 `k` / `j`）|选择任务|
|`Enter` 或 `o`|展开/收起输出|
|`PgUp` / `PgDn` / `Home` / `End`|滚动输出框（需先展开输出；也支持鼠标滚轮）|
|`x` → `y`|结束选中的运行中任务（`n` 取消）|
|`a`|切换范围：本会话 ↔ 本目录全部会话|
|`r`|刷新|
|`Esc`|关闭|

弹窗高度跟随终端：任务列表最多 12 行，超出部分在列表内滚动并自动跟随选中项；输出框占用
剩余空间（4–24 行），自带滚动条。因此历史任务堆积或展开输出都不会再把弹窗撑出屏幕。

输出框会**自动跟随运行中的任务**：打开时读取日志尾部 64 KB，之后按字节游标增量续读——
有积压时连续读，追平后每秒轮询一次（新输出没有自己的事件，轮询与内置 shell 查看器同款），
无需手动刷新。任务退出后服务端记录会被删除，此时视图自动切换到磁盘上保留的日志文件继续
显示（标题标注 `retained log`），因此已完成任务的输出同样可以查看。按 `r` 会重新开始当前
任务的数据流。

侧栏最多列 4 条运行中的任务，超出显示 `+N more · /tasks`；点击条目可打开弹窗。

## 二、服务端工具

模型在会话中可以直接调用 `task` 工具：

|action|说明|必填|
|-|-|-|
|`list`|列出运行中的任务，默认限定本会话及子代理|—|
|`status`|单个任务的状态、命令、耗时、退出码、日志路径|`taskID`|
|`output`|读取 stdout/stderr，**默认读最新输出**，支持 `cursor`/`limit` 分页。任务已退出时自动改读磁盘保留的日志|`taskID`|
|`kill`|终止运行中的任务；服务端未登记时回退到终止进程组|`taskID`|

`list` 可传 `scope: "location"` 查看整个工作目录下的任务。

### 完成后自动唤醒（不要 sleep）

后台任务结束时，shell 工具会把完成通知作为一条合成会话消息投递；会话即使已经空闲，
也会被这条通知**自动恢复一次执行**，把结果送达模型。因此启动后台任务后直接结束回合即可，
**不要**用 `sleep`、轮询或类似命令阻塞会话等待任务。`task` 工具和 shell 工具的描述里都
写入了这条提醒，防止后续模型再主动执行等待。

### 服务端记录与本地索引（重要）

shell 端点都是 **location 作用域**的。服务端从 `x-opencode-directory` 头（生成客户端的
做法）或 deepObject 查询参数 `location[directory]` 取位置；传普通的 `?directory=` 是
**无效参数**，服务端会回落到自己的工作目录，此时注册表看起来是空的、任务看起来"从未被登记"。
插件两种形式都发（`withLocation()` / `locationHeaders()`）。

位置正确时，`GET /api/shell` **确实**会列出 shell 工具派生的运行中任务，
`GET /api/shell/{id}` 返回完整记录（含 `pid`、`cwd`、`shell`、日志路径）。插件仍自建
索引，但理由变成"服务端记录在任务退出时立即丢弃"，而不是"注册表不含这类任务"：

1. **事件流**：订阅 `shell.created` / `shell.exited`，在任务**启动时**就记下
   命令、cwd、日志路径、会话与起始时间，而不是等某次工具调用才记录。
2. **磁盘保留的日志**：合并输出写在
   `<XDG_DATA_HOME|~/.local/share>/opencode/shell/<location-hash>/<taskID>.out`，
   任务退出后**不会删除**。按 taskID 精确查找该文件即可继续 `status` / `output`。

因此 `status` 与 `output` 对**已经退出的任务**依然可用，即使从未在运行期间查询过它：

```
Task sh_xxx is no longer known to the server at /path.
Last observed state:
  status: exited
  command: ...
  log: /home/.../sh_xxx.out
  exit: 7

The retained log still holds the output: call 'output' to page through it, ...
```

`output` 会自动回退到该文件，分页语义与服务端一致，并注明
`Paged from the retained log`。

`list` 以服务端注册表为主，再合并事件流中仍在运行、但服务端已丢弃记录的条目
（保留 `status: running` 且 pid 仍存活，或事件未带 pid 的条目）。

### kill 的兜底

正常情况下 `task kill` 直接调用 `DELETE /api/shell/{id}`，由服务端终止任务
（Windows 上服务端用 `taskkill /pid <pid> /T /F` 终止整棵进程树）。只有当服务端
**已经没有该任务的记录**而插件仍认为它在运行时，才走进程组兜底：

* 任务由服务端以 `<shell> -c <command>` 形式派生，且**自成一个进程组/会话**
  （`pgrp == session == pid`）。
* 若事件或服务端给了 `pid`，先用 `/proc/<pid>/stat` 校验它仍是进程组/会话首领，
  并用起始时间排除同名旧进程；没有 pid 时退化为扫描 `/proc`，要求命令唯一匹配。
* 匹配命令时同时接受 `<shell> -c <command>` 与 shell 优化后 exec 出来的直接命令行
  （如 `sleep 240`），不会因为 shell 的 exec 优化而漏杀。
* `kill(-pgrp, SIGTERM)` 终止整棵命令树，与正常 kill 一样尽力拦截完成通知。

这套兜底依赖 `/proc`，**仅 Linux 可用**；其他平台在此情形下不会误杀，而是报告命令原文
让调用方自行处理（见"跨平台可用性"）。

匹配不唯一或找不到时不会误杀，而是报告命令原文让调用方自行处理。

### 读取运行日志

AI 随时可以读取**正在运行**的任务日志，读取本身不会干扰任务。三条路径：

|方式|能力|适用|
|-|-|-|
|`task` → `output`|字节游标分页，**默认读最新输出**|判断"现在进展如何"|
|`read` 工具读日志文件|行号、offset/limit、分页|已知要看哪一段|
|`grep` 工具搜日志文件|正则匹配|大日志中找错误/关键字|

`list` 与 `status` 都会给出日志文件的绝对路径，后两条路径直接用它。

`output` 的读取语义：

* **省略 `cursor`**：读取最新的 `limit` 字节（默认 20 KB，上限 200 KB）。运行中任务读头部
通常没有价值，所以默认给尾部，并在回复中注明范围与总量。
* **`cursor: 0`**：从头读。
* **指定 `cursor`**：从该字节偏移精确续读；回复会给出下次可用的 `cursor`。
* `cursor` 超出总量时提示"没有更多输出"，不会误报为空。

服务端该端点的行为（已实测确认）：默认窗口 64 KB、**无硬上限**（请求 10 MB 时返回了完整的
4.67 MB）；响应中的 `truncated` 恒为 `false`——它只在 shell 工具完成任务时用于表示输出被裁剪，
游标读取永不设置它。

### 实现要点

服务端插件的 `ctx.shell` 只有一个 `create.before` 钩子，没有管理接口，而
`@opencode/client` 在插件运行时无法导入。因此工具通过本地服务自身的 HTTP API 工作：

1. 从 `$XDG\_STATE\_HOME/opencode/service.json`（非 latest 通道为 `service-<channel>.json`）
读取服务 URL 与密码。
2. 用 `Basic opencode:<password>` 调用 `/api/shell\*` 端点，并始终带上 location
   （`x-opencode-directory` 头 + `location[directory]` 查询参数，两种形式都发）。
3. **身份校验**：插件运行在服务进程内，因此比对 `GET /api/info` 返回的 `pid` 与
`process.pid`。不一致（例如运行在 `--standalone` 私有服务器中）时拒绝操作，
避免误管另一个服务器的任务。
4. 连接失败或 401 时重新解析注册信息一次，以覆盖服务重启后更换端口/密码的情况。

日志与退出码来自服务端记录；记录被清理后，工具会退回显示最近一次观察到的
状态和保留的日志文件路径。

### 已知的现象与限制

* 事件会**重复投递**（同一 `shell.created` 可能出现多次）；`remember()` 用同一 id
  覆盖写入，因此重复是幂等的。
* `shell.created` 携带的 `Shell.Info` **可能没有 `pid`**，所以"无 pid"不能当作
  "进程已死"，`list` 只在 pid 存在时才做存活校验。
* 日志目录名是对 location 的哈希，不可从目录字符串反推；插件按 taskID 遍历各
  location 子目录精确匹配文件名来定位。
* 服务端记录在任务退出时立即丢弃，且 `DELETE` 对已消失的记录仍是 `204`，
  所以不能靠响应码判断终止是否成功——插件的 `markKilled()` 在发请求前就记账。

\---

## 二·五、跨平台可用性

|能力|Linux|Windows|macOS|
|-|-|-|-|
|`list` / `status` / `output`|✅|✅|✅|
|已退出任务的日志分页（磁盘回退）|✅|✅|✅|
|输出框自动跟随运行中任务（1 秒轮询）|✅|✅|✅|
|输出框读取磁盘保留日志（记录已删时）|✅|✅|✅|
|`kill`（服务端主路径）|✅|✅（服务端走 `taskkill /T /F`）|✅|
|`kill` 进程组兜底（服务端已丢记录时）|✅ `/proc`|❌ 报告命令原文|❌ 报告命令原文|
|侧栏面板与 `/tasks` 弹窗|✅|✅|✅|

要点：

* **路径**：OpenCode 在所有平台都用 homedir 下的 XDG 风格目录
  （`~/.local/share`、`~/.local/state`），插件对这一点的假设与 OpenCode 自身一致，
  Windows 上无需翻译成 `%LOCALAPPDATA%`。
* **进程兜底**：`/proc` 扫描与 `kill(-pgrp, SIGTERM)` 只在 Linux 存在。Windows/macOS
  上该路径直接判定为"无法识别"，不会误杀；由于服务端主路径正常，这只影响
  "记录已被清理但进程仍在跑"的边缘情形。
* **shell 派生形式**：Linux 的 bash 会把简单命令 exec 优化掉，`/proc` 里看到的是
  `sleep 240` 而不是 `bash -c 'sleep 240'`；匹配逻辑两种都接受。Windows 的
  cmd/PowerShell 不做这种替换，且该路径本就不执行。
* **服务端记录本身跨平台一致**：`GET /api/shell` 是普通 HTTP + JSON，与宿主平台无关。

\---

## 三、任务判定与范围

`shell` 接口是 **目录（location）作用域** 的，而 `shell` 工具创建任务时会写入
`metadata.sessionID`。因此会话范围通过该字段加上会话树（父链）推导：
子代理会话的任务会归到父会话名下。

终端侧判断"这是一个后台任务"的依据是：shell 工具在后台任务结束时注入一条
**合成会话消息**（`metadata.source === "shell"`，带 `shellID`）。普通前台命令只把
结果作为工具返回值，不会产生这类通知，因此不会进入 Tasks 列表。

## 四、已完成的任务（终端侧）

OpenCode 在任务退出时会把它从运行注册表移除 —— 而且如上所述，该注册表本来就不含
shell 工具派生的任务。终端侧用持久存储保留最近 30 条、展示最近 10 条，包含命令、
退出码与耗时。输出按以下顺序获取：

1. `client.shell.output`（服务端仍保留该任务时；运行中由输出流持续轮询）
2. 磁盘上保留的日志文件（服务端记录已被删除时直接读取该文件：从上次游标读到文件末尾，
   或展示尾部窗口，标题标注 `retained log`）
3. 合成通知里的输出文本（截尾兜底）
4. `Output is no longer available`（文件与通知都不可用时）

## 五、结构

```
index.ts   # 服务端入口：task 工具
tui.tsx    # CLI 插件：侧栏板块 + /tasks 弹窗
reload.sh  # 手动触发插件重载（仓库在 /mnt/c 等 Windows 盘时用）
```

依赖由 OpenCode 运行时代为解析（`@opencode/plugin/tui`、`@opentui/\*`、`solid-js`），
无需在此目录安装 node\_modules。`opencode plugin list` 应显示 `tasks  local`。

## 六、刷新

在 Linux 文件系统上编辑任一文件后保存，OpenCode 会自动重新加载插件，无需重启。

**仓库位于 Windows 盘时不会自动重载**：WSL 不向 inotify 传递 `/mnt/c`（drvfs/9p）上的
变更，编辑不会触发 OpenCode 的文件监视。此时运行仓库内的 `reload.sh` 手动触发一次扫描：

```bash
bash /mnt/c/ntc/opencode/opencode_plugins/tasks/reload.sh
```

脚本的做法是在插件目录（ext4）里创建再删除一个探针文件；那次目录变更会触发重扫，
而重扫会顺着符号链接读到本仓库的最新内容。

## 七、终止任务时的行为

终止任务分两种情况，行为刻意不同：

**用户主动终止**（`/tasks` 弹窗按 `x` → `y`、内置 Shell 标签页 `ctrl+d`、或 AI 调用
`task kill`）：服务端插件会尽力在完成通知送达前把它取消，通常不会唤醒 AI。
这是**尽力而为**的拦截，存在已知竞态窗口（见下），并非 100% 可靠。终止记录写在两处：

* 终端侧：`\~/.local/state/opencode/latest/tui/plugin.tasks.history.json`，
在 `/tasks` 弹窗中显示为 `✕ killed`
* 服务端：插件存储 `kill-log`（最近 50 条，含时间、任务 ID、命令）

**自然停止**（正常完成、非零退出、任务自身报错）：通知照常送达并唤醒 AI（第二节的
"完成后自动唤醒"），实现里不做任何拦截。

### 拦截为什么是尽力而为的

拦截的工作方式：shell 工具的完成通知先经会话 inbox 入队（`session.inbox.enqueued`），
插件收到事件后用 HTTP `DELETE /api/session/{id}/inbox/{inboxID}` 取消尚未投递的条目。
从"入队"到"取消请求发出"之间有一个毫秒级的窗口：如果投递循环在这个窗口里已经把通知
取进会话，取消就无处可撤，通知照样抵达模型。

实测 5 次终止中 1 次泄漏，泄漏案例里入队与取消请求只隔 21ms。泄漏时：

* 会话里出现 `<shell … state="error">Shell.NotFoundError</shell>` 形式的合成消息，
  AI 会看到某任务"消失"，可能因此被唤醒。
* `/tasks` 面板仍会把任务记为 `✕ killed`——终端侧用同样的 `Shell.NotFoundError`
  特征识别这种通知（`tui.tsx` 的 `isKillNotice`），不会误记为 `failed`。

竞态无法在插件层面消除：插件 SDK 没有 inbox 投递前的拦截钩子，通知由 shell 工具在
服务端进程内直接产生，插件只能事后取消。要根治需要上游支持按通知 ID 预先取消或在
投递前拦截。

### 为什么不写一条"已终止"消息到会话里

任何写入会话的内容都可能被 steer 进正在执行的回合从而抵达模型。
`resume: false` 只阻止会话**空闲时**启动新执行，挡不住运行中回合的注入。
因此设计上不写任何"已终止"内容，而是把原完成通知整条取消——这是在现有插件能力下
最接近"绝不唤醒"的做法，但仍受上述竞态限制。代价是被终止的任务不会出现在对话记录
中——它的记录在 `/tasks` 面板里。

## 八、排查

* 插件状态：`opencode plugin list`，或在 TUI 中打开插件管理器。
* 加载失败详情：`\~/.local/share/opencode/log/opencode.log`。
* 服务端工具报"registered service is not the server running this session"：
说明当前用的是私有服务器（`--standalone`），任务管理不可用。
* 终止后会话里仍出现 `Shell.NotFoundError` 形式的合成通知：拦截输给了投递竞态
  （见第七节）。任务与面板记录不受影响，属已知限制而非故障。
* 面板/弹窗文字全部变成默认白色：多半是 OpenCode 升级后主题令牌改名。v2 的令牌为
  `text.base`（正文）、`text.muted`（次要文字）、`text.feedback.<info|success|warning|error>.base`
  （状态色）与 `scrollbar.base`；`tui.tsx` 若仍引用旧名（如 `text.default`、`text.subdued`），
  取到 `undefined` 就会退化为默认白色。
* `/tasks` 弹窗内容异常变长：弹窗宿主只限制宽度，高度需要插件自己约束。列表与输出框
  已按终端高度分配行数并各自滚动；若仍溢出，检查 `tui.tsx` 中的 `DIALOG_CHROME_ROWS`
  余量是否被新增的固定内容行吃掉。
* 输出框不自动更新或长时间停在 `output · loading…`：运行中任务的输出靠 1 秒轮询跟随
  （新输出没有自己的事件）。若标题出现 `unable to read; retrying…` 说明请求在重试；
  若很快变成 `retained log`，说明服务端记录已被删除，视图已切换到磁盘日志——两者都是
  正常状态而非故障。
* `status` / `kill` 总是报 "no longer known to the server" 而任务明明在跑：
  先确认插件发出的 location 正确（`x-opencode-directory` 头 + `location[directory]`）。
  `?directory=` 不是有效参数，服务端会静默回落到自己的工作目录，注册表因此看起来是空的。
  这是 v2.0.8 之后最容易被误判为"上游不支持"的现象。
* 想确认服务端到底登记了什么（用真实 HTTP 复现）：

  ```bash
  URL=$(python3 -c "import json;print(json.load(open('$HOME/.local/state/opencode/service.json'))['url'])")
  PASS=$(python3 -c "import json;print(json.load(open('$HOME/.local/state/opencode/service.json'))['password'])")
  curl -s -u "opencode:$PASS" -H "x-opencode-directory: $(python3 -c "import urllib.parse;print(urllib.parse.quote('$PWD',safe=''))")" \
    "$URL/api/shell" | head -c 400
  ```