import * as settings from './config.js';
import { getMissileArt, paintMissileArt } from './missile-art.js';

const { serverUrl, battleUrl = '../index.html' } = settings;
const PROTOCOL_VERSION = 12;

const find = id => document.getElementById(id);
const entry = find('entry');
const roomPanel = find('room');
const connection = find('connection');
const notice = find('notice');
const latency = find('connection-latency');
const directory = find('lobby-directory');
const tutorial = find('tutorial');
const tutorialTabs = tutorial.querySelectorAll('[aria-controls]');
const startPractice = find('start-practice');
const callsign = find('callsign');
const code = find('room-code');
const missionSelect = find('mission-select');
const aircraft = find('aircraft');
const ready = find('ready');
const start = find('start');
const reopen = find('reopen');
const leave = find('leave');
const teamButtons = { uk: find('join-uk'), fr: find('join-fr') };
const battleScreen = find('battle-screen');
const enterBattle = find('enter-battle');
const lobbyRegions = document.querySelectorAll('body > header, body > main');
const loadoutEditor = find('loadout-editor');
const applyLoadout = find('apply-loadout');
const cancelLoadout = find('cancel-loadout');
const countermeasureFields = { flares: find('fit-flares'), chaff: find('fit-chaff') };
const presetButtons = [...loadoutEditor.querySelectorAll('[data-preset]')];
const invitedCode = new URL(location.href).searchParams.get('room')?.toUpperCase();
if (/^[A-HJ-NP-Z2-9]{6}$/.test(invitedCode)) code.value = invitedCode;
callsign.value = sessionStorage.getItem('tos-callsign') ?? '';

fetch('./version.json', { cache: 'no-cache' }).then(async response => {
  if (!response.ok) return;
  const { version } = await response.json();
  if (!/^\d+\.\d+\.\d+([-+][a-z0-9.-]+)*$/i.test(version)) return;
  const label = find('game-version');
  label.textContent = `v${version}`;
  label.hidden = false;
}).catch(error => console.warn('Could not read the game version:', error));

let socket;
let playerId;
let room = null;
let online = false;
let maintenance = false;
let reconnectDelay = 750;
let battleView = null;
let missions = new Map();
let loadouts = {};
let loadoutKey = '';
let loadoutDraft = {};
let savedLoadout = {};
let countermeasureDraft = {};
let savedCountermeasures = {};
let savingLoadout = false;
let stationControls = [];
let presence = null;

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

function currentPilot() {
  return room?.players.find(player => player.id === playerId);
}

function renderMission() {
  const mission = room?.mission ?? missions.get(missionSelect.value);
  const cooperative = mission?.mode === 'pve';
  const raid = mission?.raid;
  const mode = cooperative ? '合作 PvE' : '对抗 PvP';
  const briefing = mission ? `${mission.objective} 限时 ${mission.timeLimit / 60} 分钟。` : '';
  find('map-mode').textContent = mission ? mode : '多佛';
  find('map-capacity').textContent = mission ? `${mission.playerLimit} 人` : '—';
  find('map-friendly').textContent = raid ? '防御编队' : cooperative ? '合作编队' : '英国侧';
  find('map-enemy').textContent = raid ? '轰炸编队' : cooperative ? 'AI 敌机' : '法国侧';
  find('mission-map').setAttribute('aria-label', raid ? '多佛海峡地图，守军在英国侧，轰炸编队从法国出发'
    : cooperative ? '多佛海峡地图，合作编队和 AI 敌机从海峡两侧出发'
    : '多佛海峡地图，英国和法国编队从海峡两侧出发');
  find('mission-preview').hidden = !mission;
  find('mission-preview').textContent = briefing;
  if (room) {
    find('room-mission').textContent = `${mode} · ${mission.name}`;
    find('room-objective').textContent = briefing;
  }
}

