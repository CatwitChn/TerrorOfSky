import * as settings from './config.js';

const { serverUrl, battleUrl = '../index.html' } = settings;
const PROTOCOL_VERSION = 3;

const find = id => document.getElementById(id);
const entry = find('entry');
const roomPanel = find('room');
const connection = find('connection');
const notice = find('notice');
const callsign = find('callsign');
const code = find('room-code');
const aircraft = find('aircraft');
const ready = find('ready');
const start = find('start');
const reopen = find('reopen');
const leave = find('leave');
const teamButtons = { uk: find('join-uk'), fr: find('join-fr') };
const battleScreen = find('battle-screen');
const enterBattle = find('enter-battle');
const lobbyRegions = document.querySelectorAll('body > header, body > main');
const aircraftNames = { f15: 'F-15A', su27: 'Su-27' };
const invitedCode = new URL(location.href).searchParams.get('room')?.toUpperCase();
if (/^[A-HJ-NP-Z2-9]{6}$/.test(invitedCode)) code.value = invitedCode;
callsign.value = sessionStorage.getItem('tos-callsign') ?? '';

let socket;
let playerId;
let room = null;
let online = false;
let reconnectDelay = 750;
let battleView = null;

function showNotice(message = '', error = false) {
  notice.textContent = message;
  notice.toggleAttribute('data-error', error);
  notice.hidden = !message;
}

function addText(parent, className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  parent.append(span);
  return span;
}

function renderTeam(team, me) {
  const members = room.players.filter(player => player.team === team);
  const list = find(`${team}-roster`);
  list.replaceChildren();
  for (let index = 0; index < room.teamSize; index++) {
    const player = members[index];
    const row = document.createElement('li');
    if (player) {
      const identity = document.createElement('div');
      const label = player.id === me.id ? `${player.name}（你）` : player.name;
      addText(identity, 'callsign', label).title = label;
      addText(identity, 'aircraft-tag', aircraftNames[player.aircraft]);
      row.append(identity);
      const status = !player.connected ? '重连中' : player.id === room.hostId ? '房主' : '';
      const readiness = player.connected && player.ready ? '已准备' : '';
      addText(row, 'player-status', [status, readiness].filter(Boolean).join(' · ') || '未准备')
        .toggleAttribute('data-ready', Boolean(readiness));
    } else {
      addText(row, 'slot-empty', '空位');
    }
    list.append(row);
  }
  const current = me.team === team;
  const full = members.length === room.teamSize;
  teamButtons[team].textContent = current ? '本队' : full ? '已满' : '加入';
  teamButtons[team].disabled = !online || current || full || Boolean(room.match);
}

function render() {
  find('create').disabled = !online;
  find('join').disabled = !online;
  entry.hidden = Boolean(room);
  roomPanel.hidden = !room;
  if (!room) return;

  const me = room.players.find(player => player.id === playerId);
  if (!me) return;
  const host = room.hostId === playerId;
  const matchStarted = Boolean(room.match);
  find('room-number').textContent = room.code;
  find('room-count').textContent = `${room.players.length} / ${room.teamSize * 2} 名飞行员 · ${matchStarted ? '已开局' : '准备中'}`;
  renderTeam('uk', me);
  renderTeam('fr', me);

  find('room-controls').hidden = matchStarted && !host;
  find('aircraft-control').hidden = matchStarted;
  aircraft.disabled = !online;
  aircraft.value = me.aircraft;
  ready.hidden = matchStarted;
  ready.disabled = !online;
  ready.textContent = me.ready ? '取消准备' : '准备';
  start.hidden = !host || matchStarted;
  start.disabled = !online || !room.canStart;
  reopen.hidden = !host || !matchStarted;
  reopen.disabled = !online;
  leave.disabled = !online;
  find('start-rule').hidden = matchStarted;
  find('start-rule').textContent = room.players.length === 1
    ? '一人准备后即可开局，空位由 AI 补齐。'
    : '两队均有人且全员准备后，房主可以开局。';
  find('match').hidden = !matchStarted;
  if (matchStarted) {
    const state = room.match.state;
    find('match-status').textContent = {
      loading: '正在加载战场', playing: '对局进行中', finished: '对局已结束',
    }[state];
    find('match-code').textContent = `对局编号 ${room.match.id.slice(0, 8).toUpperCase()}`;
    reopen.textContent = state === 'playing' || state === 'loading' ? '结束本局' : '返回准备';
    enterBattle.hidden = !battleView;
  }
}

function sendBattleView(message) {
  battleView?.frame.contentWindow?.postMessage({ channel: 'tos-lobby', ...message }, location.origin);
}

function showBattle(visible) {
  if (!visible) sendBattleView({ type: 'suspend' });
  battleScreen.hidden = !visible;
  document.body.classList.toggle('battle-open', visible);
  for (const region of lobbyRegions) region.inert = visible;
  if (visible) battleView?.frame.focus();
}

function attachBattle() {
  const match = room?.match;
  if (match?.id === battleView?.id) return;
  showBattle(false);
  battleScreen.replaceChildren();
  battleView = null;
  const pilot = match?.players.find(member => member.id === playerId);
  if (!match?.display || !pilot) return;
  const url = new URL(battleUrl, location.href);
  if (url.origin !== location.origin) {
    showNotice('大厅和战斗页面需要托管在同一站点。', true);
    return;
  }
  url.searchParams.set('online', match.id);
  const frame = document.createElement('iframe');
  frame.title = '多佛白崖联机战场';
  frame.src = url.href;
  const seat = (pilot.team === 'uk' ? 0 : room.teamSize) + pilot.slot;
  battleView = { id: match.id, frame, seat, display: match.display, ready: false, readySent: false, latest: null };
  battleScreen.append(frame);
  showBattle(true);
}

