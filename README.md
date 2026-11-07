# pi-websocket

Pi 的网页客户端：通过 WebSocket 在浏览器里继续当前 Pi 会话，查看实时回复、收发图片与文件，并执行受限的会话控制。

> **这是远程操作入口，不是只读分享页面，也不是权限沙箱。** 能登录的人可以向 Pi 发送任务；Pi 仍以宿主进程的系统权限执行。请先阅读 [SECURITY.md](SECURITY.md)。

## 功能

- **双向聊天**：网页输入发送到当前 Pi，会话忙碌时可选择 steer 或 followUp。
- **实时显示**：消息级事件、可选流式文字/思考增量、工具调用与最终结果。
- **近期历史回放**：新连接和重连收到当前分支的一段历史；不是所有会话的管理列表。
- **主题与页面体验**：同步 Pi 主题，Markdown/表格、断线退避重连、滚动跟随与跳到最新。
- **双向文件传输**：网页上传图片/附件；AI 调用 `send_image_to_web`、`send_file_to_web` 发布允许目录中的文件。
- **会话控制**：查看状态、选择模型和思考强度、选择工具、压缩上下文、重载或新建会话。
- **邮箱验证码登录**：邮箱白名单、邮件 OTP、会话 Cookie、限速与临时封禁。

本插件运行在 Pi 进程中，不是独立模型服务。多个已登录客户端共享同一个 Pi 会话，没有按用户隔离的工作区或权限体系。

## 环境要求

- Node.js 22.19 或更新版本。
- 已安装并配置好模型的 Pi（`@earendil-works/pi-coding-agent`）。
- 一个可用的 SMTP 邮箱及应用专用密码/授权码。

运行依赖是 `ws`；Pi 提供自身扩展 API 和 `typebox`。源码测试另需 `jiti` 与本地开发用 `typebox`。没有数据库依赖。

## 从源码开始

以下命令以 Bash 为例；在解压或克隆得到的包目录中执行：

```bash
# 不执行依赖安装脚本，也不额外安装一套 Pi peer dependency
npm install --ignore-scripts --legacy-peer-deps

# 复制样例；所有账号、服务器与密码都是占位符，必须自行填写
cp pi-websocket.config.example.json pi-websocket.config.json
chmod 600 pi-websocket.config.json
```

编辑配置中的 `adminEmails` 和 `smtp`，再加载：

```bash
pi --extension .
```

打开 <http://localhost:18100/>，使用白名单邮箱获取验证码并登录。SMTP 必须由你自行配置，示例地址不会代发邮件。

持久加载可使用 `pi install /path/to/pi-websocket`，或项目级 `pi install /path/to/pi-websocket --local`。本地目录不会自动安装依赖，请先完成上述 `npm install`。

从打包产物安装时，安装本地 `.tgz` 后由 Pi 加载其目录，或在正式发布到 npm 后使用 `pi install npm:pi-websocket`。本 README 不代表同名包已经发布，也不保证 npm 名称/版本仍可用；请在发布前核实。

## 配置

查找顺序为第一个存在的文件：

1. 环境变量 `PI_WS_CONFIG` 指定的文件；
2. 包根目录的 `pi-websocket.config.json`；
3. `~/.pi/pi-websocket.config.json`。

最小示例：

```json
{
  "adminEmails": ["admin@example.com"],
  "smtp": {
    "host": "smtp.example.com",
    "port": 465,
    "secure": true,
    "starttls": false,
    "user": "mailer@example.com",
    "pass": "YOUR_SMTP_APP_PASSWORD",
    "from": "mailer@example.com",
    "fromName": "pi-websocket"
  },
  "allowExec": [],
  "publishRoots": []
}
```

完整选项见 [pi-websocket.config.example.json](pi-websocket.config.example.json)。不要提交真实配置。

- `secure: true` 通常用于隐式 TLS（465）；587 通常配合 `secure: false, starttls: true`，以邮箱服务商要求为准。
- `allowExec` 默认空数组：关闭网页命令通道的直接程序执行。**这不限制 AI 通过 Pi 已有工具执行任务。**
- `publishRoots` 默认空数组：文件发布只允许当前会话工作目录；数组用于额外放行目录，不建议设置为整个主目录或磁盘根目录。
- `fileStoreDir` 未配置时使用用户目录下的 `.pi/pi-websocket-files`。上传和发布的文件及其元数据会落盘，按 TTL/配额回收；这与内存态登录信息不同。
- `historyEntries` 默认 200、上限 1000；`historyByteBudget` 默认 1500000、上限 8388608，实际按 JSON 字符长度计算。极大单条记录仍可能保留最近一条；这些是体积控制，不是隐私过滤。
- 配置缺失或必填字段不全时不监听端口（fail-closed）。配置权限过宽会告警；仍应自行做好权限与网络边界。

