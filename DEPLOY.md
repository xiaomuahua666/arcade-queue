# 部署教程（零基础版）

从「刚买好一台服务器」到「群里发 `万达几` 有回复」的完整流程。

**怎么用这份文档**：每一步都有「做什么 → 复制这条命令 → 应该看到什么」。
只要看到的和写的一样就继续下一步；不一样就看那一步末尾的「出错了？」。

带 `你的xxx` 字样的地方要换成你自己的东西，其余原样复制。

---

## 名词表（只需要看懂这几个）

| 词 | 意思 |
|---|---|
| VPS / 服务器 | 一台租来的、24 小时开机的远程电脑。我们的机器人住在里面 |
| SSH | 从你自己电脑连到服务器的方式，连上后你在服务器上打命令 |
| NapCat | 一个程序，负责用你的 QQ 号登录、收发群消息 |
| 本服务 | 就是这个项目，负责「看懂 `万达几` 并算出回复」 |
| 终端 | 打命令的黑框。Windows 用 PowerShell，Mac 用「终端」App |
| `#` 开头的行 | 注释，给人看的说明，复制进去也没关系 |

**整体是两个程序配合**：NapCat 管 QQ，本服务管排卡逻辑。两个都装在同一台服务器上。

---

## 你需要准备的东西

1. **一台 VPS**，Ubuntu 22.04 或 24.04 系统（最便宜的 1 核 1G 就够）
2. **一个 QQ 小号** —— 千万别用你的主号，见文末风险提示
3. 服务器的 **IP 地址** 和 **root 密码**（买的时候商家给你的）

---

## 第 1 步：连上服务器

在你自己电脑的终端里打（把 `你的IP` 换成真实 IP）：

```sh
ssh root@你的IP
```

第一次连会问 `Are you sure you want to continue connecting (yes/no)?` —— 输 `yes` 回车。
然后输密码（**输密码时屏幕不会显示任何字符，这是正常的**，输完直接回车）。

**应该看到**：命令提示符变成类似 `root@ubuntu:~#`。

> **出错了？**
> - `Connection refused` / `timed out` → IP 打错了，或服务器还没开机完（等 2 分钟重试）
> - `Permission denied` → 密码错了。注意别把密码里的字符看错（0 和 O、1 和 l）

---

## 第 2 步：装 Node.js 22

本服务需要 Node 22.5 以上版本（它内置了我们用的数据库功能）。

依次复制这几条（**一条一条来，每条等它跑完**）：

```sh
apt update
```

