# 机厅排卡 · 真人 QQ 版（OneBot v11，自托管）

用**你自己的 QQ 号**当机器人，在群里发 `万达几` 查人数、`万达+2` 报人数，与 Nearcade
双向同步，附带按需天气查询。

全部跑在你自己的 VPS 上：**运行时零第三方依赖**（只用 Node 内置模块），
数据存本地 SQLite 文件，不依赖任何云服务。

从 `maimaiDX-QueryBot` 的排卡功能移植而来，不依赖 nonebot、不依赖 QQ 官方机器人。

## 架构

```
QQ 群
  ↕ （你的 QQ 号登录）
NapCat（同一台 VPS，登号 + 收发消息）
  ↓ HTTP POST 上报事件（走 127.0.0.1，不出机器）
本服务（node，端口 8787）
  ↓ 响应体返回 {"reply": "..."}（OneBot 快速操作）
NapCat 把消息发到群里
      ↕
  SQLite 文件（机厅、别名、上报流水）
```

两个进程都在同一台机器上，事件走 loopback，**消息处理链路完全不出网**。
只有查 Nearcade / 天气时才有外部请求。

### 为什么需要 NapCat 这一层

用真人 QQ 登录需要维持长连接、做协议签名、保持在线。这活儿由 NapCat 干；
本服务只管业务逻辑与数据。两者用 OneBot v11 协议对接，将来换 Lagrange
之类的其他实现也不用改代码。

### 回复为什么不用反向调用 NapCat

OneBot 允许在上报请求的**响应体**里直接返回 `{"reply": "..."}`，客户端收到后
自己把消息发出去。所以本服务不需要知道 NapCat 的地址、不需要 access_token，
配置少一半，故障点也少一个。

只有「不依附于某条消息的主动推送」才需要反向调用，那是可选功能（配
`ONEBOT_API_BASE` 才启用），目前所有指令都是被动回复，用不到。

## 部署

**零基础请直接看 [DEPLOY.md](DEPLOY.md)** —— 从买好 VPS 到群里发出第一条
`万达几`，每一条命令都能复制粘贴，含每步的预期输出和出错怎么办。

下面是给有经验的人看的速查版。

### 0. 前置

- Node **22.5+**（需要内置的 `node:sqlite`）。检查：`node --version`
- Docker（用来跑 NapCat）

### 1. 拉代码、配环境变量

```sh
git clone <你的仓库> /opt/arcade-queue
cd /opt/arcade-queue

cp .env.example .env
# 生成两个随机密钥填进去
echo "ONEBOT_SECRET=$(openssl rand -hex 24)"
echo "CONSOLE_TOKEN=$(openssl rand -hex 24)"
```

`.env` 完整可用项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址。`127.0.0.1` = 只本机（控制台需 SSH 转发） |
| `PORT` | `8787` | 监听端口 |
| `DB_PATH` | `./data/arcade-queue.db` | SQLite 文件路径 |
| `CONSOLE_TOKEN` | 空 | 控制台密钥。**空则管理 API 全部拒绝** |
| `ONEBOT_SECRET` | 空 | 上报签名密钥，须与 NapCat 一致 |
| `NEARCADE_TOKEN` | 空 | 可选。配了才向 Nearcade 写上报 |
| `QWEATHER_KEY` | 空 | 可选。不配则只用 Open-Meteo（免 key） |
| `ONEBOT_API_BASE` | 空 | 可选。仅主动推送需要，如 `http://127.0.0.1:3000` |

启动时会自我体检，配置有隐患会打警告（比如公网监听却没配 `ONEBOT_SECRET`）。

### 2. 装成 systemd 服务

```sh
sudo cp deploy/arcade-queue.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arcade-queue
sudo systemctl status arcade-queue
journalctl -u arcade-queue -f     # 看日志
```

服务文件假定代码在 `/opt/arcade-queue`、以 `arcade` 用户运行。路径或用户不同就改
`deploy/arcade-queue.service` 里对应几行。

### 3. 装 NapCat 并登录你的 QQ