function drawPlanform(airframe) {
  // Compact nose-up outlines for the hangar diagram, in the same art coordinates as the markers.
  const halves = {
    f15: [[0,-10],[.7,-7.4],[.8,-4.2],[1.7,-4.2],[2,-.4],[6.4,3.8],[6.6,4.5],[5.7,5.8],
      [2.1,5.4],[1.9,6.4],[4.4,9.6],[3.8,10],[1.7,9.5],[1.4,8.3],[0,8.1]],
    su27: [[0,-11],[.65,-8.6],[.9,-5.7],[1.15,-4.4],[1.5,-2.1],[2.2,-1],[7.15,3.75],
      [7.35,2.65],[7.47,5.9],[2.22,4.56],[2.24,5.35],[4.88,8.19],[4.43,9.02],
      [2.19,8.87],[1.83,9.15],[.65,9.15],[.57,10.37],[0,11.03]],
    f14d: [[0,-9.48],[.57,-8.01],[.89,-4.12],[1.63,-3.68],[2.25,-1.75],[3.62,.67],
      [9.18,3.13],[9.47,3.52],[9.47,4.46],[2.31,4.22],[2.22,5.53],[4.99,8.96],[4.61,9.55],
      [2.18,9.16],[2.10,8.8],[.82,8.8],[.58,7.98],[.35,9.16],[0,9.16]],
  };
  const canvas = find('aircraft-planform');
  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(10, 10);
  const outline = halves[airframe];
  ctx.beginPath();
  for (const [x, z] of outline) ctx.lineTo(x, z);
  for (const [x, z] of [...outline].reverse()) ctx.lineTo(-x, z);
  ctx.closePath();
  ctx.fillStyle = airframe === 'su27' ? '#34576a' : '#38515a';
  ctx.strokeStyle = '#71919a';
  ctx.lineWidth = .12;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#9db8bf';
  ctx.beginPath();
  const canopy = { f15: [-5.25, 1.38], su27: [-7, 1.38], f14d: [-5.98, 2.02] }[airframe];
  ctx.ellipse(0, canopy[0], .49, canopy[1], 0, 0, Math.PI * 2);
  ctx.fill();
  for (const station of loadouts[airframe].stations) {
    const art = getMissileArt(loadoutDraft[station.id]);
    if (!art) continue;
    ctx.save();
    ctx.translate(station.x, station.z);
    paintMissileArt(ctx, art);
    ctx.restore();
  }
}

function buildStations(airframe) {
  const diagram = find('aircraft-diagram');
  const list = find('station-list');
  diagram.replaceChildren(find('aircraft-planform'));
  list.replaceChildren();
  stationControls = loadouts[airframe].stations.map((station, index) => {
    const number = String(index + 1);
    const field = document.createElement('select');
    field.id = `station-${station.id}`;
    field.append(new Option('空挂', ''), ...station.weapons.map(weapon => new Option(weapon, weapon)));
    field.addEventListener('change', () => {
      if (field.value) loadoutDraft[station.id] = field.value;
      else delete loadoutDraft[station.id];
      editedLoadout();
    });
    const label = document.createElement('label');
    label.textContent = `${number} ${station.label}`;
    label.htmlFor = field.id;
    const row = document.createElement('div');
    row.className = 'station-row';
    row.append(label, field);
    list.append(row);

    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'station-marker';
    marker.style.left = `${50 + station.x * 5}%`;
    marker.style.top = `${50 + station.z * 100 / 24}%`;
    marker.textContent = number;
    marker.setAttribute('aria-label', `${station.label}挂载`);
    marker.addEventListener('click', () => field.focus());
    diagram.append(marker);
    return { station, field, marker };
  });
}

