const tau = 2 * Math.PI;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const decay = (time, seconds) => Math.exp(-time / seconds);
const attack = (time, seconds) => Math.min(1, time / seconds);
const wave = (frequency, time) => Math.sin(tau * frequency * time);

const effects = {
  cannon: {
    duration: .21, interval: .15, gain: .54,
    sample(time, { bass, mid, air }) {
      const shot = time % .021;
      const burst = decay(time, .12) * attack(.21 - time, .035);
      const crack = attack(shot, .0006) * decay(shot, .004);
      const punch = attack(shot, .001) * decay(shot, .012);
      return burst * (crack * (.62 * air + .24 * mid) + punch * (.37 * bass + .17 * wave(92, shot)));
    },
  },
  launch: {
    duration: 1.16, interval: .14, gain: .59,
    sample(time, { bass, mid, air }) {
      const ignition = attack(time, .004) * decay(time, .055);
      const exhaust = attack(time, .06) * decay(time, .32) * attack(1.16 - time, .12);
      return ignition * (.45 * bass + .35 * mid) +
        exhaust * (.55 * mid + .18 * air + .2 * bass) * (.89 + .11 * wave(19, time));
    },
  },
  explosion: {
    duration: 1.43, interval: .14, gain: .66,
    sample(time, { bass, mid, air }) {
      const shock = attack(time, .003) * decay(time, .036);
      const pressure = attack(time, .012) * decay(time, .17);
      const debris = attack(time, .07) * decay(time, .37) * attack(1.43 - time, .2);
      return shock * (.65 * mid + .34 * air) +
        pressure * (.81 * bass + .31 * wave(48 - 10 * time, time)) +
        debris * (.25 * mid + .23 * air) * (.72 + .28 * wave(27, time));
    },
  },
  countermeasure: {
    duration: .22, interval: .06, gain: .3,
    sample(time, { bass, mid, air }) {
      return attack(time, .003) * decay(time, .038) * (.5 * bass + .46 * mid + .25 * air);
    },
  },
  sonic: {
    duration: .54, interval: .3, gain: .41,
    sample(time, { bass, mid }) {
      const first = attack(time, .004) * decay(time, .042);
      const second = time > .085 ? attack(time - .085, .004) * decay(time - .085, .06) : 0;
      return (first + second * .72) * (.6 * bass + .43 * mid + .26 * wave(52, time));
    },
  },
};

const rwrTones = {
  'F-15A': [
    { pulses: [[0, .08, 605]], duration: .08, gain: .10, interval: 2.4 },
    { pulses: [[0, .19, 800], [.25, .19, 800]], duration: .44, gain: .15, interval: 1.32 },
    { pulses: [[0, .14, 1030], [.19, .17, 1280]], duration: .36, gain: .22, interval: .90 },
  ],
  'F-14D': [
    { pulses: [[0, .12, 485]], duration: .12, gain: .10, interval: 2.05 },
    { pulses: [[0, .23, 740]], duration: .23, gain: .16, interval: .96 },
    { pulses: [[0, .54, 980, 6]], duration: .54, gain: .22, interval: 1.03 },
  ],
  'Su-27': [
    { pulses: [[0, .13, 465]], duration: .13, gain: .10, interval: 1.46 },
    { pulses: [[0, .6, 970]], duration: .6, gain: .14, interval: .72 },
    { pulses: [[0, .15, 970], [.24, .15, 970]], duration: .39, gain: .21, interval: .56 },
  ],
};
const missileCalls = ['su27-missile-front', 'su27-missile-right', 'su27-missile-rear', 'su27-missile-left'];
export const cockpitVoiceFiles = [
  ...missileCalls, 'su27-low-fuel', 'su27-over-g', 'f15-over-g', 'f14-bingo',
].map(call => call + '.wav');

function makeBuffer(context, seconds, fill) {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = fill(i / context.sampleRate);
  return buffer;
}

function noiseGenerator(sampleRate) {
  const smoothing = hz => 1 - Math.exp(-tau * hz / sampleRate);
  const bassStep = smoothing(95), midStep = smoothing(1800);
  let low = 0, body = 0;
  const bands = {};
  return () => {
    const white = Math.random() * 2 - 1;
    low += (white - low) * bassStep;
    body += (white - body) * midStep;
    bands.bass = low * 5;
    bands.mid = (body - low) * 2;
    bands.air = white - body;
    return bands;
  };
}

function effectBuffer(context, profile) {
  const noise = noiseGenerator(context.sampleRate);
  return makeBuffer(context, profile.duration, time => profile.sample(time, noise()));
}

