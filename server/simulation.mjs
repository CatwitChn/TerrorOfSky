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
// War Thunder vehicle cards: f_15a and su_27. Reference mass uses 30% internal fuel.
// Thrust and nose response [TAS km/h, degrees/second] are tuned for the planar game.
const AIRCRAFT = [
  {
    name: 'F-15A', ir: 'AIM-9M', sarh: 'AIM-7M', radarName: 'APG-63', launchWarning: true,
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
    name: 'Su-27', ir: 'R-73', sarh: 'R-27R', radarName: 'N001', launchWarning: true,
    flight: {
      massKg: 18810, limitIasKph: 1540, limitMach: 2.35, turnSeconds: 23.5, spoolSeconds: 0.12,
      noseResponse: [[300, 25], [450, 30], [560, 29], [680, 21], [900, 14.5], [1200, 10.5], [1850, 7]],
      liftAreaByMach: [[0.35, 105], [0.8, 95], [1.15, 84]],
      dryThrottle: [[0, 0.05], [0.3, 0.22], [0.55, 0.50], [0.90, 0.82], [1, 1]],
      thrust: [
        [0, 114, 185], [500, 113, 193], [900, 119, 212], [1400, 129, 228], [1950, 134, 235]
      ]
    }
  }
];

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
  capacity: 2,
  launchSpeedBonus: 22,
  lifetime: 6.5,
  lockSeconds: 0.42,
  acquireAngle: 0.30,
  holdAngle: 0.44
};
const MISSILES = {
  'AIM-9M': { ...MISSILE_DEFAULTS, mach: 2.5, g: 30, boostSeconds: 5.3, lockRangeKm: 3.4, flareResistance: 2 },
  'R-73': { ...MISSILE_DEFAULTS, mach: 2.5, g: 40, boostSeconds: 4.8, lockRangeKm: 3.1, acquireAngle: 0.38, flareResistance: 2 },
  'AIM-7M': {
    ...MISSILE_DEFAULTS, guidance: 'sarh', mach: 4, g: 25, launchRangeKm: 14, lifetime: 19,
    boostSeconds: 4.5, sustainSeconds: 11, boostSpeedShare: 0.85
  },
  'R-27R': { ...MISSILE_DEFAULTS, guidance: 'sarh', mach: 3.5, g: 35, boostSeconds: 6, lifetime: 15, launchRangeKm: 12 }
};
const MISSILE_SMOKE = { interval: 0.055, lifetime: 0.75 };
const EXPLOSION_SECONDS = 1.2;
const MISSILE_AIM_PREVIEW_SECONDS = 0.8;
const AIRCRAFT_HIT_RADIUS = 6.1;
const FLARE = { capacity: 6, cooldown: 0.8, lifetime: 1.35, attractionRadius: 96 };
const CHAFF = { capacity: 6, cooldown: 1, lifetime: 1.6 };
const RADAR = { rangeKm: 22, scanAngle: 0.88, trackAngle: 1.08, scanSeconds: 2.2, memory: 3.2, lockSeconds: 0.35 };
// FLIGHT_SPEED_SCALE converts a speed in km/h to world units per second.
const WORLD_UNITS_PER_KILOMETER = 3600 * FLIGHT_SPEED_SCALE;
const WORLD_UNITS_PER_METER = WORLD_UNITS_PER_KILOMETER / 1000;
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
const BATTLE_KEYS = new Set(['Space', 'KeyQ', 'KeyT', 'KeyY', 'KeyG', 'KeyX', 'KeyC']);
const PILOT_ACTIONS = new Set(['KeyB', 'KeyW', 'KeyS', ...BATTLE_KEYS]);

