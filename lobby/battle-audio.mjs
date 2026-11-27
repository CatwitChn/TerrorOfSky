const EFFECTS = {
  cannon:    { seconds: .13, from: 130, to: 48, noise: .86, interval: .11 },
  launch:    { seconds: .4, from: 230, to: 55, noise: .79, interval: .06 },
  explosion: { seconds: .64, from: 85, to: 30, noise: .87, interval: .09 },
  lock:      { seconds: .19, from: 660, to: 660, noise: 0, interval: .19 },
  warning:   { seconds: .37, from: 1120, to: 790, noise: 0, interval: .28 },
};

function makeBuffer(context, seconds, fill) {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = fill(i / samples.length, i / context.sampleRate);
  return buffer;
}

export function createBattleAudio() {
  let context, master, engine, engineFilter, engineLevel;
  let active = false;
  let volume = .55;
  let previousWarning = 0;
  const samples = new Map();
  const lastPlayed = new Map();

  function setActive(value) {
    if (active === value) return;
    active = value;
    if (!active) previousWarning = 0;
    master?.gain.setTargetAtTime(active ? volume : 0, context.currentTime, .02);
  }

  return {
    async start() {
      if (!context) {
        context = new AudioContext();
        master = context.createGain();
        master.gain.value = 0;
        master.connect(context.destination);
        engine = context.createBufferSource();
        let rumble = 0;
        engine.buffer = makeBuffer(context, 2, () => {
          rumble = rumble * .975 + (Math.random() * 2 - 1) * .025;
          return rumble * 3;
        });
        engine.loop = true;
        engineFilter = context.createBiquadFilter();
        engineFilter.type = 'lowpass';
        engineLevel = context.createGain();
        engineLevel.gain.value = 0;
        engine.connect(engineFilter).connect(engineLevel).connect(master);
        engine.start();
      }
      await context.resume();
    },
    setActive,
    setVolume(value) {
      volume = Math.max(0, Math.min(1, value));
      if (active && master) master.gain.setTargetAtTime(volume, context.currentTime, .03);
    },
    engine(flight) {
      if (!active || !engine) return;
      const throttle = flight?.throttle ?? 0;
      const afterburner = flight?.afterburner ? .35 : 0;
      const now = context.currentTime;
      engine.playbackRate.setTargetAtTime(.65 + throttle * .55 + afterburner, now, .12);
      engineFilter.frequency.setTargetAtTime(180 + throttle * 350 + afterburner * 930, now, .12);
      engineLevel.gain.setTargetAtTime(flight ? .14 + throttle * .26 + afterburner : 0, now, .12);
    },
    play(type, strength = 1) {
      if (!active || !context || context.state !== 'running' || strength <= 0) return;
      const { seconds, from, to, noise, interval } = EFFECTS[type];
      const now = context.currentTime;
      if (now - (lastPlayed.get(type) ?? -Infinity) < interval) return;
      lastPlayed.set(type, now);
      if (!samples.has(type)) {
        let hiss = 0;
        samples.set(type, makeBuffer(context, seconds, (progress, time) => {
          const fade = Math.min(1, time / .007) * (1 - progress) ** (noise ? 2.4 : 1.2);
          hiss = .56 * hiss + .44 * (Math.random() * 2 - 1);
          const tone = Math.sin(2 * Math.PI * time * (from + (to - from) * progress / 2));
          const pulse = type === 'warning' && progress > .41 && progress < .57 ? .06 : 1;
          return fade * pulse * (hiss * noise + tone * (1 - noise));
        }));
      }
      const source = context.createBufferSource();
      source.buffer = samples.get(type);
      const level = context.createGain();
      level.gain.value = Math.min(1, strength) * (noise ? .66 : .25);
      source.connect(level).connect(master);
      source.onended = () => { source.disconnect(); level.disconnect(); };
      source.start();
    },
    warning(level) {
      if (!active || level === previousWarning) return;
      previousWarning = level;
      if (level >= 2) this.play(level === 3 ? 'warning' : 'lock');
    },
  };
}