function toneBuffer(context, { duration, pulses }) {
  return makeBuffer(context, duration, time => {
    for (const [start, length, frequency, warble] of pulses) {
      const age = time - start;
      if (age < 0 || age >= length) continue;
      const envelope = attack(age, .007) * attack(length - age, .022);
      const phase = tau * frequency * age + (warble ? 21 * wave(warble, age) : 0);
      return envelope * (.7 * Math.sin(phase) + .18 * Math.sin(2 * phase) + .07 * Math.sin(3 * phase));
    }
    return 0;
  });
}

function engineLayer(context, mixer, filterType, length, sample) {
  const generator = noiseGenerator(context.sampleRate);
  const source = context.createBufferSource();
  source.buffer = makeBuffer(context, length, time => sample(generator(), time) * attack(time, .013) * attack(length - time, .013));
  source.loop = true;
  const filter = context.createBiquadFilter();
  filter.type = filterType;
  filter.Q.value = .58;
  const gain = context.createGain();
  gain.gain.value = 0;
  source.connect(filter).connect(gain).connect(mixer);
  source.start();
  return { source, filter, gain: gain.gain };
}

export function createBattleAudio() {
  let context, master, exterior, alerts, headset, engine, wind, lockTone;
  let active = false;
  let volume = .55;
  let audience, danger = 0, lowerAt, lastToneAt, lastMissileVoiceAt, speaking;
  let lockToneOn = false, overGWarned = false, fuelWarned = false;
  const samples = new Map();
  const tones = new Map();
  const voices = new Map();
  const lastPlayed = new Map();

  function isAudible() {
    return active && volume > 0 && context?.state === 'running';
  }

  function setHeadsetMix(speech) {
    const now = context.currentTime;
    exterior.gain.setTargetAtTime(speech ? .43 : 1, now, .045);
    alerts.gain.setTargetAtTime(speech ? .28 : 1, now, .035);
  }

  function stopVoice() {
    if (!speaking) return;
    speaking.source.stop(context.currentTime);
    speaking = null;
    setHeadsetMix(false);
  }

  function voice(call, priority) {
    const buffer = voices.get(call);
    if (!buffer || (speaking && speaking.priority >= priority)) return false;
    stopVoice();
    const source = context.createBufferSource();
    const channel = context.createGain();
    source.buffer = buffer;
    channel.gain.value = .60;
    source.connect(channel).connect(headset);
    setHeadsetMix(true);
    speaking = { source, priority };
    source.onended = () => {
      source.disconnect();
      channel.disconnect();
      if (speaking?.source !== source) return;
      speaking = null;
      setHeadsetMix(false);
    };
    source.start();
    return true;
  }

  function setSteadyLock(value) {
    if (value === lockToneOn) return;
    lockToneOn = value;
    lockTone.gain.setTargetAtTime(value ? .12 : 0, context.currentTime, .035);
  }

  function playSample(buffer, bus, gain, pan = 0) {
    const source = context.createBufferSource();
    const level = context.createGain();
    const stereo = context.createStereoPanner();
    source.buffer = buffer;
    level.gain.value = gain;
    stereo.pan.value = pan;
    source.connect(level).connect(stereo).connect(bus);
    source.onended = () => { source.disconnect(); level.disconnect(); stereo.disconnect(); };
    source.start();
  }

  function resetWarning() {
    danger = 0;
    lowerAt = null;
    fuelWarned = overGWarned = false;
    setSteadyLock(false);
    stopVoice();
  }

  function flightVoice(model, flight) {
    if (!flight) return;
    const overG = model === 'Su-27' ? 'su27-over-g' : model === 'F-15A' ? 'f15-over-g' : null;
    const gLimit = model === 'Su-27' ? 7 : 8;
    if (flight.loadFactor < gLimit - .6) overGWarned = false;
    if (overG && !overGWarned && flight.loadFactor >= gLimit && voice(overG, 2)) overGWarned = true;
    const fuel = model === 'Su-27' ? 'su27-low-fuel' : model === 'F-14D' ? 'f14-bingo' : null;
    const reserve = model === 'Su-27' ? .10 : .25;
    if (flight.fuel > reserve + .04) fuelWarned = false;
    if (fuel && !fuelWarned && flight.fuel <= reserve && voice(fuel, 1)) fuelWarned = true;
  }

  return {
    async start() {
      if (!context) {
        context = new AudioContext();
        master = context.createGain();
        exterior = context.createGain();
        alerts = context.createGain();
        headset = context.createBiquadFilter();
        headset.type = 'bandpass';
        headset.frequency.value = 1380;
        headset.Q.value = .68;
        lockTone = context.createGain();
        lockTone.gain.value = 0;
        lockTone.connect(alerts);
        const lockOscillator = context.createOscillator();
        lockOscillator.frequency.value = 970;
        lockOscillator.connect(lockTone);
        lockOscillator.start();
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -12;
        limiter.knee.value = 11;
        limiter.ratio.value = 5;
        limiter.attack.value = .004;
        limiter.release.value = .18;
        master.gain.value = active ? volume : 0;
        exterior.connect(limiter);
        alerts.connect(limiter);
        headset.connect(limiter);
        limiter.connect(master).connect(context.destination);
        engine = engineLayer(context, exterior, 'lowpass', 2.85, ({ bass, mid }, time) =>
          (bass * .75 + mid * .51) * (1 + .10 * wave(29, time)));
        wind = engineLayer(context, exterior, 'bandpass', 3.38, ({ mid, air }, time) =>
          (mid * .61 + air * .38) * (1 + .08 * wave(12, time)));
        for (const file of cockpitVoiceFiles) {
          fetch(new URL('./audio/' + file, import.meta.url)).then(response => {
            if (!response.ok) throw Error('HTTP ' + response.status);
            return response.arrayBuffer();
          }).then(data => context.decodeAudioData(data))
            .then(buffer => voices.set(file.slice(0, -4), buffer))
            .catch(error => console.warn('Could not load cockpit voice (' + file + '):', error));
        }
      }
      if (context.state !== 'running') await context.resume();
    },
    setActive(value) {
      if (active === value) return;
      active = value;
      if (!active) resetWarning();
      master?.gain.setTargetAtTime(active ? volume : 0, context.currentTime, .03);
    },
    setVolume(value) {
      volume = clamp(value, 0, 1);
      if (volume === 0) resetWarning();
      master?.gain.setTargetAtTime(active ? volume : 0, context.currentTime, .04);
    },
    engine(flight) {
      if (!active || !engine) return;
      const power = clamp((flight?.enginePower ?? 0) * (flight?.damage?.power ?? 1), 0, 1);
      const speed = clamp((flight?.speed ?? 0) / 1500, 0, 1.45);
      const boost = flight?.afterburner ? 1 : 0;
      const brake = flight?.airbrakeExtension ?? 0;
      const now = context.currentTime;
      engine.source.playbackRate.setTargetAtTime(.80 + .47 * power + .10 * boost, now, .14);
      engine.filter.frequency.setTargetAtTime(160 + 420 * power + 350 * boost, now, .14);
      engine.gain.setTargetAtTime(flight ? .55 * (.055 + .13 * power + .085 * boost) : 0, now, .15);
      wind.filter.frequency.setTargetAtTime(490 + 670 * speed + 250 * brake, now, .18);
      wind.gain.setTargetAtTime(flight ? .78 * (.18 * speed ** 1.7 + .07 * brake * speed) : 0, now, .18);
    },
    play(type, strength, pan = 0) {
      if (!isAudible() || strength <= 0) return;
      const profile = effects[type];
      const now = context.currentTime;
      if (now - (lastPlayed.get(type) ?? -Infinity) < profile.interval) return;
      lastPlayed.set(type, now);
      if (!samples.has(type)) samples.set(type, effectBuffer(context, profile));
      playSample(samples.get(type), exterior, clamp(strength, 0, 1) * profile.gain, pan);
    },
    warning(receiver, model, flight, level, missile, repeat = true) {
      if (!isAudible()) return;
      if (receiver !== audience) {
        resetWarning();
        audience = receiver;
      }
      const profile = rwrTones[model]?.[level - 1];
      const now = context.currentTime;
      if (level < danger) lowerAt ??= now + .30;
      else lowerAt = null;
      if (lowerAt !== null && now < lowerAt) return;
      if (level !== danger) {
        lastToneAt = lastMissileVoiceAt = -Infinity;
        danger = level;
      }
      const steady = model === 'Su-27' && danger === 2 && repeat;
      setSteadyLock(steady);
      if (profile && !steady && (repeat || lastToneAt === -Infinity) && now - lastToneAt >= profile.interval) {
        if (!tones.has(profile)) tones.set(profile, toneBuffer(context, profile));
        playSample(tones.get(profile), alerts, profile.gain);
        lastToneAt = now;
      }
      if (model === 'Su-27' && danger === 3 && (repeat || lastMissileVoiceAt === -Infinity)
          && missile?.range <= 15 && now - lastMissileVoiceAt >= 3.7) {
        const quadrant = Math.round(missile.angle / (Math.PI / 2) + 4) % 4;
        if (voice(missileCalls[quadrant], 3)) lastMissileVoiceAt = now;
      }
      if (danger < 3) flightVoice(model, flight);
    },
  };
}