function notifyReady() {
  if (!online || !battleView?.ready || battleView.readySent) return;
  battleView.readySent = true;
  socket.send(JSON.stringify({ type: 'battle-ready', id: battleView.id }));
}

window.addEventListener('message', event => {
  if (!battleView || event.origin !== location.origin || event.source !== battleView.frame.contentWindow) return;
  const { channel, id, type, throttle, turn, action } = event.data ?? {};
  if (channel !== 'tos-flight' || id !== battleView.id) return;
  if (type === 'configure') {
    sendBattleView({ type: 'configuration', display: battleView.display });
  } else if (type === 'ready') {
    battleView.ready = true;
    if (battleView.latest) sendBattleView({ type: 'snapshot', seat: battleView.seat, snapshot: battleView.latest });
    sendBattleView({ type: 'connection', online });
    notifyReady();
  } else if (type === 'return') {
    showBattle(false);
    enterBattle.focus();
  } else if (type === 'input' && online && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 64_000) {
    if (battleScreen.hidden && (action || throttle || turn)) return;
    socket.send(JSON.stringify({ type: 'battle-input', id, throttle, turn, action }));
  }
});

function setConnection(state, text) {
  online = state === 'online';
  connection.dataset.state = state;
  connection.textContent = text;
  render();
}

function connect(endpoint) {
  const tokenKey = `tos-session:${endpoint.href}`;
  let incompatible = false;
  socket = new WebSocket(endpoint);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello', token: sessionStorage.getItem(tokenKey) }));
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    switch (message.type) {
      case 'session':
        if (message.protocol !== PROTOCOL_VERSION) {
          incompatible = true;
          setConnection('offline', '服务端版本不匹配');
          showNotice('请用 0.3.0 服务端启动新版大厅。', true);
          socket.close();
          break;
        }
        if (playerId && playerId !== message.id) {
          room = null;
          attachBattle();
        }
        playerId = message.id;
        sessionStorage.setItem(tokenKey, message.token);
        reconnectDelay = 750;
        setConnection('online', '服务在线');
        break;
      case 'room':
        if (room?.code !== message.room?.code) find('share').hidden = true;
        room = message.room;
        attachBattle();
        render();
        sendBattleView({ type: 'connection', online: true });
        notifyReady();
        break;
      case 'battle':
        if (battleView?.id !== message.id) break;
        battleView.latest = message;
        if (battleView.ready) sendBattleView({ type: 'snapshot', seat: battleView.seat, snapshot: message });
        break;
      case 'error':
        showNotice(message.message, true);
        render();
    }
  });
  socket.addEventListener('close', event => {
    if (incompatible) return;
    if (event.code === 4001) {
      sessionStorage.removeItem(tokenKey);
      room = null;
      attachBattle();
    }
    if (battleView) battleView.readySent = false;
    sendBattleView({ type: 'connection', online: false });
    setConnection('offline', '重连中');
    setTimeout(() => connect(endpoint), reconnectDelay);
    reconnectDelay = Math.min(2 * reconnectDelay, 5000);
  });
}

function send(type, fields = {}) {
  if (!online || socket.readyState !== WebSocket.OPEN) return;
  showNotice();
  socket.send(JSON.stringify({ type, ...fields }));
}

function enterRoom(type) {
  const name = callsign.value.trim();
  callsign.setCustomValidity(name && [...name].length <= 16 ? '' : '请输入 1 至 16 个字符的呼号。');
  if (!callsign.reportValidity()) return;
  sessionStorage.setItem('tos-callsign', name);
  send(type, { name, code: code.value.toUpperCase() });
}

callsign.addEventListener('input', () => callsign.setCustomValidity(''));
find('create').addEventListener('click', () => enterRoom('create'));
find('join-form').addEventListener('submit', event => {
  event.preventDefault();
  enterRoom('join');
});
for (const [team, button] of Object.entries(teamButtons)) {
  button.addEventListener('click', () => send('team', { team }));
}
aircraft.addEventListener('change', () => send('aircraft', { aircraft: aircraft.value }));
ready.addEventListener('click', () => send('ready', { ready: !room.players.find(player => player.id === playerId).ready }));
start.addEventListener('click', () => send('start'));
reopen.addEventListener('click', () => send('reopen'));
leave.addEventListener('click', () => send('leave'));
enterBattle.addEventListener('click', () => showBattle(true));
find('invite').addEventListener('click', async () => {
  const link = new URL(location.href);
  link.search = '';
  link.hash = '';
  link.searchParams.set('room', room.code);
  try {
    await navigator.clipboard.writeText(link.href);
    showNotice('邀请链接已复制。');
  } catch {
    find('share').hidden = false;
    const field = find('share-link');
    field.value = link.href;
    field.focus();
    field.select();
  }
});

try {
  const endpoint = new URL(serverUrl, location.href);
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('请在 config.js 中填写有效的 WebSocket 地址。');
  }
  if (location.protocol === 'https:' && endpoint.protocol !== 'wss:') {
    throw new Error('HTTPS 大厅需要使用 wss:// 服务地址。');
  }
  connect(endpoint);
} catch (error) {
  setConnection('offline', '服务地址无效');
  showNotice(error.message, true);
}
