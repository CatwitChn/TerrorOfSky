import { AIRFRAME_LOADOUTS, defaultCountermeasures, defaultLoadout, MISSIONS } from './missions.mjs';
import { AIRFIELDS, RUNWAY, captureApproach, stepFuel, stepRunway } from './airfields.mjs';
import { blastDamage, freshDamage, missilePass } from './combat.mjs';

const TAU = Math.PI * 2;
const MAX_BANK = 55 * Math.PI / 180;
const MAX_HEADING_LEAD = 20 * Math.PI / 180;
const COURSE_RESPONSE_SECONDS = 0.16;
const PILOT_COMFORT_G = 7;
const PILOT_STRAIN_THRESHOLD = 0.5;
const STEP = 1 / 120;
const START_THROTTLE = 0.55;
const START_SPEED = 695;
const FLIGHT_ALTITUDE_M = 3000;
const TEMPERATURE_RATIO = 1 - 0.0065 * FLIGHT_ALTITUDE_M / 288.15;
// Standard-atmosphere density approximation for converting the airspeed limits.
const TAS_PER_IAS = TEMPERATURE_RATIO ** -2.128;
const AIR_DENSITY = 1.225 / TAS_PER_IAS ** 2;
const GRAVITY = 9.80665;
const MACH_ONE_KPH = 340.3 * 3.6 * Math.sqrt(TEMPERATURE_RATIO);
const TURN_REFERENCE_KPH = 700 * TAS_PER_IAS;
const MIN_LEVEL_SPEED_KPH = 300;
const THRUST_MULTIPLIER = 2;
const AFTERBURNER_SPOOL_MULTIPLIER = 0.3;
const AIRBRAKE_REFERENCE_KPH = 700;
const AIRBRAKE_REFERENCE_DRAG_KN = 155;
const AIRBRAKE_MAX_DRAG_KN = 235;
const AIRBRAKE_TRAVEL_SECONDS = 0.32;
// War Thunder vehicle cards. Reference masses use 30% internal fuel.
// Thrust and nose response [TAS km/h, degrees/second] are tuned for the planar game.
const AIRCRAFT = [
  {
    id: 'f15', name: 'F-15A', radarName: 'APG-63', launchWarning: true,
    cannon: { muzzleSpeedMps: 850, roundsPerSecond: 54, capacity: 500, muzzle: { x: 1.6, y: 0.2, z: -4.4 } },
    flight: {
      massKg: 14406, limitIasKph: 1629, limitMach: 2.4, turnSeconds: 20.5, spoolSeconds: 0.12,
      noseResponse: [[300, 20], [450, 25], [600, 27], [730, 23], [900, 16.5], [1200, 12], [1950, 7.5]],
      liftAreaByMach: [[0.35, 75], [0.8, 75], [1.15, 66]],
      dryThrottle: [[0, 0.05], [0.3, 0.22], [0.55, 0.50], [0.90, 0.82], [1, 1]],
      thrust: [
        [0, 101, 158], [500, 102, 165], [900, 108, 182], [1400, 119, 201], [1950, 123, 214]
      ]
    }
  },
  {
    id: 'su27', name: 'Su-27', radarName: 'N001', launchWarning: true,
    cannon: { muzzleSpeedMps: 790, roundsPerSecond: 36, capacity: 240, muzzle: { x: 1.4, y: 0.2, z: -4.7 } },
    flight: {
      massKg: 18810, limitIasKph: 1540, limitMach: 2.35, turnSeconds: 23.5, spoolSeconds: 0.12,
      noseResponse: [[300, 25], [450, 30], [560, 29], [680, 21], [900, 14.5], [1200, 10.5], [1850, 7]],
      liftAreaByMach: [[0.35, 105], [0.8, 95], [1.15, 84]],
      dryThrottle: [[0, 0.05], [0.3, 0.22], [0.55, 0.50], [0.90, 0.82], [1, 1]],
      thrust: [
        [0, 114, 185], [500, 113, 193], [900, 119, 212], [1400, 129, 228], [1950, 134, 235]
      ]
    }
  },
  {
    id: 'f14d', name: 'F-14D', radarName: 'APG-71', launchWarning: true,
    cannon: { muzzleSpeedMps: 850, roundsPerSecond: 54, capacity: 620, muzzle: { x: -1.5, y: 0.2, z: -5 } },
    radarModes: ['src', 'pd', 'tws'],
    flight: {
      massKg: 21805, limitIasKph: 1555, limitMach: 2.4, turnSeconds: 24, spoolSeconds: 0.12,
      noseResponse: [[300, 21], [450, 26], [610, 26], [760, 22], [920, 16], [1200, 10.5], [1900, 6]],
      liftAreaByMach: [[0.35, 101], [0.8, 96], [1.15, 81]],
      dryThrottle: [[0, .02], [.45, .33], [.8, .65], [.9, .87], [1, 1]],
      // Two engines sampled from the 3049 m row of the War Thunder F-14D flight model.
      thrust: [[0, 85.9, 141.8], [400, 84.7, 152.4], [600, 85.9, 170.2], [800, 88.4, 189.6],
               [1000, 94.5, 215.3], [1200, 101.9, 248.9], [1400, 103.1, 257], [1650, 108, 222.8], [1900, 108, 205]],
      // The actuator rate is the game's 0.10 fraction of travel per second.
      wingSweep: { byMach: [[0, 20], [0.65, 20], [0.85, 36], [1.05, 53], [1.32, 68]], rate: 4.8 },
    }
  }
];

export function airframeIndex(id) {
  return AIRCRAFT.findIndex(airframe => airframe.id === id);
}

for (const { flight: profile } of AIRCRAFT) {
  profile.topSpeedKph = Math.min(profile.limitIasKph * TAS_PER_IAS, profile.limitMach * MACH_ONE_KPH);
  profile.dragAtTopKn = sampleCurve(profile.thrust, profile.topSpeedKph, 2);
  // Use the reference turn to scale the additional drag.
  profile.turnAccelerationAtReference = (TAU / profile.turnSeconds) * (TURN_REFERENCE_KPH / 3.6);
  profile.turnDragAtReferenceKn = sampleCurve(profile.thrust, TURN_REFERENCE_KPH, 2) - levelDragKn(profile, TURN_REFERENCE_KPH);
}

