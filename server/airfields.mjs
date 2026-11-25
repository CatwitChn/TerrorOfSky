import { freshDamage } from './combat.mjs';

export const AIRFIELDS = [
  { team: 0, name: '肯特机场', x: -2800, z: -1600, heading: 1.2 },
  { team: 1, name: '加来机场', x: 5100, z: 5900, heading: 1.25 }
];

export const RUNWAY = {
  lengthM: 1500,
  widthM: 56,
  approachLengthM: 2000,
  approachHalfWidthM: 175,
  approachAngle: 20 * Math.PI / 180,
  touchdownM: 400,
  safeTouchdownKph: 360,
  serviceSeconds: 8,
  takeoffKph: 300,
  climbSeconds: 8,
  glideSeconds: 16
};

// Stopping distance from the reference touchdown speed equals the runway left after touchdown.
const BRAKING = (RUNWAY.safeTouchdownKph / 3.6) ** 2 / (2 * (RUNWAY.lengthM - RUNWAY.touchdownM));
const TAKEOFF_ACCELERATION = 11;
const TAU = 2 * Math.PI;
const clamp01 = value => Math.max(0, Math.min(1, value));
const angleDelta = (from, to) => ((to - from + 1.5 * TAU) % TAU) - Math.PI;
const normalizedHeading = heading => (heading + TAU) % TAU;
const smooth = fraction => fraction * fraction * (3 - 2 * fraction);

export function fuelRate(throttle, afterburner) {
  if (afterburner) return 1 / 80;
  if (throttle <= 0.55) return 1 / 800 + (1 / 240 - 1 / 800) * throttle / 0.55;
  return 1 / 240 + (1 / 150 - 1 / 240) * (throttle - 0.55) / 0.45;
}

export function stepFuel(flight, dt) {
  const rate = fuelRate(flight.throttle, flight.afterburner);
  flight.fuel = Math.max(0, flight.fuel - rate * dt);
  flight.fuelSeconds = flight.fuel / rate;
  if (flight.fuel === 0) flight.afterburner = false;
}

export function captureApproach(aircraft, scale) {
  const { flight, team } = aircraft;
  const field = AIRFIELDS[team];
  const x = (flight.x - field.x) / scale;
  const z = (flight.z - field.z) / scale;
  const heading = normalizedHeading(field.heading + (Math.cos(flight.heading - field.heading) < 0 ? Math.PI : 0));
  if (Math.abs(angleDelta(heading, flight.heading)) > RUNWAY.approachAngle + 1e-9) return false;
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const along = x * fx + z * fz + RUNWAY.lengthM / 2;
  const cross = x * -fz + z * fx;
  if (along < -RUNWAY.approachLengthM || along >= 0 || Math.abs(cross) > RUNWAY.approachHalfWidthM) return false;

  aircraft.runway = {
    field, heading, along, entryAlong: along, entryCross: cross, entryAltitude: flight.altitudeM,
    entryHeading: angleDelta(heading, flight.heading)
  };
  flight.phase = 'approach';
  return true;
}

function followRunway(flight, runway, scale, cross = 0) {
  const length = (runway.along - RUNWAY.lengthM / 2) * scale;
  const lateral = cross * scale;
  const fx = Math.sin(runway.heading);
  const fz = -Math.cos(runway.heading);
  flight.x = runway.field.x + length * fx - lateral * fz;
  flight.z = runway.field.z + length * fz + lateral * fx;
}

function startService(aircraft) {
  const { runway, flight, originalStores, stores } = aircraft;
  runway.serviceElapsed = 0;
  runway.serviceFuel = flight.fuel;
  runway.missingStations = Object.keys(originalStores).filter(station => !Object.hasOwn(stores, station));
  runway.reloaded = 0;
  runway.parkedHeading = runway.heading;
  // Depart in the direction with more pavement ahead, from the same parking position.
  if (runway.along > RUNWAY.lengthM / 2) {
    runway.along = RUNWAY.lengthM - runway.along;
    runway.heading = normalizedHeading(runway.heading + Math.PI);
  }
  flight.phase = 'service';
  flight.serviceRemaining = RUNWAY.serviceSeconds;
}

