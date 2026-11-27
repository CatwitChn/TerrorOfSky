import { AIRFIELDS, RUNWAY } from './airfields.mjs';
import { applyFlightAction, FLIGHT_ALTITUDE_M, FLIGHT_SPEED_SCALE } from './flight-model.mjs';
import { freshDamage } from './combat.mjs';

const unitsPerKm = FLIGHT_SPEED_SCALE * 3600;
const axisInputs = { KeyW: [1, 0], KeyS: [-1, 0], KeyA: [0, -1], KeyD: [0, 1] };
const tutorialActions = new Set(['look', 'follow', 'skip', 'continue']);
const feedbackHold = 1.6;
const impactHold = .58;
const percent = value => Math.round(value * 100) + '%';
const heading = p => String(Math.round(p.flight.heading * 180 / Math.PI) % 360).padStart(3, '0') + '°';

const steps = [
  { id: 'throttle-up', title: '加油门', detail: '按住 W，观察左下角油门杆上升。', key: 'KeyW', hold: true, seconds: .32, result: p => `油门已增加至 ${percent(p.flight.throttle)}。` },
  { id: 'throttle-down', title: '收油门', detail: '按住 S，让油门杆往下走。', key: 'KeyS', hold: true, seconds: .32, result: p => `油门已降至 ${percent(p.flight.throttle)}。` },
  { id: 'turn-left', title: '左转', detail: '按住 A，观察机体左倾和航向变化。', key: 'KeyA', hold: true, seconds: .38, result: p => `已左转，航向 ${heading(p)}。` },
  { id: 'turn-right', title: '右转', detail: '按住 D，把飞机向右转。', key: 'KeyD', hold: true, seconds: .38, result: p => `已右转，航向 ${heading(p)}。` },
  { id: 'brake-on', title: '打开减速板', detail: '按 B，观察飞机上的减速板和状态提示。', key: 'KeyB', test: p => p.flight.airbrakeExtension >= .99, result: () => '减速板已完全展开。' },
  { id: 'brake-off', title: '收回减速板', detail: '再按 B 收回减速板。', key: 'KeyB', test: p => p.flight.airbrakeExtension <= .01, result: () => '减速板已收回。' },
  { id: 'full-throttle', title: '推到满油门', detail: '按住 W，直到油门显示 100%。', key: 'KeyW', hold: true, test: p => p.flight.throttle === 1, result: () => '油门已达到 100%。' },
  { id: 'boost', title: '开启加力', detail: '松开 W 后再按一次，观察尾焰和「加力」提示。', key: 'KeyW', seconds: .55, result: () => '加力已开启，尾焰已拉长。' },
  { id: 'look', title: '看向机外', detail: '按住鼠标右键，把光标移离屏幕中心，改变观察方向。', camera: true, result: () => '视角已移动，松开右键即可回中。' },
  { id: 'cannon', title: '航炮命中', detail: '前方有一个练习目标。按 F 发射，观察弹迹和命中结果。', key: 'KeyF', weapon: 'cannon' },
  { id: 'radar-mode', title: '切换雷达模式', detail: '按 G 切到 PD。右侧雷达会扫出两个练习目标。', key: 'KeyG', seconds: 2, result: p => `已切到 PD，雷达收到 ${p.radar.echoes.size} 个回波。` },
  { id: 'radar-select', title: '换选雷达目标', detail: '按 Y，把雷达上的选中框移到另一个目标。', key: 'KeyY', result: () => '已选中另一个练习目标。' },
  { id: 'radar-lock', title: '硬锁目标', detail: '按 T，等右侧雷达显示「硬锁」。', key: 'KeyT', test: p => Boolean(p.radar.target), result: () => '雷达已硬锁。' },
  { id: 'radar-weapon', title: '选择雷达弹', detail: '按 Q，选中 AIM-7M 半主动雷达弹。', key: 'KeyQ', test: p => p.weapon === 'sarh', result: p => `已选中 ${p.radarRack.type}，剩余 ${p.radarRack.ammo} 枚。` },
  { id: 'radar-fire', title: '发射雷达弹', detail: '按空格发射 AIM-7M。', key: 'Space', weapon: 'radar' },
  { id: 'follow', title: '跟随导弹至命中', detail: '按住 U 跟弹。观察导弹飞行，等到目标受到毁伤或导弹飞偏。', camera: true, weapon: 'follow' },
  { id: 'chaff', title: '释放箔条', detail: '左侧 RWR 显示雷达威胁。按 C 释放箔条，查看剩余数量。', key: 'KeyC', seconds: .3, result: p => `箔条已释放，剩余 ${p.chaffRack.ammo} 组。` },
  { id: 'flare', title: '释放热诱弹', detail: '按 X 释放热诱弹，查看剩余数量。', key: 'KeyX', seconds: .3, result: p => `热诱弹已释放，剩余 ${p.flareRack.ammo} 枚。` },
  { id: 'ir-weapon', title: '切回红外弹', detail: '按 Q，选中 AIM-9M 红外弹。', key: 'KeyQ', test: p => p.weapon === 'ir', result: p => `已选中 ${p.rack.type}，剩余 ${p.rack.ammo} 枚。` },
  { id: 'ir-arm', title: '引导红外弹', detail: '按空格开启导引头，机头正对近处目标时会锁定。', key: 'Space', seconds: .55, test: p => Boolean(p.rack.target), result: () => '红外导引头已捕获目标。' },
  { id: 'ir-fire', title: '红外弹命中', detail: '再按一次空格发射。可以按住 U 查看命中过程。', key: 'Space', weapon: 'ir' },
  { id: 'landing', title: '进近和补给', detail: '己方跑道已在前方。按 B 减速，飞机会自动对正、落地并补给。', key: 'KeyB', test: p => p.flight.phase === 'ready', result: p => `已停稳并补给，燃油 ${percent(p.flight.fuel)}。` },
  { id: 'takeoff', title: '补给后起飞', detail: '按 W 开始滑跑，离地爬升后恢复操控。', key: 'KeyW', test: p => p.flight.phase === 'airborne', result: p => `已爬升至 ${Math.round(p.flight.altitudeM)} 米，可以正常飞行。` },
];

