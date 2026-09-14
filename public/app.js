/* 神枪手客户端：负责大厅、实时输入与 Canvas 绘制。 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const canvas = $('#arena'), ctx = canvas.getContext('2d');
  const lobby = $('#lobby'), game = $('#game');
  const keys = {a:false,s:false,d:false,w:false};
  const state = { socket:null, roomCode:'', name:'', playerId:null, players:[], bullets:[], walls:[], winner:null, round:0, connected:false, particles:[], previousHp:new Map(), lobbySocket:null, lobbyPeople:[], lobbyRooms:[], shooting:false, lastShot:0, reconnectTimer:null, dpr:1, aim:{x:500,y:325}, leaving:false, world:{width:1000,height:650}, reconnecting:false, renderPlayers:new Map(), predictedLocal:null, serverLocal:null, pendingInputs:[], nextInputSeq:0, lastAck:0, inputDirty:false, lastInputSentAt:0, lastPredictAt:0, muzzleFlashUntil:0 };
  const PLAYER_RADIUS = 22;
  const MAX_PLAYERS = 4;
  const PLAYER_SPEED = 230;
  const COLORS = ['#ff669b','#58b8e8'];

  /** 将大厅切换到游戏界面并更新房间信息。 */
  function enterGame() { lobby.classList.remove('active'); game.classList.add('active'); $('#room-label').textContent = `ROOM ${state.roomCode || '——'}`; $('#waiting-code').textContent = state.roomCode || '——'; $('#my-name').textContent = state.name || '你'; resize(); requestAnimationFrame(resize); }
  /** 将游戏界面恢复为大厅，并清理本局连接状态。 */
  function leaveGame() { state.leaving = true; clearTimeout(state.reconnectTimer); if (state.socket) { send({type:'leave'}); state.socket.close(); } state.socket = null; state.connected = false; state.reconnecting = false; state.players = []; state.renderPlayers.clear(); state.bullets = []; state.walls = []; state.predictedLocal = null; state.serverLocal = null; state.pendingInputs = []; state.nextInputSeq = 0; state.lastAck = 0; state.lastPredictAt = 0; game.classList.remove('active'); lobby.classList.add('active'); }
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
    if (type === 'online') { state.lobbyPeople = data.players || []; updateLobby({ online: state.lobbyPeople, rooms: state.lobbyRooms }); return; }
    if (type === 'roomList') { state.lobbyRooms = data.rooms || []; updateLobby({ online: state.lobbyPeople, rooms: state.lobbyRooms }); return; }
    if (type === 'lobby' || type === 'lobby_update' || type === 'rooms') { updateLobby(data); return; }
    if (type === 'invite') { showInvite(data); return; }
    if (type === 'room' || type === 'joined') {
      state.roomCode = data.roomCode || state.roomCode; state.playerId = data.playerId || state.playerId; state.world = data.world || state.world;
      state.walls = data.walls || state.walls; updatePlayers(data.players || []); toggleWaiting((data.status || '').toLowerCase() !== 'playing' && (data.players || []).length < 3); return;
    }
    if (type === 'state' || type === 'game_state') { state.round = data.round || state.round; state.bullets = Array.isArray(data.bullets) ? data.bullets : Object.values(data.bullets || {}); state.walls = data.walls || state.walls; state.world = data.world || state.world; const players = data.players || []; const me = players.find(p => p.id === state.playerId); if (me) reconcileLocal(me, data); updatePlayers(players); state.winner = data.winner ?? null; if (state.winner) showResult(state.winner); else $('#result').classList.add('hidden'); toggleWaiting(state.players.length < 3 && !state.winner); return; }
    if (type === 'event' || type === 'message') { if (data.message) toast(data.message); if (data.event === 'start' || data.event === 'round_start') toast('开战！'); if (data.event === 'deathExplosion') { const dead = state.players.find(p => p.id === data.playerId); if (dead) spawnBurst({...dead, x:data.x ?? dead.x, y:data.y ?? dead.y}); } if (data.event === 'win' || data.event === 'round_end') showResult(data.winner); return; }
    if (type === 'error') { $('#lobby-msg').textContent = data.message || '房间操作失败'; toast(data.message || '操作失败'); }
  }
  /** 更新玩家列表，并刷新双方昵称与生命显示。 @param {Array<object>|object} list 服务端返回的玩家数组或字典。 */
  function updatePlayers(list) {
    list = Array.isArray(list) ? list : Object.values(list || {});
    const before = state.previousHp;
    state.players = list;
    for (const p of list) {
      const hp = Number(p.hp ?? p.health ?? 3);
      const old = before.get(p.id);
      if (old != null && old > 0 && hp <= 0) spawnBurst(p);
      before.set(p.id, hp);
    }
    const me = list.find(p => p.id === state.playerId) || list.find(p => p.name === state.name);
    if (me) { state.playerId = me.id || state.playerId; $('#my-name').textContent = me.name || state.name; }
    renderRoster(list);
    const waitTitle = $('#waiting-title'); if (waitTitle) waitTitle.textContent = list.length >= 3 ? '准备开战！' : `还差 ${3 - list.length} 位玩家开局`;
    toggleWaiting((list.length < 3) && !state.winner);
  }
  /** 绘制四人生命与在线状态面板。 @param {Array<object>} list 当前房间玩家。 */
  function renderRoster(list) {
    const el = $('#player-roster'); if (!el) return;
    el.innerHTML = list.map((p,i) => { const hp = Math.max(0, Math.min(3, Number(p.hp ?? p.health ?? 3))); const color = p.color === 'blue' || i % 4 === 1 ? '#58b8e8' : ['#ff669b','#9d7bea','#58b8e8','#f3bd40'][i%4]; return `<div class="roster-card ${hp<=0?'dead':''}"><span class="mini-avatar" style="background:${color}">${(p.name||'?').slice(0,1)}</span><span><b>${escapeHtml(p.name||'枪手')}</b><small class="mini-hearts">${hearts(hp)}</small></span></div>`; }).join('');
  }
  /** 对动态昵称做 HTML 转义，避免昵称被当作标签解析。 @param {string} value 原始昵称。 @returns {string} 安全文本。 */
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  /** 在玩家死亡位置生成十几个糖果圆点粒子。 @param {object} player 死亡玩家状态。 */
  function spawnBurst(player) { for (let i=0;i<16;i++) { const a=Math.random()*Math.PI*2, speed=70+Math.random()*150; state.particles.push({x:Number(player.x)||0,y:Number(player.y)||0,vx:Math.cos(a)*speed,vy:Math.sin(a)*speed,life:.7+Math.random()*.45,color:i%2?'#ff669b':'#ffd75e',r:3+Math.random()*4}); } }

  /** 将生命值转换成三个爱心图标。 @param {number} hp 当前生命值，范围 0 至 3。 @returns {string} 爱心字符串。 */
  function hearts(hp) { hp = Math.max(0, Math.min(3, Number(hp))); return '♥ '.repeat(hp) + '♡ '.repeat(3-hp); }
  /** 控制等待遮罩，在第二位玩家加入后自动隐藏。 @param {boolean} show 是否显示等待层。 */
  function toggleWaiting(show) { $('#waiting').classList.toggle('hidden', !show); }
  /** 显示胜负结果动画。 @param {string|number} winner 获胜玩家标识。 */
  function showResult(winner) { const won = String(winner) === String(state.playerId) || winner === state.name || winner === 'me'; $('#result-title').textContent = won ? '胜利！' : '再接再厉'; $('#result-sub').textContent = won ? '你是今天的糖果之王' : '下一发子弹，扭转局势'; $('#result').classList.remove('hidden'); }

  /** 判断圆形玩家是否与地图掩体相交。 @param {number} x 玩家中心 X。 @param {number} y 玩家中心 Y。 @param {object} wall 墙体矩形。 @returns {boolean} 是否发生碰撞。 */
  function localCircleRect(x, y, wall) { const cx = Math.max(wall.x, Math.min(x, wall.x + wall.w)); const cy = Math.max(wall.y, Math.min(y, wall.y + wall.h)); return (x - cx) ** 2 + (y - cy) ** 2 <= PLAYER_RADIUS ** 2; }
  /** 在本地预测一帧 ASDW 移动，碰撞规则与服务端保持一致。 @param {{x:number,y:number}} point 当前坐标。 @param {object} input 输入快照。 @param {number} dt 预测时间（秒）。 @returns {{x:number,y:number}} 预测后的世界坐标。 */
  function predictMove(point, input, dt) { let dx = 0, dy = 0; if (input.a) dx -= 1; if (input.d) dx += 1; if (input.s) dy += 1; if (input.w) dy -= 1; if (!dx && !dy) return point; const len = Math.hypot(dx, dy) || 1; const nx = Math.max(PLAYER_RADIUS, Math.min(state.world.width - PLAYER_RADIUS, point.x + dx / len * PLAYER_SPEED * dt)); const ny = Math.max(PLAYER_RADIUS, Math.min(state.world.height - PLAYER_RADIUS, point.y + dy / len * PLAYER_SPEED * dt)); const walls = state.walls || []; if (!walls.some(w => localCircleRect(nx, point.y, w))) point.x = nx; if (!walls.some(w => localCircleRect(point.x, ny, w))) point.y = ny; return point; }
  /** 将服务端坐标与已确认输入对齐，并重放未确认输入，消除网络往返造成的移动停顿。 @param {object} authoritative 服务端玩家状态。 @param {object} packet 服务端状态包，可能携带 inputAck/lastInputSeq。 */
  function reconcileLocal(authoritative, packet) { const seqMap = packet.lastProcessedSeq || packet.processedSeq || {}; const ackValue = authoritative.inputAck ?? seqMap[state.playerId] ?? packet.inputAck ?? packet.lastInputSeq ?? packet.lastProcessedInput ?? packet.ack; const ack = Number(ackValue); if (Number.isFinite(ack) && ack >= state.lastAck) { state.lastAck = ack; state.pendingInputs = state.pendingInputs.filter(item => item.seq > ack); } state.serverLocal = {x:Number(authoritative.x) || 0, y:Number(authoritative.y) || 0}; const replay = { ...state.serverLocal }; for (const item of state.pendingInputs) predictMove(replay, item.keys, item.dt || 1 / 30); state.predictedLocal = replay; state.lastPredictAt = performance.now(); }
  /** 发送当前按键、瞄准点和射击状态；每条输入带序号供服务端确认。 @param {{x:number,y:number}=} aim 服务端世界坐标中的瞄准点。 @param {boolean=} immediate 是否跳过节流立即发送。 */
  function sendInput(aim, immediate = true) { if (aim) state.aim = aim; state.inputDirty = true; if (!immediate) return; flushInput(true); }
  /** 按约 30Hz 发送输入，并在按键变化或开枪时立即补发。 @param {boolean=} force 是否忽略发送间隔。 */
  function flushInput(force = false) { if (!state.connected || (!state.inputDirty && !state.shooting && !Object.values(keys).some(Boolean))) return; const now = performance.now(); if (!force && now - state.lastInputSentAt < 33) return; if (state.shooting && now - state.lastShot > 350) { state.muzzleFlashUntil = now + 120; state.lastShot = now; } const input = { keys:{...keys}, shoot:state.shooting, aim:{...state.aim}, clientTime:Date.now() }; const seq = ++state.nextInputSeq; const replayDt = Math.min(.05, Math.max(.001, (now - (state.lastInputSentAt || now - 33)) / 1000)); state.pendingInputs.push({ seq, keys:input.keys, dt:replayDt }); send({type:'input', ...input, seq}); state.lastInputSentAt = now; state.inputDirty = false; if (state.pendingInputs.length > 120) state.pendingInputs.splice(0, state.pendingInputs.length - 120); }
  /** 将浏览器画布坐标转换为服务端世界坐标，保证瞄准方向在不同屏幕上一致。 */
  function pointerAim(ev) { const r = canvas.getBoundingClientRect(); return {x:(ev.clientX-r.left)/r.width*state.world.width, y:(ev.clientY-r.top)/r.height*state.world.height}; }
  canvas.addEventListener('pointermove', e => { if (state.connected) sendInput(pointerAim(e), false); });
  canvas.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); state.shooting = true; state.muzzleFlashUntil = performance.now() + 120; sendInput(pointerAim(e), true); });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('pointerup', () => { if (state.shooting) { state.shooting = false; sendInput(); } });
  window.addEventListener('keydown', e => { const k=e.key.toLowerCase(); if (k in keys) { if (!keys[k]) state.inputDirty = true; keys[k]=true; sendInput(undefined, true); } if (e.code==='Space') { e.preventDefault(); state.shooting=true; state.muzzleFlashUntil = performance.now() + 120; sendInput(undefined, true); } });
  window.addEventListener('keyup', e => { const k=e.key.toLowerCase(); if (k in keys) keys[k]=false; if (e.code==='Space') state.shooting=false; sendInput(undefined, true); });
  document.querySelectorAll('.touch-controls button[data-key]').forEach(btn => { const k=btn.dataset.key; const on=e=>{e.preventDefault();keys[k]=true;sendInput(undefined, true)}; const off=e=>{e.preventDefault();keys[k]=false;sendInput(undefined, true)}; btn.addEventListener('pointerdown',on); btn.addEventListener('pointerup',off); btn.addEventListener('pointerleave',off); });
  $('#touch-shoot').addEventListener('pointerdown', e=>{e.preventDefault();state.shooting=true;state.muzzleFlashUntil = performance.now() + 120;sendInput(undefined, true)}); $('#touch-shoot').addEventListener('pointerup', e=>{e.preventDefault();state.shooting=false;sendInput(undefined, true)});
  // 页面加载后保持大厅连接，用于在线玩家和房间列表实时刷新。
  (function openLobby() { try { const proto=location.protocol==='https:'?'wss:':'ws:'; state.lobbySocket=new WebSocket(`${proto}//${location.host}/ws`); state.lobbySocket.onopen=()=>sendLobby({type:'lobby'}); state.lobbySocket.onmessage=e=>{try{const m=JSON.parse(e.data); if(m.type!=='welcome') handleMessage(m);}catch{}}; state.lobbySocket.onclose=()=>setTimeout(openLobby,3000); } catch {} })();
  $('#create-btn').onclick = () => { const name=($('#nickname').value||'小神枪').trim(); const code=makeRoomCode(); $('#room-code').value=code; $('#lobby-msg').textContent=''; connect(code,name); };
  $('#join-btn').onclick = () => { const name=($('#nickname').value||'小神枪').trim(); const code=($('#room-code').value||'').trim().toUpperCase(); if(code.length!==6){$('#lobby-msg').textContent='请输入 6 位房间码';return} $('#lobby-msg').textContent=''; connect(code,name); };
  $('#leave-btn').onclick = leaveGame;
  $('#restart-btn').onclick = () => { state.winner=null; $('#result').classList.add('hidden'); send({type:'restart'}); };
  $('#copy-code').onclick = async () => { try { await navigator.clipboard.writeText(state.roomCode); toast('房间码已复制'); } catch { toast(`房间码：${state.roomCode}`); } };
  window.addEventListener('resize', resize);
  // 房间切换和移动端旋转都可能改变竞技场尺寸，持续同步 Canvas 分辨率。
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe($('.arena-wrap'));
  setInterval(() => { if (state.connected) flushInput(false); }, 33);

  /** 绘制带圆角的 Canvas 矩形。 @param {CanvasRenderingContext2D} c 绘图上下文。 @param {number} x 左上角 X。 @param {number} y 左上角 Y。 @param {number} w 宽度。 @param {number} h 高度。 @param {number} r 圆角半径。 */
  function roundedRect(c,x,y,w,h,r){c.beginPath(); if (typeof c.roundRect === 'function') c.roundRect(x,y,w,h,r); else { c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); } c.fill()}
  /** 绘制糖果色渐变背景与装饰圆点。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function drawBackground(w,h){ const g=ctx.createLinearGradient(0,0,w,h);g.addColorStop(0,'#c9eee7');g.addColorStop(1,'#9cd9d2');ctx.fillStyle=g;ctx.fillRect(0,0,w,h); ctx.globalAlpha=.16; for(let i=0;i<18;i++){ctx.fillStyle=i%2?'#fff':'#70bfb6';ctx.beginPath();ctx.arc((i*173)%w,(i*91)%h,20+(i%3)*13,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1}
  /** 绘制边界墙和地图内的随机掩体。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function drawWalls(w,h){ const boundary=[{x:25,y:25,w:950,h:18},{x:25,y:607,w:950,h:18},{x:25,y:25,w:18,h:600},{x:957,y:25,w:18,h:600}]; const walls=boundary.concat(state.walls || []); const sx=w/state.world.width, sy=h/state.world.height; walls.forEach((wall,i)=>{const x=wall.x*sx,y=wall.y*sy,ww=wall.w*sx,hh=wall.h*sy;ctx.fillStyle='#8063aa';roundedRect(ctx,x+4*sx,y+6*sy,ww,hh,8);ctx.fillStyle=i%3===0?'#a98dc9':'#997cbe';roundedRect(ctx,x,y,ww,hh,8);ctx.fillStyle='#cdb8e7';roundedRect(ctx,x+8*sx,y+4*sy,Math.max(8*sx,ww-20*sx),Math.min(5*sy,hh/3),3)}) }
  /** 绘制一个带表情的卡通角色。 @param {object} p 服务端玩家状态。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function drawPlayer(p,w,h){ const sx=w/state.world.width,sy=h/state.world.height,x=p.x*sx,y=p.y*sy,r=Math.min(w,h)*.034*(p.hp<=0?.82:(p.hp===2?.92:1)),col=p.id===state.playerId?'#ff669b':({blue:'#58b8e8',yellow:'#f3bd40',green:'#78c86b'}[p.color]||'#9d7bea');ctx.save();ctx.translate(x,y);ctx.fillStyle='#5d477f33';ctx.beginPath();ctx.ellipse(0,r*1.1,r*1.2,r*.42,0,0,Math.PI*2);ctx.fill();ctx.rotate(Number(p.angle)||0);ctx.fillStyle='#ffe28a';roundedRect(ctx,r*.35,-r*.18,r*1.05,r*.36,r*.12);ctx.fillStyle='#ffb35e';roundedRect(ctx,r*1.15,-r*.12,r*.3,r*.24,r*.08); if (p.id === state.playerId && state.muzzleFlashUntil > performance.now()) { ctx.fillStyle='#fff4a8'; ctx.shadowColor='#ffcb62'; ctx.shadowBlur=10; ctx.beginPath(); ctx.arc(r*1.62,0,r*.28,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0; } ctx.rotate(-(Number(p.angle)||0));ctx.fillStyle=col;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(-r*.32,-r*.1,r*.16,0,Math.PI*2);ctx.arc(r*.32,-r*.1,r*.16,0,Math.PI*2);ctx.fill();ctx.fillStyle='#423454';ctx.beginPath();ctx.arc(-r*.3,-r*.08,r*.07,0,Math.PI*2);ctx.arc(r*.3,-r*.08,r*.07,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#423454';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,r*.05,r*.3,0,Math.PI);ctx.stroke();ctx.fillStyle='#ffdf6b';ctx.beginPath();ctx.arc(0,-r*.85,r*.32,0,Math.PI*2);ctx.fill();ctx.restore() }
  /** 绘制可爱的糖果子弹及其高光。 @param {object} b 服务端子弹状态。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function drawBullet(b,w,h){const x=b.x*w/state.world.width,y=b.y*h/state.world.height;ctx.fillStyle='#fff4a8';ctx.shadowColor='#ffcb62';ctx.shadowBlur=12;ctx.beginPath();ctx.arc(x,y,Math.max(5,Math.min(w,h)*.012),0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;ctx.fillStyle='#ff8da8';ctx.beginPath();ctx.arc(x-2,y-2,2,0,Math.PI*2);ctx.fill()}
  /** 推进并绘制死亡爆裂粒子。 @param {number} w 画布 CSS 宽度。 @param {number} h 画布 CSS 高度。 */
  function updateParticles(w,h) { const dt=1/60; for (let i=state.particles.length-1;i>=0;i--) { const q=state.particles[i]; q.x+=q.vx*dt; q.y+=q.vy*dt; q.vx*=.97; q.vy*=.97; q.life-=dt; if(q.life<=0){state.particles.splice(i,1);continue;} ctx.globalAlpha=Math.max(0,q.life); ctx.fillStyle=q.color; ctx.beginPath();ctx.arc(q.x*w/state.world.width,q.y*h/state.world.height,q.r,0,Math.PI*2);ctx.fill(); } ctx.globalAlpha=1; }
  /** 更新大厅在线玩家及可加入房间列表。 @param {object} data 服务端大厅快照。 */
  function updateLobby(data) { const people = data.people || data.online || data.players || null; if (people) state.lobbyPeople = people; const rooms = data.rooms; if (rooms) state.lobbyRooms = rooms; const shownPeople = state.lobbyPeople; const shownRooms = state.lobbyRooms; const pe=$('#online-people'); if(pe) { $('#online-people-count').textContent=shownPeople.length; pe.innerHTML=shownPeople.length?shownPeople.map(p=>`<div class="person-row"><span><i class="person-dot"></i>${escapeHtml(p.name||p.nickname||'枪手')}</span><button class="btn ghost small invite-btn" data-id="${escapeHtml(p.id||'')}">邀请</button></div>`).join(''):'<span class="empty-state">暂无其他在线玩家</span>'; pe.querySelectorAll('.invite-btn').forEach(b=>b.onclick=()=>sendLobby({type:'invite',targetId:b.dataset.id,roomCode:state.roomCode})); } const ge=$('#game-online-people'); if(ge) { $('#game-online-count').textContent=shownPeople.length; ge.innerHTML=shownPeople.length?shownPeople.map(p=>`<div class="person-row"><span><i class="person-dot"></i>${escapeHtml(p.name||p.nickname||'枪手')}</span><button class="btn ghost small invite-btn" data-id="${escapeHtml(p.id||'')}">邀请</button></div>`).join(''):'<span class="empty-state">暂无其他在线玩家</span>'; ge.querySelectorAll('.invite-btn').forEach(b=>b.onclick=()=>{ const payload={type:'invite',targetId:b.dataset.id,roomCode:state.roomCode}; if(state.socket?.readyState===WebSocket.OPEN) state.socket.send(JSON.stringify(payload)); }); } const re=$('#room-list'); if(re){ $('#room-count').textContent=shownRooms.length; re.innerHTML=shownRooms.length?shownRooms.map(r=>{const count=r.count??r.playerCount??r.players?.length??0,full=count>=MAX_PLAYERS; return `<div class="room-row"><span><b>${escapeHtml(r.roomCode||r.code||'——')}</b> · ${count}/${MAX_PLAYERS}</span><button data-room="${escapeHtml(r.roomCode||r.code||'')}" ${full?'disabled':''}>${full?'已满':'加入'}</button></div>`}).join(''):'<span class="empty-state">暂无公开房间</span>'; re.querySelectorAll('button[data-room]').forEach(b=>b.onclick=()=>{ if(!b.disabled){ const n=($('#nickname').value||'小神枪').trim(); connect(b.dataset.room,n); }}); } }
  /** 向大厅专用连接发送邀请或查询消息。 @param {object} payload 消息体。 */
  function sendLobby(payload){ if(state.lobbySocket?.readyState===WebSocket.OPEN) state.lobbySocket.send(JSON.stringify(payload)); else toast('大厅连接尚未就绪'); }
  /** 显示被邀请加入房间的弹窗。 @param {object} data 邀请信息。 */
  function showInvite(data){ const code=data.roomCode||data.code; if(!code)return; if(confirm(`${data.fromName||'好友'} 邀请你加入房间 ${code}，现在加入？`)){ const n=($('#nickname').value||'小神枪').trim(); connect(code,n); } }

  /** 按屏幕刷新率循环渲染当前对战状态。 */
  /** 对服务端快照做轻量插值，减少网络抖动造成的两端画面跳动。 */
  function smoothPlayer(player){ const old=state.renderPlayers.get(player.id); if(!old){ state.renderPlayers.set(player.id,{...player}); return player; } old.x += (player.x-old.x)*.35; old.y += (player.y-old.y)*.35; old.angle = player.angle; old.hp = player.hp; return old; }
  /** 每帧推进本地玩家预测位置；服务端快照到达时会重新校正并重放未确认输入。 */
  function advancePrediction() { if (!state.predictedLocal) { const me = state.players.find(p => p.id === state.playerId); if (me) state.predictedLocal = {x:Number(me.x) || 0, y:Number(me.y) || 0}; } if (!state.predictedLocal) return; const now = performance.now(); const dt = state.lastPredictAt ? Math.min(.05, Math.max(0, (now - state.lastPredictAt) / 1000)) : 0; state.lastPredictAt = now; if (dt > 0) predictMove(state.predictedLocal, keys, dt); }
  function render(){ if(game.classList.contains('active')){const w=canvas.width/state.dpr,h=canvas.height/state.dpr;ctx.setTransform(state.dpr,0,0,state.dpr,0,0);advancePrediction();drawBackground(w,h);drawWalls(w,h);state.bullets.forEach(b=>drawBullet(b,w,h)); updateParticles(w,h); state.players.forEach(p=>{ const local = p.id === state.playerId && state.predictedLocal ? {...p, x:state.predictedLocal.x, y:state.predictedLocal.y} : p; drawPlayer(smoothPlayer(local),w,h); });} requestAnimationFrame(render)}
  render();
})();
