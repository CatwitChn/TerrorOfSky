import { advanceBattle, airframeIndex, applyFlightAction, BATTLE_DISPLAY, initialBattle, isAlive, PILOT_ACTIONS, STEP, twsLaunchTarget } from './simulation.mjs';
import { tutorialActive, tutorialReadout } from './tutorial.mjs';

const LOAD_TIMEOUT_MS = 8000;
const INPUT_TIMEOUT_MS = 700;

export function createMatch(players, now, mission, practice = false) {
  const roster = players.map(player => ({
    ...player, team: player.team === 'uk' ? 0 : 1, airframe: airframeIndex(player.aircraft),
  }));
  const battle = initialBattle(roster, mission, practice);
  const pilots = new Map();
  const seats = new Map();
  for (const player of roster) {
    const aircraft = battle.aircraft.find(plane => plane.team === player.team && plane.slot === player.slot);
    const controls = { aircraft, seat: aircraft.id, ready: false, throttle: 0, turn: 0, fireCannon: false,
      commands: new Set(), receivedAt: now, inputSequence: 0, appliedInput: [0, 0, 0] };
    pilots.set(player.id, controls);
    seats.set(aircraft.id, controls);
  }
  return {
    battle, pilots, seats, controlsFor: aircraft => seats.get(aircraft.id),
    state: 'loading', loadedBy: now + LOAD_TIMEOUT_MS, lastTick: now, accumulator: 0,
  };
}

export function acceptInput(pilot, message, now) {
  const { sequence, throttle, turn, action, fireCannon = false } = message;
  if (![-1, 0, 1].includes(throttle) || ![-1, 0, 1].includes(turn)
      || typeof fireCannon !== 'boolean' || (action != null && !PILOT_ACTIONS.has(action))
      || !Number.isSafeInteger(sequence) || sequence <= pilot.inputSequence) return;
  pilot.receivedAt = now;
  pilot.inputSequence = sequence;
  pilot.throttle = throttle;
  pilot.turn = turn;
  pilot.fireCannon = fireCannon;
  if (action) pilot.commands.add(action);
}

export function neutralizePilot(pilot) {
  pilot.throttle = 0;
  pilot.turn = 0;
  pilot.fireCannon = false;
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
      if (!tutorialActive(match.battle)) {
        for (const command of pilot.commands) applyFlightAction(pilot.aircraft.flight, command);
      }
    }
    advanceBattle(match.battle, match.controlsFor, STEP);
    for (const pilot of match.pilots.values()) {
      pilot.commands.clear();
      pilot.appliedInput[0] = pilot.inputSequence;
      pilot.appliedInput[1] = pilot.throttle;
      pilot.appliedInput[2] = pilot.turn;
    }
    match.accumulator -= STEP;
  }
  if (match.battle.result) match.state = 'finished';
}

const ref = aircraft => aircraft?.id ?? null;

function snapshotAircraft(aircraft, battle, pilot) {
  const { id, team, slot, role, name, flight, destroyedAt, weapon, stores, rack, radarRack, activeRack, radar, flareRack, chaffRack, missileOutcome } = aircraft;
  const { combatStats } = aircraft;
  return {
    id, team, slot, role, name, flight, destroyedAt, weapon, stores, damageReport: aircraft.damageReport,
    combatStats: { ...combatStats, points: 100 * combatStats.kills + 50 * combatStats.assists },
    ...(pilot && { input: pilot.appliedInput }),
    rack: { ...rack, target: ref(rack.target) }, radarRack: { ...radarRack, target: ref(radarRack.target) },
    activeRack, ...(aircraft.ground && { ground: aircraft.ground }),
    radar: {
      ...radar, selected: ref(radar.selected), target: ref(radar.target), pending: ref(radar.pending),
      twsTarget: ref(twsLaunchTarget(battle, aircraft)),
      echoes: [...radar.echoes].map(([target, echo]) => [target.id, echo]),
    },
    flareRack, chaffRack, missileOutcome, cannonAmmo: aircraft.cannonRack?.ammo ?? null,
  };
}

function snapshotMissileReadout(missile) {
  const { boostUntil, poweredUntil, tws, activeRadar, lostAt, flare, speed, loadG, distance } = missile;
  const { worldUnitsPerKilometer } = BATTLE_DISPLAY;
  return {
    boostUntil, poweredUntil, tws, activeRadar, lostAt, flare: Boolean(flare),
    telemetry: { speedKph: speed * 3600 / worldUnitsPerKilometer, loadG, distanceKm: distance / worldUnitsPerKilometer },
  };
}

function snapshotMissile(missile) {
  const { id, team, type, heading, x, z, bornAt, trail, trackId } = missile;
  return {
    id, team, type, heading, x, z, bornAt, trail, trackId, ...snapshotMissileReadout(missile),
    source: ref(missile.source), target: ref(missile.target),
  };
}

export function encodeMatchFrame(id, match) {
  const { time, result, resultReason, aircraft, missiles, cannonRounds, flares, chaff, explosions, endedMissiles, raid } = match.battle;
  const frame = {
    type: 'battle', id, state: match.state, time, result, resultReason,
    tutorial: tutorialReadout(match.battle),
    aircraft: aircraft.map(plane => snapshotAircraft(plane, match.battle, match.seats.get(plane.id))),
    ...(raid && { strike: raid.bomb }),
    ...(match.battle.mission.groundTargets && {
      groundTargets: match.battle.groundTargets, groundOrdnance: match.battle.groundOrdnance,
      defenseShots: match.battle.defenseShots,
    }),
    missiles: missiles.map(snapshotMissile),
    cannonTracers: cannonRounds.filter(round => round.tracer).map(({ originX, originZ, vx, vz, bornAt }) =>
      [originX, originZ, vx, vz, bornAt]),
    flares: flares.map(({ x, z, vx, vz, bornAt, owner }) => ({ x, z, vx, vz, bornAt, owner: ref(owner) })),
    chaff: chaff.map(({ x, z, bornAt, owner }) => ({ x, z, bornAt, owner: ref(owner) })), explosions,
    endedMissiles: endedMissiles.map(missile => {
      const { id, source, type, endedAt, endStatus, explosion } = missile;
      if (missile.impactAt !== undefined) return { ...missile, source: ref(source) };
      return { id, source: ref(source), type, endedAt, endStatus, explosion, ...snapshotMissileReadout(missile) };
    }),
  };
  // Limit the precision of network snapshots to keep the per-frame payload small.
  return JSON.stringify(frame, (_, value) => Number.isFinite(value) && !Number.isInteger(value) ? Math.round(value * 1000) / 1000 : value);
}
