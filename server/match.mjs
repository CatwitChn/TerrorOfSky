import { advanceBattle, applyFlightAction, initialBattle, isAlive, PILOT_ACTIONS, STEP } from './simulation.mjs';

const LOAD_TIMEOUT_MS = 8000;
const INPUT_TIMEOUT_MS = 700;

export function createMatch(players, now) {
  const roster = players.map(player => ({
    ...player, team: player.team === 'uk' ? 0 : 1, airframe: player.aircraft === 'f15' ? 0 : 1,
  }));
  const battle = initialBattle(0, roster);
  const pilots = new Map();
  const seats = new Map();
  for (const player of roster) {
    const aircraft = battle.aircraft.find(plane => plane.team === player.team && plane.slot === player.slot);
    const controls = { aircraft, seat: aircraft.id, ready: false, throttle: 0, turn: 0, commands: new Set(), receivedAt: now };
    pilots.set(player.id, controls);
    seats.set(aircraft.id, controls);
  }
  return {
    battle, pilots, seats, controlsFor: aircraft => seats.get(aircraft.id),
    state: 'loading', loadedBy: now + LOAD_TIMEOUT_MS, lastTick: now, accumulator: 0,
  };
}

export function acceptInput(pilot, message, now) {
  const { throttle, turn, action } = message;
  if (![-1, 0, 1].includes(throttle) || ![-1, 0, 1].includes(turn)
      || (action != null && !PILOT_ACTIONS.has(action))) return;
  pilot.receivedAt = now;
  pilot.throttle = throttle;
  pilot.turn = turn;
  if (action) pilot.commands.add(action);
}

export function neutralizePilot(pilot) {
  pilot.throttle = 0;
  pilot.turn = 0;
  pilot.commands.clear();
}

export function releasePilot(match, id) {
  const pilot = match.pilots.get(id);
  if (!pilot) return;
  match.pilots.delete(id);
  match.seats.delete(pilot.seat);
  pilot.aircraft.name = null;
}

export function tickMatch(match, now) {
  if (match.state === 'finished') return;
  if (match.state === 'loading') {
    if (now >= match.loadedBy || [...match.pilots.values()].every(pilot => pilot.ready)) {
      match.state = 'playing';
      match.lastTick = now;
    }
    return;
  }

  match.accumulator += Math.min(0.25, (now - match.lastTick) / 1000);
  match.lastTick = now;
  while (match.accumulator + 1e-9 >= STEP && !match.battle.result) {
    for (const pilot of match.pilots.values()) {
      if (now - pilot.receivedAt > INPUT_TIMEOUT_MS || !isAlive(pilot.aircraft)) neutralizePilot(pilot);
      for (const command of pilot.commands) applyFlightAction(pilot.aircraft.flight, command);
    }
    advanceBattle(match.battle, match.controlsFor, STEP);
    for (const pilot of match.pilots.values()) pilot.commands.clear();
    match.accumulator -= STEP;
  }
  if (match.battle.result) match.state = 'finished';
}

const ref = aircraft => aircraft?.id ?? null;

function snapshotAircraft(aircraft) {
  const { id, name, flight, destroyedAt, weapon, rack, radarRack, radar, flareRack, chaffRack, missileOutcome } = aircraft;
  return {
    id, name, flight, destroyedAt, weapon,
    rack: { ...rack, target: ref(rack.target) }, radarRack: { ...radarRack, target: ref(radarRack.target) },
    radar: {
      ...radar, selected: ref(radar.selected), target: ref(radar.target), pending: ref(radar.pending),
      echoes: [...radar.echoes].map(([target, echo]) => [target.id, echo]),
    },
    flareRack, chaffRack, missileOutcome,
  };
}

function snapshotMissile(missile) {
  const { id, team, type, heading, x, z, bornAt, poweredUntil, trail, trackId, lostAt, flare } = missile;
  return {
    id, team, type, heading, x, z, bornAt, poweredUntil, trail, trackId, lostAt, flare: Boolean(flare),
    source: ref(missile.source), target: ref(missile.target),
  };
}

export function encodeMatchFrame(id, match) {
  const { time, result, aircraft, missiles, flares, chaff, explosions, endedMissiles } = match.battle;
  const frame = {
    type: 'battle', id, state: match.state, time, result, aircraft: aircraft.map(snapshotAircraft),
    missiles: missiles.map(snapshotMissile),
    flares: flares.map(({ x, z, vx, vz, bornAt, owner }) => ({ x, z, vx, vz, bornAt, owner: ref(owner) })),
    chaff: chaff.map(({ x, z, bornAt, owner }) => ({ x, z, bornAt, owner: ref(owner) })), explosions,
    endedMissiles: endedMissiles.map(({ id, source, type, endedAt, endStatus, explosion }) =>
      ({ id, source: ref(source), type, endedAt, endStatus, explosion })),
  };
  // Limit the precision of network snapshots to keep the per-frame payload small.
  return JSON.stringify(frame, (_, value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value);
}