function updateLoadoutControls(editingField = null) {
  if (!room || room.match) return;
  const count = Object.keys(loadoutDraft).length;
  const airframe = currentPilot().aircraft;
  const { stations, countermeasureCapacity } = loadouts[airframe];
  const limit = stations.length;
  const dirty = count !== Object.keys(savedLoadout).length
    || Object.entries(loadoutDraft).some(([id, weapon]) => savedLoadout[id] !== weapon)
    || countermeasureDraft.flares !== savedCountermeasures.flares;
  const locked = !online || savingLoadout;
  drawPlanform(airframe);
  for (const { station, field, marker } of stationControls) {
    field.value = loadoutDraft[station.id] ?? '';
    field.disabled = marker.disabled = locked;
    marker.toggleAttribute('data-loaded', Boolean(field.value));
  }
  for (const button of presetButtons) {
    button.disabled = locked;
    button.hidden = button.dataset.preset === 'arh' && !loadouts[airframe].arh;
  }
  find('countermeasure-capacity').value = `${countermeasureCapacity} 发`;
  for (const [kind, field] of Object.entries(countermeasureFields)) {
    field.max = countermeasureCapacity;
    field.disabled = locked;
    if (field !== editingField) field.value = countermeasureDraft[kind];
  }
  find('loadout-summary').value = `${count} / ${limit} 枚`;
  find('loadout-status').textContent = savingLoadout ? '正在保存' : count === 0
    ? '请至少配置一枚导弹' : dirty ? '有未保存的修改' : '';
  applyLoadout.disabled = locked || !dirty || count < 1;
  cancelLoadout.disabled = locked || !dirty;
  ready.disabled = locked || dirty;
  start.disabled = locked || dirty || !room.canStart || maintenance;
  aircraft.disabled = locked;
}

function editedLoadout(editingField = null) {
  if (currentPilot()?.ready) send('ready', { ready: false });
  updateLoadoutControls(editingField);
}

function renderTeam(team, me) {
  const members = room.players.filter(player => player.team === team);
  const list = find(`${team}-roster`);
  list.replaceChildren();
  const cooperative = room.mission.mode === 'pve';
  const enemyWave = cooperative && team === 'fr';
  const raid = room.mission.raid;
  const fillAirframe = members[0]?.aircraft ?? (team === 'uk' ? 'f15' : 'su27');
  const slots = enemyWave ? (raid ? raid.bombers + raid.escorts : room.match?.players.length ?? room.players.length) : room.teamSize;
  find(`${team}-label`).textContent = cooperative
    ? (raid ? (enemyWave ? '轰炸编队' : '工厂防御编队') : enemyWave ? 'AI 敌机' : '合作编队')
    : team === 'uk' ? '英国侧' : '法国侧';
  for (let index = 0; index < slots; index++) {
    const player = members[index];
    const row = document.createElement('li');
    if (player) {
      const identity = document.createElement('div');
      const label = player.id === me.id ? `${player.name}（你）` : player.name;
      addText(identity, 'callsign', label).title = label;
      addText(identity, 'aircraft-tag', loadouts[player.aircraft].name);
      row.append(identity);
      const status = !player.connected ? '重连中' : player.id === room.hostId ? '房主' : '';
      const readiness = player.connected && player.ready ? '已准备' : '';
      addText(row, 'player-status', [status, readiness].filter(Boolean).join(' · ') || '未准备')
        .toggleAttribute('data-ready', Boolean(readiness));
    } else if (enemyWave) {
      const bomber = raid && index < raid.bombers;
      const number = index - (raid && !bomber ? raid.bombers : 0) + 1;
      addText(row, 'callsign', `${bomber ? 'B-52' : raid ? '护航战斗机' : '战斗机'} ${number}`);
    } else if (raid || !cooperative) {
      addText(row, 'slot-empty', 'AI 补位');
      addText(row, 'aircraft-tag', loadouts[fillAirframe].name);
    } else {
      addText(row, 'slot-empty', '空位');
    }
    list.append(row);
  }
  const current = me.team === team;
  const full = members.length === room.teamSize;
  teamButtons[team].hidden = cooperative;
  teamButtons[team].textContent = current ? '本队' : full ? '已满' : '加入';
  teamButtons[team].disabled = !online || current || full || Boolean(room.match);
}

