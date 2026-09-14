/**
 * 神枪手多人在线对战服务端。使用 Node HTTP 提供静态文件，WebSocket 负责大厅、房间、输入与实时物理。
 * 游戏状态仅保存在单进程内，适合 Render 单实例部署；客户端断线后保留席位 15 秒供重连。
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORLD = { width: 1000, height: 650 };
// 30Hz 物理循环可缩短输入等待时间，同时保持单进程部署的 CPU 开销可控。
const TICK_MS = 33;
const PLAYER_SPEED = 230;
const PLAYER_RADIUS = 26;
const MIN_PLAYERS_TO_START = 3;
const MAX_PLAYERS_PER_ROOM = 4;
const SPAWN_INVINCIBLE_MS = 1000;
const BULLET_SPEED = 340;
const BULLET_RADIUS = 8;
const FIRE_COOLDOWN_MS = 420;
const RECONNECT_GRACE_MS = 15000;

/**
 * @typedef {object} Player
 * @property {string} id 玩家连接标识，用于断线重连，15 秒后失效。
 * @property {string} name 玩家昵称，最多 16 个字符。
 * @property {'pink'|'blue'|'yellow'|'green'} color 客户端展示颜色及出生点阵营，分别对应四个出生方向。
 * @property {import('ws').WebSocket|null} socket 当前连接，断线时为 null。
 * @property {object} room 玩家所属房间对象。
 * @property {number} x 世界坐标 X，单位为像素。
 * @property {number} y 世界坐标 Y，单位为像素。
 * @property {number} angle 面向角度，单位为弧度。
 * @property {number} hp 剩余生命值，初始 3，每次命中减少 1，降为 0 后淘汰。
 * @property {number} spawnProtectionUntil 出生无敌截止时间戳（毫秒）；此时间前子弹不会扣血。
 * @property {{a:boolean,s:boolean,d:boolean,w:boolean}} keys ASDW 四方向按键状态。
 * @property {boolean} shooting 是否持续开火；服务端按冷却生成子弹。
 * @property {number} lastShotAt 最近一次开火时间戳（毫秒）。
 * @property {number} lastInputSeq 最近确认的客户端输入序号；用于丢弃乱序或重复输入。
 * @property {number|null} lastClientTime 客户端发送输入时的时间戳（毫秒）；仅用于同步诊断，可为空。
 * @property {number|null} disconnectedAt 断线时间戳；null 表示在线。
 */

/**
 * @typedef {object} Room
 * @property {string} code 6 位大写房间码。
 * @property {'waiting'|'playing'|'finished'} status 对局阶段。
 * @property {Map<string, Player>} players 房间玩家，最多四人。
 * @property {Array<{x:number,y:number,w:number,h:number}>} walls 内部随机墙体，边界墙隐含于世界尺寸。
 * @property {Array<object>} bullets 当前飞行中的子弹。
 * @property {string|null} winner 获胜玩家 ID；null 表示未分胜负。
 * @property {number} round 当前局数，从 1 开始。
 * @property {number} createdAt 房间创建时间戳（毫秒）。
 */

/** 所有 WebSocket 连接及其临时会话。 */
const sessions = new Map();
/** 房间码到房间状态的索引。 */
const rooms = new Map();