export const BATTLE_DISPLAY = {
  map: { name: COAST_MAP.name, bounds: COAST_MAP.bounds },
  worldUnitsPerKilometer: WORLD_UNITS_PER_KILOMETER,
  flightAltitudeM: FLIGHT_ALTITUDE_M,
  machOneKph: MACH_ONE_KPH,
  pilotStrainThreshold: PILOT_STRAIN_THRESHOLD,
  airbrakeReferenceKph: AIRBRAKE_REFERENCE_KPH,
  missileSmokeLifetime: MISSILE_SMOKE.lifetime,
  explosionSeconds: EXPLOSION_SECONDS,
  flareLifetime: FLARE.lifetime,
  chaffLifetime: CHAFF.lifetime,
  radar: { rangeKm: RADAR.rangeKm, scanAngle: RADAR.scanAngle, trackAngle: RADAR.trackAngle },
  aircraft: AIRCRAFT.map(({ name, flight, radarName, launchWarning }) =>
    ({ name, topSpeedKph: flight.topSpeedKph, radarName, launchWarning })),
  missiles: Object.fromEntries(Object.entries(MISSILES).map(([type, { capacity, guidance, launchRangeKm, lockSeconds }]) =>
    [type, { capacity, guidance, launchRangeKm, lockSeconds }])),
};

function initialFlight(airframe, spawn) {
  return {
    ...spawn, airframe, bank: 0, speed: START_SPEED, course: spawn.heading,
    turnAcceleration: 0, loadFactor: 1, liftUse: 0, pilotStrain: 0,
    throttle: START_THROTTLE, enginePower: START_THROTTLE, afterburner: false,
    airbrake: false, airbrakeExtension: 0
  };
}

function stepFlight(flight, throttleInput, turnInput, dt) {
  const profile = AIRCRAFT[flight.airframe].flight;
  flight.throttle = Math.max(0, Math.min(1, flight.throttle + throttleInput * 0.48 * dt));
  if (flight.throttle < 1) flight.afterburner = false;
  const brakeTravel = dt / AIRBRAKE_TRAVEL_SECONDS;
  flight.airbrakeExtension = clamp(Number(flight.airbrake), flight.airbrakeExtension - brakeTravel, flight.airbrakeExtension + brakeTravel);
  const spoolSeconds = flight.afterburner ? profile.spoolSeconds * AFTERBURNER_SPOOL_MULTIPLIER : profile.spoolSeconds;
  flight.enginePower += (flight.throttle - flight.enginePower) * (1 - Math.exp(-dt / spoolSeconds));
  const pilotAuthority = 1 - Math.max(0, flight.pilotStrain - PILOT_STRAIN_THRESHOLD);
  const desiredBank = turnInput * pilotAuthority * MAX_BANK;
  flight.bank += (desiredBank - flight.bank) * (1 - Math.exp(-dt / 0.14));

  // The nose can move ahead of the course while lift bends the flight path.
  const noseRate = sampleCurve(profile.noseResponse, flight.speed) * Math.PI / 180;
  const desiredHeading = flight.heading + noseRate * (flight.bank / MAX_BANK) * dt;
  const headingLead = clamp(angleDelta(flight.course, desiredHeading), -MAX_HEADING_LEAD, MAX_HEADING_LEAD);
  flight.heading = (flight.course + headingLead + TAU) % TAU;
  const speedMps = flight.speed / 3.6;
  const maxLift = maxLiftAcceleration(profile, flight.speed);
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
  const distance = flight.speed * FLIGHT_SPEED_SCALE * dt;
  flight.x += Math.sin(flight.course) * distance;
  flight.z -= Math.cos(flight.course) * distance;
}