export function createTutorial() {
  return { index: 0, elapsed: 0, running: false, cameraAction: null, skipped: false, feedback: null };
}

export function tutorialActive(battle) {
  const lesson = battle.tutorial;
  return lesson && !lesson.skipped && lesson.index < steps.length;
}

export function tutorialReadout(battle) {
  const lesson = battle.tutorial;
  if (!lesson) return undefined;
  const step = steps[lesson.index];
  if (!step || lesson.skipped) return { id: 'complete', skipped: lesson.skipped };
  const { feedback, running } = lesson;
  const projectile = running && (step.weapon === 'cannon' ? 'cannon' :
    (step.weapon === 'follow' || step.weapon === 'ir') && lesson.shot?.launched ? 'missile' : null);
  return { id: step.id, index: lesson.index + 1, total: steps.length, title: step.title, detail: step.detail,
    waiting: !running && !feedback, projectile, feedback };
}

export function acceptTutorialAction(battle, action, player) {
  const lesson = battle.tutorial;
  if (!lesson || !tutorialActions.has(action)) return;
  if (action === 'skip') lesson.skipped = true;
  else if (action === 'continue' && lesson.feedback?.confirm) lesson.continue = true;
  else if (steps[lesson.index]?.id === action
      && (action !== 'follow' || battle.missiles.some(missile => missile.id === lesson.shot?.id && missile.source === player))) {
    lesson.cameraAction = action;
  }
}

function positionFlight(plane, x, z, heading, speed, throttle, altitudeM = FLIGHT_ALTITUDE_M) {
  Object.assign(plane.flight, { x, z, heading, course: heading, speed, throttle, enginePower: throttle,
    altitudeM, bank: 0, airbrake: false, airbrakeExtension: 0, afterburner: false });
  Object.assign(plane.previous, plane.flight);
}

function stageTargets(battle, player, drill) {
  const x = 0, z = 1200;
  positionFlight(player, x, z, 0, 695, .55);
  for (const [index, drone] of battle.aircraft.filter(aircraft => aircraft !== player).entries()) {
    const closeTarget = index === 0 && drill !== 'radar';
    const range = closeTarget ? drill === 'cannon' ? .37 : 1.45 : 5 + index * 2;
    const offset = closeTarget ? 0 : (index === 0 ? -1 : 1) * .7 * unitsPerKm;
    positionFlight(drone, x + offset, z - range * unitsPerKm, Math.PI, 650, .55);
    drone.flight.damage = freshDamage(drone.flight.airframe);
    drone.damageReport = null;
    drone.destroyedAt = null;
  }
  battle.missiles.length = 0;
  battle.cannonRounds.length = 0;
  Object.assign(player.radar, { target: null, pending: null, selected: null, progress: 0 });
  player.radar.echoes.clear();
  Object.assign(player.rack, { armed: false, lock: 0, target: null });
  if (drill === 'radar') {
    player.weapon = 'ir';
    player.radar.mode = 'src';
  }
}

function beginStep(battle, player, index) {
  const lesson = battle.tutorial;
  Object.assign(lesson, { index, running: false, elapsed: 0, cameraAction: null, feedback: null,
    feedbackRemaining: 0, continue: false, retry: null });
  const next = steps[index]?.id;
  if (next !== 'follow') lesson.shot = null;
  if (next === 'cannon') stageTargets(battle, player, 'cannon');
  if (next === 'radar-mode') stageTargets(battle, player, 'radar');
  if (next === 'ir-weapon' || next === 'ir-arm') stageTargets(battle, player, 'ir');
  if (next === 'landing') {
    battle.missiles.length = 0;
    const field = AIRFIELDS[player.team];
    const approach = (RUNWAY.lengthM / 2 + 180) * unitsPerKm / 1000;
    positionFlight(player, field.x - Math.sin(field.heading) * approach,
      field.z + Math.cos(field.heading) * approach, field.heading, 315, .12, 620);
  }
}