/** @returns {string} 生成短且适合展示在房间码中的随机标识。 */
function createId() { return crypto.randomBytes(5).toString('hex'); }
/** @returns {string} 生成 6 位大写房间码，避免含易混淆字符。 */
function createRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}
/** @param {number} value @param {number} min @param {number} max @returns {number} 将数值限制在指定范围内。 */
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
/** @param {object} room @returns {Array<object>} 创建 2 至 3 面不遮挡出生点的随机内部墙。 */
function generateWalls(room) {
  const walls = [];
  const random = () => Math.floor(90 + Math.random() * 700);
  const count = 2 + Math.floor(Math.random() * 2);
  const spawns = [{ x: WORLD.width / 2, y: 90 }, { x: WORLD.width - 110, y: WORLD.height / 2 }, { x: WORLD.width / 2, y: WORLD.height - 90 }, { x: 110, y: WORLD.height / 2 }];
  let attempts = 0;
  while (walls.length < count && attempts++ < 100) {
    const horizontal = Math.random() > 0.5;
    const wall = horizontal ? { x: random(), y: Math.floor(90 + Math.random() * 470), w: 130 + Math.floor(Math.random() * 150), h: 18 } : { x: random(), y: Math.floor(90 + Math.random() * 470), w: 18, h: 130 + Math.floor(Math.random() * 150) };
    if (wall.x + wall.w >= WORLD.width - 40 || wall.y + wall.h >= WORLD.height - 40) continue;
    if (spawns.some((p) => circleRect(p.x, p.y, PLAYER_RADIUS + 60, wall))) continue;
    if (walls.some((w) => rectsOverlap(w, wall, 45))) continue;
    walls.push(wall);
  }
  return walls;
}
/** @param {object} a @param {object} b @param {number} padding @returns {boolean} 判断两矩形是否重叠。 */
function rectsOverlap(a, b, padding = 0) { return a.x - padding < b.x + b.w && a.x + a.w + padding > b.x && a.y - padding < b.y + b.h && a.y + a.h + padding > b.y; }
/** @param {number} cx @param {number} cy @param {number} radius @param {object} rect @returns {boolean} 判断圆与矩形是否相交。 */
function circleRect(cx, cy, radius, rect) { const x = clamp(cx, rect.x, rect.x + rect.w); const y = clamp(cy, rect.y, rect.y + rect.h); return (cx - x) ** 2 + (cy - y) ** 2 <= radius ** 2; }

/**
 * 返回客户端可见的玩家状态，并携带服务端已确认的输入序号。
 * @param {Player} player 玩家实体，坐标和生命值均来自服务端权威状态。
 * @returns {object} 玩家公开状态；inputAck 为最近处理的输入序号，旧客户端可忽略该字段。
 */
function publicPlayer(player) { return { id: player.id, name: player.name, color: player.color, x: Math.round(player.x * 10) / 10, y: Math.round(player.y * 10) / 10, angle: player.angle, hp: player.hp, radius: playerRadius(player), invincible: Date.now() < player.spawnProtectionUntil, connected: Boolean(player.socket), inputAck: player.lastInputSeq }; }
/** @param {object} room @returns {object} 构造房间信息，包含墙体和玩家席位。 */
function roomInfo(room) { return { roomCode: room.code, status: room.status, players: [...room.players.values()].map(publicPlayer), walls: room.walls, world: WORLD, maxPlayers: MAX_PLAYERS_PER_ROOM, minPlayers: MIN_PLAYERS_TO_START, aliveCount: [...room.players.values()].filter((p) => p.hp > 0).length }; }
/** @param {import('ws').WebSocket} socket @param {string} type @param {object} payload @returns {void} 发送统一格式 WebSocket 消息。 */
function send(socket, type, payload = {}) { if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type, ...payload })); }
/** @param {object} room @param {string} type @param {object} payload @returns {void} 向房间内在线玩家广播消息。 */
function broadcastRoom(room, type, payload = {}) { for (const player of room.players.values()) if (player.socket) send(player.socket, type, payload); }
/** @param {object} socket @param {string} message @returns {void} 返回客户端可读的错误事件。 */
function errorEvent(socket, message) { send(socket, 'error', { message }); }

/**
 * 向所有在线连接广播大厅数据，供客户端展示在线玩家、可加入房间和邀请入口。
 * @returns {void} 无返回值；每个连接收到 online 与 roomList 两类消息。
 */
function broadcastLobby() {
  const online = [...sessions.values()].map((session) => ({ id: session.id, name: session.player?.name || session.name || `枪手${session.id.slice(0, 3)}`, roomCode: session.player?.room?.code || null, status: session.player?.room?.status || 'lobby' }));
  const roomList = [...rooms.values()].filter((room) => room.players.size > 0 && room.status !== 'finished').map((room) => ({ roomCode: room.code, status: room.status, playerCount: room.players.size, maxPlayers: MAX_PLAYERS_PER_ROOM, minPlayers: MIN_PLAYERS_TO_START, players: [...room.players.values()].map((player) => ({ id: player.id, name: player.name, color: player.color, hp: player.hp, connected: Boolean(player.socket) })) }));
  for (const session of sessions.values()) { send(session.socket, 'online', { players: online, count: online.length }); send(session.socket, 'roomList', { rooms: roomList }); }
}

/** @param {Player} player @returns {number} 根据剩余生命返回绘制半径，保证受伤后只缩小一部分。 */
function playerRadius(player) { return PLAYER_RADIUS - (3 - Math.max(0, player.hp)) * 3; }