function flightAcceleration(profile, flight) {
  const turnLoadRatio = flight.turnAcceleration / profile.turnAccelerationAtReference;
  const turnDragKn = profile.turnDragAtReferenceKn * (turnLoadRatio * TURN_REFERENCE_KPH / flight.speed) ** 2;
  const straightDragKn = levelDragKn(profile, flight.speed, flight.airbrakeExtension);
  const thrustKn = engineThrustKn(profile, flight.speed, flight.enginePower, flight.afterburner);
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

function initialMissileRack(type) {
  return { type, ammo: MISSILES[type].capacity, armed: false, lock: 0, target: null, lastLaunch: -Infinity };
}

function initialBattle(roster) {
  const departures = COAST_MAP.departures;
  const aircraft = departures.flatMap((departure, team) => {
    const heading = (bearing(departure, departures[1 - team]) + TAU) % TAU;
    const sin = Math.sin(heading);
    const cos = Math.cos(heading);
    return FORMATION.map(({ forward, right }, slot) => {
      const pilot = roster.find(member => member.team === team && member.slot === slot);
      const model = pilot?.airframe ?? team;
      const flight = initialFlight(model, {
        x: departure.x + sin * forward + cos * right,
        z: departure.z - cos * forward + sin * right,
        heading
      });
      return {
        id: team * FORMATION.length + slot, name: pilot?.name ?? null,
        team, slot, flight, previous: { ...flight },
        rack: initialMissileRack(AIRCRAFT[model].ir),
        radarRack: initialMissileRack(AIRCRAFT[model].sarh),
        weapon: 'ir', destroyedAt: null,
        flareRack: { ammo: FLARE.capacity, readyAt: 0, lastRedirect: -Infinity },
        chaffRack: { ammo: CHAFF.capacity, readyAt: 0 }, missileOutcome: null,
        ai: { phase: 'opening', target: null, exitHeading: 0, extendUntil: 0 },
        radar: { mode: 'src', echoes: new Map(), sweep: -RADAR.scanAngle, selected: null,
          pending: null, target: null, progress: 0, trackId: 0, lostAt: -Infinity }
      };
    });
  });
  return {
    aircraft, missiles: [], flares: [], chaff: [], explosions: [], time: 0, result: null,
    nextMissileId: 1, endedMissiles: [],
  };
}

function isAlive(aircraft) {
  return aircraft.destroyedAt === null;
}

function nearestOpponent(battle, aircraft) {
  let nearest = null;
  let distance = Infinity;
  for (const other of battle.aircraft) {
    if (other.team === aircraft.team || !isAlive(other)) continue;
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

function radarCanTrack(battle, aircraft, target) {
  if (!isAlive(target)) return false;
  const { angle, range } = radarPosition(aircraft, target.flight);
  if (!range || range > RADAR.rangeKm || Math.abs(angle) > RADAR.trackAngle) return false;
  const clouds = battle.chaff.filter(cloud => cloud.owner === target).length;
  // PD rejects one decoy cloud in this game's sensor model.
  return clouds < (aircraft.radar.mode === 'pd' ? 2 : 1);
}

function clearRadarTrack(radar, time) {
  if (radar.target) radar.lostAt = time;
  radar.pending = null;
  radar.target = null;
  radar.progress = 0;
  radar.trackId++;
}

function radarCandidates(aircraft) {
  return [...aircraft.radar.echoes.keys()]
    .filter(target => target.team !== aircraft.team && isAlive(target))
    .sort((a, b) => radarPosition(aircraft, aircraft.radar.echoes.get(a)).range
      - radarPosition(aircraft, aircraft.radar.echoes.get(b)).range);
}

function stepRadar(battle, aircraft, commands, dt) {
  const { radar } = aircraft;
  if (commands?.has('KeyG')) {
    clearRadarTrack(radar, battle.time);
    radar.mode = radar.mode === 'src' ? 'pd' : 'src';
  }
  if (radar.target && !radarCanTrack(battle, aircraft, radar.target)) clearRadarTrack(radar, battle.time);

  for (const [target, echo] of radar.echoes) {
    if (!isAlive(target) || battle.time - echo.time > RADAR.memory) radar.echoes.delete(target);
  }
  if (radar.target) radar.echoes.set(radar.target, { x: radar.target.flight.x, z: radar.target.flight.z, time: battle.time });
  if (!radar.target && !radar.pending) {
    const phase = (battle.time / RADAR.scanSeconds + aircraft.slot * 0.11 + aircraft.team * 0.19) % 1;
    const sweep = RADAR.scanAngle * (1 - 4 * Math.abs(phase - 0.5));
    const low = Math.min(radar.sweep, sweep) - 0.025;
    const high = Math.max(radar.sweep, sweep) + 0.025;
    radar.sweep = sweep;
    for (const target of battle.aircraft) {
      if (target === aircraft || !isAlive(target)) continue;
      const { angle, range } = radarPosition(aircraft, target.flight);
      if (range <= RADAR.rangeKm && angle >= low && angle <= high && Math.abs(angle) <= RADAR.scanAngle) {
        radar.echoes.set(target, { x: target.flight.x, z: target.flight.z, time: battle.time });
      }
    }
  }

  const candidates = radarCandidates(aircraft);
  if (commands?.has('KeyY') && candidates.length) {
    radar.selected = candidates[(candidates.indexOf(radar.selected) + 1) % candidates.length];
  } else if (!radar.echoes.has(radar.selected) && (!radar.target || radar.selected !== radar.target)) {
    radar.selected = candidates[0] ?? null;
  }
  if (commands?.has('KeyT')) {
    const next = radar.selected;
    const dropping = next === radar.target || next === radar.pending;
    clearRadarTrack(radar, battle.time);
    if (next && !dropping && radar.echoes.has(next)) radar.pending = next;
  } else if (!commands && !radar.target && !radar.pending && aircraft.radarRack.ammo) {
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
    radar.echoes.set(radar.target, { x: radar.target.flight.x, z: radar.target.flight.z, time: battle.time });
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
    if (other.team === aircraft.team || !isAlive(other)) continue;
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

function launchMissile(battle, aircraft, rack = aircraft.rack) {
  const { flight, team, radar } = aircraft;
  const profile = MISSILES[rack.type];
  const guidedByRadar = profile.guidance === 'sarh';
  const target = guidedByRadar ? radar.target : rack.target;
  if (!rack.ammo || !target || !isAlive(target)) return false;
  if (guidedByRadar ? radarPosition(aircraft, target.flight).range > profile.launchRangeKm : rack.lock < profile.lockSeconds) return false;
  const x = flight.x + Math.sin(flight.heading) * 8.8;
  const z = flight.z - Math.cos(flight.heading) * 8.8;
  const topSpeed = profile.mach * MACH_ONE_KPH * FLIGHT_SPEED_SCALE;
  const speed = Math.min(topSpeed, flight.speed * FLIGHT_SPEED_SCALE + profile.launchSpeedBonus);
  const boostUntil = battle.time + profile.boostSeconds;
  const sustainSeconds = profile.sustainSeconds ?? 0;
  const boostSpeedGain = (topSpeed - speed) * (profile.boostSpeedShare ?? 1);
  battle.missiles.push({
    id: battle.nextMissileId++, team, source: aircraft, target, trackId: radar.trackId, type: rack.type, heading: flight.heading,
    x, z, previousX: x, previousZ: z, bornAt: battle.time, speed,
    boostUntil, poweredUntil: boostUntil + sustainSeconds,
    boostAcceleration: boostSpeedGain / profile.boostSeconds,
    sustainAcceleration: sustainSeconds ? (topSpeed - speed - boostSpeedGain) / sustainSeconds : 0,
    trail: [{ x, z, time: battle.time }], nextTrailAt: battle.time + MISSILE_SMOKE.interval,
    flareContacts: new Set(), lostAt: null, endedAt: null
  });
  rack.ammo--;
  rack.armed = false;
  rack.lock = 0;
  rack.target = null;
  rack.lastLaunch = battle.time;
  return true;
}

function missileContact(missile, target, previousTarget) {
  // Test the swept segment in the moving target's frame.
  const x = missile.previousX - previousTarget.x;
  const z = missile.previousZ - previousTarget.z;
  const dx = missile.x - target.x - x;
  const dz = missile.z - target.z - z;
  const along = clamp(-(x * dx + z * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return (x + dx * along) ** 2 + (z + dz * along) ** 2 <= AIRCRAFT_HIT_RADIUS ** 2;
}

function releaseFlare(battle, aircraft) {
  const { time } = battle;
  const { flight, flareRack } = aircraft;
  if (!isAlive(aircraft) || !flareRack.ammo || time < flareRack.readyAt) return;
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
  flareRack.readyAt = time + FLARE.cooldown;
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
  if (!isAlive(aircraft) || !chaffRack.ammo || time < chaffRack.readyAt) return;
  const { x, z, heading } = flight;
  battle.chaff.push({ x: x - Math.sin(heading) * 11, z: z + Math.cos(heading) * 11, bornAt: time, owner: aircraft });
  chaffRack.ammo--;
  chaffRack.readyAt = time + CHAFF.cooldown;
}

function hasMissileTrack(missile) {
  const { source, target } = missile;
  return isAlive(source) && source.radar.target === target && source.radar.trackId === missile.trackId;
}

function reportMissileOutcome(battle, missile, text) {
  missile.source.missileOutcome = { text, time: battle.time };
}

function detonateMissile(battle, index, status, struckAircraft) {
  const missile = battle.missiles[index];
  missile.endedAt = battle.time;
  missile.endStatus = status;
  const center = struckAircraft ? struckAircraft.flight : missile;
  if (struckAircraft) struckAircraft.destroyedAt = battle.time;
  missile.explosion = {
    x: center.x, z: center.z, time: battle.time,
    size: struckAircraft ? 13 : 5.6, direction: missile.heading
  };
  battle.explosions.push(missile.explosion);
  battle.endedMissiles.push(missile);
  reportMissileOutcome(battle, missile, status);
  battle.missiles.splice(index, 1);
}

function stepMissiles(battle, dt) {
  while (battle.explosions.length && battle.time - battle.explosions[0].time >= EXPLOSION_SECONDS) {
    battle.explosions.shift();
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

    const targetLost = missile.flare ? battle.time - missile.flare.bornAt >= FLARE.lifetime : !target || !isAlive(target);
    const lockLost = profile.guidance === 'sarh' && !hasMissileTrack(missile);
    if (missile.lostAt === null && (targetLost || lockLost)) {
      missile.lostAt = battle.time;
      reportMissileOutcome(battle, missile, targetLost ? '目标丢失 · 导弹继续飞行' : '雷达弹脱锁 · 继续飞行');
    }

    if (missile.lostAt === null && !missile.flare && profile.guidance === 'ir' && target) {
      const flare = battle.flares.findLast(candidate => candidate.owner === target && !missile.flareContacts.has(candidate)
        && Math.hypot(candidate.x - missile.x, candidate.z - missile.z) <= FLARE.attractionRadius);
      if (flare) missile.flareContacts.add(flare);
      if (flare && missile.flareContacts.size >= profile.flareResistance) {
        missile.flare = flare;
        target.flareRack.lastRedirect = battle.time;
      }
    }
    const destination = missile.lostAt === null ? missile.flare ?? target.flight : null;
    const previousDestination = destination ? missile.flare?.previous ?? target.previous : null;
    const stepStart = battle.time - dt;
    const boostTime = clamp(missile.boostUntil - stepStart, 0, dt);
    const sustainTime = Math.max(0, Math.min(battle.time, missile.poweredUntil) - Math.max(stepStart, missile.boostUntil));
    missile.speed += missile.boostAcceleration * boostTime + missile.sustainAcceleration * sustainTime;
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
      missile.heading += clamp(desired, -turnLimit, turnLimit);
    }
    missile.previousX = missile.x;
    missile.previousZ = missile.z;
    missile.x += Math.sin(missile.heading) * missile.speed * dt;
    missile.z -= Math.cos(missile.heading) * missile.speed * dt;

    if (destination && missileContact(missile, destination, previousDestination)) {
      detonateMissile(battle, index, missile.flare ? '导弹被诱偏' : '导弹命中', missile.flare ? null : target);
      continue;
    }
    if (!destination) {
      const struckAircraft = battle.aircraft.find(aircraft =>
        aircraft.team !== missile.team && isAlive(aircraft) && missileContact(missile, aircraft.flight, aircraft.previous));
      if (struckAircraft) {
        detonateMissile(battle, index, '导弹命中', struckAircraft);
        continue;
      }
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
  const opposite = battle.aircraft[(1 - aircraft.team) * FORMATION.length + aircraft.slot];
  return isAlive(opposite) ? opposite : nearestOpponent(battle, aircraft);
}

function stepAiFlight(battle, aircraft, dt) {
  const { flight, ai, slot, radar } = aircraft;
  if (!ai.target || !isAlive(ai.target)) ai.target = assignedOpponent(battle, aircraft);
  const supporting = battle.missiles.some(missile => missile.source === aircraft
    && MISSILES[missile.type].guidance === 'sarh' && missile.lostAt === null && hasMissileTrack(missile));
  const target = supporting ? radar.target : ai.target;
  if (!target) return;
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
  const { rack, radarRack } = aircraft;
  if (commands) {
    if (commands.has('KeyQ')) {
      aircraft.weapon = aircraft.weapon === 'ir' ? 'sarh' : 'ir';
      rack.armed = false;
      rack.lock = 0;
      rack.target = null;
    }
    const activate = commands.has('Space');
    if (aircraft.weapon === 'sarh') {
      if (activate) launchMissile(battle, aircraft, radarRack);
      return;
    }
    if (!rack.ammo) return;
    const wasArmed = rack.armed;
    if (activate) rack.armed = true;
    updateLock(battle, aircraft, dt);
    if (activate && wasArmed) launchMissile(battle, aircraft);
    return;
  }

  if (aircraft.ai.phase === 'extend' || battle.time - Math.max(rack.lastLaunch, radarRack.lastLaunch) < 2.6) return;
  if (rack.ammo) {
    rack.armed = true;
    updateLock(battle, aircraft, dt);
    if (launchMissile(battle, aircraft)) return;
  }
  const canFireRadar = aircraft.slot === 0 || aircraft.ai.phase !== 'opening';
  if (canFireRadar && radarRack.ammo && !battle.missiles.some(missile =>
    missile.source === aircraft && missile.lostAt === null && MISSILES[missile.type].guidance === 'sarh')) {
    launchMissile(battle, aircraft, radarRack);
  }
}

function applyFlightAction(flight, action) {
  if (action === 'KeyW' && flight.throttle === 1) flight.afterburner = true;
  else if (action === 'KeyS') flight.afterburner = false;
  else if (action === 'KeyB') flight.airbrake = !flight.airbrake;
}

function advanceBattle(battle, getControls, dt) {
  battle.time += dt;
  for (const aircraft of battle.aircraft) Object.assign(aircraft.previous, aircraft.flight);
  for (const aircraft of battle.aircraft) {
    if (!isAlive(aircraft)) continue;
    const controls = getControls(aircraft);
    if (controls) stepFlight(aircraft.flight, controls.throttle, controls.turn, dt);
    else stepAiFlight(battle, aircraft, dt);
  }

  stepFlares(battle, dt);
  while (battle.chaff.length && battle.time - battle.chaff[0].bornAt >= CHAFF.lifetime) battle.chaff.shift();
  for (const aircraft of battle.aircraft) {
    if (!isAlive(aircraft)) continue;
    const commands = getControls(aircraft)?.commands;
    if (commands?.has('KeyX')) releaseFlare(battle, aircraft);
    if (commands?.has('KeyC')) releaseChaff(battle, aircraft);
  }
  for (const aircraft of battle.aircraft) {
    if (isAlive(aircraft)) stepRadar(battle, aircraft, getControls(aircraft)?.commands, dt);
  }
  stepMissiles(battle, dt);
  const uk = teamCount(battle, 0);
  const france = teamCount(battle, 1);
  if (!uk || !france) {
    battle.result = uk ? 'won' : france ? 'lost' : 'draw';
    return;
  }

  for (const aircraft of battle.aircraft) {
    if (isAlive(aircraft)) stepWeapons(battle, aircraft, getControls(aircraft)?.commands, dt);
  }
  if (!battle.missiles.length && !battle.aircraft.some(aircraft => isAlive(aircraft) && (aircraft.rack.ammo || aircraft.radarRack.ammo))) {
    battle.result = 'draw';
  }
}

function lerp(start, end, fraction) {
  return start + (end - start) * fraction;
}

export { STEP, PILOT_ACTIONS, initialBattle, advanceBattle, applyFlightAction, isAlive };