const FLIGHT_SPEED_SCALE = 0.064;
// War Thunder game data informs the speed caps, turning limits and motor durations.
// Speed gain by stage, ranges, lifetimes and sensor rules are tuned for this 2D game.
const MISSILE_DEFAULTS = {
  guidance: 'ir',
  launchSpeedBonus: 22,
  lifetime: 6.5,
  lockSeconds: 0.42,
  acquireAngle: 0.30,
  holdAngle: 0.44
};
const MISSILES = {
  'AIM-9M': { ...MISSILE_DEFAULTS, mach: 2.5, g: 30, boostSeconds: 5.3, lockRangeKm: 3.4,
    flareGate: .16, flareExposure: .28, fuse: 5.3, blastRadius: 13, blastPower: .92 },
  'R-73': { ...MISSILE_DEFAULTS, mach: 2.5, g: 40, boostSeconds: 4.8, lockRangeKm: 3.1, acquireAngle: 0.38,
    flareGate: .075, flareExposure: .22, fuse: 5.8, blastRadius: 14.5, blastPower: 1.04 },
  'AIM-7M': {
    ...MISSILE_DEFAULTS, guidance: 'sarh', mach: 4, g: 25, launchRangeKm: 14, lifetime: 19,
    boostSeconds: 4.5, sustainSeconds: 11, boostSpeedShare: 0.85, fuse: 8, blastRadius: 19, blastPower: 1.28
  },
  'R-27R': { ...MISSILE_DEFAULTS, guidance: 'sarh', mach: 3.5, g: 35, boostSeconds: 6, lifetime: 15, launchRangeKm: 12,
    fuse: 8.8, blastRadius: 21, blastPower: 1.48 },
  // Target speed and motor stages tuned for the fixed-altitude match.
  'AIM-54C': { ...MISSILE_DEFAULTS, guidance: 'arh', mach: 4.2, g: 25,
    boostSeconds: 5.5, sustainSeconds: 6.5, boostSpeedShare: 0.82,
    launchRangeKm: 21, lifetime: 35, handoffSeconds: 2.5, fuse: 10, blastRadius: 25, blastPower: 1.72 },
};
const MISSILE_SMOKE = { interval: 0.055, lifetime: 0.75 };
const MISSILE_COAST_DECAY_PER_SECOND = 0.07;
const EXPLOSION_SECONDS = 1.2;
const MISSILE_AIM_PREVIEW_SECONDS = 0.8;
const FLARE = { lifetime: 1.35 };
const CHAFF = { lifetime: 1.6 };
const RADAR = { rangeKm: 22, scanAngle: 0.88, trackAngle: 1.08, scanSeconds: 2.2, memory: 3.2, lockSeconds: 0.35 };
// FLIGHT_SPEED_SCALE converts a speed in km/h to world units per second.
const WORLD_UNITS_PER_KILOMETER = 3600 * FLIGHT_SPEED_SCALE;
const WORLD_UNITS_PER_METER = WORLD_UNITS_PER_KILOMETER / 1000;
const CANNON_RANGE = 800 * WORLD_UNITS_PER_METER;
const CANNON_FADE_DISTANCE = 260 * WORLD_UNITS_PER_METER;
const CANNON_DAMAGE = 0.08;
const BOMBER = { airframe: AIRCRAFT.length, name: 'B-52', speedKph: 820, countermeasures: { flares: 192, chaff: 1126 } };
const FACTORY_DROP_RADIUS = 150 * WORLD_UNITS_PER_METER;
const BOMB_FALL_SECONDS = 4;
const DOVER_HALF_SPAN = 30 * WORLD_UNITS_PER_KILOMETER;
// Copernicus GLO-30, N50E001 and N51E001. Local metric grid centered at 51.13°N, 1.45°E.
const COAST_MAP = {
  name: '多佛白崖',
  bounds: { minX: -DOVER_HALF_SPAN, maxX: DOVER_HALF_SPAN, minZ: -DOVER_HALF_SPAN, maxZ: DOVER_HALF_SPAN },
  departures: [{ x: -1564.45, z: -51.26 }, { x: 4395, z: 5025 }]
};
const FORMATION = [
  { forward: 0, right: 0 },
  { forward: -26, right: -38 },
  { forward: -26, right: 38 },
  { forward: -57, right: 0 }
];
const AI_OPENINGS = [
  { angle: 0, throttle: 0.93, joinKm: 9 },
  { angle: -0.21, throttle: 0.89, joinKm: 7 },
  { angle: 0.25, throttle: 0.85, joinKm: 6 },
  { angle: 0.12, throttle: 0.72, joinKm: 5 }
];
const BATTLE_KEYS = new Set(['Space', 'KeyF', 'KeyQ', 'KeyT', 'KeyY', 'KeyG', 'KeyX', 'KeyC']);
const PILOT_ACTIONS = new Set(['KeyB', 'KeyW', 'KeyS', ...BATTLE_KEYS]);
const DEFAULT_RADAR_MODES = ['src', 'pd'];

export const BATTLE_DISPLAY = {
  map: { name: COAST_MAP.name, bounds: COAST_MAP.bounds },
  airfields: AIRFIELDS,
  runway: RUNWAY,
  worldUnitsPerKilometer: WORLD_UNITS_PER_KILOMETER,
  flightAltitudeM: FLIGHT_ALTITUDE_M,
  machOneKph: MACH_ONE_KPH,
  pilotStrainThreshold: PILOT_STRAIN_THRESHOLD,
  airbrakeReferenceKph: AIRBRAKE_REFERENCE_KPH,
  missileSmokeLifetime: MISSILE_SMOKE.lifetime,
  cannonRange: CANNON_RANGE,
  cannonFadeDistance: CANNON_FADE_DISTANCE,
  explosionSeconds: EXPLOSION_SECONDS,
  flareLifetime: FLARE.lifetime,
  chaffLifetime: CHAFF.lifetime,
  radar: { rangeKm: RADAR.rangeKm, scanAngle: RADAR.scanAngle, trackAngle: RADAR.trackAngle, scanSeconds: RADAR.scanSeconds },
  aircraft: [...AIRCRAFT.map(({ id, name, flight, radarName, launchWarning, cannon }) => ({
    name, topSpeedKph: flight.topSpeedKph, radarName, launchWarning,
    cannon: { muzzleSpeedMps: cannon.muzzleSpeedMps, roundsPerSecond: cannon.roundsPerSecond, capacity: cannon.capacity },
    stations: Object.fromEntries(AIRFRAME_LOADOUTS[id].stations.map(({ id, x, y, z }) => [id, [x, y, z]])),
  })), { name: BOMBER.name, topSpeedKph: BOMBER.speedKph, radarName: null, launchWarning: false, stations: {} }],
  missiles: Object.fromEntries(Object.entries(MISSILES).map(([type, { guidance, launchRangeKm, lockSeconds, blastPower }]) =>
    [type, { guidance, launchRangeKm, lockSeconds, blastPower }])),
};

function initialFlight(airframe, spawn, speed = START_SPEED) {
  const sweep = AIRCRAFT[airframe]?.flight.wingSweep;
  return {
    ...spawn, airframe, bank: 0, speed, course: spawn.heading,
    turnAcceleration: 0, loadFactor: 1, liftUse: 0, pilotStrain: 0,
    throttle: START_THROTTLE, enginePower: START_THROTTLE, afterburner: false,
    airbrake: false, airbrakeExtension: 0, wingSweep: sweep ? sampleCurve(sweep.byMach, speed / MACH_ONE_KPH) : 0,
    altitudeM: FLIGHT_ALTITUDE_M, fuel: 1, fuelSeconds: 240, phase: 'airborne', serviceRemaining: 0,
    crashReason: null, damage: freshDamage(airframe)
  };
}

function stepFlight(flight, throttleInput, turnInput, dt, burnFuel = false) {
  const profile = AIRCRAFT[flight.airframe].flight;
  flight.throttle = Math.max(0, Math.min(1, flight.throttle + throttleInput * 0.48 * dt));
  if (flight.throttle < 1 || flight.damage.power <= .01) flight.afterburner = false;
  if (burnFuel) stepFuel(flight, dt);
  const brakeTravel = dt / AIRBRAKE_TRAVEL_SECONDS;
  flight.airbrakeExtension = clamp(Number(flight.airbrake), flight.airbrakeExtension - brakeTravel, flight.airbrakeExtension + brakeTravel);
  const spoolSeconds = flight.afterburner ? profile.spoolSeconds * AFTERBURNER_SPOOL_MULTIPLIER : profile.spoolSeconds;
  flight.enginePower += (flight.throttle - flight.enginePower) * (1 - Math.exp(-dt / spoolSeconds));
  const pilotAuthority = 1 - Math.max(0, flight.pilotStrain - PILOT_STRAIN_THRESHOLD);
  const desiredBank = turnInput * pilotAuthority * flight.damage.control * MAX_BANK;
  flight.bank += (desiredBank - flight.bank) * (1 - Math.exp(-dt / 0.14));

  // The nose can move ahead of the course while lift bends the flight path.
  const noseRate = sampleCurve(profile.noseResponse, flight.speed) * Math.PI / 180;
  const desiredHeading = flight.heading + noseRate * (flight.bank / MAX_BANK) * dt;
  const headingLead = clamp(angleDelta(flight.course, desiredHeading), -MAX_HEADING_LEAD, MAX_HEADING_LEAD);
  flight.heading = (flight.course + headingLead + TAU) % TAU;
  const speedMps = flight.speed / 3.6;
  const maxLift = maxLiftAcceleration(profile, flight.speed)
    * (0.50 + 0.25 * (flight.damage.leftWing + flight.damage.rightWing));
  // A level turn reserves enough lift to balance gravity.
  const availableAcceleration = Math.sqrt(Math.max(0, maxLift ** 2 - GRAVITY ** 2));
  const requestedAcceleration = speedMps * headingLead / COURSE_RESPONSE_SECONDS;
  flight.turnAcceleration = clamp(requestedAcceleration, -availableAcceleration, availableAcceleration);
  flight.course = (flight.course + flight.turnAcceleration / speedMps * dt + TAU) % TAU;

  flight.loadFactor = Math.hypot(1, flight.turnAcceleration / GRAVITY);
  flight.liftUse = flight.loadFactor * GRAVITY / Math.max(maxLift, GRAVITY);
  const strainRate = clamp((flight.loadFactor - PILOT_COMFORT_G) / 4, -0.28, 0.75);
  flight.pilotStrain = clamp(flight.pilotStrain + strainRate * dt, 0, 1);

  const acceleration = flightAcceleration(profile, flight);
  flight.speed = clamp(flight.speed + acceleration * 3.6 * dt, MIN_LEVEL_SPEED_KPH, profile.topSpeedKph);
  if (profile.wingSweep) {
    const { byMach, rate } = profile.wingSweep;
    const desiredSweep = sampleCurve(byMach, flight.speed / MACH_ONE_KPH);
    flight.wingSweep += clamp(desiredSweep - flight.wingSweep, -rate * dt, rate * dt);
  }
  const distance = flight.speed * FLIGHT_SPEED_SCALE * dt;
  flight.x += Math.sin(flight.course) * distance;
  flight.z -= Math.cos(flight.course) * distance;
}

