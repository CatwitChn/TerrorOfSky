# Terror of Sky 命令行服务端

## Debian 12 和 CentOS Stream 10 部署

先把游戏子域名解析到服务器公网地址，例如 `play.catwitchn.cn`。在云安全组或外部防火墙放行 TCP 80 和游戏的 HTTPS 端口，默认 443。服务器使用 Git 拉取同一版本的大厅和联机服务。

在 Debian 12 上运行以下命令。已经登录为 root 时可以直接运行命令。

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/CatwitChn/TerrorOfSky.git
cd TerrorOfSky
sudo bash tools/deploy-linux.sh --domain play.catwitchn.cn
```

Debian 12 的软件源提供 Node.js 18。脚本会下载并校验官方 Node.js 24，并安装到 `/opt/tosky`。也可以把 `tools/deploy-linux.sh` 复制到服务器后直接运行，脚本会自行安装 Git 和拉取仓库。 [Debian Node.js 软件包](https://packages.debian.org/bookworm/nodejs)

CentOS Stream 10 可以继续使用原部署命令。

```bash
sudo dnf install -y git
git clone https://github.com/CatwitChn/TerrorOfSky.git
cd TerrorOfSky
sudo bash tools/deploy-centos.sh --domain play.catwitchn.cn
```

脚本支持 x86_64 和 ARM64。它安装锁定的 npm 依赖，下载并校验指定版本的 Caddy，然后注册 `tosky-game.service` 和 `tosky-proxy.service`。Node.js 监听 `127.0.0.1:3000`。Caddy 公布独立的静态目录，验证 `/ws` 的浏览器来源后再代理。游戏和代理各自以低权限运行。已有程序占用 TCP 80、配置的 HTTPS 端口或 Node.js 端口时，脚本会报出占用情况。

如果服务器通过 firewalld 管理入站规则，先用 `sudo firewall-cmd --get-active-zones` 查看公网网卡的区域，再传入对应的 `--firewall-zone`。例如 `--firewall-zone public` 会放行该区域的 HTTP 和 HTTPS。也可以用 `--port 3100` 指定联机服务的本机端口。

如果 443 已被占用，可以使用 `--https-port 8443`。放行公网 TCP 80 和 8443，然后访问 `https://play.catwitchn.cn:8443/`。证书签发和续期仍通过 TCP 80 验证。使用 `--firewall-zone` 时，脚本会为指定区域放行 TCP 80 和所选 HTTPS 端口。[ACME 验证端口](https://letsencrypt.org/docs/challenge-types/)

使用默认端口时，部署后打开 `https://play.catwitchn.cn/`。如果脚本提示证书仍在等待验证，检查 DNS、80 和所选 HTTPS 端口的外网连通性，以及 `sudo journalctl -u tosky-proxy -n 50`。通过浏览器从外网进入大厅并建房即可验证 WebSocket 链路。

更新时再次运行相同的部署命令即可。默认拉取 `master`，可用 `--ref` 指定分支、标签或提交。切换版本会重启对局服务并结束当前房间。部署保留本地版本目录，启动检查失败时会尝试恢复上一版。

### 自动更新

在 Linux 上部署时加 `--auto-update`，并保留这台服务器原来的域名和端口参数。

```bash
sudo bash tools/deploy-linux.sh --domain play.example.com --auto-update
```

`tosky-update.timer` 每五分钟检查部署分支。发现新提交后先准备发布文件，再提示维护并等待已开局的对战结束。更新会重启服务，等待中的房间需要重建。启动或 HTTPS 检查失败后会恢复上一版，回滚过的提交可通过手动部署重试。定时任务使用安装时的部署脚本，升级脚本时重新执行上面的命令。运行 `sudo journalctl -u tosky-update -n 60` 查看记录，或用 `sudo systemctl disable --now tosky-update.timer` 停止后续自动检查。

## Windows Server 部署

### 从 GitHub 启动大厅和联机服务

安装 Git for Windows 和带 npm 的 Node.js 22 或更新版本，然后在 PowerShell 中运行以下命令。

```powershell
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/CatwitChn/TerrorOfSky/master/tools/deploy-windows.ps1' -OutFile .\deploy-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-windows.ps1
```