/** @param {object} room @returns {void} 达到最低人数时开始房间对局，并为所有玩家重置出生状态。 */
function maybeStartRoom(room) {
  if (room.status !== 'waiting' || room.players.size < MIN_PLAYERS_TO_START) return;
  room.status = 'playing'; room.winner = null; room.bullets = [];
  for (const player of room.players.values()) resetPlayer(player);
  broadcastRoom(room, 'event', { event: 'start', message: '三人到齐，开战！' });
}

/** @param {string} code @returns {object} 创建等待中的四人房间，达到三名玩家后自动开局。 */
function createRoom(code = createRoomCode()) {
  const room = { code, status: 'waiting', players: new Map(), walls: [], bullets: [], winner: null, round: 1, createdAt: Date.now() };
  room.walls = generateWalls(room);
  rooms.set(code, room);
  return room;
}
/**
 * 将连接加入房间并分配四方向出生点；达到三名玩家后自动切换为 playing。
 * @param {Room} room 目标房间；玩家数必须少于四，否则抛出“房间已满”。
 * @param {object} session 当前 WebSocket 会话，使用其 id 与 socket 建立玩家席位。
 * @param {string} name 玩家昵称；为空时生成默认昵称，最终截断为最多 16 个字符。
 * @returns {Player} 新建的玩家实体，同时写入 room.players 与 session.player。
 * @throws {Error} 房间已有四名玩家时抛出房间已满异常。
 */
function addPlayer(room, session, name) {
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) throw new Error('房间已满');
  const spawn = [
    { x: WORLD.width / 2, y: 90, angle: Math.PI / 2, color: 'pink' },
    { x: WORLD.width - 110, y: WORLD.height / 2, angle: Math.PI, color: 'blue' },
    { x: WORLD.width / 2, y: WORLD.height - 90, angle: -Math.PI / 2, color: 'yellow' },
    { x: 110, y: WORLD.height / 2, angle: 0, color: 'green' },
  ][room.players.size];
  const player = { id: session.id, name: String(name || `枪手${session.id.slice(0, 3)}`).trim().slice(0, 16) || `枪手${session.id.slice(0, 3)}`, color: spawn.color, socket: session.socket, room, x: spawn.x, y: spawn.y, angle: spawn.angle, hp: 3, spawnProtectionUntil: Date.now() + SPAWN_INVINCIBLE_MS, keys: { a: false, s: false, d: false, w: false }, shooting: false, lastShotAt: 0, lastInputSeq: -1, lastClientTime: null, disconnectedAt: null };
  room.players.set(player.id, player); session.player = player; session.room = room;
  session.name = player.name;
  if (room.status === 'finished') { room.status = 'waiting'; room.winner = null; room.bullets = []; }
  maybeStartRoom(room);
  broadcastLobby();
  return player;
}
/**
 * 将玩家恢复到本局出生点并清空移动、射击及输入确认状态。
 * @param {Player} player 待重置的玩家实体；其在房间中的席位决定上下左右出生点。
 * @returns {void} 无返回值，直接修改玩家的坐标、生命、按键和输入序号。
 */
function resetPlayer(player) { const index = [...player.room.players.keys()].indexOf(player.id); const spawn = [{ x: WORLD.width / 2, y: 90, angle: Math.PI / 2 }, { x: WORLD.width - 110, y: WORLD.height / 2, angle: Math.PI }, { x: WORLD.width / 2, y: WORLD.height - 90, angle: -Math.PI / 2 }, { x: 110, y: WORLD.height / 2, angle: 0 }][Math.max(0, index) % 4]; player.x = spawn.x; player.y = spawn.y; player.hp = 3; player.angle = spawn.angle; player.spawnProtectionUntil = Date.now() + SPAWN_INVINCIBLE_MS; player.keys = { a: false, s: false, d: false, w: false }; player.shooting = false; player.lastInputSeq = -1; player.lastClientTime = null; }
/** @param {object} room @returns {void} 重置房间本局状态并递增局数；至少三名玩家才会重新开局。 */
function restartRoom(room) { room.round += 1; room.winner = null; room.bullets = []; room.status = 'waiting'; for (const player of room.players.values()) resetPlayer(player); maybeStartRoom(room); broadcastRoom(room, 'room', roomInfo(room)); broadcastLobby(); }