function flightAcceleration(profile, flight) {
  const turnLoadRatio = flight.turnAcceleration / profile.turnAccelerationAtReference;
  const turnDragKn = profile.turnDragAtReferenceKn * (turnLoadRatio * TURN_REFERENCE_KPH / flight.speed) ** 2;
  const straightDragKn = levelDragKn(profile, flight.speed, flight.airbrakeExtension);
  const thrustKn = flight.fuel > 0 ? engineThrustKn(profile, flight.speed, flight.enginePower, flight.afterburner) * flight.damage.power : 0;
  return (thrustKn - (straightDragKn + turnDragKn)) * 1000 / profile.massKg;
}

function maxLiftAcceleration(profile, speedKph) {
  const speedMps = speedKph / 3.6;
  const liftArea = sampleCurve(profile.liftAreaByMach, speedKph / MACH_ONE_KPH);
  return 0.5 * AIR_DENSITY * speedMps ** 2 * liftArea / profile.massKg;
}

function sampleCurve(points, value, column = 1) {
  for (let i = 1; i < points.length; i++) {
    const next = points[i];
    if (value <= next[0]) {
      const previous = points[i - 1];
      const fraction = clamp((value - previous[0]) / (next[0] - previous[0]), 0, 1);
      return lerp(previous[column], next[column], fraction);
    }
  }
  return points[points.length - 1][column];
}

function engineThrustKn(profile, speedKph, power, afterburner) {
  const maxDryThrust = sampleCurve(profile.thrust, speedKph, 1);
  const dryThrust = maxDryThrust * sampleCurve(profile.dryThrottle, power);
  // Apply the afterburner gain while the dry engine continues to spool.
  const boostThrust = afterburner ? sampleCurve(profile.thrust, speedKph, 2) - maxDryThrust : 0;
  return THRUST_MULTIPLIER * (dryThrust + boostThrust);
}