脚本将源码和锁定的依赖安装到 `%LOCALAPPDATA%\TerrorOfSky`，服务就绪后会在终端打印大厅地址，默认为 `http://127.0.0.1:3000/lobby/`。按 `Ctrl+C` 停服，再次运行会拉取更新并启动。可以用 `-InstallDirectory` 更换安装目录，用 `-Port` 更换监听端口。要让局域网玩家加入，用 `-BindAddress` 指定服务器的局域网 IP，并在 Windows 防火墙允许该局域网访问所选端口。

从已有的项目目录启动当前代码时，在项目根目录运行以下命令。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy-windows.ps1 -UseCheckout
```

接已有的 HTTPS 反向代理时，在启动命令后加 `-PublicUrl https://play.example.com:8443`。代理需要将网页和 `/ws` 转发到 `127.0.0.1:3000` 并保留 WebSocket 的 `Origin` 请求头。

### 使用 Windows x64 服务端 ZIP

Windows x64 发布包自带 Node.js 和 WebSocket 依赖。将 `terror-of-sky-server-0.7.0-windows-x64.zip` 上传到服务器，在 PowerShell 中解压并启动。Node.js 24 的官方 Windows x64 支持范围从 Windows Server 2016 起。 [Node.js 平台支持表](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)

```powershell
Expand-Archive -LiteralPath .\terror-of-sky-server-0.7.0-windows-x64.zip -DestinationPath .
Set-Location .\terror-of-sky-server-0.7.0-windows-x64
.\start-server.cmd --host 127.0.0.1 --port 3000 --origin https://play.example.com
```

`--origin` 填写大厅网页的协议、域名和非默认端口。可重复使用 `--origin` 配置多个站点。服务器上的反向代理可以转发到 `127.0.0.1:3000`。需要让局域网客户端直接访问时，将 `--host` 改为 `0.0.0.0`，并将 `--origin` 设为实际使用的大厅站点。监听地址、端口和站点列表也可通过环境变量 `HOST`、`PORT` 和 `LOBBY_ORIGINS` 设置，多个站点用逗号分隔。运行 `.\start-server.cmd --help` 可查看参数。

`/ws` 提供大厅与对局 WebSocket。另开 PowerShell 窗口运行 `Invoke-RestMethod http://127.0.0.1:3000/healthz` 可检查服务状态，成功时返回 `ok`。服务在终端前台运行，可按 `Ctrl+C` 关闭。房间和对局存储在内存中，重启会清空。

## 接入单独托管的大厅

将 `lobby/` 和 `index.html` 一起发布到 `https://play.example.com`，并将 `server/flight-model.mjs` 复制到发布目录中的 `lobby/flight-model.mjs`。大厅地址为 `https://play.example.com/lobby/`。在 `lobby/config.js` 中填写服务端的公网地址。

单独托管时，发布前在仓库根目录生成大厅显示的版本文件。版本号来自 `server/package.json`。

```sh
node -e "require('node:fs').writeFileSync('lobby/version.json', JSON.stringify({ version: require('./server/package.json').version }))"
```

当前服务端使用第 11 版协议。更新服务端时一并发布新版大厅和战场页面。

```js
export const serverUrl = 'wss://game.example.com/ws';
export const battleUrl = '../index.html';
```

使用 HTTPS 的大厅通过 WSS 连接服务端。若使用 Caddy 作为入口，可将 WebSocket 请求转发到本机端口。 [Caddy 反向代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)

```caddyfile
game.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

示例中的 `play.example.com` 和 `game.example.com` 分别换成你的网页和服务地址。

## 从源码打包

在 Windows 上进入仓库的 `server/` 目录，运行以下命令生成 `dist/` 下的 Windows x64 ZIP。

```powershell
npm.cmd ci --omit=dev
node .\package-windows.mjs
```

也可生成通用 `.tgz` 发布包。通用包在已有 Node.js 22 或更高版本的环境中运行 `node server.mjs`。

```sh
npm ci --omit=dev
npm pack
```

生成的 `.tgz` 包含服务端和已锁定的 WebSocket 依赖。 [npm 打包依赖文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bundledependencies)