/** @param {object} player @returns {void} 按 ASDW 输入移动玩家并避开墙体。 */
function movePlayer(player) {
  const dt = TICK_MS / 1000; const k = player.keys; let dx = 0; let dy = 0;
  // A/D 控制左右，W/S 控制上下；服务端统一归一化对角线速度。
  if (k.a) dx -= 1; if (k.d) dx += 1; if (k.s) dy += 1; if (k.w) dy -= 1;
  if (!dx && !dy) return;
  const radius = playerRadius(player); const length = Math.hypot(dx, dy) || 1; const nx = clamp(player.x + dx / length * PLAYER_SPEED * dt, radius, WORLD.width - radius); const ny = clamp(player.y + dy / length * PLAYER_SPEED * dt, radius, WORLD.height - radius);
  if (!roomCollides(player.room, nx, player.y, radius)) player.x = nx;
  if (!roomCollides(player.room, player.x, ny, radius)) player.y = ny;
}
/** @param {object} room @param {number} x @param {number} y @param {number} radius @returns {boolean} 判断玩家圆形碰撞体是否撞墙。 */
function roomCollides(room, x, y, radius) { return room.walls.some((wall) => circleRect(x, y, radius, wall)); }
/** @param {object} player @returns {void} 依据瞄准角度生成一枚慢速可爱的子弹。 */
function fire(player) {
  const now = Date.now(); if (now - player.lastShotAt < FIRE_COOLDOWN_MS || player.hp <= 0 || player.room.status !== 'playing') return;
  player.lastShotAt = now; const angle = Number.isFinite(player.angle) ? player.angle : 0; const start = playerRadius(player) + 10;
  player.room.bullets.push({ id: createId(), owner: player.id, x: player.x + Math.cos(angle) * start, y: player.y + Math.sin(angle) * start, vx: Math.cos(angle) * BULLET_SPEED, vy: Math.sin(angle) * BULLET_SPEED, bounces: 0, bornAt: now });
}
/** @param {object} room @returns {void} 更新子弹位置、反弹次数和命中判定。 */
function updateBullets(room) {
  const dt = TICK_MS / 1000; const next = [];
  for (const bullet of room.bullets) {
    const oldX = bullet.x; const oldY = bullet.y; bullet.x += bullet.vx * dt; bullet.y += bullet.vy * dt;
    let hitWall = false; let nx = 0; let ny = 0;
    if (bullet.x - BULLET_RADIUS <= 0 || bullet.x + BULLET_RADIUS >= WORLD.width) { hitWall = true; nx = 1; bullet.x = clamp(bullet.x, BULLET_RADIUS, WORLD.width - BULLET_RADIUS); }
    if (bullet.y - BULLET_RADIUS <= 0 || bullet.y + BULLET_RADIUS >= WORLD.height) { hitWall = true; ny = 1; bullet.y = clamp(bullet.y, BULLET_RADIUS, WORLD.height - BULLET_RADIUS); }
    for (const wall of room.walls) if (circleRect(bullet.x, bullet.y, BULLET_RADIUS, wall)) { hitWall = true; if (oldX < wall.x || oldX > wall.x + wall.w) nx = 1; if (oldY < wall.y || oldY > wall.y + wall.h) ny = 1; bullet.x = oldX; bullet.y = oldY; break; }
    if (hitWall) {
      if (bullet.bounces >= 1) continue;
      bullet.bounces += 1; if (nx) bullet.vx *= -1; if (ny) bullet.vy *= -1; if (!nx && !ny) bullet.vx *= -1;
    }
    let removed = false;
    for (const player of room.players.values()) {
      if (player.id === bullet.owner || player.hp <= 0) continue;
      if (Date.now() < player.spawnProtectionUntil) continue;
      if ((player.x - bullet.x) ** 2 + (player.y - bullet.y) ** 2 <= (playerRadius(player) + BULLET_RADIUS) ** 2) {
        player.hp = Math.max(0, player.hp - 1); removed = true;
        const alive = [...room.players.values()].filter((candidate) => candidate.hp > 0);
        if (player.hp <= 0) {
          const particles = Array.from({ length: 14 }, (_, index) => { const angle = index / 14 * Math.PI * 2; const speed = 70 + Math.random() * 110; return { x: player.x, y: player.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, color: player.color, size: 3 + Math.random() * 4 }; });
          broadcastRoom(room, 'event', { event: 'deathExplosion', playerId: player.id, x: player.x, y: player.y, particles });
          if (alive.length <= 1) {
            room.winner = alive[0]?.id || null; room.status = 'finished';
            const winner = alive[0]; broadcastRoom(room, 'event', { event: 'win', winner: winner?.id, message: winner ? `${winner.name} 获胜！` : '本局结束！' });
          }
        } else {
          player.spawnProtectionUntil = Date.now() + SPAWN_INVINCIBLE_MS;
          broadcastRoom(room, 'event', { event: 'hit', playerId: player.id, hp: player.hp });
        }
        break;
      }
    }
    if (!removed) next.push(bullet);
  }
  room.bullets = next;
}
/**
 * 每 33ms 驱动移动、射击、子弹与状态广播。
 * @returns {void} 无返回值；通过 WebSocket 广播带服务端时间和输入确认序号的快照。
 */