function levelDragKn(profile, speedKph, airbrakeExtension = 0) {
  const relativeSpeed = speedKph / profile.topSpeedKph;
  const transonic = Math.max(0, 1 - Math.abs(speedKph - MACH_ONE_KPH) / 220);
  const brakeDragKn = Math.min(AIRBRAKE_REFERENCE_DRAG_KN * (speedKph / AIRBRAKE_REFERENCE_KPH) ** 2, AIRBRAKE_MAX_DRAG_KN);
  return profile.dragAtTopKn * (relativeSpeed ** 2 + 0.16 * transonic ** 2) + brakeDragKn * airbrakeExtension;
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

function bearing(from, to) {
  return Math.atan2(to.x - from.x, from.z - to.z);
}

function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function initialMissileRack(type, installed) {
  const capacity = installed.filter(weapon => weapon === type).length;
  return { type, capacity, ammo: capacity, armed: false, lock: 0, target: null, lastLaunch: -Infinity };
}

function formationPosition(center, heading, forward, right) {
  return {
    x: center.x + Math.sin(heading) * forward + Math.cos(heading) * right,
    z: center.z - Math.cos(heading) * forward + Math.sin(heading) * right,
    heading
  };
}

function initialAircraft(id, team, slot, role, spawn, pilot, teamAirframe = team) {
  const bomber = role === 'bomber';
  const model = bomber ? BOMBER.airframe : pilot?.airframe ?? teamAirframe;
  const airframe = AIRCRAFT[model]?.id;
  const { ir, sarh, arh } = AIRFRAME_LOADOUTS[airframe] ?? {};
  const stores = bomber ? {} : { ...(pilot?.loadout ?? defaultLoadout(airframe)) };
  const { flares, chaff } = bomber ? BOMBER.countermeasures : pilot?.countermeasures ?? defaultCountermeasures(airframe);
  const installed = Object.values(stores);
  const rack = initialMissileRack(ir, installed);
  const radarRack = initialMissileRack(sarh, installed);
  const activeRack = arh ? initialMissileRack(arh, installed) : null;
  const cannonCapacity = AIRCRAFT[model]?.cannon.capacity;
  const flight = initialFlight(model, spawn, bomber || role === 'escort' ? BOMBER.speedKph : START_SPEED);
  return {
    id, team, slot, role, name: pilot?.name ?? null, flight, previous: { ...flight },
    stores, originalStores: { ...stores }, runway: null, rack, radarRack, activeRack,
    cannonRack: cannonCapacity ? { capacity: cannonCapacity, ammo: cannonCapacity, nextShotAt: 0 } : null,
    weapon: bomber ? null : rack.capacity ? 'ir' : radarRack.capacity ? 'sarh' : 'arh', destroyedAt: null,
    flareRack: { capacity: flares, ammo: flares, lastRedirect: -Infinity },
    chaffRack: { capacity: chaff, ammo: chaff }, missileOutcome: null,
    ai: { phase: 'opening', target: null, exitHeading: 0, extendUntil: 0 },
    radar: { mode: pilot && AIRCRAFT[model].radarModes?.includes('tws') ? 'tws' : 'src',
      echoes: new Map(), sweep: -RADAR.scanAngle, selected: null,
      pending: null, target: null, progress: 0, trackId: 0, lostAt: -Infinity }
  };
}

function initialBattle(roster, mission = MISSIONS['dover-pvp']) {
  const departures = COAST_MAP.departures;
  const raid = mission.raid ? { bomb: null } : null;
  const formation = mission.mode === 'pve' && !raid ? FORMATION.slice(0, roster.length) : FORMATION;
  const aircraft = departures.flatMap((departure, team) => {
    const enemy = raid && team === 1 ? mission.factory : departures[1 - team];
    const heading = (bearing(departure, enemy) + TAU) % TAU;
    const teamFormation = raid && team === 1 ? formation.slice(0, mission.raid.escorts) : formation;
    const firstPilot = roster.find(member => member.team === team);
    return teamFormation.map(({ forward, right }, slot) => {
      const pilot = roster.find(member => member.team === team && member.slot === slot);
      const escort = raid && team === 1;
      const start = escort ? escortPosition(departure, heading, slot) : formationPosition(departure, heading, forward, right);
      return initialAircraft(team * formation.length + slot, team, slot, escort ? 'escort' : 'fighter', start, pilot, firstPilot?.airframe);
    });
  });
  if (raid) {
    const departure = departures[1];
    const heading = (bearing(departure, mission.factory) + TAU) % TAU;
    for (const [slot, { forward, right }] of FORMATION.slice(0, mission.raid.bombers).entries()) {
      const start = formationPosition(departure, heading, forward * 4, right * 3);
      aircraft.push(initialAircraft(aircraft.length, 1, slot, 'bomber', start));
    }
  }
  return {
    mission, raid, aircraft, missiles: [], cannonRounds: [], flares: [], chaff: [], explosions: [], time: 0, result: null, resultReason: null,
    nextMissileId: 1, endedMissiles: [],
  };
}

function isAlive(aircraft) {
  return aircraft.destroyedAt === null;
}

function canBeTracked(aircraft) {
  return aircraft && isAlive(aircraft) && aircraft.flight.altitudeM > 0;
}

function canFight(aircraft) {
  return canBeTracked(aircraft) && aircraft.role !== 'bomber'
    && (aircraft.flight.phase === 'airborne' || aircraft.flight.phase === 'climb');
}

function nearestOpponent(battle, aircraft) {
  let nearest = null;
  let distance = Infinity;
  for (const other of battle.aircraft) {
    if (other.team === aircraft.team || !canBeTracked(other)) continue;
    const separation = Math.hypot(aircraft.flight.x - other.flight.x, aircraft.flight.z - other.flight.z);
    if (separation < distance) {
      distance = separation;
      nearest = other;
    }
  }
  return nearest;
}

function teamCount(battle, team) {
  return battle.aircraft.filter(aircraft => aircraft.team === team && isAlive(aircraft)).length;
}

function radarPosition(aircraft, point) {
  const { flight } = aircraft;
  return {
    angle: angleDelta(flight.heading, bearing(flight, point)),
    range: Math.hypot(point.x - flight.x, point.z - flight.z) / WORLD_UNITS_PER_KILOMETER
  };
}

function radarInterference(battle, sensor, target, doppler) {
  const flight = target.flight;
  const direction = bearing(sensor, flight);
  const broadside = 1 - clamp(Math.abs(Math.cos(flight.course - direction)) / .28, 0, 1);
  let decoy = 0;
  for (const cloud of battle.chaff) {
    if (cloud.owner !== target || Math.abs(angleDelta(direction, bearing(sensor, cloud))) > .10) continue;
    const separation = Math.hypot(cloud.x - flight.x, cloud.z - flight.z);
    const age = (battle.time - cloud.bornAt) / CHAFF.lifetime;
    const strength = (1 - age) * clamp(1 - separation / 85, 0, 1);
    decoy = Math.max(decoy, strength);
  }
  return doppler ? broadside * (.98 + .82 * decoy) >= .92 : decoy > .53;
}

function radarCanTrack(battle, aircraft, target, checkInterference = true) {
  if (!canBeTracked(target)) return false;
  const { angle, range } = radarPosition(aircraft, target.flight);
  if (!range || range > RADAR.rangeKm || Math.abs(angle) > RADAR.trackAngle) return false;
  return !checkInterference || !radarInterference(battle, aircraft.flight, target, aircraft.radar.mode !== 'src');
}

function hasTwsTrack(battle, aircraft, target) {
  const { radar } = aircraft;
  if (radar.mode !== 'tws' || !canFight(aircraft)) return false;
  const echo = radar.echoes.get(target);
  return Boolean(echo) && battle.time - echo.time <= RADAR.memory && radarCanTrack(battle, aircraft, target)
    && Math.abs(radarPosition(aircraft, target.flight).angle) <= RADAR.scanAngle;
}

export function twsLaunchTarget(battle, aircraft) {
  const { radar } = aircraft;
  return !radar.target && !radar.pending && hasTwsTrack(battle, aircraft, radar.selected) ? radar.selected : null;
}

function clearRadarTrack(radar, time) {
  if (radar.target) radar.lostAt = time;
  radar.pending = null;
  radar.target = null;
  radar.progress = 0;
  radar.interference = 0;
  radar.trackId++;
}

function radarCandidates(aircraft) {
  return [...aircraft.radar.echoes.keys()]
    .filter(target => target.team !== aircraft.team && canBeTracked(target))
    .sort((a, b) => radarPosition(aircraft, aircraft.radar.echoes.get(a)).range
      - radarPosition(aircraft, aircraft.radar.echoes.get(b)).range || a.id - b.id);
}

function recordRadarEcho(radar, target, time) {
  const { x, z, speed, course } = target.flight;
  const echo = { x, z, time };
  if (radar.mode === 'tws') {
    echo.vx = Math.sin(course) * speed * FLIGHT_SPEED_SCALE;
    echo.vz = -Math.cos(course) * speed * FLIGHT_SPEED_SCALE;
  }
  radar.echoes.set(target, echo);
}

function stepRadar(battle, aircraft, commands, dt) {
  const { radar } = aircraft;
  if (commands?.has('KeyG')) {
    clearRadarTrack(radar, battle.time);
    const modes = AIRCRAFT[aircraft.flight.airframe].radarModes ?? DEFAULT_RADAR_MODES;
    radar.mode = modes[(modes.indexOf(radar.mode) + 1) % modes.length];
  }
  if (radar.target) {
    const noise = !radarCanTrack(battle, aircraft, radar.target);
    radar.interference = noise ? (radar.interference ?? 0) + dt : 0;
    if (!radarCanTrack(battle, aircraft, radar.target, false) || radar.interference > .22) clearRadarTrack(radar, battle.time);
  }

  for (const [target, echo] of radar.echoes) {
    if (!canBeTracked(target) || battle.time - echo.time > RADAR.memory) radar.echoes.delete(target);
  }
  if (radar.target) recordRadarEcho(radar, radar.target, battle.time);
  if (!radar.target && !radar.pending) {
    const phase = (battle.time / RADAR.scanSeconds + aircraft.slot * 0.11 + aircraft.team * 0.19) % 1;
    const sweep = RADAR.scanAngle * (1 - 4 * Math.abs(phase - 0.5));
    const low = Math.min(radar.sweep, sweep) - 0.025;
    const high = Math.max(radar.sweep, sweep) + 0.025;
    radar.sweep = sweep;
    for (const target of battle.aircraft) {
      if (target === aircraft || !canBeTracked(target)) continue;
      const { angle, range } = radarPosition(aircraft, target.flight);
      if (range <= RADAR.rangeKm && angle >= low && angle <= high && Math.abs(angle) <= RADAR.scanAngle) {
        if (radar.mode === 'tws' && !radarCanTrack(battle, aircraft, target)) continue;
        recordRadarEcho(radar, target, battle.time);
      }
    }
  }

  let candidates = radarCandidates(aircraft);
  if (radar.mode === 'tws' && !radar.target) {
    candidates = candidates.filter(target => hasTwsTrack(battle, aircraft, target));
  }
  if (commands?.has('KeyY') && candidates.length) {
    radar.selected = candidates[(candidates.indexOf(radar.selected) + 1) % candidates.length];
  } else if (!candidates.includes(radar.selected) && (!radar.target || radar.selected !== radar.target)) {
    radar.selected = candidates[0] ?? null;
  }
  if (commands?.has('KeyT')) {
    const next = radar.selected;
    const dropping = next === radar.target || next === radar.pending;
    clearRadarTrack(radar, battle.time);
    if (next && !dropping && radar.echoes.has(next)) radar.pending = next;
  } else if (!commands && !radar.target && !radar.pending && (aircraft.radarRack.ammo || aircraft.activeRack?.ammo)) {
    const preferred = aircraft.ai.target;
    radar.pending = candidates.includes(preferred) && radarCanTrack(battle, aircraft, preferred)
      ? preferred
      : candidates.find(target => radarCanTrack(battle, aircraft, target)) ?? null;
  }

  if (!radar.pending) return;
  if (!radarCanTrack(battle, aircraft, radar.pending)) {
    clearRadarTrack(radar, battle.time);
    return;
  }
  radar.progress += dt;
  if (radar.progress >= RADAR.lockSeconds) {
    radar.target = radar.pending;
    radar.selected = radar.target;
    recordRadarEcho(radar, radar.target, battle.time);
    radar.pending = null;
    radar.trackId++;
  }
}

function updateLock(battle, aircraft, dt) {
  const { rack, flight } = aircraft;
  if (!rack.armed) return;
  const profile = MISSILES[rack.type];
  const maxRange = profile.lockRangeKm * WORLD_UNITS_PER_KILOMETER;
  let target = null;
  let bestAngle = profile.acquireAngle;
  const hold = rack.lock >= profile.lockSeconds ? profile.holdAngle : profile.acquireAngle;
  for (const other of battle.aircraft) {
    if (other.team === aircraft.team || !canBeTracked(other)) continue;
    const range = Math.hypot(other.flight.x - flight.x, other.flight.z - flight.z);
    if (range === 0 || range > maxRange) continue;
    const lineOfSight = bearing(flight, other.flight);
    const angle = Math.abs(angleDelta(flight.heading, lineOfSight));
    if (other === rack.target && angle <= hold) {
      target = other;
      break;
    }
    if (angle <= bestAngle) {
      bestAngle = angle;
      target = other;
    }
  }
  if (rack.target !== target) rack.lock = 0;
  rack.target = target;
  rack.lock = target ? Math.min(profile.lockSeconds, rack.lock + dt) : 0;
}

function airframePoint(flight, point) {
  // Match the renderer's local bank followed by heading rotation.
  const across = point.x * Math.cos(flight.bank) + point.y * Math.sin(flight.bank);
  const cos = Math.cos(flight.heading), sin = Math.sin(flight.heading);
  return { x: flight.x + across * cos - point.z * sin, z: flight.z + across * sin + point.z * cos };
}

function launchMissile(battle, aircraft, rack = aircraft.rack) {
  const { flight, team, radar } = aircraft;
  const profile = MISSILES[rack.type];
  const guidedByRadar = profile.guidance !== 'ir';
  const twsTarget = profile.guidance === 'arh' ? twsLaunchTarget(battle, aircraft) : null;
  const target = guidedByRadar ? radar.target ?? twsTarget : rack.target;
  if (!rack.ammo || !canBeTracked(target)) return false;
  if (guidedByRadar ? radarPosition(aircraft, target.flight).range > profile.launchRangeKm : rack.lock < profile.lockSeconds) return false;
  const airframe = AIRCRAFT[flight.airframe].id;
  const station = AIRFRAME_LOADOUTS[airframe].stations.find(({ id }) => aircraft.stores[id] === rack.type);
  if (!station) return false;
  const { x, z } = airframePoint(flight, station);
  const topSpeed = profile.mach * MACH_ONE_KPH * FLIGHT_SPEED_SCALE;
  const speed = Math.min(topSpeed, flight.speed * FLIGHT_SPEED_SCALE + profile.launchSpeedBonus);
  const boostUntil = battle.time + profile.boostSeconds;
  const sustainSeconds = profile.sustainSeconds ?? 0;
  const boostSpeedGain = (topSpeed - speed) * (profile.boostSpeedShare ?? 1);
  battle.missiles.push({
    id: battle.nextMissileId++, team, source: aircraft, target, trackId: radar.trackId, tws: Boolean(twsTarget),
    type: rack.type, heading: flight.heading,
    x, z, previousX: x, previousZ: z, bornAt: battle.time, speed,
    loadG: 0, distance: 0,
    boostUntil, poweredUntil: boostUntil + sustainSeconds,
    boostAcceleration: boostSpeedGain / profile.boostSeconds,
    sustainAcceleration: sustainSeconds ? (topSpeed - speed - boostSpeedGain) / sustainSeconds : 0,
    trail: [{ x, z, time: battle.time }], nextTrailAt: battle.time + MISSILE_SMOKE.interval,
    flareExposure: 0, interference: 0, activeRadar: false, lostAt: null, endedAt: null
  });
  delete aircraft.stores[station.id];
  rack.ammo--;
  rack.armed = false;
  rack.lock = 0;
  rack.target = null;
  rack.lastLaunch = battle.time;
  return true;
}

function missileContact(missile, target, previousTarget, radius) {
  // Test the swept segment in the moving target's frame.
  const x = missile.previousX - previousTarget.x;
  const z = missile.previousZ - previousTarget.z;
  const dx = missile.x - target.x - x;
  const dz = missile.z - target.z - z;
  const along = clamp(-(x * dx + z * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return (x + dx * along) ** 2 + (z + dz * along) ** 2 <= radius ** 2;
}

function releaseFlare(battle, aircraft) {
  const { time } = battle;
  const { flight, flareRack } = aircraft;
  if (!isAlive(aircraft) || !flareRack.ammo) return;
  const forwardX = Math.sin(flight.heading);
  const forwardZ = -Math.cos(flight.heading);
  const side = flareRack.ammo % 2 ? 1 : -1;
  const lateralX = -forwardZ * side;
  const lateralZ = forwardX * side;
  const x = flight.x - forwardX * 8 + lateralX * 3;
  const z = flight.z - forwardZ * 8 + lateralZ * 3;
  battle.flares.push({
    x, z, previous: { x, z }, bornAt: time, owner: aircraft,
    vx: forwardX * 12 + lateralX * 18,
    vz: forwardZ * 12 + lateralZ * 18
  });
  flareRack.ammo--;
}

function stepFlares(battle, dt) {
  for (let index = battle.flares.length - 1; index >= 0; index--) {
    const flare = battle.flares[index];
    if (battle.time - flare.bornAt >= FLARE.lifetime) {
      battle.flares.splice(index, 1);
      continue;
    }
    flare.previous.x = flare.x;
    flare.previous.z = flare.z;
    flare.x += flare.vx * dt;
    flare.z += flare.vz * dt;
  }
}

function releaseChaff(battle, aircraft) {
  const { time } = battle;
  const { flight, chaffRack } = aircraft;
  if (!isAlive(aircraft) || !chaffRack.ammo) return;
  const { x, z, heading } = flight;
  battle.chaff.push({ x: x - Math.sin(heading) * 11, z: z + Math.cos(heading) * 11, bornAt: time, owner: aircraft });
  chaffRack.ammo--;
}

function hasMissileTrack(battle, missile) {
  const { source, target } = missile;
  if (missile.tws) return hasTwsTrack(battle, source, target);
  return canFight(source) && source.radar.target === target && source.radar.trackId === missile.trackId;
}

function needsRadarSupport(missile) {
  return MISSILES[missile.type].guidance !== 'ir' && !missile.activeRadar;
}

function reportMissileOutcome(battle, missile, text) {
  missile.source.missileOutcome = { text, time: battle.time };
}

function heatDecoy(battle, missile, target, profile) {
  const { flight } = target;
  const aim = bearing(missile, flight);
  const rear = .55 + .45 * Math.cos(flight.heading - aim);
  const engineHeat = (target.role === 'bomber' ? .91 : .68) * flight.enginePower * flight.damage.power;
  const heat = .51 + rear * (engineHeat + (flight.afterburner ? 1.35 : 0));
  let best = heat;
  let candidate;
  for (const flare of battle.flares) {
    if (flare.owner !== target) continue;
    const angle = Math.abs(angleDelta(aim, bearing(missile, flare)));
    if (angle > profile.flareGate) continue;
    const separation = Math.hypot(flare.x - flight.x, flare.z - flight.z);
    const age = (battle.time - flare.bornAt) / FLARE.lifetime;
    const maneuver = clamp((separation - 6) / 26, 0, 1);
    const signal = (1 - age) * (1.04 + .95 * maneuver) * (1 - .61 * angle / profile.flareGate);
    if (signal <= best) continue;
    best = signal;
    candidate = flare;
  }
  return candidate;
}

function findProjectileImpact(battle, projectile, fuse) {
  let first = null;
  for (const aircraft of battle.aircraft) {
    if (aircraft.team === projectile.team || !canBeTracked(aircraft)) continue;
    if (Math.abs(projectile.x - aircraft.flight.x) > 36 + fuse || Math.abs(projectile.z - aircraft.flight.z) > 36 + fuse) continue;
    const contact = missilePass(projectile, aircraft.flight, aircraft.previous, fuse);
    if (contact && (!first || contact.along < first.along)) first = { ...contact, aircraft };
  }
  return first;
}

function fireCannon(battle, aircraft, dt) {
  const { cannonRack, flight, team } = aircraft;
  if (!cannonRack?.ammo || battle.time + 1e-9 < cannonRack.nextShotAt) return;
  const { muzzle, muzzleSpeedMps, roundsPerSecond } = AIRCRAFT[flight.airframe].cannon;
  const { x, z } = airframePoint(flight, muzzle);
  const speed = muzzleSpeedMps * WORLD_UNITS_PER_METER;
  const shotAt = battle.time - cannonRack.nextShotAt < dt ? cannonRack.nextShotAt : battle.time;
  cannonRack.nextShotAt = shotAt + 1 / roundsPerSecond;
  battle.cannonRounds.push({
    team, x, z, originX: x, originZ: z, previousX: x, previousZ: z,
    vx: Math.sin(flight.heading) * speed, vz: -Math.cos(flight.heading) * speed,
    heading: flight.heading, speed, distance: 0, bornAt: battle.time,
    tracer: (cannonRack.capacity - cannonRack.ammo) % 3 === 0,
  });
  cannonRack.ammo--;
}

function stepCannonRounds(battle, dt) {
  battle.cannonRounds = battle.cannonRounds.filter(round => {
    const step = round.speed * dt;
    const remaining = CANNON_RANGE - round.distance;
    round.previousX = round.x;
    round.previousZ = round.z;
    round.x += round.vx * dt;
    round.z += round.vz * dt;
    round.distance += step;
    const hit = remaining > 0 && findProjectileImpact(battle, round, 0);
    if (hit && hit.along * step <= remaining) {
      const { aircraft, along } = hit;
      const { damage } = aircraft.flight;
      damage.structure = Math.max(0, damage.structure - CANNON_DAMAGE);
      aircraft.damageReport = { part: '机体', time: battle.time, cause: 'cannon' };
      if (damage.structure === 0) {
        aircraft.destroyedAt = battle.time;
        battle.explosions.push({ x: lerp(round.previousX, round.x, along), z: lerp(round.previousZ, round.z, along),
          time: battle.time, size: 9, direction: round.heading });
      }
      return false;
    }
    // Only tracer rounds remain visible after their hit range.
    return round.distance < CANNON_RANGE + (round.tracer ? CANNON_FADE_DISTANCE : 0);
  });
}

function detonateMissile(battle, index, status, contact) {
  const missile = battle.missiles[index];
  const profile = MISSILES[missile.type];
  const center = contact ? {
    x: lerp(missile.previousX, missile.x, contact.along), z: lerp(missile.previousZ, missile.z, contact.along)
  } : missile;
  if (contact) missile.distance = Math.max(0, missile.distance - Math.hypot(missile.x - center.x, missile.z - center.z));
  let damageMessage = '';
  for (const aircraft of battle.aircraft) {
    if (aircraft.team === missile.team || !canBeTracked(aircraft)) continue;
    const { flight } = aircraft;
    const direct = aircraft === contact?.aircraft && contact.direct;
    if (direct) {
      flight.damage = { ...flight.damage, structure: 0 };
      aircraft.destroyedAt = battle.time;
      damageMessage = '直接命中 · 击毁';
      continue;
    }
    if (Math.hypot(flight.x - center.x, flight.z - center.z) > profile.blastRadius + 26) continue;
    const result = blastDamage(flight, center, profile);
    if (!result) continue;
    flight.damage = result.damage;
    aircraft.damageReport = { part: result.part, time: battle.time };
    if (flight.damage.structure <= 0) aircraft.destroyedAt = battle.time;
    if (!damageMessage || aircraft === contact?.aircraft) {
      damageMessage = aircraft.destroyedAt !== null ? '近炸 · 击毁' : `近炸 · ${result.part}受损`;
    }
  }
  missile.endedAt = battle.time;
  missile.endStatus = damageMessage || status;
  missile.explosion = {
    x: center.x, z: center.z, time: battle.time,
    size: profile.blastRadius * (contact ? .92 : .55), direction: missile.heading,
    blastPower: profile.blastPower
  };
  battle.explosions.push(missile.explosion);
  battle.endedMissiles.push(missile);
  reportMissileOutcome(battle, missile, missile.endStatus);
  battle.missiles.splice(index, 1);
}

function stepMissiles(battle, dt) {
  while (battle.explosions.length && battle.time - battle.explosions[0].time >= EXPLOSION_SECONDS) {
    battle.explosions.shift();
  }
  while (battle.endedMissiles.length && battle.time - battle.endedMissiles[0].endedAt >= EXPLOSION_SECONDS) {
    battle.endedMissiles.shift();
  }
  for (let index = battle.missiles.length - 1; index >= 0; index--) {
    const missile = battle.missiles[index];
    const profile = MISSILES[missile.type];
    const target = missile.target;
    if (battle.time - missile.bornAt >= profile.lifetime) {
      detonateMissile(battle, index, '导弹自爆');
      continue;
    }

    const targetLost = missile.flare ? battle.time - missile.flare.bornAt >= FLARE.lifetime : !canBeTracked(target);
    const lockLost = needsRadarSupport(missile) && !hasMissileTrack(battle, missile);
    const seekerNoise = missile.activeRadar && !targetLost && radarInterference(battle, missile, target, true);
    const twsNoise = lockLost && missile.tws && missile.source.radar.mode === 'tws' && canFight(missile.source)
      && !targetLost && radarCanTrack(battle, missile.source, target, false)
      && missile.source.radar.echoes.has(target);
    missile.interference = seekerNoise || twsNoise ? (missile.interference ?? 0) + dt : 0;
    const decoyed = missile.interference >= .24;
    if (missile.lostAt === null && (targetLost || (lockLost && !twsNoise) || decoyed)) {
      missile.lostAt = battle.time;
      reportMissileOutcome(battle, missile, decoyed ? '主动雷达受干扰' : targetLost ? '目标丢失 · 导弹继续飞行' : '雷达弹脱锁 · 继续飞行');
    }
    if (profile.guidance === 'arh' && !missile.activeRadar && missile.lostAt === null
        && !lockLost && battle.time - missile.bornAt >= profile.handoffSeconds) {
      missile.activeRadar = true;
      reportMissileOutcome(battle, missile, 'AIM-54C 已切换主动追踪');
    }

    if (missile.lostAt === null && !missile.flare && profile.guidance === 'ir' && target) {
      const flare = heatDecoy(battle, missile, target, profile);
      missile.flareExposure = flare ? (missile.flareExposure ?? 0) + dt : 0;
      if (flare && missile.flareExposure >= profile.flareExposure) {
        missile.flare = flare;
        target.flareRack.lastRedirect = battle.time;
      }
    }
    const destination = missile.lostAt === null ? missile.flare ?? target.flight : null;
    const previousDestination = destination ? missile.flare?.previous ?? target.previous : null;
    const stepStart = battle.time - dt;
    const boostTime = clamp(missile.boostUntil - stepStart, 0, dt);
    const sustainTime = Math.max(0, Math.min(battle.time, missile.poweredUntil) - Math.max(stepStart, missile.boostUntil));
    const coastTime = clamp(battle.time - missile.poweredUntil, 0, dt);
    missile.speed += missile.boostAcceleration * boostTime + missile.sustainAcceleration * sustainTime;
    if (coastTime > 0) missile.speed *= Math.exp(-MISSILE_COAST_DECAY_PER_SECOND * coastTime);
    missile.loadG = 0;
    if (destination) {
      // Convert the lateral acceleration limit to the same world units as speed.
      const lateralAcceleration = profile.g * GRAVITY * WORLD_UNITS_PER_METER;
      const turnLimit = lateralAcceleration / missile.speed * dt;
      // Give moving sprites a short aim preview. Contact still uses the actual target position.
      const distance = Math.hypot(destination.x - missile.x, destination.z - missile.z);
      const previewFrames = missile.flare ? 0 : Math.min(MISSILE_AIM_PREVIEW_SECONDS, distance / missile.speed) / dt;
      const aim = {
        x: destination.x + (destination.x - previousDestination.x) * previewFrames,
        z: destination.z + (destination.z - previousDestination.z) * previewFrames
      };
      const desired = angleDelta(missile.heading, bearing(missile, aim));
      const turn = clamp(desired, -turnLimit, turnLimit);
      missile.heading += turn;
      missile.loadG = profile.g * Math.abs(turn / turnLimit);
    }
    missile.previousX = missile.x;
    missile.previousZ = missile.z;
    const travel = missile.speed * dt;
    missile.x += Math.sin(missile.heading) * travel;
    missile.z -= Math.cos(missile.heading) * travel;
    missile.distance += travel;

    if (missile.flare && destination && missileContact(missile, destination, previousDestination, 2.4)) {
      detonateMissile(battle, index, '导弹被诱偏');
      continue;
    }
    const fuse = battle.time - missile.bornAt >= .16 ? profile.fuse : 0;
    const impact = findProjectileImpact(battle, missile, fuse);
    if (impact) {
      detonateMissile(battle, index, '近炸', impact);
      continue;
    }
    if (battle.time < missile.poweredUntil && battle.time >= missile.nextTrailAt) {
      missile.trail.push({ x: missile.x, z: missile.z, time: battle.time });
      missile.nextTrailAt = battle.time + MISSILE_SMOKE.interval;
    }
    while (missile.trail.length && battle.time - missile.trail[0].time > MISSILE_SMOKE.lifetime) {
      missile.trail.shift();
    }
  }
}

function assignedOpponent(battle, aircraft) {
  if (battle.raid && aircraft.team === 0) {
    const bombers = battle.aircraft.filter(other => other.role === 'bomber' && canBeTracked(other));
    const bomber = bombers.find(other => other.slot === aircraft.slot) ?? bombers[0];
    if (bomber) return bomber;
  }
  return battle.aircraft.find(other => other.team !== aircraft.team && other.slot === aircraft.slot && canBeTracked(other))
    ?? nearestOpponent(battle, aircraft);
}

function escortPosition(center, heading, slot) {
  return formationPosition(center, heading, 250 + Math.floor(slot / 2) * 105, (slot - 1.5) * 140);
}

function stepEscort(aircraft, bomber, dt) {
  const { flight, slot } = aircraft;
  const heading = bomber.previous.heading;
  const station = escortPosition(bomber.previous, heading, slot);
  const aim = formationPosition(station, heading, 330, 0);
  const ahead = (station.x - flight.x) * Math.sin(heading) - (station.z - flight.z) * Math.cos(heading);
  const speed = clamp(BOMBER.speedKph + ahead * 2.4, 640, 1120);
  const { flight: profile } = AIRCRAFT[flight.airframe];
  const balance = levelDragKn(profile, speed) / engineThrustKn(profile, speed, 1, false);
  const throttle = sampleCurve(profile.dryThrottle.map(([input, thrust]) => [thrust, input]), balance);
  stepFlight(flight, clamp((throttle - flight.throttle) * 2 + (speed - flight.speed) / 90, -1, 1),
    clamp(angleDelta(flight.heading, bearing(flight, aim)) * 1.55, -1, 1), dt);
}

function incomingMissile(battle, aircraft) {
  let danger;
  for (const missile of battle.missiles) {
    if (missile.target !== aircraft || missile.lostAt !== null || missile.flare) continue;
    if (battle.time - missile.bornAt < .21 + aircraft.slot * .07) continue;
    const infrared = MISSILES[missile.type].guidance === 'ir';
    const sensor = infrared || missile.activeRadar ? missile : missile.source.flight;
    const distance = Math.hypot(missile.x - aircraft.flight.x, missile.z - aircraft.flight.z);
    const range = (infrared ? 2.7 : missile.tws && !missile.activeRadar ? 3.5 : 9) * WORLD_UNITS_PER_KILOMETER;
    const timeToGo = distance / missile.speed;
    if (distance < range && (!danger || timeToGo < danger.timeToGo)) danger = { missile, infrared, sensor, distance, timeToGo };
  }
  return danger;
}

function stepDefense(battle, aircraft, dt) {
  const { flight, ai } = aircraft;
  const threat = incomingMissile(battle, aircraft);
  if (threat) {
    const direction = bearing(flight, threat.sensor);
    const angle = threat.infrared ? 2.12 : Math.PI / 2;
    const previous = ai.defense?.id === threat.missile.id ? ai.defense : null;
    const side = previous ? previous.side
      : Math.abs(angleDelta(flight.course, direction + angle)) <= Math.abs(angleDelta(flight.course, direction - angle)) ? 1 : -1;
    const heading = direction + angle * side;
    const launchDecoy = threat.infrared ? threat.timeToGo < 1.8 || Math.abs(flight.bank) > .2
      : threat.timeToGo < 4.5 && (Math.abs(Math.cos(flight.course - direction)) < .40 || threat.timeToGo < 1.8);
    const decoyStage = threat.timeToGo < .65 ? 2 : launchDecoy ? 1 : 0;
    const lastStage = previous?.decoyStage ?? 0;
    if (decoyStage > lastStage) {
      if (threat.infrared) releaseFlare(battle, aircraft);
      else releaseChaff(battle, aircraft);
    }
    ai.defense = { id: threat.missile.id, side, heading, until: battle.time + .75, infrared: threat.infrared,
      decoyStage: Math.max(lastStage, decoyStage) };
  }
  const defense = ai.defense;
  if (!defense) return false;
  if (battle.time > defense.until) {
    ai.defense = null;
    ai.phase = 'rejoin';
    return false;
  }
  if (aircraft.role === 'bomber') return true;
  flight.airbrake = false;
  if (defense.infrared) flight.afterburner = false;
  const throttle = defense.infrared ? .29 : .74;
  const turn = clamp(angleDelta(flight.heading, defense.heading) * 2.2, -1, 1);
  stepFlight(flight, throttle - flight.throttle, turn, dt);
  return true;
}

function stepAiFlight(battle, aircraft, dt) {
  const { flight, ai, slot } = aircraft;
  if (stepDefense(battle, aircraft, dt)) return;
  if (!canBeTracked(ai.target)) ai.target = assignedOpponent(battle, aircraft);
  const supporting = battle.missiles.find(missile => missile.source === aircraft
    && missile.lostAt === null && needsRadarSupport(missile) && hasMissileTrack(battle, missile));
  const target = supporting?.target ?? ai.target;
  if (!supporting && aircraft.role === 'escort') {
    const closeThreat = battle.aircraft.some(other => other.team !== aircraft.team && canBeTracked(other)
      && Math.hypot(other.previous.x - flight.x, other.previous.z - flight.z) < 8 * WORLD_UNITS_PER_KILOMETER);
    const bombers = battle.aircraft.filter(other => other.role === 'bomber' && isAlive(other));
    const bomber = bombers.find(other => other.slot === slot) ?? bombers[0];
    if (bomber && !closeThreat) {
      stepEscort(aircraft, bomber, dt);
      return;
    }
  }
  if (!target) {
    stepFlight(flight, 0.8 - flight.throttle, 0, dt);
    return;
  }
  const opening = AI_OPENINGS[slot];
  const distanceKm = Math.hypot(target.previous.x - flight.x, target.previous.z - flight.z) / WORLD_UNITS_PER_KILOMETER;
  const heading = bearing(flight, target.previous);
  const angle = angleDelta(flight.heading, heading);

  if (ai.phase === 'opening' && (distanceKm <= opening.joinKm || supporting)) ai.phase = 'engage';
  if (ai.phase === 'extend' && (battle.time >= ai.extendUntil || supporting)) ai.phase = 'rejoin';
  if (ai.phase === 'rejoin' && Math.abs(angle) <= 0.45) ai.phase = 'engage';
  if (ai.phase === 'engage' && !supporting && distanceKm < 2.1 && Math.abs(angle) > 1.2) {
    // Commit to a short turn before coming back, even if the target crosses again.
    ai.phase = 'extend';
    ai.exitHeading = flight.heading + Math.sign(angle) * (0.50 + slot * 0.08);
    ai.extendUntil = battle.time + 2.7 + slot * 0.55;
  }

  let desiredHeading = heading;
  let throttle = distanceKm > 1.8 ? 0.93 : 0.70;
  if (ai.phase === 'opening') {
    desiredHeading += opening.angle;
    throttle = opening.throttle;
  } else if (ai.phase === 'extend') {
    desiredHeading = ai.exitHeading;
    throttle = 0.91;
  } else if (ai.phase === 'rejoin' && !supporting && Math.abs(angle) > 0.65) {
    throttle = 0.40;
  }
  const turn = clamp(angleDelta(flight.heading, desiredHeading) * 1.55, -1, 1);
  stepFlight(flight, throttle - flight.throttle, turn, dt);
}

function stepWeapons(battle, aircraft, commands, dt) {
  const { rack, radarRack, activeRack } = aircraft;
  if (commands) {
    if (commands.has('KeyQ')) {
      const fitted = Object.entries({ ir: rack, sarh: radarRack, arh: activeRack })
        .filter(([, candidate]) => candidate?.capacity).map(([kind]) => kind);
      if (fitted.length > 1) {
        aircraft.weapon = fitted[(fitted.indexOf(aircraft.weapon) + 1) % fitted.length];
        rack.armed = false;
        rack.lock = 0;
        rack.target = null;
      }
    }
    const activate = commands.has('Space');
    if (aircraft.weapon !== 'ir') {
      if (activate) launchMissile(battle, aircraft, aircraft.weapon === 'sarh' ? radarRack : activeRack);
      return;
    }
    if (!rack.ammo) return;
    const wasArmed = rack.armed;
    if (activate) rack.armed = true;
    updateLock(battle, aircraft, dt);
    if (activate && wasArmed) launchMissile(battle, aircraft);
    return;
  }

  const lastLaunch = Math.max(rack.lastLaunch, radarRack.lastLaunch, activeRack?.lastLaunch ?? -Infinity);
  if (aircraft.ai.defense || aircraft.ai.phase === 'extend' || battle.time - lastLaunch < 2.6) return;
  if (rack.ammo) {
    rack.armed = true;
    updateLock(battle, aircraft, dt);
    if (launchMissile(battle, aircraft)) return;
  }
  const canFireRadar = aircraft.slot === 0 || aircraft.ai.phase !== 'opening';
  if (canFireRadar && (radarRack.ammo || activeRack?.ammo) && !battle.missiles.some(missile =>
    missile.source === aircraft && missile.lostAt === null && needsRadarSupport(missile))) {
    if (radarRack.ammo && launchMissile(battle, aircraft, radarRack)) return;
    if (activeRack?.ammo) launchMissile(battle, aircraft, activeRack);
  }
}

function aiCanFireCannon(aircraft) {
  const { target, defense } = aircraft.ai;
  if (defense || !canBeTracked(target)) return false;
  const { angle, range } = radarPosition(aircraft, target.flight);
  return Math.abs(angle) < 0.055 && range <= CANNON_RANGE / WORLD_UNITS_PER_KILOMETER;
}

function applyFlightAction(flight, action) {
  if (flight.phase !== 'airborne' && flight.phase !== 'approach' && flight.phase !== 'climb') return;
  if (action === 'KeyW' && flight.throttle === 1 && flight.fuel > 0 && flight.damage.power > .01) flight.afterburner = true;
  else if (action === 'KeyS') flight.afterburner = false;
  else if (action === 'KeyB') flight.airbrake = !flight.airbrake;
}

function crashAircraft(battle, aircraft, reason) {
  const { flight } = aircraft;
  flight.altitudeM = 0;
  flight.afterburner = false;
  flight.crashReason = reason;
  aircraft.destroyedAt = battle.time;
  battle.explosions.push({ x: flight.x, z: flight.z, time: battle.time, size: 13, direction: flight.course });
}

function stepAircraft(battle, aircraft, controls, dt) {
  const { flight } = aircraft;
  if (aircraft.role === 'bomber') {
    stepDefense(battle, aircraft, dt);
    const turn = angleDelta(flight.heading, bearing(flight, battle.mission.factory));
    const turnLimit = .18 * flight.damage.control * dt;
    flight.heading = flight.course = (flight.heading + clamp(turn, -turnLimit, turnLimit) + TAU) % TAU;
    flight.bank += (clamp(turn, -.32, .32) - flight.bank) * (1 - Math.exp(-dt * 3));
    const cruisingSpeed = BOMBER.speedKph * (.52 + .48 * flight.damage.power);
    flight.speed += (cruisingSpeed - flight.speed) * (1 - Math.exp(-dt * .18));
    const distance = flight.speed * FLIGHT_SPEED_SCALE * dt;
    flight.x += Math.sin(flight.heading) * distance;
    flight.z -= Math.cos(flight.heading) * distance;
    if (flight.damage.power <= .01) stepGlide(battle, aircraft, dt, 'engine-failure');
    return;
  }
  if (controls && flight.phase === 'airborne' && captureApproach(aircraft, WORLD_UNITS_PER_METER)) {
    clearRadarTrack(aircraft.radar, battle.time);
    aircraft.radar.echoes.clear();
    aircraft.radar.selected = null;
    aircraft.rack.lock = 0;
    aircraft.rack.target = null;
    aircraft.rack.armed = false;
  }
  if (aircraft.runway) {
    const crash = stepRunway(aircraft, controls, dt, WORLD_UNITS_PER_METER, stepFlight);
    if (crash) crashAircraft(battle, aircraft, crash);
    return;
  }

  if (controls) stepFlight(flight, controls.throttle, controls.turn, dt, true);
  else stepAiFlight(battle, aircraft, dt);
  if (flight.fuel === 0 || flight.damage.power <= .01) {
    stepGlide(battle, aircraft, dt, flight.fuel === 0 ? 'fuel-exhausted' : 'engine-failure');
  } else if (flight.phase === 'climb') {
    flight.altitudeM = Math.min(FLIGHT_ALTITUDE_M, flight.altitudeM + FLIGHT_ALTITUDE_M / RUNWAY.climbSeconds * dt);
    if (flight.altitudeM === FLIGHT_ALTITUDE_M) flight.phase = 'airborne';
  }
}

function stepGlide(battle, aircraft, dt, reason) {
  aircraft.flight.altitudeM -= FLIGHT_ALTITUDE_M / RUNWAY.glideSeconds * dt;
  if (aircraft.flight.altitudeM <= 1e-7) crashAircraft(battle, aircraft, reason);
}

function resolveFactoryDefense(battle) {
  const { raid, time, mission } = battle;
  const { factory } = mission;
  const bombers = battle.aircraft.filter(aircraft => aircraft.role === 'bomber' && isAlive(aircraft));
  if (raid.bomb) {
    if (time < raid.bomb.impactAt) return;
    battle.explosions.push({ x: factory.x, z: factory.z, time, size: 35, direction: 0 });
    battle.result = 'lost';
    battle.resultReason = 'factory-hit';
  } else if (!bombers.length) {
    battle.result = 'won';
    battle.resultReason = 'bombers-stopped';
  } else if (time + 1e-9 >= mission.timeLimit) {
    battle.result = 'won';
    battle.resultReason = 'factory-held';
  } else {
    const bomber = bombers.find(({ flight }) => Math.hypot(flight.x - factory.x, flight.z - factory.z) <= FACTORY_DROP_RADIUS);
    if (bomber) {
      const { x, z } = bomber.flight;
      raid.bomb = { x, z, droppedAt: time, impactAt: time + BOMB_FALL_SECONDS };
    }
  }
}

function advanceBattle(battle, getControls, dt) {
  battle.time += dt;
  for (const aircraft of battle.aircraft) Object.assign(aircraft.previous, aircraft.flight);
  for (const aircraft of battle.aircraft) {
    if (!isAlive(aircraft)) continue;
    stepAircraft(battle, aircraft, getControls(aircraft), dt);
  }

  stepFlares(battle, dt);
  while (battle.chaff.length && battle.time - battle.chaff[0].bornAt >= CHAFF.lifetime) battle.chaff.shift();
  for (const aircraft of battle.aircraft) {
    if (!canFight(aircraft)) continue;
    const commands = getControls(aircraft)?.commands;
    if (commands?.has('KeyX')) releaseFlare(battle, aircraft);
    if (commands?.has('KeyC')) releaseChaff(battle, aircraft);
  }
  for (const aircraft of battle.aircraft) {
    if (canFight(aircraft)) stepRadar(battle, aircraft, getControls(aircraft)?.commands, dt);
  }
  stepMissiles(battle, dt);
  stepCannonRounds(battle, dt);
  if (battle.raid) resolveFactoryDefense(battle);
  else resolveAirBattle(battle);
  if (battle.result) return;
  for (const aircraft of battle.aircraft) {
    if (!canFight(aircraft)) continue;
    const controls = getControls(aircraft);
    const firing = controls ? controls.fireCannon || controls.commands.has('KeyF') : aiCanFireCannon(aircraft);
    if (firing) fireCannon(battle, aircraft, dt);
    stepWeapons(battle, aircraft, controls?.commands, dt);
  }
}

function resolveAirBattle(battle) {
  const uk = teamCount(battle, 0);
  const france = teamCount(battle, 1);
  const cooperative = battle.mission.mode === 'pve';
  if (!uk || !france) {
    battle.result = uk ? 'won' : france || cooperative ? 'lost' : 'draw';
    battle.resultReason = 'elimination';
    return;
  }
  if (battle.time + 1e-9 >= battle.mission.timeLimit) {
    battle.result = cooperative ? 'lost' : uk === france ? 'draw' : uk > france ? 'won' : 'lost';
    battle.resultReason = 'timeout';
    return;
  }
}

function lerp(start, end, fraction) {
  return start + (end - start) * fraction;
}

export { STEP, PILOT_ACTIONS, initialBattle, advanceBattle, applyFlightAction, isAlive };