```sh
apt install -y curl
```

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
```

```sh
apt install -y nodejs
```

检查装好了没：

```sh
node --version
```

**应该看到**：`v22.` 或更高的版本号，比如 `v22.14.0`。

> **出错了？**
> - 显示 `v18.x` 或 `v20.x` → 版本太低，本服务跑不起来。重新执行上面的
>   `curl ... setup_22.x` 那条，再 `apt install -y nodejs`
> - `command not found: node` → 上一条 `apt install -y nodejs` 没成功，往上翻找红色报错

---

## 第 3 步：装 Docker

Docker 是用来跑 NapCat 的。

```sh
curl -fsSL https://get.docker.com | sh
```

这条要跑 1–3 分钟，会刷很多字，正常。

检查：

```sh
docker --version
```

**应该看到**：`Docker version 27.x.x` 之类。

---

## 第 4 步：下载本服务的代码

```sh
apt install -y git
```

```sh
git clone https://github.com/你的用户名/arcade-queue.git /opt/arcade-queue
```

> 如果你还没把代码放到 GitHub，可以用别的办法传上去（比如
> `scp -r 本地目录 root@你的IP:/opt/arcade-queue`）。总之最后代码要在
> `/opt/arcade-queue` 这个目录里。

进入目录：

```sh
cd /opt/arcade-queue
```

检查文件在不在：

```sh
ls
```

**应该看到**：`DEPLOY.md  README.md  deploy  migrations  package.json  public  src  test  tsconfig.json`

---

## 第 5 步：生成两个密码

本服务需要两个随机密码（叫「密钥」）：

- **ONEBOT_SECRET**：给 NapCat 和本服务对暗号用的，防止别人伪造消息
- **CONSOLE_TOKEN**：你登录管理网页的密码

生成它们：

```sh
openssl rand -hex 24
```

**应该看到**：一串 48 位的字母数字，比如 `9f2a...c71d`。

**再执行一次**，这样你有两串不同的：

```sh
openssl rand -hex 24
```

把这两串**复制到记事本里存好**，下面要用。第一串当 `ONEBOT_SECRET`，
第二串当 `CONSOLE_TOKEN`。

---

## 第 6 步：写配置文件

先复制模板：

```sh
cp .env.example .env
```

用 nano 编辑器打开（这是个简单的文本编辑器）：

```sh
nano .env
```

屏幕会变成编辑界面。用**方向键**移动光标，找到这两行：

```
CONSOLE_TOKEN=
ONEBOT_SECRET=
```

把第 5 步生成的两串密码分别贴在 `=` 后面（**等号两边不要加空格**），变成：

```
CONSOLE_TOKEN=你的第二串密码
ONEBOT_SECRET=你的第一串密码
```

> 在 nano 里粘贴：Windows 的 PowerShell 里用**鼠标右键**，Mac 用 `Cmd+V`。

**保存并退出**：
1. 按 `Ctrl + O`（字母 O，不是零）
2. 按 `回车` 确认文件名
3. 按 `Ctrl + X` 退出

检查有没有写对：

```sh
cat .env | grep -E "CONSOLE_TOKEN|ONEBOT_SECRET"
```

**应该看到**：两行都在 `=` 后面有内容，不是空的。

保护这个文件（里面是密码，只让 root 能读）：

```sh
chmod 600 .env
```

---

## 第 7 步：先手动启动，确认能跑

正式装成后台服务之前，先手动跑一次看看有没有问题：

```sh
node src/main.ts
```

**应该看到**（时间和警告内容可能略有不同）：

```
[2026-09-06 12:00:00 +08] ⚠️  监听 0.0.0.0:8787 且无 TLS：控制台密钥以明文经过网络。建议只在自己网络下使用，或后续加 nginx + HTTPS。
[2026-09-06 12:00:00 +08] 数据库已就绪：./data/arcade-queue.db
[2026-09-06 12:00:00 +08] 服务已启动：http://0.0.0.0:8787
[2026-09-06 12:00:00 +08]   OneBot 上报地址（填进 NapCat）：http://127.0.0.1:8787/onebot
[2026-09-06 12:00:00 +08]   控制台：http://<你的公网IP>:8787/
```

那条 ⚠️ 警告是**正常的、预期的**（因为我们让网页对公网开放，而没配 HTTPS）。
只要看到「服务已启动」就是成功了。

按 `Ctrl + C` 停掉它，继续下一步。

> **出错了？**
> - `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` → Node 版本太低，回第 2 步
> - `Cannot find module` → 代码没下全，回第 4 步重新 clone
> - `⚠️ 未设置 CONSOLE_TOKEN` → 第 6 步没填对，回去检查 `.env`
> - `EADDRINUSE` → 8787 端口被别的程序占了。编辑 `.env` 把 `PORT=8787` 改成 `PORT=8888`，
>   后面所有出现 8787 的地方都相应改成 8888

---

## 第 8 步：装成后台服务（开机自启、崩溃自动重启）

刚才那样跑，一关终端就停了。要让它一直跑，得装成「系统服务」。

创建一个专用账号来跑它（比用 root 跑安全）：

```sh
useradd -r -s /bin/false arcade
```

> 如果提示 `user 'arcade' already exists` 就说明已经有了，跳过继续。

建数据目录并把所有权给它：

```sh
mkdir -p /opt/arcade-queue/data
```

```sh
chown -R arcade:arcade /opt/arcade-queue/data
```

```sh
chown arcade:arcade /opt/arcade-queue/.env
```

安装服务配置：

```sh
cp deploy/arcade-queue.service /etc/systemd/system/
```

```sh
systemctl daemon-reload
```

```sh
systemctl enable --now arcade-queue
```

看它跑起来没：

```sh
systemctl status arcade-queue
```

**应该看到**：绿色的 `active (running)`。

> 这个界面不会自动退出，按 `q` 退出查看。

看日志：

```sh
journalctl -u arcade-queue -n 20 --no-pager
```

**应该看到**：和第 7 步一样的「服务已启动」。

自测一下：

```sh
curl http://127.0.0.1:8787/health
```

**应该看到**：`{"ok":true}`

> **出错了？**
> - `failed (Result: exit-code)` → 看 `journalctl -u arcade-queue -n 50 --no-pager` 的报错
> - 报 `EACCES` / `permission denied` 且提到 data 目录 → 上面的 `chown` 没做，重做一次
> - `curl: command not found` → `apt install -y curl`

---

## 第 9 步：开放防火墙端口

要让你能从自己电脑打开管理网页：

```sh
ufw allow 8787/tcp
```

```sh
ufw allow 22/tcp
```

> 第二条很重要！它保证你以后还能 SSH 连进来。**别跳过**。

如果 ufw 本来没开，可以先不开（很多 VPS 默认不装防火墙，那就跳过这步）。

**另外**：很多云服务商（阿里云、腾讯云、AWS 等）在网页控制台里还有一层
「安全组」，也要去那里放通 **8787** 端口。这一步在服务商的网页上做，不在服务器里。

---

## 第 10 步：装 NapCat（负责登录你的 QQ）

```sh
mkdir -p /opt/napcat/config /opt/napcat/ntqq
```

```sh
docker run -d --name napcat --restart=always \
  --network host \
  -e NAPCAT_UID=0 -e NAPCAT_GID=0 \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/ntqq:/app/.config/QQ \
  mlikiowa/napcat-docker:latest