function tick() {
  for (const room of rooms.values()) {
    if (room.status === 'playing') {
      for (const player of room.players.values()) { if (!player.disconnectedAt) movePlayer(player); if (player.shooting) fire(player); }
      updateBullets(room);
    }
    const players = [...room.players.values()];
    const snapshot = { roomCode: room.code, walls: room.walls, world: WORLD, serverTime: Date.now(), lastProcessedSeq: Object.fromEntries(players.map((p) => [p.id, p.lastInputSeq])), players: players.map((p) => ({ ...publicPlayer(p), radius: playerRadius(p), invincible: Date.now() < p.spawnProtectionUntil })), bullets: room.bullets.map((b) => ({ id: b.id, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, vx: b.vx, vy: b.vy, bounces: b.bounces })), winner: room.winner, round: room.round, status: room.status, aliveCount: players.filter((p) => p.hp > 0).length };
    broadcastRoom(room, 'state', snapshot);
  }
}
setInterval(tick, TICK_MS);

/**
 * 处理大厅查询/邀请、join、输入、射击、离开、重开和重连消息。
 * @param {object} session 当前 WebSocket 会话及其玩家引用。
 * @param {object} payload 客户端消息；input 可带递增 seq、clientTime、keys、shoot 与 aim，invite 可带 targetId 与 roomCode。
 * @returns {void} 更新服务端权威状态或向客户端发送错误；过期 seq 的 input 会被忽略。
 */
function handleMessage(session, payload) {
  if (!payload || typeof payload.type !== 'string') return;
  if (payload.type === 'roomList' || payload.type === 'lobby') { broadcastLobby(); return; }
  if (payload.type === 'invite') {
    const targetId = String(payload.targetId || payload.playerId || ''); const target = [...sessions.values()].find((candidate) => candidate.id === targetId);
    const roomCode = String(payload.roomCode || session.room?.code || '').toUpperCase();
    if (!target) return errorEvent(session.socket, '玩家不在线');
    send(target.socket, 'invite', { from: session.id, fromName: session.player?.name || session.name || '玩家', roomCode }); return;
  }
  if (payload.type === 'leave') { disconnect(session.socket); return; }
  if (payload.type === 'join' || payload.type === 'create' || payload.type === 'joinRoom') {
    const requested = String(payload.roomCode || payload.code || '').trim().toUpperCase(); const code = requested || createRoomCode(); let room = rooms.get(code);
    if (!room && requested) room = createRoom(code); else if (!room) room = createRoom();
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) return errorEvent(session.socket, '房间已满');
    if (session.player?.room) return errorEvent(session.socket, '你已经在房间中');
    session.name = String(payload.name || payload.nickname || session.name || '').trim().slice(0, 16);
    const player = addPlayer(room, session, session.name); send(session.socket, 'room', { ...roomInfo(room), playerId: player.id }); broadcastRoom(room, 'room', roomInfo(room)); broadcastLobby(); return;
  }
  if (payload.type === 'reconnect') {
    const playerId = String(payload.playerId || payload.clientId || ''); const room = rooms.get(String(payload.roomCode || '').toUpperCase()); const player = room?.players.get(playerId);
    if (!player || !player.disconnectedAt || Date.now() - player.disconnectedAt > RECONNECT_GRACE_MS) return errorEvent(session.socket, '重连已过期');
    player.socket = session.socket; player.disconnectedAt = null; session.player = player; session.room = room; session.name = player.name; send(session.socket, 'room', { ...roomInfo(room), playerId: player.id }); broadcastRoom(room, 'event', { event: 'reconnected', message: '玩家已重新连接' }); broadcastLobby(); return;
  }
  const player = session.player; if (!player) return errorEvent(session.socket, '请先加入房间');
  if (payload.type === 'input') {
    // 客户端预测会连续发送输入；序号保证网络乱序时旧状态不会覆盖新状态。
    const seq = Number(payload.seq);
    if (Number.isFinite(seq)) {
      const normalizedSeq = Math.floor(seq);
      if (normalizedSeq <= player.lastInputSeq) return;
      player.lastInputSeq = normalizedSeq;
    }
    const clientTime = Number(payload.clientTime);
    if (Number.isFinite(clientTime)) player.lastClientTime = clientTime;
    const keys = payload.keys || {};
    for (const key of ['a', 's', 'd', 'w']) if (key in keys) player.keys[key] = Boolean(keys[key]);
    if ('shoot' in payload) player.shooting = Boolean(payload.shoot);
    if (payload.aim && Number.isFinite(Number(payload.aim.x)) && Number.isFinite(Number(payload.aim.y))) player.angle = Math.atan2(Number(payload.aim.y) - player.y, Number(payload.aim.x) - player.x);
    if (Number.isFinite(Number(payload.angle))) player.angle = Number(payload.angle);
    return;
  }
  if (payload.type === 'shoot' || payload.type === 'fire') { player.shooting = payload.down !== false; if (payload.aim) player.angle = Math.atan2(Number(payload.aim.y) - player.y, Number(payload.aim.x) - player.x); if (payload.down !== false) fire(player); return; }
  if (payload.type === 'restart') { if (player.room.winner || player.room.status === 'finished') restartRoom(player.room); }
}