function renderDirectory() {
  directory.hidden = Boolean(room);
  if (room) return;
  const { rooms = [], callsigns = [], count = 0 } = presence ?? {};
  const statusText = online ? '正在加载列表' : connection.dataset.state === 'connecting' ? '正在连接服务器' : '服务器未连接';
  find('directory-room-count').value = presence ? `${rooms.length} 间` : '—';
  find('online-count').value = presence ? `${count} 人` : '—';
  find('rooms-placeholder').hidden = rooms.length > 0;
  find('empty-rooms').textContent = presence ? '当前没有公开房间' : statusText;
  find('pilots-placeholder').hidden = count > 0;
  find('empty-pilots').textContent = presence ? '当前没有玩家在线' : statusText;

  const roomRows = find('directory-rooms');
  const focusedCode = roomRows.contains(document.activeElement) ? document.activeElement.dataset.room : null;
  let focusedButton;
  const states = { waiting: '准备中', full: '已满', loading: '加载中', playing: '对局中', finished: '已结束' };
  roomRows.replaceChildren(...rooms.map(item => {
    const row = document.createElement('tr');
    const missionName = missions.get(item.mission)?.name ?? item.mission;
    const mission = row.insertCell();
    mission.className = 'directory-mission';
    mission.textContent = mission.title = missionName;
    const host = row.insertCell();
    host.textContent = host.title = item.host || '—';
    const roomCode = row.insertCell();
    roomCode.className = 'directory-code';
    roomCode.textContent = item.code;
    const size = row.insertCell();
    size.className = 'directory-size';
    size.textContent = `${item.count}/${item.capacity}`;
    const state = item.state === 'waiting' && item.count >= item.capacity ? 'full' : item.state;
    const status = row.insertCell();
    status.className = 'directory-state';
    status.dataset.state = state;
    status.textContent = states[state] ?? '—';
    const action = row.insertCell();
    action.className = 'directory-action';
    const button = document.createElement('button');
    button.className = 'button secondary';
    button.type = 'button';
    button.textContent = '加入';
    button.setAttribute('aria-label', `加入房间 ${item.code}`);
    button.dataset.room = item.code;
    button.disabled = !online || state !== 'waiting';
    button.addEventListener('click', () => enterRoom('join', item.code));
    action.append(button);
    if (focusedCode === item.code && !button.disabled) focusedButton = button;
    return row;
  }));
  focusedButton?.focus({ preventScroll: true });

  const pilots = find('online-callsigns');
  pilots.replaceChildren(...callsigns.map(name => {
    const row = document.createElement('tr');
    const cell = row.insertCell();
    cell.textContent = cell.title = name;
    return row;
  }));
  const unnamed = count - callsigns.length;
  if (unnamed > 0) {
    const cell = pilots.insertRow().insertCell();
    cell.className = 'directory-unnamed';
    cell.textContent = `未设置呼号 · ${unnamed} 人`;
  }
}

function render() {
  renderMission();
  renderDirectory();
  missionSelect.disabled = !online;
  find('create').disabled = !online || !missions.has(missionSelect.value);
  find('join').disabled = !online;
  startPractice.disabled = !online || Boolean(room) || maintenance;
  find('maintenance-notice').hidden = !maintenance;
  entry.hidden = Boolean(room);
  roomPanel.hidden = !room;
  if (!room) {
    loadoutKey = '';
    savingLoadout = false;
    loadoutEditor.open = false;
    return;
  }

  const me = currentPilot();
  if (!me) return;
  const host = room.hostId === playerId;
  const matchStarted = Boolean(room.match);
  find('room-number').textContent = room.code;
  find('room-count').textContent = `${room.players.length} / ${room.mission.playerLimit} 名飞行员 · ${matchStarted ? '已开局' : '准备中'}`;
  renderTeam('uk', me);
  renderTeam('fr', me);

  find('room-controls').hidden = matchStarted && !host;
  find('aircraft-control').hidden = matchStarted;
  loadoutEditor.hidden = matchStarted;
  aircraft.disabled = !online;
  aircraft.value = me.aircraft;
  ready.hidden = matchStarted;
  ready.textContent = me.ready ? '取消准备' : '准备';
  start.hidden = !host || matchStarted;
  reopen.hidden = !host || !matchStarted;
  reopen.disabled = !online;
  leave.disabled = !online;
  find('start-rule').hidden = matchStarted;
  find('start-rule').textContent = room.mission.mode === 'pve' ? '全员准备后，房主可以开局。' : room.players.length === 1
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
  } else {
    const key = JSON.stringify([me.aircraft, me.loadout, me.countermeasures]);
    if (key !== loadoutKey) {
      loadoutKey = key;
      savedLoadout = me.loadout;
      loadoutDraft = { ...savedLoadout };
      savedCountermeasures = me.countermeasures;
      countermeasureDraft = { ...savedCountermeasures };
      savingLoadout = false;
      buildStations(me.aircraft);
    }
    updateLoadoutControls();
  }
}

