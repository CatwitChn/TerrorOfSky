# Terror of Sky

- `lobby/` 是游戏入口，负责建房、选边和准备。
- `index.html` 是大厅加载的战场页面，负责输入、画面和仪表。
- `server/` 是独立命令行服务端。仓库提供 Debian 12、CentOS Stream 10 和 Windows 部署脚本，以及 Windows x64 服务端打包。 [部署说明](server/README.md)

## 本地开发

使用 Node.js 22 或更高版本。首次安装依赖后，在项目根目录运行本地服务。

```powershell
npm.cmd ci --prefix server
node tools/local.mjs
```

打开 `http://127.0.0.1:8081/lobby/`。浏览器与 WebSocket 共用本机端口。可传入 `--port 8082` 指定其他端口。Linux 或 macOS 上使用 `npm` 安装依赖。

Windows 上安装依赖后可双击项目目录里的 **本地测试.cmd**，也可以用桌面的 **Terror of Sky 本地测试**。启动器会在 8081–8090 查找与当前源码一致的本地服务并复用。需要启动新版时，它会尝试关闭属于当前项目的旧版服务，再选择空闲端口打开大厅。关闭的旧服务中的房间会随之结束。

启动器可从 `.local/node/node.exe`、系统 Node.js 安装目录或 PATH 找到 Node.js。使用项目内 Node.js 时，可运行 `.\.local\node\npm.cmd ci --prefix server` 安装依赖。启动失败时窗口会保留报错，服务端日志位于 `.local/server.log`。

一个人创建房间并准备后即可开局，空位由 AI 补齐。多人测试可以从两个浏览器窗口加入同一房间。

## 当前联机范围

房主创建房间时选择任务，其他玩家用房间码加入。多佛空战为 4 对 4，对抗空位由 AI 补齐。拦截战斗机支持 1–4 人合作，一波 AI 敌机的数量与开局玩家数相同。工厂防御支持 1–4 人合作，守军需要在敌方 4 架 B-52 和 4 架护航战斗机的进攻下保住肯特工厂。

玩家可选 F-15A、Su-27 或 F-14D，并在准备前逐挂点保存兼容的导弹。三种飞机最多分别可挂 8、10、8 枚。挂载配置中也可以分配热诱弹和箔条，三种飞机分别共用 180、96、60 发。换队、换机、保存挂载或掉线会取消准备。短时掉线后可恢复席位，房主退出后会转移权限。

Su-27 搭载 R-27ER 半主动雷达弹。R-27ER 与 AIM-7M 的发射上限均为 14 km。

F-14D 的机翼随空速自动改变后掠角，雷达默认使用 TWS。`G` 切换雷达模式，`Y` 换选目标，`T` 硬锁或解锁，`Q` 切弹。AIM-54C 可在 TWS 下对选中目标发射，进入主动追踪阶段后可以独立跟踪。

按住 `F` 发射航炮，实战挂载栏显示当前备弹。弹丸速度由沿机头方向的炮口初速和发射瞬间沿航迹方向的载机速度合成。弹丸从炮口实际飞行的前 800 米内可命中，之后只显示逐渐淡出的弹迹。

己方跑道两端都支持自动进近。用 `S` 收油、`B` 开减速板，在停稳后补充燃油和弹药并维修。补给完成后按 `W` 起飞。击毁后按任意键进入观战，左键切换队友。按住 `U` 跟随当前视角所属飞机的导弹，查看速度、马赫数、转向过载、累计飞行距离和工作模式。

玩家和 AI 都从满油出发，按当前油门消耗燃油。B-52 按 55% 油门巡航。断油后飞机滑翔减速，空中空速低于 100 km/h 时触发失速坠毁。

全员准备后，房主可开始合作任务。多人对抗还要求两队都有人。服务端统一计算飞行、雷达、武器和胜负。按 Esc 可回大厅，房主可以结束本局或在对局结束后返回准备。

房间和对局保存在内存中，服务重启会清空。新版大厅和服务端使用第 12 版协议。

大厅直接显示在线玩家、公开房间和到服务端的往返延迟。填写呼号后可从房间列表加入。入门教程包含截图参考和分步实操，每一课暂停等待对应操作，完成后会显示实际结果。武器练习会等弹药命中或打空，按 Enter 或点击提示按钮继续或重试。完成教程后可继续自由练习。战斗声音默认开启。F-15A、F-14D 和 Su-27 各有独立的 RWR 提示音，座舱语音用于过载、低油量或 Su-27 来袭方位。可在战场顶部「声音」菜单静音或调节音量。

战斗中按住 Tab 查看双方名单和战绩。每次击毁计 100 分，助攻计 50 分。引导教程中的练习目标不计分。

多佛地图的雷达参数按机型配置，扫描角度表示从机头向单侧的角度。

| 机型 | 模式 | 探测距离 | 面板量程 | 扫描角度 | 扫描周期 |
| --- | --- | --- | --- | --- | --- | --- |
| F-15A | SRC、PD | 28 km | 30 km | 约 60° | 1.8 s |
| Su-27 | SRC、PD | 24 km | 30 km | 约 55° | 2.3 s |
| F-14D | SRC、PD、TWS | 32 km | 40 km | 约 65° | 1.65 s |

修改画面或 HUD 后刷新本地网页。飞行积分由浏览器和服务端共用 `server/flight-model.mjs`，机场和毁伤规则分别位于 `server/airfields.mjs` 和 `server/combat.mjs`。修改服务端规则后重启本地服务。

## 多佛地面景物

战场从本地资源 `lobby/dover-map.json.gz` 加载建筑轮廓、道路、铁路、码头、林地、灯塔和风车。屋顶材质与林地内的树木由游戏绘制，任务工厂和机场使用游戏布置。

地图数据来自 © OpenStreetMap contributors，经 VersaTiles 的第 14 级 Shortbread 矢量瓦片提取，数据按 ODbL 1.0 分发。[OpenStreetMap 版权](https://www.openstreetmap.org/copyright) · [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) · [VersaTiles 瓦片说明](https://docs.versatiles.org/basics/tilesets.html)

`tools/build-dover-map.mjs` 负责把矢量瓦片投影到游戏坐标并生成压缩资源。运行脚本需要预先准备瓦片及对应的 `tiles.json` 坐标列表，并在运行脚本的工具目录安装 `@mapbox/vector-tile`、`pbf` 和 `earcut`。开发和部署直接使用仓库中的压缩资源。

地表材质使用 `lobby/dover-landcover.bin.gz`，由 `tools/build-dover-landcover.mjs` 将 ESA WorldCover 2021 v200 重投影为约 20 米的游戏网格。脚本在生成时通过 HTTPS 读取两张原始瓦片，运行脚本的工具目录需安装 `geotiff`。

© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. [ESA WorldCover 2021 v200 (Zanaga et al., 2022)](https://doi.org/10.5281/zenodo.7254221) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## 开发计划

- [x] 在大厅显示在线人数和在线玩家的呼号列表。
- [x] 增加简单的入门教程。
- [ ] 增加任务、飞机和导弹种类。
- [x] 更新游戏内的雷达数据。
- [x] 服务器检测 Git 部署分支的新提交并自动更新。
- [x] 增加游戏声音。