/** @param {import('ws').WebSocket} socket @returns {void} 连接关闭时保留席位并在 15 秒后清理。 */
function disconnect(socket) { const session = sessions.get(socket); if (!session) return; sessions.delete(socket); const player = session.player; if (!player) { broadcastLobby(); return; } player.socket = null; player.disconnectedAt = Date.now(); const room = player.room; broadcastRoom(room, 'event', { event: 'disconnected', playerId: player.id, message: '玩家暂时离线，15 秒内可重连。' }); broadcastLobby(); setTimeout(() => { if (!player.disconnectedAt || Date.now() - player.disconnectedAt < RECONNECT_GRACE_MS) return; room.players.delete(player.id); if (room.players.size === 0) rooms.delete(room.code); else { if (room.status === 'finished' && room.players.size >= MIN_PLAYERS_TO_START) { room.status = 'waiting'; room.winner = null; } broadcastRoom(room, 'room', roomInfo(room)); } broadcastLobby(); }, RECONNECT_GRACE_MS + 50); }

/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @returns {void} 提供 Render 健康检查和 public 静态资源。 */
function serveStatic(request, response) { const pathname = decodeURIComponent((request.url || '/').split('?')[0]); if (pathname === '/healthz') { response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ ok: true, rooms: rooms.size, online: sessions.size })); return; } const target = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname)); if (!target.startsWith(PUBLIC_DIR)) { response.writeHead(403); response.end('Forbidden'); return; } fs.readFile(target, (error, data) => { if (error) { response.writeHead(404); response.end('Not found'); return; } const ext = path.extname(target); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }; response.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(data); }); }

const httpServer = http.createServer(serveStatic);
const wsServer = new WebSocketServer({ server: httpServer, path: '/ws' });
wsServer.on('connection', (socket) => { const session = { socket, id: createId(), player: null, room: null, name: '' }; sessions.set(socket, session); send(socket, 'welcome', { playerId: session.id, maxPlayers: MAX_PLAYERS_PER_ROOM, minPlayers: MIN_PLAYERS_TO_START }); broadcastLobby(); socket.isAlive = true; socket.on('pong', () => { socket.isAlive = true; }); socket.on('message', (raw) => { try { handleMessage(session, JSON.parse(raw.toString())); } catch { errorEvent(socket, '消息格式不正确'); } }); socket.on('close', () => disconnect(socket)); socket.on('error', () => disconnect(socket)); });
setInterval(() => { for (const socket of wsServer.clients) { if (socket.isAlive === false) { socket.terminate(); continue; } socket.isAlive = false; socket.ping(); } }, 25000);

httpServer.listen(PORT, HOST, () => console.log(`神枪手服务已启动：http://127.0.0.1:${PORT}`));
process.on('SIGINT', () => { wsServer.close(); httpServer.close(() => process.exit(0)); });