| 环境变量 | 说明 |
|---|---|
| `PI_WS_CONFIG` | 配置文件路径 |
| `PI_WS_PORT` | 监听端口，默认 18100；`--ws-port` 优先 |
| `PI_WS_AUTH` | 默认 `on`；显式 `off` 会关闭鉴权，危险，见安全说明 |

```bash
PI_WS_CONFIG=/path/to/private-config.json pi --extension . --ws-port 18100
```

**服务器当前默认绑定所有网卡，而不是只绑定 localhost。** 关闭鉴权不会自动限制监听范围；不要把无鉴权实例暴露到局域网或公网。反向代理部署应使用 HTTPS、可信代理边界与独立的入口访问控制。

## 使用与控制

Pi 命令：

| 命令 | 用途 |
|---|---|
| `/ws` | 当前服务器状态与连接信息 |
| `/ws-start` | 启动网页服务 |
| `/ws-stop` | 停止网页服务 |
| `/piws reload` / `/piws new` | 内部会话控制桥接命令 |

网页提供状态、压缩、重载、新建会话，以及模型/思考强度选择。命令通道支持：

- `state`、`files`、`commands`、`models`；
- `model_set`、`thinking_set`、`tools_get`、`tools_set`；
- `compact`、`reload`、`new`；
- `exec` / `bash`（默认拒绝，仅配置 `allowExec` 后允许匹配的可执行程序）。

`reload`、`new` 要求客户端明确确认。会话、验证码及封禁状态保存在当前进程内；重启/重载后需要重新登录。修改网页静态文件后，需要重新启动网页服务才能重新读取文件。

工具运行过程的完整增量日志不是当前版本的保证能力；主要展示调用与最终结果。

## 图片与文件

### 浏览器 → Pi

使用附件按钮或粘贴图片上传。受支持且未超过模型转发大小限制的图片作为图片内容块进入 Pi；普通文件则提供本机路径，让 AI 在需要时读取。输入内容和附件仍属于当前共享会话。

### Pi → 浏览器

插件注册两个模型工具：

- `send_image_to_web({ imagePath, fileName? })`：图片预览；
- `send_file_to_web({ filePath, fileName? })`：下载文件。

只允许会话 cwd 或 `publishRoots` 中的目录，拒绝符号链接。文件被复制进存储区；下载需要登录，并受文件 TTL 和配额约束，**不是一次性销毁的下载链接**。

服务端做基本格式嗅探，HTML/SVG/XML 不作为可执行页面内联提供，并带 `nosniff`；这不等同于全面的恶意文件扫描。请只上传和打开可信文件。

## 协议概要

服务端事件使用 JSON：

```json
{"v":1,"t":1700000000000,"type":"hello"}
```

主要事件包括 `hello`、`history`、`history_end`、消息/流式事件、工具事件、生命周期事件、`file_ready` 与 `command_result`。

客户端示例：

```json
{"type":"subscribe","stream":true}
{"type":"user_message","text":"Hello","deliverAs":"followUp"}
{"type":"command","action":"state","id":1}
{"type":"command","action":"new","id":2,"confirm":true}
```

类型定义见 `extensions/protocol.ts`，HTTP/WebSocket 处理见 `extensions/server.ts`。

## 开发与离线测试

源码仓库包含测试；npm 运行包不包含 `test/`。

```bash
npm install --ignore-scripts --legacy-peer-deps
npm test
# 或分别运行
npm run test:auth
npm run test:history
```

测试使用 mock Pi API、虚构邮箱和本机假 SMTP，无需真实模型、邮件账号或生产会话。测试 HTTP/SMTP 只监听回环地址，使用自动分配的端口与独立临时目录，不读取用户真实配置，不递归清理公共临时路径。临时夹具会保留供排查。

测试覆盖鉴权、WebSocket、文件收发、会话控制与历史预算。离线测试不能代替真实 Pi/浏览器、Windows/macOS 或公网部署验收。

## 打包与公开发布

```bash
npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts
```

`package.json.files` 使用精确文件清单；`.gitignore` / `.npmignore` 额外排除真实配置、日志、会话、上传内容、依赖缓存与历史备份。`.tgz` 不内置 `node_modules`，消费方仍需安装依赖。

发布前检查最终压缩包，而不只是工作目录。演示截图和录屏使用虚构账号与会话，避免拍到工具输出、本机路径或凭据。

## 安全边界与许可

登录客户端可读取当前会话的消息、思考内容、工具参数和输出；插件**没有通用敏感信息自动脱敏机制**。不要把含密码/API key的真实会话当公开演示，也不要把多邮箱白名单当作多租户隔离。

更多边界见 [SECURITY.md](SECURITY.md)。MIT License，见 [LICENSE](LICENSE)。
