# 神枪手 · Gunslinger

可爱的 3～4 人在线躲子弹小游戏：进入大厅后可以邀请在线玩家或加入未满的房间，满 3 人自动开战。`A/D` 左右移动，`W/S` 上下移动，鼠标点击或 `Space` 发射慢速星星子弹。

## 本地运行

```bash
npm install
npm start
```

浏览器打开 <http://localhost:3000>，两个人输入同一个房间码加入。

## Docker 局域网运行

电脑安装并启动 Docker Desktop 后，在项目目录执行：

```bash
docker compose up --build -d
```

默认使用宿主机 `3000` 端口。如果该端口已被其他程序占用，可以改用例如 `3010`：

```bash
GAME_PORT=3010 docker compose up --build -d
```

确认容器状态：

```bash
docker compose ps
curl http://localhost:${GAME_PORT:-3000}/healthz
```

然后获取本机局域网 IP（macOS 常用命令如下）：

```bash
ipconfig getifaddr en0 || ipconfig getifaddr en1
```

把 `http://你的局域网IP:端口` 发给同事即可（默认端口是 `3000`，如果用了上面的示例则是 `3010`）。双方需要连接同一个 Wi-Fi 或局域网；如果 macOS 防火墙弹窗询问 Docker/Node 网络访问，请允许局域网访问。WebSocket 使用页面同源连接，不需要额外配置。

停止服务：

```bash
docker compose down
```

## 部署到 Render

将 `gunslinger-local` 作为独立仓库（或 Root Directory）连接到 Render，`render.yaml` 已包含 Node Web Service 配置。Render 会自动使用 `npm ci` 和 `npm start`，WebSocket 使用同域 `/ws`，无需额外环境变量。

房间状态保存在单实例内存中，适合演示和小规模临时对战；免费实例休眠或重启后房间会失效，页面会提示重新连接。
# gunslinger-local
# gunslinger-local

## 实时同步策略

服务端以约 30Hz 运行权威物理循环；客户端输入按约 30Hz 发送并带有递增序号。客户端会先预测自己的移动，收到服务端快照后按确认序号重放未确认输入并平滑校正，对手位置使用插值显示。这样可以降低正常网络下的操作等待，但 Render 实例与玩家距离、免费实例休眠仍会影响实际 RTT。