function showFeedback(lesson, text, kind = 'ok', retry = null) {
  lesson.feedback = { text, kind, confirm: kind !== 'ok' };
  lesson.feedbackRemaining = feedbackHold;
  lesson.retry = retry;
}

function finishFeedback(battle, player, dt) {
  const lesson = battle.tutorial;
  if (lesson.feedback.confirm ? !lesson.continue : (lesson.feedbackRemaining -= dt) > 1e-8) return;
  if (!lesson.retry) {
    beginStep(battle, player, lesson.index + 1);
    return;
  }
  if (lesson.retry === 'cannon') player.cannonRack.ammo = lesson.cannonAmmo;
  else if (lesson.shot) {
    lesson.shot.rack.ammo = lesson.shot.ammo;
    player.stores = lesson.shot.stores;
  }
  beginStep(battle, player, steps.findIndex(step => step.id === lesson.retry));
}

function checkWeaponResult(battle, player, weapon) {
  const lesson = battle.tutorial;
  if (weapon === 'cannon') {
    const target = battle.aircraft.find(aircraft => aircraft.damageReport?.cause === 'cannon');
    if (target && lesson.elapsed >= .68) {
      const result = target.destroyedAt === null
        ? `目标机体受损，完整度 ${percent(target.flight.damage.structure)}。`
        : '练习目标已击毁。';
      showFeedback(lesson, '航炮命中。' + result, 'hit');
    } else if (!target && lesson.elapsed >= 1.55) {
      showFeedback(lesson, '炮弹未命中目标。可以重新试射。', 'retry', 'cannon');
    }
    return;
  }

  const shot = lesson.shot;
  const missile = battle.missiles.find(item => item.id === shot.id);
  const ended = battle.endedMissiles.find(item => item.id === shot.id);
  shot.launched ||= Boolean(missile || ended);
  const retry = weapon === 'ir' ? 'ir-arm' : 'radar-mode';
  if (!shot.launched && lesson.elapsed >= 1.2) {
    showFeedback(lesson, `${shot.rack.type} 未能发射。请重新建立锁定。`, 'retry', retry);
  } else if (weapon === 'radar' && shot.launched) {
    showFeedback(lesson, `${shot.rack.type} 已发射，剩余 ${shot.rack.ammo} 枚。下一步跟随导弹查看结果。`);
  } else if (ended && battle.time - ended.endedAt >= impactHold) {
    const effect = ended.targetEffect;
    if (!effect) {
      const outcome = ended.endStatus === '导弹自爆' ? '已自爆，未损伤锁定目标。' : '未损伤锁定目标。';
      showFeedback(lesson, ended.type + ' ' + outcome + '可以重新试射。', 'retry', retry);
      return;
    }
    const impact = effect.direct ? '直接命中' : '近炸';
    const damage = effect.destroyed ? '目标已击毁' : `目标${effect.part}受损`;
    showFeedback(lesson, `${ended.type} ${impact}，${damage}。`, 'hit');
  }
}

export function stepTutorial(battle, controlsFor, dt, simulate) {
  const player = battle.aircraft.find(aircraft => controlsFor(aircraft));
  if (!player) return;
  const controls = controlsFor(player);
  const lesson = battle.tutorial;
  const step = steps[lesson.index];
  if (lesson.feedback) {
    finishFeedback(battle, player, dt);
    return;
  }
  const [throttle, turn] = axisInputs[step.key] ?? [0, 0];
  const pressed = controls.commands.has(step.key);
  const held = step.hold && (throttle ? controls.throttle === throttle : controls.turn === turn);
  const entered = step.camera ? lesson.cameraAction === step.id : step.hold ? held : pressed;
  if ((!lesson.running && !entered) || (step.hold && !held)) {
    lesson.running = false;
    return;
  }
  const firstTick = !lesson.running && lesson.elapsed === 0;
  if (firstTick) {
    if (step.weapon === 'cannon') lesson.cannonAmmo = player.cannonRack.ammo;
    if (step.weapon === 'radar' || step.weapon === 'ir') {
      const rack = step.weapon === 'radar' ? player.radarRack : player.rack;
      lesson.shot = { id: battle.nextMissileId, rack, ammo: rack.ammo, stores: { ...player.stores }, launched: false };
    }
  }
  lesson.running = true;
  lesson.elapsed += dt;
  const commands = firstTick && step.key && !step.hold ? new Set([step.key]) : new Set();
  for (const action of commands) applyFlightAction(player.flight, action);
  const input = { commands, throttle: step.hold ? throttle : 0, turn: step.hold ? turn : 0,
    fireCannon: step.weapon === 'cannon' && lesson.elapsed < .24 && controls.fireCannon };
  simulate(battle, aircraft => aircraft === player ? input : undefined, dt);
  if (step.weapon) checkWeaponResult(battle, player, step.weapon);
  else if (lesson.elapsed + 1e-8 >= (step.seconds ?? 0) && (!step.test || step.test(player, battle))) {
    showFeedback(lesson, step.result(player, battle));
  }
}
