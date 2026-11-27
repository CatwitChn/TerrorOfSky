import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { acceptInput, createMatch, encodeMatchFrame, neutralizePilot, releasePilot, tickMatch } from './match.mjs';
import {
  AIRFRAME_LOADOUTS, defaultCountermeasures, defaultLoadout, MISSIONS, PROTOCOL_VERSION, validateCountermeasures, validateLoadout
} from './missions.mjs';
import { BATTLE_DISPLAY } from './simulation.mjs';
import { acceptTutorialAction } from './tutorial.mjs';

const HELP = `Terror of Sky server

Usage: node server.mjs [options]
  --host <address>    Listen address (default: 127.0.0.1)
  --port <number>     Listen port (default: 3000)
  --origin <url>      Allowed browser origin. Repeat for multiple sites.
                     Defaults to http://localhost:8080 and http://127.0.0.1:8080.
  --help, -h         Show this help.

Environment: HOST, PORT, LOBBY_ORIGINS (comma-separated)
Endpoints: /ws (WebSocket), /healthz (HTTP)
`;

function readOptions() {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      origin: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP.trimEnd());
    process.exit(0);
  }
  const host = (values.host ?? process.env.HOST ?? '127.0.0.1').trim();
  const portText = values.port ?? process.env.PORT ?? '3000';
  if (!host) throw new Error('Host must not be empty.');
  if (!/^\d+$/.test(portText) || Number(portText) > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  const sites = values.origin ?? process.env.LOBBY_ORIGINS?.split(',')
    ?? ['http://localhost:8080', 'http://127.0.0.1:8080'];
  const origins = new Set(sites.map(parseBrowserOrigin));
  return { host, port: Number(portText), origins };
}