function sendBattleView(message) {
  battleView?.frame.contentWindow?.postMessage({ channel: 'tos-lobby', ...message }, location.origin);
}

function showBattle(visible) {
  sendBattleView({ type: visible ? 'resume' : 'suspend' });
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
  const { channel, id, type, sequence, throttle, turn, action, fireCannon, operation } = event.data ?? {};
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
    if (room?.match?.display.practice) {
      send('leave');
      find('show-tutorial').focus();
    } else enterBattle.focus();
  } else if (type === 'lesson-action' && online && !battleScreen.hidden && battleView.display.practice) {
    send('lesson-action', { id, operation });
  } else if (type === 'input' && online && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 64_000) {
    if (battleScreen.hidden && (action || throttle || turn || fireCannon)) return;
    socket.send(JSON.stringify({ type: 'battle-input', id, sequence, throttle, turn, action, fireCannon }));
  }
});

function setConnection(state, text) {
  online = state === 'online';
  if (!online) {
    presence = null;
    latency.value = '延迟 —';
    delete latency.dataset.quality;
    maintenance = false;
  }
  connection.dataset.state = state;
  connection.textContent = text;
  render();
}

function connect(endpoint) {
  const tokenKey = `tos-session:${endpoint.href}`;
  let incompatible = false;
  let latencyTimer, probe, probeId = 0;
  socket = new WebSocket(endpoint);
  const connectionSocket = socket;
  const measureLatency = () => {
    const now = performance.now();
    if (connectionSocket.readyState !== WebSocket.OPEN || (probe && now - probe.at < 7500)) return;
    if (probe) {
      latency.value = '延迟 —';
      delete latency.dataset.quality;
    }
    probe = { id: ++probeId, at: now };
    connectionSocket.send(JSON.stringify({ type: 'latency', id: probe.id }));
  };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello', token: sessionStorage.getItem(tokenKey), name: callsign.value.trim() }));
  });
  socket.addEventListener('message', ({ data }) => {
    if (incompatible) return;
    const message = JSON.parse(data);
    switch (message.type) {
      case 'session':
        if (message.protocol !== PROTOCOL_VERSION) {
          incompatible = true;
          setConnection('offline', '服务端版本不匹配');
          showNotice('请使用与此大厅匹配的服务端。本地测试可重新打开「本地测试.cmd」。', true);
          socket.close();
          break;
        }
        if (playerId && playerId !== message.id) {
          room = null;
          attachBattle();
        }
        playerId = message.id;
        const selectedMission = missionSelect.value;
        missions = new Map(message.missions.map(mission => [mission.id, mission]));
        loadouts = message.airframes;
        aircraft.replaceChildren(...Object.entries(loadouts).map(([id, airframe]) => new Option(airframe.name, id)));
        missionSelect.replaceChildren(new Option('选择任务', ''), ...[...missions.values()].map(mission =>
          new Option(`${mission.mode === 'pve' ? 'PvE' : 'PvP'} · ${mission.name}`, mission.id)));
        if (missions.has(selectedMission)) missionSelect.value = selectedMission;
        sessionStorage.setItem(tokenKey, message.token);
        reconnectDelay = 750;
        setConnection('online', '服务在线');
        measureLatency();
        latencyTimer = setInterval(measureLatency, 2500);
        break;
      case 'latency': {
        if (!probe || message.id !== probe.id) break;
        const ms = Math.round(performance.now() - probe.at);
        probe = null;
        latency.value = `延迟 ${ms} ms`;
        latency.dataset.quality = ms < 90 ? 'good' : ms < 200 ? 'fair' : 'poor';
        break;
      }
      case 'presence': {
        presence = message;
        if (maintenance !== message.maintenance) {
          maintenance = message.maintenance;
          render();
        } else renderDirectory();
        break;
      }
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
        savingLoadout = false;
        showNotice(message.message, true);
        render();
    }
  });
  socket.addEventListener('close', event => {
    clearInterval(latencyTimer);
    if (incompatible) return;
    if (event.code === 4001) {
      sessionStorage.removeItem(tokenKey);
      room = null;
      attachBattle();
    }
    if (battleView) battleView.readySent = false;
    savingLoadout = false;
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

function enterRoom(type, roomCode = code.value) {
  const name = callsign.value.trim();
  callsign.setCustomValidity(name && [...name].length <= 16 ? '' : '请输入 1 至 16 个字符的呼号。');
  if (!callsign.reportValidity()) return;
  sessionStorage.setItem('tos-callsign', name);
  send(type, type === 'create' ? { name, mission: missionSelect.value } : { name, code: roomCode.toUpperCase() });
}

callsign.addEventListener('input', () => callsign.setCustomValidity(''));
callsign.addEventListener('change', () => {
  const name = callsign.value.trim();
  if ([...name].length > 16) return;
  sessionStorage.setItem('tos-callsign', name);
  send('callsign', { name });
});
find('show-tutorial').addEventListener('click', () => tutorial.showModal());
for (const tab of tutorialTabs) {
  tab.addEventListener('click', () => {
    for (const other of tutorialTabs) {
      const selected = other === tab;
      other.setAttribute('aria-pressed', String(selected));
      find(other.getAttribute('aria-controls')).hidden = !selected;
    }
  });
}
startPractice.addEventListener('click', () => {
  tutorial.close();
  send('practice', { name: callsign.value.trim() });
});
missionSelect.addEventListener('change', render);
find('create').addEventListener('click', () => enterRoom('create'));
find('join-form').addEventListener('submit', event => {
  event.preventDefault();
  enterRoom('join');
});
for (const [team, button] of Object.entries(teamButtons)) {
  button.addEventListener('click', () => send('team', { team }));
}
aircraft.addEventListener('change', () => send('aircraft', { aircraft: aircraft.value }));
for (const button of presetButtons) {
  button.addEventListener('click', () => {
    const airframe = loadouts[currentPilot().aircraft];
    const { stations, balanced } = airframe;
    const mode = button.dataset.preset;
    const weapon = airframe[mode];
    loadoutDraft = Object.fromEntries(stations.map(station =>
      [station.id, station.weapons.includes(weapon) ? weapon : balanced[station.id]]));
    editedLoadout();
  });
}
applyLoadout.addEventListener('click', () => {
  savingLoadout = true;
  updateLoadoutControls();
  send('loadout', { aircraft: currentPilot().aircraft, loadout: loadoutDraft, countermeasures: countermeasureDraft });
});
cancelLoadout.addEventListener('click', () => {
  loadoutDraft = { ...savedLoadout };
  countermeasureDraft = { ...savedCountermeasures };
  updateLoadoutControls();
});
for (const [kind, field] of Object.entries(countermeasureFields)) {
  field.addEventListener('input', () => {
    const { countermeasureCapacity } = loadouts[currentPilot().aircraft];
    const amount = Math.min(countermeasureCapacity, Math.max(0, Math.trunc(field.valueAsNumber || 0)));
    if (field.value && field.valueAsNumber !== amount) field.value = amount;
    const flares = kind === 'flares' ? amount : countermeasureCapacity - amount;
    countermeasureDraft = { flares, chaff: countermeasureCapacity - flares };
    editedLoadout(field);
  });
  field.addEventListener('change', () => updateLoadoutControls());
}
ready.addEventListener('click', () => send('ready', { ready: !currentPilot().ready }));
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