```

第一次会下载镜像，2–5 分钟。

**应该看到**：最后输出一串长长的容器 ID（64 位十六进制）。

确认它在跑：

```sh
docker ps
```

**应该看到**：有一行 `napcat`，状态是 `Up X seconds`。

拿到 WebUI 的登录 token：

```sh
docker logs napcat 2>&1 | grep -i token
```

**应该看到**：类似 `WebUi Local Panel Url: http://127.0.0.1:6099/webui?token=xxxxxx`

把那个 **token 值记下来**。

> **出错了？**
> - `docker: command not found` → 回第 3 步
> - `port is already allocated` → 6099 被占了，先 `docker rm -f napcat` 再检查谁占用
> - grep 没输出 → 容器可能还在启动，等 30 秒再执行一次

---

## 第 11 步：登录你的 QQ

NapCat 的管理界面**不能暴露到公网**（它能操作你的 QQ 号）。用 SSH 隧道安全访问。

**回到你自己电脑**，开一个**新的终端窗口**（别关掉原来那个），执行：

```sh
ssh -L 6099:127.0.0.1:6099 root@你的IP
```

输密码连上。**这个窗口连着的时候隧道才有效，先别关。**

然后在你电脑的**浏览器**里打开：

```
http://127.0.0.1:6099/webui
```

**应该看到**：NapCat 的登录页面，要你填 token。

填第 10 步记下的 token → 进去后会看到一个**二维码** → 用手机 QQ（那个小号）扫码 → 手机上确认登录。

**应该看到**：网页显示已登录，有你的 QQ 昵称和头像。

> **出错了？**
> - 浏览器打不开 → 隧道那个 SSH 窗口断了，重新执行第 11 步的 ssh 命令
> - token 不对 → 重新 `docker logs napcat 2>&1 | grep -i token` 拿最新的
> - 二维码过期 → 页面上有刷新按钮，点一下

---

## 第 12 步：让 NapCat 把消息转给本服务

这是最关键的一步 —— 把两个程序接起来。

**方法 A：在网页上点（推荐新手）**

在刚才的 NapCat WebUI 里：

1. 左边菜单找 **网络配置**
2. 点 **新建** / **添加配置**
3. 类型选 **HTTP 客户端**（英文可能显示 `httpClients` 或 `HTTP Client`）
4. 按下表填：

| 字段 | 填什么 |
|---|---|
| 名称 name | `arcade-queue`（随便起） |
| 启用 enable | **开** |
| URL | `http://127.0.0.1:8787/onebot` |
| **Token** | 你的 **ONEBOT_SECRET**（第 5 步生成的第一串） |
| 消息格式 messagePostFormat | `array` |
| 上报自身消息 reportSelfMessage | **关** |

5. 保存

> ⚠️ **两个最容易搞错的地方**：
> 1. **Token 那一栏填的是 `ONEBOT_SECRET`，不是 `CONSOLE_TOKEN`**。
>    NapCat 管它叫 Token，但它就是我们的 ONEBOT_SECRET，两边必须一字不差。
> 2. **「上报自身消息」必须关掉**。开着的话机器人会看到自己发的消息，
>    可能自己跟自己对话。

