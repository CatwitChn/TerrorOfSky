# Terror of Sky 命令行服务端

## Windows Server 部署

Windows x64 发布包自带 Node.js 和 WebSocket 依赖。将 `terror-of-sky-server-0.6.0-windows-x64.zip` 上传到服务器，在 PowerShell 中解压并启动。Node.js 24 的官方 Windows x64 支持范围从 Windows Server 2016 起。 [Node.js 平台支持表](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)

```powershell
Expand-Archive -LiteralPath .\terror-of-sky-server-0.6.0-windows-x64.zip -DestinationPath .
Set-Location .\terror-of-sky-server-0.6.0-windows-x64
.\start-server.cmd --host 127.0.0.1 --port 3000 --origin https://play.example.com
```

`--origin` 填写大厅网页的协议、域名和非默认端口。可重复使用 `--origin` 配置多个站点。服务器上的反向代理可以转发到 `127.0.0.1:3000`。需要让局域网客户端直接访问时，将 `--host` 改为 `0.0.0.0`，并将 `--origin` 设为实际使用的大厅站点。监听地址、端口和站点列表也可通过环境变量 `HOST`、`PORT` 和 `LOBBY_ORIGINS` 设置，多个站点用逗号分隔。运行 `.\start-server.cmd --help` 可查看参数。

`/ws` 提供大厅与对局 WebSocket。另开 PowerShell 窗口运行 `Invoke-RestMethod http://127.0.0.1:3000/healthz` 可检查服务状态，成功时返回 `ok`。服务在终端前台运行，可按 `Ctrl+C` 关闭。房间和对局存储在内存中，重启会清空。

## 接入单独托管的大厅

将 `lobby/` 和 `index.html` 一起发布到 `https://play.example.com`，大厅地址为 `https://play.example.com/lobby/`。在 `lobby/config.js` 中填写服务端的公网地址。

0.6.0 服务端使用第 7 版协议。更新服务端时一并发布新版大厅和战场页面。

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
