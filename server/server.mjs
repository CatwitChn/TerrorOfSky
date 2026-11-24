import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { acceptInput, createMatch, encodeMatchFrame, neutralizePilot, releasePilot, tickMatch } from './match.mjs';

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
  const origins = new Set(sites.map(site => {
    const origin = site.trim();
    const url = URL.canParse(origin) ? new URL(origin) : null;
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`Invalid browser origin: "${site}". Specify the scheme, host and optional port.`);
    }
    return url.origin;
  }));
  return { host, port: Number(portText), origins };
}

let options;
try {
  options = readOptions();
} catch (error) {
  console.error(`[server] ${error.message}\nRun with --help for usage.`);
  process.exit(2);
}

const TEAM_SIZE = 4;
const TEAMS = ['uk', 'fr'];
const AIRCRAFT = ['f15', 'su27'];
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECONNECT_MS = 20_000;
const rooms = new Map();
const sessions = new Map();

const health = '{"status":"ok"}\n';
const server = createServer((request, response) => {
  if (request.url !== '/healthz') {
    response.writeHead(404).end();
  } else if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
  } else {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(health),
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : health);
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });

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
  socket.send(typeof message === 'string' ? message : JSON.stringify(message));
}

function teamSize(room, team) {
  return room.players.filter(player => player.team === team).length;
}

function canStart(room) {
  return !room.match && TEAMS.every(team => teamSize(room, team) > 0)
    && room.players.every(player => player.ready && player.socket?.readyState === WebSocket.OPEN);
}

function publishRoom(room) {
  const players = room.players.map(({ id, name, team, aircraft, ready, socket }) => ({
    id, name, team, aircraft, ready, connected: socket?.readyState === WebSocket.OPEN,
  }));
  const state = { code: room.code, hostId: room.hostId, teamSize: TEAM_SIZE, canStart: canStart(room), players, match: room.match };
  for (const player of room.players) send(player.socket, { type: 'room', room: state });
}

function newRoom(host) {
  let code;
  do {
    code = '';
    for (let index = 0; index < 6; index++) code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  } while (rooms.has(code));
  const room = { code, hostId: host.id, players: [], match: null, arena: null };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, player, name) {
  const team = teamSize(room, 'uk') <= teamSize(room, 'fr') ? 'uk' : 'fr';
  Object.assign(player, { room, name, team, aircraft: AIRCRAFT[TEAMS.indexOf(team)], ready: false });
  room.players.push(player);
  publishRoom(room);
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
}

function startMatch(room) {
  const nextSlot = { uk: 0, fr: 0 };
  room.match = {
    id: randomUUID(),
    map: 'dover',
    startedAt: Date.now(),
    state: 'loading',
    players: room.players.map(({ id, name, team, aircraft }) => ({
      id, name, team, aircraft, slot: nextSlot[team]++,
    })),
  };
  room.arena = createMatch(room.match.players, performance.now());
}

function publishMatch(room, recipient) {
  const encoded = encodeMatchFrame(room.match.id, room.arena);
  if (recipient) send(recipient.socket, encoded);
  else for (const player of room.players) send(player.socket, encoded);
}

function perform(player, action) {
  const { room } = player;
  if (action.type === 'create' || action.type === 'join') {
    requireLobby(!room, '请先离开当前房间。');
    const name = typeof action.name === 'string' ? action.name.trim() : '';
    requireLobby(name && [...name].length <= 16 && !/[\p{Cc}\p{Cf}]/u.test(name), '请输入 1 至 16 个字符的呼号。');
    const code = typeof action.code === 'string' ? action.code.trim().toUpperCase() : '';
    const destination = action.type === 'create' ? newRoom(player) : rooms.get(code);
    requireLobby(destination, '找不到该房间，请检查房间代码。');
    requireLobby(!destination.match, '该房间已开局。');
    requireLobby(destination.players.length < TEAM_SIZE * TEAMS.length, '房间已满。');
    addPlayer(destination, player, name);
    return;
  }

  requireLobby(room, '请先加入房间。');
  if (action.type === 'leave') {
    leaveRoom(player);
    return;
  }
  if (action.type === 'battle-ready' || action.type === 'battle-input') {
    const pilot = room.arena?.pilots.get(player.id);
    if (!pilot || action.id !== room.match.id) return;
    if (action.type === 'battle-ready') {
      pilot.ready = true;
      publishMatch(room, player);
    } else if (pilot.ready && room.arena.state === 'playing') {
      acceptInput(pilot, action, performance.now());
    }
    return;
  }
  requireLobby(!room.match || action.type === 'reopen', '请先返回准备阶段。');
  switch (action.type) {
    case 'team':
      requireLobby(TEAMS.includes(action.team), '队伍无效。');
      if (action.team === player.team) return;
      requireLobby(teamSize(room, action.team) < TEAM_SIZE, '该队伍已满。');
      player.team = action.team;
      player.ready = false;
      break;
    case 'aircraft':
      requireLobby(AIRCRAFT.includes(action.aircraft), '机型无效。');
      if (action.aircraft === player.aircraft) return;
      player.aircraft = action.aircraft;
      player.ready = false;
      break;
    case 'ready':
      requireLobby(typeof action.ready === 'boolean', '准备状态无效。');
      player.ready = action.ready;
      break;
    case 'start':
      requireLobby(room.hostId === player.id, '仅房主可以开始。');
      requireLobby(canStart(room), '请确保两队均有人，且所有玩家已准备。');
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

function establishSession(socket, token) {
  let player = sessions.get(token);
  if (!player) {
    player = { id: randomUUID(), token: randomBytes(24).toString('base64url'), room: null };
    sessions.set(player.token, player);
  }
  clearTimeout(player.expiry);
  player.socket?.close(4001, 'Session resumed');
  player.socket = socket;
  send(socket, { type: 'session', id: player.id, token: player.token });
  if (player.room) {
    publishRoom(player.room);
    if (player.room.arena) publishMatch(player.room, player);
  } else send(socket, { type: 'room', room: null });
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
        player = establishSession(socket, action.token);
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
server.listen(options.port, options.host, () => {
  const address = server.address();
  const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.log(`[server] Listening at ws://${urlHost}:${address.port}/ws`);
  console.log(`[server] Browser origins: ${[...options.origins].join(', ')}`);
});

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

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