function serviceAircraft(aircraft, dt) {
  const { runway, flight, stores, originalStores, rack, radarRack, activeRack } = aircraft;
  runway.serviceElapsed = Math.min(RUNWAY.serviceSeconds, runway.serviceElapsed + dt);
  if (RUNWAY.serviceSeconds - runway.serviceElapsed < 1e-9) runway.serviceElapsed = RUNWAY.serviceSeconds;
  const progress = runway.serviceElapsed / RUNWAY.serviceSeconds;
  flight.serviceRemaining = RUNWAY.serviceSeconds - runway.serviceElapsed;
  flight.fuel = runway.serviceFuel + (1 - runway.serviceFuel) * progress;
  flight.heading = flight.course = normalizedHeading(runway.parkedHeading
    + angleDelta(runway.parkedHeading, runway.heading) * smooth(clamp01(runway.serviceElapsed / 2)));
  const readyStations = Math.floor(progress * runway.missingStations.length);
  while (runway.reloaded < readyStations) {
    const station = runway.missingStations[runway.reloaded++];
    const weapon = originalStores[station];
    stores[station] = weapon;
    [rack, radarRack, activeRack].find(candidate => candidate?.type === weapon).ammo++;
  }
  if (progress === 1) {
    flight.damage = freshDamage(flight.airframe);
    aircraft.damageReport = null;
    aircraft.flareRack.ammo = aircraft.flareRack.capacity;
    aircraft.chaffRack.ammo = aircraft.chaffRack.capacity;
    flight.phase = 'ready';
  }
}

export function stepRunway(aircraft, controls, dt, scale, stepFlight) {
  const { flight, runway } = aircraft;
  switch (flight.phase) {
    case 'approach': {
      stepFlight(flight, controls?.throttle ?? -1, 0, dt, true);
      runway.along = Math.min(RUNWAY.touchdownM, runway.along + flight.speed / 3.6 * dt);
      const progress = clamp01((runway.along - runway.entryAlong) / (RUNWAY.touchdownM - runway.entryAlong));
      const align = 1 - smooth(clamp01(progress * 1.8));
      followRunway(flight, runway, scale, runway.entryCross * align);
      flight.heading = flight.course = normalizedHeading(runway.heading + runway.entryHeading * align);
      flight.altitudeM = runway.entryAltitude * (1 - progress);
      if (progress === 1) {
        flight.phase = 'rollout';
        flight.bank = flight.throttle = flight.enginePower = 0;
        flight.turnAcceleration = flight.liftUse = 0;
        flight.loadFactor = 1;
        flight.afterburner = false;
      }
      break;
    }
    case 'rollout': {
      const speed = flight.speed / 3.6;
      const timeBraking = Math.min(dt, speed / BRAKING);
      const nextSpeed = Math.max(0, speed - BRAKING * dt);
      const nextPosition = runway.along + (speed + nextSpeed) * 0.5 * timeBraking;
      runway.along = Math.min(RUNWAY.lengthM, nextPosition);
      followRunway(flight, runway, scale);
      flight.speed = nextSpeed * 3.6;
      if (nextPosition > RUNWAY.lengthM + 1e-6) return 'runway-overrun';
      if (!nextSpeed) {
        flight.airbrake = false;
        flight.airbrakeExtension = 0;
        startService(aircraft);
      }
      break;
    }
    case 'service':
      serviceAircraft(aircraft, dt);
      break;
    case 'ready':
      if (!controls || controls.commands.has('KeyW')) {
        flight.phase = 'takeoff';
        flight.throttle = flight.enginePower = 1;
      }
      break;
    case 'takeoff': {
      stepFuel(flight, dt);
      const speed = flight.speed / 3.6;
      const nextSpeed = Math.min(RUNWAY.takeoffKph / 3.6, speed + TAKEOFF_ACCELERATION * dt);
      runway.along += (speed + nextSpeed) * 0.5 * (nextSpeed - speed) / TAKEOFF_ACCELERATION;
      followRunway(flight, runway, scale);
      flight.speed = nextSpeed * 3.6;
      if (nextSpeed === RUNWAY.takeoffKph / 3.6) {
        flight.phase = 'climb';
        flight.altitudeM = 1;
        aircraft.runway = null;
      }
      break;
    }
  }
  return null;
}
