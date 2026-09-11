/* 神枪手客户端：负责大厅、实时输入与 Canvas 绘制。 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const canvas = $('#arena'), ctx = canvas.getContext('2d');
  const lobby = $('#lobby'), game = $('#game');
  const keys = {a:false,s:false,d:false,w:false};
  const state = { socket:null, roomCode:'', name:'', playerId:null, players:[], bullets:[], walls:[], winner:null, round:0, connected:false, shooting:false, lastShot:0, reconnectTimer:null, dpr:1, aim:{x:500,y:325}, leaving:false, world:{width:1000,height:650}, reconnecting:false, renderPlayers:new Map() };
  const COLORS = ['#ff669b','#58b8e8'];

  /** 将大厅切换到游戏界面并更新房间信息。 */
  function enterGame() { lobby.classList.remove('active'); game.classList.add('active'); $('#room-label').textContent = `ROOM ${state.roomCode || '——'}`; $('#waiting-code').textContent = state.roomCode || '——'; $('#my-name').textContent = state.name || '你'; resize(); requestAnimationFrame(resize); }
  /** 将游戏界面恢复为大厅，并清理本局连接状态。 */
  function leaveGame() { state.leaving = true; clearTimeout(state.reconnectTimer); if (state.socket) state.socket.close(); state.socket = null; state.connected = false; state.reconnecting = false; state.players = []; state.renderPlayers.clear(); state.bullets = []; state.walls = []; game.classList.remove('active'); lobby.classList.add('active'); }
  /** 生成可读的六位房间码。 */
  function makeRoomCode() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
  /** 在页面顶部显示短暂的提示消息。 @param {string} message 要展示的中文提示。 */
  function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600); }
  /** 根据设备像素比调整 Canvas 内部分辨率。 */
  function resize() { if (!canvas.clientWidth) return; state.dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = canvas.clientWidth * state.dpr; canvas.height = canvas.clientHeight * state.dpr; }
  /** 向服务器发送 JSON 消息，连接断开时安全忽略。 @param {object} payload 协议消息体。 */
  function send(payload) { if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(payload)); }
  /** 打开实时连接并发送加入房间请求。 @param {string} roomCode 六位房间码。 @param {string} name 玩家昵称。 */
  function connect(roomCode, name) {
    state.leaving = false; state.roomCode = roomCode; state.name = name; enterGame();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    try { state.socket = new WebSocket(url); } catch { toast('连接失败，请稍后重试'); return; }
    state.socket.onopen = () => { state.connected = true; $('#online-count').textContent = '● 已连接'; if (state.reconnecting && state.playerId) send({type:'reconnect', roomCode, playerId:state.playerId}); else send({type:'join', roomCode, name}); state.reconnecting = false; toast('已进入房间，准备开火！'); }; 
    state.socket.onmessage = (e) => { let msg; try { msg = JSON.parse(e.data); } catch { return; } handleMessage(msg); };
    state.socket.onclose = () => { state.connected = false; $('#online-count').textContent = '○ 连接断开'; if (game.classList.contains('active') && !state.leaving) { state.reconnecting = true; toast('网络断开，正在尝试重连…'); clearTimeout(state.reconnectTimer); state.reconnectTimer = setTimeout(() => connect(roomCode, name), 1800); } };
    state.socket.onerror = () => { $('#online-count').textContent = '○ 连接异常'; };
  }
  /** 解析服务端事件、房间和状态消息，兼容扁平或 data 包裹格式。 @param {object} msg 服务端 JSON 消息。 */
  function handleMessage(msg) {
    const type = msg.type || msg.event;
    const data = msg.data || msg;
    if (type === 'welcome') { state.playerId = data.playerId || data.id; return; }
    if (type === 'room' || type === 'joined') {
      state.roomCode = data.roomCode || state.roomCode; state.playerId = data.playerId || state.playerId; state.world = data.world || state.world;
      state.walls = data.walls || state.walls; updatePlayers(data.players || []); toggleWaiting((data.status || '').toLowerCase() !== 'playing' && (data.players || []).length < 2); return;
    }
    if (type === 'state' || type === 'game_state') { state.round = data.round || state.round; state.bullets = Array.isArray(data.bullets) ? data.bullets : Object.values(data.bullets || {}); state.walls = data.walls || state.walls; state.world = data.world || state.world; updatePlayers(data.players || []); state.winner = data.winner ?? null; if (state.winner) showResult(state.winner); else $('#result').classList.add('hidden'); toggleWaiting(state.players.length < 2); return; }
    if (type === 'event' || type === 'message') { if (data.message) toast(data.message); if (data.event === 'start' || data.event === 'round_start') toast('开战！'); if (data.event === 'win' || data.event === 'round_end') showResult(data.winner); return; }
    if (type === 'error') { $('#lobby-msg').textContent = data.message || '房间操作失败'; toast(data.message || '操作失败'); }
  }
  /** 更新玩家列表，并刷新双方昵称与生命显示。 @param {Array<object>|object} list 服务端返回的玩家数组或字典。 */
  function updatePlayers(list) { list = Array.isArray(list) ? list : Object.values(list || {}); state.players = list; const me = list.find(p => p.id === state.playerId) || list.find(p => p.name === state.name); const opp = list.find(p => p !== me); if (me) { state.playerId = me.id || state.playerId; $('#my-name').textContent = me.name || state.name; $('#my-hearts').textContent = hearts(me.hp ?? me.health ?? 3); } if (opp) { $('#opp-name').textContent = opp.name || '对手'; $('#opp-hearts').textContent = hearts(opp.hp ?? opp.health ?? 3); $('#opp-avatar').textContent = (opp.name || '?').slice(0,1).toUpperCase(); } else { $('#opp-name').textContent='等待中'; $('#opp-hearts').textContent=''; }
  }
  /** 将生命值转换成三个爱心图标。 @param {number} hp 当前生命值，范围 0 至 3。 @returns {string} 爱心字符串。 */
  function hearts(hp) { hp = Math.max(0, Math.min(3, Number(hp))); return '♥ '.repeat(hp) + '♡ '.repeat(3-hp); }
  /** 控制等待遮罩，在第二位玩家加入后自动隐藏。 @param {boolean} show 是否显示等待层。 */
  function toggleWaiting(show) { $('#waiting').classList.toggle('hidden', !show); }
  /** 显示胜负结果动画。 @param {string|number} winner 获胜玩家标识。 */
  function showResult(winner) { const won = String(winner) === String(state.playerId) || winner === state.name || winner === 'me'; $('#result-title').textContent = won ? '胜利！' : '再接再厉'; $('#result-sub').textContent = won ? '你是今天的糖果之王' : '下一发子弹，扭转局势'; $('#result').classList.remove('hidden'); }

  /** 发送当前按键、瞄准点和射击状态给服务端。 @param {{x:number,y:number}=} aim 服务端世界坐标中的瞄准点。 */
  function sendInput(aim) { if (aim) state.aim = aim; send({type:'input', keys:{...keys}, shoot:state.shooting, aim:state.aim}); }
  /** 将浏览器画布坐标转换为服务端世界坐标，保证瞄准方向在不同屏幕上一致。 */
  function pointerAim(ev) { const r = canvas.getBoundingClientRect(); return {x:(ev.clientX-r.left)/r.width*state.world.width, y:(ev.clientY-r.top)/r.height*state.world.height}; }
  canvas.addEventListener('pointermove', e => { if (state.connected) sendInput(pointerAim(e)); });
  canvas.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); state.shooting = true; sendInput(pointerAim(e)); });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('pointerup', () => { if (state.shooting) { state.shooting = false; sendInput(); } });
  window.addEventListener('keydown', e => { const k=e.key.toLowerCase(); if (k in keys) { keys[k]=true; sendInput(); } if (e.code==='Space') { e.preventDefault(); state.shooting=true; sendInput(); } });
  window.addEventListener('keyup', e => { const k=e.key.toLowerCase(); if (k in keys) keys[k]=false; if (e.code==='Space') state.shooting=false; sendInput(); });
  document.querySelectorAll('.touch-controls button[data-key]').forEach(btn => { const k=btn.dataset.key; const on=e=>{e.preventDefault();keys[k]=true;sendInput()}; const off=e=>{e.preventDefault();keys[k]=false;sendInput()}; btn.addEventListener('pointerdown',on); btn.addEventListener('pointerup',off); btn.addEventListener('pointerleave',off); });
  $('#touch-shoot').addEventListener('pointerdown', e=>{e.preventDefault();state.shooting=true;sendInput()}); $('#touch-shoot').addEventListener('pointerup', e=>{e.preventDefault();state.shooting=false;sendInput()});
  $('#create-btn').onclick = () => { const name=($('#nickname').value||'小神枪').trim(); const code=makeRoomCode(); $('#room-code').value=code; $('#lobby-msg').textContent=''; connect(code,name); };
  $('#join-btn').onclick = () => { const name=($('#nickname').value||'小神枪').trim(); const code=($('#room-code').value||'').trim().toUpperCase(); if(code.length!==6){$('#lobby-msg').textContent='请输入 6 位房间码';return} $('#lobby-msg').textContent=''; connect(code,name); };
  $('#leave-btn').onclick = leaveGame;
  $('#restart-btn').onclick = () => { state.winner=null; $('#result').classList.add('hidden'); send({type:'restart'}); };
  $('#copy-code').onclick = async () => { try { await navigator.clipboard.writeText(state.roomCode); toast('房间码已复制'); } catch { toast(`房间码：${state.roomCode}`); } };
  window.addEventListener('resize', resize);
  // 房间切换和移动端旋转都可能改变竞技场尺寸，持续同步 Canvas 分辨率。
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe($('.arena-wrap'));
  setInterval(() => { if (state.connected && (state.shooting || Object.values(keys).some(Boolean))) sendInput(); }, 80);

  /** 绘制带圆角的 Canvas 矩形。 @param {CanvasRenderingContext2D} c 绘图上下文。 @param {number} x 左上角 X。 @param {number} y 左上角 Y。 @param {number} w 宽度。 @param {number} h 高度。 @param {number} r 圆角半径。 */
  function roundedRect(c,x,y,w,h,r){c.beginPath(); if (typeof c.roundRect === 'function') c.roundRect(x,y,w,h,r); else { c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); } c.fill()}
  /** 绘制糖果色渐变背景与装饰圆点。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function drawBackground(w,h){ const g=ctx.createLinearGradient(0,0,w,h);g.addColorStop(0,'#c9eee7');g.addColorStop(1,'#9cd9d2');ctx.fillStyle=g;ctx.fillRect(0,0,w,h); ctx.globalAlpha=.16; for(let i=0;i<18;i++){ctx.fillStyle=i%2?'#fff':'#70bfb6';ctx.beginPath();ctx.arc((i*173)%w,(i*91)%h,20+(i%3)*13,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1}
  /** 绘制边界墙和地图内的随机掩体。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function drawWalls(w,h){ const boundary=[{x:25,y:25,w:950,h:18},{x:25,y:607,w:950,h:18},{x:25,y:25,w:18,h:600},{x:957,y:25,w:18,h:600}]; const walls=boundary.concat(state.walls || []); const sx=w/state.world.width, sy=h/state.world.height; walls.forEach((wall,i)=>{const x=wall.x*sx,y=wall.y*sy,ww=wall.w*sx,hh=wall.h*sy;ctx.fillStyle='#8063aa';roundedRect(ctx,x+4*sx,y+6*sy,ww,hh,8);ctx.fillStyle=i%3===0?'#a98dc9':'#997cbe';roundedRect(ctx,x,y,ww,hh,8);ctx.fillStyle='#cdb8e7';roundedRect(ctx,x+8*sx,y+4*sy,Math.max(8*sx,ww-20*sx),Math.min(5*sy,hh/3),3)}) }
  /** 绘制一个带表情的卡通角色。 @param {object} p 服务端玩家状态。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function drawPlayer(p,w,h){ const sx=w/state.world.width,sy=h/state.world.height,x=p.x*sx,y=p.y*sy,r=Math.min(w,h)*.034,col=p.id===state.playerId?COLORS[0]:COLORS[1];ctx.save();ctx.translate(x,y);ctx.fillStyle='#5d477f33';ctx.beginPath();ctx.ellipse(0,r*1.1,r*1.2,r*.42,0,0,Math.PI*2);ctx.fill();ctx.rotate(Number(p.angle)||0);ctx.fillStyle='#ffe28a';roundedRect(ctx,r*.35,-r*.18,r*1.05,r*.36,r*.12);ctx.fillStyle='#ffb35e';roundedRect(ctx,r*1.15,-r*.12,r*.3,r*.24,r*.08);ctx.rotate(-(Number(p.angle)||0));ctx.fillStyle=col;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(-r*.32,-r*.1,r*.16,0,Math.PI*2);ctx.arc(r*.32,-r*.1,r*.16,0,Math.PI*2);ctx.fill();ctx.fillStyle='#423454';ctx.beginPath();ctx.arc(-r*.3,-r*.08,r*.07,0,Math.PI*2);ctx.arc(r*.3,-r*.08,r*.07,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#423454';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,r*.05,r*.3,0,Math.PI);ctx.stroke();ctx.fillStyle='#ffdf6b';ctx.beginPath();ctx.arc(0,-r*.85,r*.32,0,Math.PI*2);ctx.fill();ctx.restore() }
  /** 绘制可爱的糖果子弹及其高光。 @param {object} b 服务端子弹状态。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function drawBullet(b,w,h){const x=b.x*w/state.world.width,y=b.y*h/state.world.height;ctx.fillStyle='#fff4a8';ctx.shadowColor='#ffcb62';ctx.shadowBlur=12;ctx.beginPath();ctx.arc(x,y,Math.max(5,Math.min(w,h)*.012),0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;ctx.fillStyle='#ff8da8';ctx.beginPath();ctx.arc(x-2,y-2,2,0,Math.PI*2);ctx.fill()}
  /** 按屏幕刷新率循环渲染当前对战状态。 */
  /** 对服务端快照做轻量插值，减少网络抖动造成的两端画面跳动。 */
  function smoothPlayer(player){ const old=state.renderPlayers.get(player.id); if(!old){ state.renderPlayers.set(player.id,{...player}); return player; } old.x += (player.x-old.x)*.35; old.y += (player.y-old.y)*.35; old.angle = player.angle; old.hp = player.hp; return old; }
  function render(){ if(game.classList.contains('active')){const w=canvas.width/state.dpr,h=canvas.height/state.dpr;ctx.setTransform(state.dpr,0,0,state.dpr,0,0);drawBackground(w,h);drawWalls(w,h);state.bullets.forEach(b=>drawBullet(b,w,h));state.players.forEach(p=>drawPlayer(smoothPlayer(p),w,h));} requestAnimationFrame(render)}
  render();
})();
