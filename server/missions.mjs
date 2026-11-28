export const PROTOCOL_VERSION = 12;

export const MISSIONS = {
  'dover-pvp': {
    id: 'dover-pvp', name: '多佛空战', mode: 'pvp', map: 'dover', playerLimit: 8, timeLimit: 300,
    objective: '击败对方编队。时间结束时比较存活机数。',
  },
  'dover-intercept': {
    id: 'dover-intercept', name: '拦截战斗机', mode: 'pve', map: 'dover', playerLimit: 4, timeLimit: 180,
    objective: '合作击败一波 AI 战斗机。敌机数与开局玩家数相同。',
  },
  'dover-factory-defense': {
    id: 'dover-factory-defense', name: '工厂防御', mode: 'pve', map: 'dover', playerLimit: 4, timeLimit: 300,
    objective: '保卫肯特工厂。4 架护航战斗机在 4 架 B-52 前方开路。任一炸弹命中工厂即告失败。',
    factory: { name: '肯特工厂', x: -2540, z: -910 },
    raid: { bombers: 4, escorts: 4 },
  },
};

// Missile centers in the game's aircraft model coordinates: right, up and aft.
function stationPair(id, label, x, y, z, ...weapons) {
  return [-1, 1].map(side => ({
    id: `${side < 0 ? 'left' : 'right'}-${id}`, label: `${side < 0 ? '左' : '右'}${label}`,
    x: x * side, y, z, weapons,
  }));
}

export const AIRFRAME_LOADOUTS = {
  f15: {
    name: 'F-15A', ir: 'AIM-9M', sarh: 'AIM-7M', countermeasureCapacity: 180,
    stations: [
      ...stationPair('outer', '外翼架', 4.2, -.27, 2.25, 'AIM-9M'),
      ...stationPair('inner', '内翼架', 2.9, -.24, 1.2, 'AIM-9M'),
      ...stationPair('front', '前机腹架', 1.15, -.76, -1.05, 'AIM-7M'),
      ...stationPair('rear', '后机腹架', 1.15, -.82, 4.25, 'AIM-7M'),
    ],
  },
  su27: {
    name: 'Su-27', ir: 'R-73', sarh: 'R-27ER', countermeasureCapacity: 96,
    stations: [
      ...stationPair('tip', '翼尖架', 7.35, -.13, 4.25, 'R-73'),
      ...stationPair('outer', '外翼架', 4.8, -.25, 2.65, 'R-73'),
      ...stationPair('wing', '内翼架', 2.95, -.39, 1.85, 'R-27ER', 'R-73'),
      ...stationPair('body', '机腹架', 1.15, -1.39, 3.85, 'R-27ER'),
      { id: 'center-front', label: '中线前挂架', x: 0, y: -1.12, z: -.65, weapons: ['R-27ER'] },
      { id: 'center-rear', label: '中线后挂架', x: 0, y: -1.42, z: 5.65, weapons: ['R-27ER'] },
    ],
  },
  f14d: {
    name: 'F-14D', ir: 'AIM-9M', sarh: 'AIM-7M', arh: 'AIM-54C', countermeasureCapacity: 60,
    stations: [
      ...stationPair('outer', '翼根外侧架', 3.45, -.23, -.7, 'AIM-9M'),
      ...stationPair('glove', '翼根内侧架', 2.7, -.40, .85, 'AIM-7M', 'AIM-54C', 'AIM-9M'),
      ...stationPair('front', '前机腹架', 1.05, -1.20, 1.9, 'AIM-54C', 'AIM-7M'),
      ...stationPair('rear', '后机腹架', 1.05, -1.12, 4.4, 'AIM-7M', 'AIM-54C'),
    ],
  },
};

export function defaultLoadout(aircraft) {
  const { ir, sarh, arh, stations } = AIRFRAME_LOADOUTS[aircraft];
  const loadout = {};
  for (const weapon of [ir, ir, sarh, arh ?? sarh]) {
    const point = stations.find(candidate => !Object.hasOwn(loadout, candidate.id) && candidate.weapons.includes(weapon));
    loadout[point.id] = weapon;
  }
  for (const { id, weapons } of stations) {
    loadout[id] ??= weapons[0];
  }
  return loadout;
}

export function validateLoadout(aircraft, loadout) {
  if (!loadout || typeof loadout !== 'object' || Array.isArray(loadout)) return null;
  const { stations } = AIRFRAME_LOADOUTS[aircraft];
  const entries = Object.entries(loadout);
  if (!entries.length) return null;
  if (entries.some(([id, weapon]) => !stations.some(point => point.id === id && point.weapons.includes(weapon)))) return null;
  return Object.fromEntries(stations.filter(point => Object.hasOwn(loadout, point.id)).map(point => [point.id, loadout[point.id]]));
}

export function defaultCountermeasures(aircraft) {
  const { countermeasureCapacity } = AIRFRAME_LOADOUTS[aircraft];
  const flares = Math.ceil(countermeasureCapacity / 2);
  return { flares, chaff: countermeasureCapacity - flares };
}

export function validateCountermeasures(aircraft, allocation) {
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) return null;
  const { flares, chaff } = allocation;
  if (!Number.isInteger(flares) || !Number.isInteger(chaff) || flares < 0 || chaff < 0
      || flares + chaff !== AIRFRAME_LOADOUTS[aircraft].countermeasureCapacity) return null;
  return { flares, chaff };
}