```sh
docker run -d --name napcat --restart=always \
  --network host \
  -e NAPCAT_UID=$(id -u) -e NAPCAT_GID=$(id -g) \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/ntqq:/app/.config/QQ \
  mlikiowa/napcat-docker:latest

docker logs napcat | grep -i token    # WebUI 登录 token 在日志里
```

用 `--network host` 是为了让 NapCat 能直接访问 `127.0.0.1:8787`。

WebUI 在 `6099` 端口，地址是 `http://<IP>:6099/webui`。
**别把它暴露到公网**——它能操作你的 QQ 号。用 SSH 隧道访问：

```sh
# 在你自己电脑上执行
ssh -L 6099:127.0.0.1:6099 你的VPS
# 然后浏览器打开 http://127.0.0.1:6099/webui
```

扫码登录你的 QQ。

### 4. 在 NapCat 里配 HTTP 上报

WebUI → 网络配置 → 新建 **HTTP 客户端**（httpClients）：

| 配置项 | 值 |
|---|---|
| URL | `http://127.0.0.1:8787/onebot` |
| **Token** | 与 `.env` 里的 `ONEBOT_SECRET` **完全一致** |
| 消息格式 messagePostFormat | `array` 或 `string` 都行（两种都支持） |
| 上报自身消息 reportSelfMessage | **关**（否则机器人会响应自己发的消息） |

> 注意 NapCat 这个字段叫 **Token** 而不是 Secret。它确实是用作 HMAC-SHA1
> 签名密钥的（源码：`createHmac('sha1', config.token)`，发在 `x-signature` 头里），
> 与本服务的 `ONEBOT_SECRET` 是同一个东西。

也可以直接写配置文件，见 `deploy/napcat-onebot11.example.json`。

保存并重启该配置。

### 5. 配机厅

浏览器打开 `http://<你的VPS_IP>:8787/`，填 `CONSOLE_TOKEN` 进入，
输入 QQ 群号，添加机厅（可以用 Nearcade 搜店自动填名称/坐标/机台数）。

记得开放防火墙端口：`sudo ufw allow 8787/tcp`

> 纯 HTTP 下控制台密钥是明文过网的。若在不可信网络下使用，建议加 nginx + HTTPS，
> 或改成 `HOST=127.0.0.1` 走 SSH 隧道访问控制台（这不影响 NapCat 上报，
> 因为它走的是 loopback）。

### 6. 验证

群里发 `排卡列表`。没反应按顺序查：

1. `journalctl -u arcade-queue -f` 有没有收到请求
   - 没有 → NapCat 的 URL 填错，或 NapCat 容器访问不到 127.0.0.1（检查 `--network host`）
   - 401 → `ONEBOT_SECRET` 两边不一致
2. `curl http://127.0.0.1:8787/health` 应返回 `{"ok":true}`
3. 收到请求但回 `{}` → 该群没配机厅，或群开关被关掉

## 群内指令

| 指令 | 作用 |
|---|---|
| `<别名>几` / `<别名>j` / 直接发别名 | 查人数与等待时间 |
| `<别名>5` | 把人数设为 5 |
| `<别名>+2` / `<别名>-1` | 增减人数 |
| `predict <别名>` | 等待预估 + 近 2 小时趋势 |
| `weather <别名>` | 机厅天气（需先在控制台填经纬度） |
| `排卡帮助` / `排卡列表` | 用法说明 / 本群机厅一览 |

不需要 @ 机器人（@ 了也能用，CQ 码会被剥掉）。

## 备份

数据就是一个 SQLite 文件，直接复制即可（WAL 模式下要连 `-wal`/`-shm` 一起，
或者先停服务）：

```sh
sudo systemctl stop arcade-queue
cp /opt/arcade-queue/data/arcade-queue.db ~/backup-$(date +%F).db
sudo systemctl start arcade-queue
```

## 风险提示

用真人 QQ 跑机器人**违反腾讯用户协议**，存在被风控、临时冻结或封号的可能。建议：

- 用小号，别用主号
- 别在大量群里高频发消息
- NapCat 的 WebUI 端口绝不暴露公网

这是这条路线固有的代价，代码层面无法规避。

## 与原 bot 版的差异

