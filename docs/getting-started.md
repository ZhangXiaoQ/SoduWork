# 从零运行 SoduWork

**简体中文** · [English](getting-started.en.md) · [返回 README](../README.zh-CN.md) · [开发指南](development.md)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

第一次使用只需要走完「装环境 → 解压 → 启动 → 登录」。这个入口在当前电脑运行 Hub（后台服务）、浏览器管理端和桌面客户端，使用独立 SQLite 数据库。没有服务器也可以体验。

## 装环境、解压、启动

1. 安装 [Python 3.12+](https://www.python.org/downloads/) 和 [Node.js 22.19+](https://nodejs.org/)。Windows 安装 Python 时勾选 **Add Python to PATH**；Node 安装保留默认选项及 npm。安装完成后关掉旧终端。
2. 下载源码 ZIP，选择「全部解压」。建议放到自己有写入权限的普通目录，例如 `C:/SoduWork`；不要放进系统程序目录，也不要在 ZIP 里直接运行。
3. 打开包含 `README.md`、`start.py`、`client` 的目录，按系统启动：

   | 系统 | 默认入口 |
   | --- | --- |
   | Windows | 双击 `start-desktop.cmd` |
   | macOS | 双击 `start-desktop.command` |
   | Linux 图形桌面 | 在该目录打开终端，运行 `sh start.sh --desktop` |

4. 第一次为账号 `admin` 设置自己的密码，长度 **12–128 个字符**，再输入一次确认。密码输入时没有字符或星号；输入完按回车即可。输错会提示重新输入，不需要关闭窗口。之后启动不会重新设置密码。
5. 保持窗口打开。启动器自动安装依赖、构建管理页面、准备数据库并打开客户端。首次依赖下载可能耗时数分钟；长步骤每隔约 15 秒显示仍在进行。可以从窗口打印的 `startup.log` 路径查看详情。

不需要手动创建数据库、安装 Docker、安装 Git、准备 `.env` 或分别运行三个工程的安装命令。首次需联网下载依赖，后续复用已安装内容。

Windows 桌面启动还会在本实例的应用副本中准备并校验命令运行环境（PortableGit），供 Agent 使用 Bash、Git 和常用命令。无需单独安装 Git 或配置 WSL。后续启动会保留运行环境和下载缓存，并再次检查可用性；准备失败时查看 `startup.log`，修复网络后重跑同一入口。

## 怎么判断启动成功

终端会出现以下关键信息（地址以实际输出为准）：

```text
SoduWork is ready: http://127.0.0.1:18989
Administrator: admin
启动成功！管理页面：http://127.0.0.1:18989
```

随后出现浏览器页面和桌面客户端：

- 浏览器默认先显示介绍首页，点击 **「进入管理后台」**才是登录页面；无需在首页再下载客户端。
- 两个界面都用 **`admin` + 自己刚设置的密码**。这是本地实例的账号，不是线上服务账号；不需要额外注册。
- 浏览器没有自动打开时，手动访问 [http://127.0.0.1:18989](http://127.0.0.1:18989)。更换端口后使用终端打印的新地址。
- 联动桌面客户端已经连接本次启动的本地服务，使用独立的桌面配置目录。本机已有的正式客户端账号、服务地址和历史不会被覆盖。

首次启动完成只表示工程可以使用。要让 AI 回答，还需要配置自己的模型服务。

## 发出第一条 AI 消息

已经保存 API Key 时，从第 3 步继续：还需添加具体的对话模型，再回到桌面端选择 Pi 和这个模型。浏览器管理端完成配置，桌面端发起对话；两端必须连接同一个 Hub。

先准备模型服务商提供的 **接口地址、API Key、模型 ID**。这些是服务商给你的资料，不能用本地管理员密码代替。真实模型调用可能产生服务商费用。

1. 在浏览器登录管理端，打开 **「能力配置 → 模型目录」**，点 **「接一个服务」**。
2. 按下表填写并保存：

   | 字段 | 怎么填 |
   | --- | --- |
   | 标识 | 自己起一个英文标识，例如 `my-provider` |
   | 名字 | 自己看得懂的名称，例如「我的模型服务」 |
   | 协议 | 按服务商说明选择；只有支持 OpenAI 兼容接口时才选「OpenAI 兼容」 |
   | 接口地址 | 服务商提供的基础地址；OpenAI 兼容服务通常包含 `/v1`，不要把完整 `/chat/completions` 路径填进来 |
   | API Key | 自己的服务密钥；仅在服务确实不需要鉴权时留空 |

3. 在该服务卡片点 **「加模型」**，填写服务商给出的准确模型 ID，选择 **「对话模型」**并保存。自定义显示名称不等于模型 ID。
4. 回到桌面端，打开新对话，选择一个**已就绪的执行底座**和刚添加的模型。若界面提示底座未安装或未登录，按提示完成该底座的准备，再继续。第一次不用接远程电脑或部署云端 Runner。
5. 输入「你好，请用一句话介绍你能做什么」。能收到真实回复，才表示这条 AI 链路已接通。

看不到刚添加的模型时，刷新模型目录或重新打开桌面端的模型选择器；仍为空时，核对两端连接的服务地址是否一致。`401/403` 通常需检查模型密钥及访问权限，`404` 需检查接口地址、模型 ID 和协议。没有模型服务时，可以先使用管理页面，稍后再接入。

## 第二次启动和退出

- 下次仍双击原启动文件，用原账号密码登录；数据和已配置的模型会保留。
- 退出时在启动终端按 **Ctrl+C**，等待停止提示。桌面窗口的关闭按钮可能只收进托盘，需要在托盘选择「退出」才能结束应用。
- 不要重复双击；提示实例已运行时，使用已打开的启动窗口和页面。
- 更新源码前停止服务、备份整个数据目录及单独存放的桌面配置目录；再更新源码并运行同一入口。不要直接修改数据目录里的应用副本。

## 常见问题

### Windows 双击没有正常启动

先看窗口最后几行。提示找不到 Python 或 Node 时，安装上面的对应软件并重新打开启动文件。窗口会在失败时保留错误，不必反复双击。

若窗口仍一闪而过，在源码文件夹空白处右键，选择「在终端中打开」，运行：

```powershell
.\start-desktop.cmd
```

只检查环境，不安装任何依赖：

```powershell
.\start.cmd --check --desktop
```

### macOS 打不开启动文件

打开终端，输入 `cd `（末尾留一个空格），把解压后的源码文件夹拖进终端，再按回车。然后执行：

```sh
chmod +x start.command start-desktop.command start.sh
sh start.sh --desktop
```

不需要 `sudo`。Linux 桌面也可直接使用最后一条命令；没有图形桌面的 Linux 服务器改用 `sh start.sh`。

### 密码输入后屏幕没有变化

密码不显示字符或星号是正常的，输入完按回车。短于 12 个字符或两次不一致时会重新提示。账号是 `admin`；没有共享默认密码。忘记已有密码时不要删数据库，以免丢失数据。

### 安装很慢、失败或提示网络错误

长步骤的「Still running」表示安装进程尚未结束，并不代表下载已经成功。查看终端打印的 `startup.log`；检查网络、代理及 npm/Python 包下载是否可用，修正后重跑同一入口。不要删除数据目录。首次 Electron 下载也需要联网。

### 提示端口已占用

不要结束不认识的进程。在源码目录的终端改用一个空闲端口，例如：

```powershell
# Windows
.\start-desktop.cmd --port 18990
```

```sh
# macOS / Linux
sh start.sh --desktop --port 18990
```

本次浏览器地址变为 `http://127.0.0.1:18990`，联动桌面端会自动使用新地址。若该端口也被占用，换另一个空闲端口。

### 浏览器能打开，桌面端打不开

Electron 二进制文件的下载有十分钟超时限制。超时后，配置能访问的镜像或代理，再运行同一个启动命令。例如，按终端类型设置镜像。

macOS/Linux：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ sh start.sh --desktop
```

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
.\start.cmd --desktop
```

Windows 命令提示符：

```bat
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
start.cmd --desktop
```

安装器会沿用已有镜像和代理设置，并校验下载文件的摘要。慢速网络可将 `ELECTRON_DOWNLOAD_TIMEOUT` 设置为更大的秒数。下次启动会复用已安装成功的依赖。

查看同一数据目录中的 `desktop.log`。Electron 下载失败时先解决下载问题，再重试。Linux 桌面需要图形会话和 Electron 所需的系统库（如 NSS、GTK、X11/Wayland）；启动器不会关闭沙箱或自动修改系统包。

需要先看管理端时，Windows 双击 `start.cmd`，macOS 双击 `start.command`，Linux 运行 `sh start.sh`。浏览器管理端用于管理配置，不是桌面的 AI 对话工作区。

### 关闭启动窗口后页面打不开

本地服务已停止。重新运行同一个启动文件即可，数据仍在。

## 按需使用的命令

在源码根目录执行。表格使用 macOS/Linux 的启动脚本；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。

| 需要做什么 | 命令 |
| --- | --- |
| 联动启动（与双击桌面入口相同） | `sh start.sh --desktop` |
| 只启动浏览器管理端 | `sh start.sh` |
| 只检查环境 | `sh start.sh --check --desktop` |
| 提前下载和构建，暂不启动 | `sh start.sh --prepare-only --desktop` |
| 不自动打开浏览器 | `sh start.sh --desktop --no-browser` |
| 指定独立的数据目录 | `sh start.sh --desktop --data-dir "D:/SoduWork-data"` |

准备和启动应使用同一个数据目录。自动化脚本可显式用 `--password-stdin` 从标准输入提供首次密码；不要将密码写进命令参数或脚本。Windows 设置 `SODUWORK_NO_PAUSE=1` 可在失败时直接返回错误码。

开发者需要分别调试前后端时，见[开发指南](development.md)。Vite 开发代理默认连接 `http://127.0.0.1:9080`，连接本启动器时使用 `SODUWORK_DEV_HUB=http://127.0.0.1:18989`。本指南默认只供当前电脑访问；团队部署见 [Docker 自托管](../ops/self-host/README.zh-CN.md)。

## 数据放在哪里

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SoduWork\source-service` |
| macOS | `~/Library/Application Support/SoduWork/source-service` |
| Linux | `$XDG_DATA_HOME/soduwork/source-service`，未设置时为 `~/.local/share/soduwork/source-service` |

也可以明确指定独立目录和端口：

```sh
sh start.sh --data-dir "D:/SoduWork-local" --port 18990
```

目录必须位于源码目录之外，并且为空，或者已由这个启动器初始化。它不会采用源码目录中的 `.env`、数据库、个人 Agent 配置和生产环境变量。

- `soduwork.db`：用户、需求、任务、配置等业务记录。
- `local-service.json`：初始化账号名与随机生成的服务签名密钥。**请按私密配置保管**；它不包含管理员明文密码。删除或替换密钥会使已有登录失效。
- `library/`、`application/hub-backend/uploads/`：资料库和任务附件。
- `runtime/`、`home/`：此实例专用的运行目录与 Agent 配置。
- `venv/`、`application/`：独立依赖与从当前源码同步的运行副本。不要直接编辑这里的代码，业务附件应通过产品管理。
- `startup.log`：依赖安装、构建、迁移与服务器日志。
- `desktop.log` 记录联动桌面客户端的日志。桌面账号和会话配置通常位于数据目录下的 `desktop-profile/`。使用 macOS 默认数据目录时，桌面配置保存在 `~/Library/Application Support/SoduWork Development/source-service-desktop`，与正式客户端的配置目录隔离。桌面配置同样属于私密数据。

更新源码后停止并重新运行同一条命令即可，启动器只更新自己的代码副本并保留数据。更新前应在服务停止时备份**整个数据目录**及单独存放的桌面配置目录；回退时同时恢复匹配版本的源码和数据备份，不能只降低源码版本。

## 开发者验证

快速检查隔离、失败恢复、端口占用和密码处理：

```sh
python3 -m unittest tools.dev.test_start_local
```

真实隔离启动验证（会在临时目录安装依赖、构建管理端、创建数据库和做 HTTP 检查，需要网络）：

```sh
python3 tools/dev/verify_local_start.py
```

在有图形桌面的系统上加 `--desktop`，可同时验证原生 Electron 启动、专用服务地址，以及 Ctrl+C / 关闭启动器后的桌面进程清理。

该验证不使用已有 `.venv`、前端 `node_modules/dist`、业务数据库或默认端口 9080，不调用付费模型；不会把接口夹具测试声称为真实模型交付验证。

桌面客户端的首次连接与切换回归，在 `client` 目录运行 `node e2e/hub-connection.cjs`。它使用独立 Electron 配置目录、操作系统加密存储与两个临时 HTTP 服务，验证离线修改地址、登录、切换后身份隔离、回到原服务和重开窗口。截图和回执在 `outputs/hub-connection/`；不连接原有后台或调用模型。这项检查也已加入 `npm run test:e2e:local`。