**方法 B：直接写配置文件**

```sh
cp /opt/arcade-queue/deploy/napcat-onebot11.example.json \
   /opt/napcat/config/onebot11_你的QQ号.json
```

```sh
nano /opt/napcat/config/onebot11_你的QQ号.json
```

把 `"token": "把这里换成你的 ONEBOT_SECRET"` 那行的引号内容替换成真实值。
`Ctrl+O` → 回车 → `Ctrl+X` 保存退出。然后重启：

```sh
docker restart napcat
```

---

## 第 13 步：添加机厅

在你电脑浏览器打开（换成你的真实 IP）：

```
http://你的IP:8787/
```

**应该看到**：深色的「机厅排卡控制台」页面。

1. 在 **CONSOLE_TOKEN** 框里填第 5 步的**第二串**密码 → 点「进入」
   - 应该看到右下角提示「密钥有效」
2. **QQ 群号** 填你要用的群号（就是真实群号，群设置里能看到）→ 点「加载」
   - 应该看到标签变成绿色的「已启用」
3. 展开 **添加机厅**，填：
   - **名称**：比如 `万达电玩城`
   - **别名**：比如 `wd, 万达`（逗号分隔，群友打这些也能查）
   - **机台数**：这个机厅有几台机器
   - 想用天气功能就填**经纬度**；也可以用「从 Nearcade 搜店自动填」
4. 点 **添加**

**应该看到**：上方出现机厅卡片，显示 `0 人`、`尚未上报`。

> **出错了？**
> - 网页打不开 → 第 9 步的端口没放通（含服务商安全组）
> - 「密钥无效」→ 填错了，注意是 CONSOLE_TOKEN 不是 ONEBOT_SECRET
> - 「群号应当是 5–15 位数字」→ 填的不是纯数字群号

---

## 第 14 步：把机器人拉进群，测试

1. 用你的**大号**（或群主号）把刚登录的**小号**拉进那个 QQ 群
2. 在群里发：

```
排卡列表
```

**应该看到**：机器人回复「本群排卡机厅：· 万达电玩城（wd、万达）：0 人 · X 台」

再试：

```
万达几
```

**应该看到**：一段带人数、机台数、等待时间的回复。

再试上报：

```
万达8
```

**应该看到**：回复里显示 `8 人 (+8)`。

🎉 **成功了。** 到此部署完成。

> **群里没反应？** 按顺序查这三步：
>
> **① 本服务收到消息了吗**
> ```sh
> journalctl -u arcade-queue -f
> ```
> 然后在群里发一条消息。看有没有新日志。
> - **完全没动静** → NapCat 没把消息发过来。检查第 12 步的 URL 是否正好是
>   `http://127.0.0.1:8787/onebot`，以及那条配置是否 **enable**。
>   再看 NapCat 自己的日志：`docker logs napcat --tail 50`
> - **有日志但提到 401 / 签名校验失败** → 第 12 步的 Token 和 `.env` 的
>   `ONEBOT_SECRET` 不一致。两边重新对一遍（建议复制粘贴，别手打）
>
> **② 机器人在线吗**
> 私聊那个小号发消息，看它在不在线。掉线了回第 11 步重新扫码。
>
> **③ 群号对吗**
> 控制台里填的群号必须和你测试的那个群一致。发 `排卡列表` 如果回复
> 「尚未配置机厅」，说明群号填错了。

---

## 日常运维

### 看日志

```sh
journalctl -u arcade-queue -f
```

（按 `Ctrl+C` 退出）

### 重启服务

```sh
systemctl restart arcade-queue
```

### 改配置后生效

```sh
nano /opt/arcade-queue/.env
systemctl restart arcade-queue
```

### 备份数据

所有数据就是一个文件。备份前先停服务，保证写完整：

```sh
systemctl stop arcade-queue
cp /opt/arcade-queue/data/arcade-queue.db /root/backup-$(date +%F).db
systemctl start arcade-queue
```

建议定期把 `/root/backup-*.db` 下载到自己电脑：

```sh
# 在你自己电脑上执行
scp root@你的IP:/root/backup-*.db ./
```

### 更新代码

