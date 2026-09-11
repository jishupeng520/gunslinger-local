# 神枪手 · Gunslinger

可爱的双人在线躲子弹小游戏：输入同一个房间码即可开战。`A/D` 左右移动，`W/S` 上下移动，鼠标点击或 `Space` 发射慢速星星子弹。

## 本地运行

```bash
npm install
npm start
```

浏览器打开 <http://localhost:3000>，两个人输入同一个房间码加入。

## 部署到 Render

将 `gunslinger-local` 作为独立仓库（或 Root Directory）连接到 Render，`render.yaml` 已包含 Node Web Service 配置。Render 会自动使用 `npm ci` 和 `npm start`，WebSocket 使用同域 `/ws`，无需额外环境变量。

房间状态保存在单实例内存中，适合演示和小规模临时对战；免费实例休眠或重启后房间会失效，页面会提示重新连接。
# gunslinger-local
# gunslinger-local

## 实时同步策略

服务端以约 30Hz 运行权威物理循环；客户端输入按约 30Hz 发送并带有递增序号。客户端会先预测自己的移动，收到服务端快照后按确认序号重放未确认输入并平滑校正，对手位置使用插值显示。这样可以降低正常网络下的操作等待，但 Render 实例与玩家距离、免费实例休眠仍会影响实际 RTT。