| 项 | bot 版 | 本版 | 原因 |
|---|---|---|---|
| 机器人身份 | QQ 官方机器人 | **真人 QQ**（NapCat 登录） | 你的要求 |
| 框架 | nonebot | 无（Node 标准库） | 只需要几条路由，框架不划算 |
| 群标识 | 内部 id ↔ namespace+openid 映射 | **真实 QQ 群号** | 少一层无用间接 |
| 存储 | 本地 SQLite | 本地 SQLite | 一样，用 `node:sqlite` |
| 天气播报 | apscheduler 定时逐群推送 | **不做** | 你明确说不用 cron |
| 天气查询 | 定时 + 群内查询 | 只有群内 `weather <别名>` | 同上 |
| 鉴权 | 论坛 OAuth + 群管理员角色 | 单个 `CONSOLE_TOKEN` | 自用工具，无用户体系 |
| 消息幂等 | 平台层去重 | `seen_message` 表 | 客户端上报超时会重发 |
| Nearcade 0 人 | 与「无数据」不区分 | 明确区分 | 修掉 bot 版已知毛边 |
| 外部故障提示 | 赋值后忘了拼进文本 | 明确显示 | 修掉 bot 版已知毛边 |

保留不动的设计（都是有意为之，别「优化」掉）：

- **Nearcade 写上报永不重试**。重试可能重复污染公共数据。失败只说「同步未确认，
  请查卡核对」，让人去核。
- **等待时间用保守公式**，不是模型：`容量=机台数×2；排队=max(0,人数-容量)；
  等待=ceil(排队/容量)×17分钟`。
- **机厅与群分离**。`shared_arcade_id` 让多群共享同一机厅的人数，但叫法、机台数、
  消息模板各群独立；历史流水不暴露其他群与上报者。
- **别名解析不到就沉默**。匹配过宽会把群里正常聊天全吃掉。

## 开发

```sh
npm install        # 只装 typescript 与 @types/node（仅开发需要）
npm test           # 187 个测试，不需要网络
npm run typecheck
npm start          # 本地起服务
```

测试策略：

- **数据层跑真 SQLite**（`openDatabase(':memory:')`，就是生产代码本身）。
  SQL 语法错、参数绑定顺序错、约束冲突、事务回滚，全在本机暴露。
- **HTTP 层起真服务器**，用真 `fetch` 打它。测得到请求体读取、header 解析、
  状态码这些真会出错的环节。
- OneBot 的 HMAC-SHA1 签名用 **`node:crypto` 独立算一遍交叉验证**，
  不是自己的期望值对自己。
- 外部依赖（Nearcade / 天气）用 `test/helpers/fetch.ts` 的桩，
  能断言「重试了几次」「降级到哪家」「请求体长什么样」。

改动后至少跑一次红验：临时把修复撤掉，确认相关测试真的变红。只见绿不见红的测试
不构成证据。

**另外别只信单测**：本项目有两个文案缺陷（`( 分钟前)` 残句、从未上报却提示
「超过 2 小时」）是单测全绿的情况下，实际启动服务发消息才发现的。改完记得
真跑一遍。

## 文件地图

| 文件 | 职责 |
|---|---|
| `src/main.ts` | 启动入口：配置 → 开库 → 起服务，含优雅退出 |
| `src/server.ts` | HTTP 路由：`/onebot`、管理 API、控制台页面、鉴权限流 |
| `src/config.ts` | 环境变量加载 + 启动自检 |
| `src/db.ts` | SQLite 封装（`node:sqlite`）+ 迁移 |
| `src/onebot.ts` | OneBot v11 适配：签名校验、CQ 码剥除、快速操作 |
| `src/handler.ts` | 指令分发（唯一把各模块缝起来的地方） |
| `src/queue.ts` | 纯逻辑：指令解析、等待估算、模板渲染 |
| `src/store.ts` | 数据访问 |
| `src/nearcade.ts` | Nearcade 客户端 |
| `src/weather.ts` | 天气双供应商 + 降级 |
| `public/index.html` | 控制台前端（单文件） |
| `migrations/0001_init.sql` | 数据库 schema |
| `deploy/arcade-queue.service` | systemd 单元文件 |
