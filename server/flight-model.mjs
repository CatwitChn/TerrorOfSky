// Shared planar flight integration for the server and the pilot view.
const TAU = Math.PI * 2;
const MAX_BANK = 55 * Math.PI / 180;
const MAX_HEADING_LEAD = 20 * Math.PI / 180;
const COURSE_RESPONSE_SECONDS = 0.16;
const PILOT_COMFORT_G = 7;
export const PILOT_STRAIN_THRESHOLD = 0.5;
export const STEP = 1 / 120;
export const FLIGHT_ALTITUDE_M = 3000;
const TEMPERATURE_RATIO = 1 - 0.0065 * FLIGHT_ALTITUDE_M / 288.15;
// Standard-atmosphere density approximation for converting the airspeed limits.
export const TAS_PER_IAS = TEMPERATURE_RATIO ** -2.128;
const AIR_DENSITY = 1.225 / TAS_PER_IAS ** 2;
export const GRAVITY = 9.80665;
export const MACH_ONE_KPH = 340.3 * 3.6 * Math.sqrt(TEMPERATURE_RATIO);
export const TURN_REFERENCE_KPH = 700 * TAS_PER_IAS;
const MIN_LEVEL_SPEED_KPH = 300;
const THRUST_MULTIPLIER = 2;
const AFTERBURNER_SPOOL_MULTIPLIER = 0.3;
export const AIRBRAKE_REFERENCE_KPH = 700;
const AIRBRAKE_REFERENCE_DRAG_KN = 155;
const AIRBRAKE_MAX_DRAG_KN = 235;
const AIRBRAKE_TRAVEL_SECONDS = 0.32;
export const FLIGHT_SPEED_SCALE = 0.064;

export function stepFlight(flight, profile, throttleInput, turnInput, dt, burnFuel = false) {
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

export function sampleCurve(points, value, column = 1) {
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

export function engineThrustKn(profile, speedKph, power, afterburner) {
  const maxDryThrust = sampleCurve(profile.thrust, speedKph, 1);
  const dryThrust = maxDryThrust * sampleCurve(profile.dryThrottle, power);
  // Apply the afterburner gain while the dry engine continues to spool.
  const boostThrust = afterburner ? sampleCurve(profile.thrust, speedKph, 2) - maxDryThrust : 0;
  return THRUST_MULTIPLIER * (dryThrust + boostThrust);
}

export function levelDragKn(profile, speedKph, airbrakeExtension = 0) {
  const relativeSpeed = speedKph / profile.topSpeedKph;
  const transonic = Math.max(0, 1 - Math.abs(speedKph - MACH_ONE_KPH) / 220);
  const brakeDragKn = Math.min(AIRBRAKE_REFERENCE_DRAG_KN * (speedKph / AIRBRAKE_REFERENCE_KPH) ** 2, AIRBRAKE_MAX_DRAG_KN);
  return profile.dragAtTopKn * (relativeSpeed ** 2 + 0.16 * transonic ** 2) + brakeDragKn * airbrakeExtension;
}

export function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

export function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function lerp(start, end, fraction) {
  return start + (end - start) * fraction;
}

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

export function applyFlightAction(flight, action) {
  if (flight.phase !== 'airborne' && flight.phase !== 'approach' && flight.phase !== 'climb') return;
  if (action === 'KeyW' && flight.throttle === 1 && flight.fuel > 0 && flight.damage.power > .01) flight.afterburner = true;
  else if (action === 'KeyS') flight.afterburner = false;
  else if (action === 'KeyB') flight.airbrake = !flight.airbrake;
}
