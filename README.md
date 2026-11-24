# Terror of Sky

- `index.html` 是可直接打开的单机版。
- `lobby/` 是联机大厅，可和 `index.html` 一起由静态站点托管。服务地址及入口在 `lobby/config.js` 设置。
- `server/` 是独立命令行服务端。Windows x64 发布包解压后用 `start-server.cmd` 启动。 [部署说明](server/README.md)

## 本地开发

使用 Node.js 22 或更高版本。从源码启动服务端：

```powershell
cd server
npm.cmd ci
node server.mjs
```

在项目根目录另开终端，用 Python 3 启动静态预览：

```powershell
py -m http.server 8080 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8080/lobby/`。Linux 或 macOS 上可使用 `npm` 和 `python3` 运行对应命令。大厅网页和 WebSocket 服务各自监听一个端口。

## 当前联机范围

大厅采用房间码邀请，单房间最多 8 人。每侧 4 个席位，玩家可换队并选择 F-15A 或 Su-27。准备阶段中，换队、换机或掉线会取消该玩家的准备。玩家短时掉线后可恢复席位，房主退出后会转移权限。

两队都有人且所有玩家均准备后，房主可开局。双方进入同一张多佛白崖地图，空位由 AI 补齐。玩家键位和单机一致，服务端统一计算飞行、雷达、武器和胜负。按 Esc 可回大厅，房主可以结束本局或在对局结束后返回准备。

房间和对局保存在内存中，服务重启会清空。联机开局需要服务端 0.2.0 或更新版本。

修改飞行或战斗规则时编辑 `server/simulation.mjs`，随后运行 `node tools/embed-simulation.mjs` 更新单文件游戏。