export function parseBrowserOrigin(site) {
  const origin = site.trim();
  const url = URL.canParse(origin) ? new URL(origin) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Invalid browser origin: "${site}". Specify the scheme, host and optional port.`);
  }
  return url.origin;
}

let options;
let servePage;

const TEAM_SIZE = 4;
const TEAMS = ['uk', 'fr'];
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECONNECT_MS = 20_000;
const rooms = new Map();
const sessions = new Map();
const maintenanceFile = process.env.TOS_MAINTENANCE_FILE;
const isMaintenance = () => Boolean(maintenanceFile && existsSync(maintenanceFile));
let maintenance = isMaintenance();
let presenceTimer;

const server = createServer((request, response) => {
  if (request.url !== '/healthz') {
    if (servePage) servePage(request, response);
    else response.writeHead(404).end();
  } else if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
  } else {
    const activeMatches = [...rooms.values()].filter(room => room.arena && room.arena.state !== 'finished').length;
    const health = JSON.stringify({ status: 'ok', protocol: PROTOCOL_VERSION, maintenance: isMaintenance(), activeMatches }) + '\n';
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(health),
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : health);
  }
});

const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: 4096,
  perMessageDeflate: {
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    zlibDeflateOptions: { level: 3 },
    concurrencyLimit: 4,
    threshold: 1024,
  },
});

server.on('upgrade', (request, connection, head) => {
  const { origin } = request.headers;
  if (request.url !== '/ws' || (origin !== undefined && !options.origins.has(origin))) {
    connection.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  sockets.handleUpgrade(request, connection, head, socket => sockets.emit('connection', socket));
});

class LobbyError extends Error {}

function requireLobby(condition, message) {
  if (!condition) throw new LobbyError(message);
}

function send(socket, message) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 64_000) {
    socket.terminate();
    return;
  }
  // Only pre-encoded public state uses compression. Session messages contain reconnect tokens.
  const encoded = typeof message === 'string';
  socket.send(encoded ? message : JSON.stringify(message), { compress: encoded });
}

function queuePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = undefined;
    const online = [...sessions.values()].filter(player => player.socket?.readyState === WebSocket.OPEN);
    const callsigns = online.flatMap(player => player.name ? [player.name] : []).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const directory = [...rooms.values()].filter(room => !room.practice && room.players.length).map(room => ({
      code: room.code, mission: room.mission.id, count: room.players.length,
      capacity: room.mission.playerLimit, state: room.match?.state ?? 'waiting',
      host: room.players.find(player => player.id === room.hostId)?.name ?? '',
    }));
    const message = JSON.stringify({ type: 'presence', count: online.length, callsigns, rooms: directory, maintenance });
    for (const player of online) send(player.socket, message);
  }, 100).unref();
}

function validCallsign(input) {
  const name = typeof input === 'string' ? input.trim() : '';
  return name && [...name].length <= 16 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : null;
}

function teamSize(room, team) {
  return room.players.filter(player => player.team === team).length;
}

function canStart(room) {
  return !room.match && room.players.length > 0
    && (room.mission.mode === 'pve' || room.players.length === 1 || TEAMS.every(team => teamSize(room, team) > 0))
    && room.players.every(player => player.ready && player.socket?.readyState === WebSocket.OPEN);
}

function publishRoom(room) {
  const players = room.players.map(({ id, name, team, aircraft, loadout, countermeasures, ready, socket }) => ({
    id, name, team, aircraft, loadout, countermeasures, ready, connected: socket?.readyState === WebSocket.OPEN,
  }));
  const state = { code: room.code, hostId: room.hostId, teamSize: TEAM_SIZE, mission: room.mission,
    canStart: canStart(room), players, match: room.match };
  for (const player of room.players) send(player.socket, { type: 'room', room: state });
  queuePresence();
}

function newRoom(host, mission) {
  let code;
  do {
    code = '';
    for (let index = 0; index < 6; index++) code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  } while (rooms.has(code));
  const room = { code, hostId: host.id, mission, players: [], match: null, arena: null };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, player, name) {
  const team = room.mission.mode === 'pve' || teamSize(room, 'uk') <= teamSize(room, 'fr') ? 'uk' : 'fr';
  const aircraft = team === 'uk' ? 'f15' : 'su27';
  Object.assign(player, { room, name, team, aircraft, loadout: defaultLoadout(aircraft),
    countermeasures: defaultCountermeasures(aircraft), ready: false });
  room.players.push(player);
  queuePresence();
}

function leaveRoom(player) {
  const { room } = player;
  if (room) {
    player.room = null;
    if (room.arena) releasePilot(room.arena, player.id);
    room.players = room.players.filter(member => member !== player);
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      if (room.hostId === player.id) {
        room.hostId = (room.players.find(member => member.socket?.readyState === WebSocket.OPEN) ?? room.players[0]).id;
      }
      publishRoom(room);
    }
  }
  send(player.socket, { type: 'room', room: null });
  queuePresence();
}

function startMatch(room) {
  const nextSlot = { uk: 0, fr: 0 };
  const { mission } = room;
  room.match = {
    id: randomUUID(),
    map: mission.map,
    startedAt: Date.now(),
    state: 'loading',
    display: { ...BATTLE_DISPLAY, mission, practice: Boolean(room.practice) },
    players: room.players.map(({ id, name, team, aircraft, loadout, countermeasures }) => ({
      id, name, team, aircraft, loadout: { ...loadout }, countermeasures: { ...countermeasures }, slot: nextSlot[team]++,
    })),
  };
  room.arena = createMatch(room.match.players, performance.now(), mission, room.practice);
}

function publishMatch(room, recipient) {
  const encoded = encodeMatchFrame(room.match.id, room.arena);
  if (recipient) send(recipient.socket, encoded);
  else for (const player of room.players) send(player.socket, encoded);
}

function perform(player, action) {
  const { room } = player;
  if (action.type === 'latency') {
    if (Number.isSafeInteger(action.id)) send(player.socket, { type: 'latency', id: action.id });
    return;
  }
  if (action.type === 'callsign') {
    const name = validCallsign(action.name);
    if (!room && name !== player.name) {
      player.name = name;
      queuePresence();
    }
    return;
  }
  if (action.type === 'practice') {
    requireLobby(!room, '请先离开当前房间。');
    requireLobby(!isMaintenance(), '服务器准备更新，请稍后开始练习。');
    const practice = newRoom(player, MISSIONS['dover-intercept']);
    practice.practice = true;
    addPlayer(practice, player, validCallsign(action.name) ?? '飞行学员');
    startMatch(practice);
    publishRoom(practice);
    publishMatch(practice, player);
    return;
  }
  if (action.type === 'create' || action.type === 'join') {
    requireLobby(!room, '请先离开当前房间。');
    const name = validCallsign(action.name);
    requireLobby(name, '请输入 1 至 16 个字符的呼号。');
    const code = typeof action.code === 'string' ? action.code.trim().toUpperCase() : '';
    const creating = action.type === 'create';
    if (creating) requireLobby(typeof action.mission === 'string' && Object.hasOwn(MISSIONS, action.mission), '请选择任务。');
    const destination = creating ? newRoom(player, MISSIONS[action.mission]) : rooms.get(code);
    requireLobby(destination, '找不到该房间，请检查房间代码。');
    requireLobby(!destination.practice && !destination.match, '该房间已开局。');
    requireLobby(destination.players.length < destination.mission.playerLimit, '房间已满。');
    addPlayer(destination, player, name);
    publishRoom(destination);
    return;
  }

  requireLobby(room, '请先加入房间。');
  if (action.type === 'leave') {
    leaveRoom(player);
    return;
  }
  if (action.type === 'battle-ready' || action.type === 'battle-input' || action.type === 'lesson-action') {
    const pilot = room.arena?.pilots.get(player.id);
    if (!pilot || action.id !== room.match.id) return;
    if (action.type === 'battle-ready') {
      pilot.ready = true;
      publishMatch(room, player);
    } else if (pilot.ready && room.arena.state === 'playing') {
      if (action.type === 'lesson-action') acceptTutorialAction(room.arena.battle, action.operation, pilot.aircraft);
      else acceptInput(pilot, action, performance.now());
    }
    return;
  }
  requireLobby(!room.match || action.type === 'reopen', '请先返回准备阶段。');
  switch (action.type) {
    case 'team':
      requireLobby(room.mission.mode === 'pvp', '合作任务的玩家在同一编队。');
      requireLobby(TEAMS.includes(action.team), '队伍无效。');
      if (action.team === player.team) return;
      requireLobby(teamSize(room, action.team) < TEAM_SIZE, '该队伍已满。');
      player.team = action.team;
      player.ready = false;
      break;
    case 'aircraft':
      requireLobby(typeof action.aircraft === 'string' && Object.hasOwn(AIRFRAME_LOADOUTS, action.aircraft), '机型无效。');
      if (action.aircraft === player.aircraft) return;
      player.aircraft = action.aircraft;
      player.loadout = defaultLoadout(player.aircraft);
      player.countermeasures = defaultCountermeasures(player.aircraft);
      player.ready = false;
      break;
    case 'loadout': {
      requireLobby(action.aircraft === player.aircraft, '座机已切换，请重新确认挂载。');
      const loadout = validateLoadout(player.aircraft, action.loadout);
      requireLobby(loadout, '请在兼容挂点上配置至少一枚导弹。');
      const countermeasures = action.countermeasures === undefined ? player.countermeasures
        : validateCountermeasures(player.aircraft, action.countermeasures);
      const { countermeasureCapacity } = AIRFRAME_LOADOUTS[player.aircraft];
      requireLobby(countermeasures, `热诱弹和箔条共用 ${countermeasureCapacity} 发，请重新分配。`);
      if (JSON.stringify(loadout) === JSON.stringify(player.loadout)
          && countermeasures.flares === player.countermeasures.flares) return;
      player.loadout = loadout;
      player.countermeasures = countermeasures;
      player.ready = false;
      break;
    }
    case 'ready':
      requireLobby(typeof action.ready === 'boolean', '准备状态无效。');
      player.ready = action.ready;
      break;
    case 'start':
      requireLobby(room.hostId === player.id, '仅房主可以开始。');
      requireLobby(!isMaintenance(), '服务器准备更新，请稍后开局。');
      requireLobby(canStart(room), room.mission.mode === 'pve' ? '请让所有玩家准备。' : '请让所有玩家准备。多人对抗需要两队均有玩家。');
      startMatch(room);
      break;
    case 'reopen':
      requireLobby(room.hostId === player.id, '仅房主可以返回准备。');
      requireLobby(room.match, '房间已在准备阶段。');
      room.match = null;
      room.arena = null;
      for (const member of room.players) member.ready = false;
      break;
    default:
      throw new LobbyError('无法识别该操作。');
  }
  publishRoom(room);
  if (action.type === 'start') publishMatch(room);
}

function establishSession(socket, token, name) {
  let player = sessions.get(token);
  if (!player) {
    player = { id: randomUUID(), token: randomBytes(24).toString('base64url'), room: null, name: validCallsign(name) };
    sessions.set(player.token, player);
  } else if (!player.room && typeof name === 'string') {
    player.name = validCallsign(name);
  }
  clearTimeout(player.expiry);
  player.socket?.close(4001, 'Session resumed');
  player.socket = socket;
  send(socket, { type: 'session', protocol: PROTOCOL_VERSION, id: player.id, token: player.token,
    missions: Object.values(MISSIONS), airframes: Object.fromEntries(Object.entries(AIRFRAME_LOADOUTS).map(([id, airframe]) =>
      [id, { ...airframe, balanced: defaultLoadout(id) }])) });
  if (player.room) {
    publishRoom(player.room);
    if (player.room.arena) publishMatch(player.room, player);
  } else send(socket, { type: 'room', room: null });
  queuePresence();
  return player;
}

sockets.on('connection', socket => {
  let player;
  const helloDeadline = setTimeout(() => socket.terminate(), 8000);
  socket.respondedToPing = true;
  socket.on('pong', () => { socket.respondedToPing = true; });
  socket.on('error', () => socket.terminate());
  socket.on('message', (data, binary) => {
    let action;
    try {
      if (!binary) action = JSON.parse(data.toString());
    } catch {
      // Invalid input is reported to the requesting client below.
    }
    try {
      requireLobby(action && typeof action.type === 'string', '请求格式无效。');
      if (!player) {
        requireLobby(action.type === 'hello', '请先建立会话。');
        clearTimeout(helloDeadline);
        player = establishSession(socket, action.token, action.name);
      } else if (player.socket === socket) {
        perform(player, action);
      }
    } catch (error) {
      if (!(error instanceof LobbyError)) {
        console.error(error);
        socket.close(1011);
        return;
      }
      send(socket, { type: 'error', message: error.message });
    }
  });
  socket.on('close', () => {
    clearTimeout(helloDeadline);
    if (player?.socket !== socket) return;
    player.socket = null;
    queuePresence();
    if (player.room) {
      const pilot = player.room.arena?.pilots.get(player.id);
      if (pilot) {
        pilot.ready = false;
        neutralizePilot(pilot);
      }
      if (!player.room.match) player.ready = false;
      publishRoom(player.room);
    }
    player.expiry = setTimeout(() => {
      leaveRoom(player);
      sessions.delete(player.token);
    }, RECONNECT_MS).unref();
  });
});

setInterval(() => {
  const now = performance.now();
  for (const room of rooms.values()) {
    if (!room.arena || room.arena.state === 'finished') continue;
    tickMatch(room.arena, now);
    const changed = room.match.state !== room.arena.state;
    if (changed) {
      room.match.state = room.arena.state;
      publishRoom(room);
    }
    if (changed || room.arena.state === 'playing') publishMatch(room);
  }
}, 50).unref();

if (maintenanceFile) {
  setInterval(() => {
    const next = isMaintenance();
    if (next === maintenance) return;
    maintenance = next;
    queuePresence();
  }, 500).unref();
}

setInterval(() => {
  for (const socket of sockets.clients) {
    if (!socket.respondedToPing) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) {
      socket.respondedToPing = false;
      socket.ping();
    }
  }
}, 20_000).unref();

server.on('error', error => {
  console.error(`[server] ${error.message}`);
  process.exitCode = 1;
});
export function startServer(settings, staticHandler) {
  options = settings;
  servePage = staticHandler;
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    console.log(`[server] Listening at ws://${urlHost}:${address.port}/ws`);
    if (staticHandler) console.log(`[server] Lobby at http://${urlHost}:${address.port}/lobby/`);
    else console.log(`[server] Browser origins: ${[...options.origins].join(', ')}`);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[server] Shutting down.');
  server.close();
  for (const socket of sockets.clients) socket.close(1001, 'Server shutting down');
  sockets.close();
  setTimeout(() => {
    for (const socket of sockets.clients) socket.terminate();
  }, 2000).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    startServer(readOptions());
  } catch (error) {
    console.error(`[server] ${error.message}\nRun with --help for usage.`);
    process.exit(2);
  }
}