```sh
cd /opt/arcade-queue
git pull
systemctl restart arcade-queue
```

### QQ 掉线了

QQ 会不定期要求重新登录：

```sh
docker logs napcat --tail 30
```

如果提示未登录，按第 11 步重新扫码。

---

## 全部指令一览

群里可用（不需要 @ 机器人）：

| 发这个 | 效果 |
|---|---|
| `万达几` 或 `万达j` 或 直接 `万达` | 查当前人数和要等多久 |
| `万达8` | 把人数改成 8 |
| `万达+2` | 人数加 2 |
| `万达-1` | 人数减 1 |
| `predict 万达` | 等待预估 + 最近两小时趋势 |
| `weather 万达` | 查机厅那边的天气（需先填经纬度） |
| `排卡帮助` | 显示用法 |
| `排卡列表` | 显示本群所有机厅 |

（`万达` 换成你设的任意名称或别名）

---

## 可选功能

### 让人数同步到 Nearcade

Nearcade（nearcade.cn）是跨平台的机厅人数网站。配了 token 后，群里上报的人数
会同步上去，别人也能看到。

1. 去 nearcade.cn 拿一个 API token
2. 填进配置：
   ```sh
   nano /opt/arcade-queue/.env
   # 找到 NEARCADE_TOKEN= 填上去
   systemctl restart arcade-queue
   ```
3. 在控制台给机厅填上 **Nearcade 店铺 ID** 和 **机种 ID**
   （用「从 Nearcade 搜店自动填」最省事）

> 同步失败时机器人会说「同步未确认，请查卡核对，不自动重试」。
> 这是**故意的**：自动重试可能导致重复上报，污染公共数据。

### 更准的天气

不配也能用天气（走免费的 Open-Meteo）。想要更详细的数据和天气预警，
可以申请和风天气的免费 key：

```sh
nano /opt/arcade-queue/.env
# 填 QWEATHER_KEY=
systemctl restart arcade-queue
```

和风挂了会自动退回 Open-Meteo，不影响使用。

### 给控制台加 HTTPS

目前控制台是明文 HTTP，你输的密码在网络上是裸奔的。在自己家网络下用问题不大，
但如果你在外面的 WiFi 用，建议加一层 nginx + 免费证书。这需要你有一个域名。

或者更简单：把 `.env` 改成 `HOST=127.0.0.1` 再重启，这样控制台只能本机访问，
以后要用就像第 11 步那样开 SSH 隧道：

```sh
ssh -L 8787:127.0.0.1:8787 root@你的IP
# 然后浏览器开 http://127.0.0.1:8787/
```

**这不影响机器人工作**，因为 NapCat 和本服务在同一台机器上，走的是内部通道。

---

## ⚠️ 风险提示（务必读）

**用真人 QQ 号跑机器人违反腾讯的用户协议**，账号有被风控、临时冻结甚至封禁的可能。

降低风险的做法：

- **一定用小号**，绝对别用绑了支付、有重要好友关系的主号
- 别同时加入很多群、别高频发消息
- **NapCat 的 6099 端口绝不要暴露到公网**（前面用 SSH 隧道就是为这个）

这是这条路线固有的代价，代码层面无法规避。如果你完全不能接受封号风险，
应该改用 QQ 官方机器人（但官方号有它自己的限制，且需要企业/个人认证）。

---

## 附：所有配置项

编辑 `/opt/arcade-queue/.env`，改完 `systemctl restart arcade-queue` 生效。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | `0.0.0.0`=控制台公网可访问；`127.0.0.1`=仅本机 |
| `PORT` | `8787` | 端口。改了记得同步改 NapCat 里的 URL 和防火墙 |
| `DB_PATH` | `./data/arcade-queue.db` | 数据文件位置 |
| `CONSOLE_TOKEN` | 空 | 控制台密码。**空 = 控制台完全无法使用** |
| `ONEBOT_SECRET` | 空 | 与 NapCat 对暗号用。必须两边一致 |
| `NEARCADE_TOKEN` | 空 | 可选。同步人数到 Nearcade |
| `QWEATHER_KEY` | 空 | 可选。更详细的天气 |
| `ONEBOT_API_BASE` | 空 | 可选。仅主动推送需要，一般不用填 |

服务启动时会自我检查配置，有隐患会在日志里打 ⚠️ 提示。
