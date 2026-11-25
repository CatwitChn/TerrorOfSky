export const PROTOCOL_VERSION = 5;

export const MISSIONS = {
  'dover-pvp': {
    id: 'dover-pvp', name: '多佛空战', mode: 'pvp', map: 'dover', playerLimit: 8, missileLimit: 4, timeLimit: 300,
    objective: '击败对方编队。时间结束时比较存活机数。',
  },
  'dover-intercept': {
    id: 'dover-intercept', name: '拦截战斗机', mode: 'pve', map: 'dover', playerLimit: 4, missileLimit: 4, timeLimit: 180,
    objective: '合作击败一波 AI 战斗机。敌机数与开局玩家数相同。',
  },
};

// Stations are selectable positions on the game's aircraft diagram.
function stationPair(id, label, x, z, ...weapons) {
  return [-1, 1].map(side => ({
    id: `${side < 0 ? 'left' : 'right'}-${id}`, label: `${side < 0 ? '左' : '右'}${label}`,
    x: x * side, z, weapons,
  }));
}

export const AIRFRAME_LOADOUTS = {
  f15: {
    name: 'F-15A', ir: 'AIM-9M', sarh: 'AIM-7M',
    stations: [
      ...stationPair('outer', '外翼架', 4.2, 3.6, 'AIM-9M'),
      ...stationPair('inner', '内翼架', 2.9, 1.6, 'AIM-9M'),
      ...stationPair('front', '前机腹架', 1.15, -1.05, 'AIM-7M'),
      ...stationPair('rear', '后机腹架', 1.15, 4.25, 'AIM-7M'),
    ],
  },
  su27: {
    name: 'Su-27', ir: 'R-73', sarh: 'R-27R',
    stations: [
      ...stationPair('tip', '翼尖架', 7.35, 4.25, 'R-73'),
      ...stationPair('outer', '外翼架', 4.8, 3.65, 'R-73'),
      ...stationPair('wing', '内翼架', 2.95, 1.85, 'R-27R'),
      ...stationPair('body', '机腹架', 1.15, 3.85, 'R-27R'),
    ],
  },
  f14d: {
    name: 'F-14D', ir: 'AIM-9M', sarh: 'AIM-7M', arh: 'AIM-54C',
    stations: [
      ...stationPair('outer', '翼根外侧架', 3.45, -.7, 'AIM-9M'),
      ...stationPair('glove', '翼根内侧架', 2.7, .85, 'AIM-7M', 'AIM-54C'),
      ...stationPair('front', '前机腹架', 1.05, 1.9, 'AIM-7M', 'AIM-54C'),
      ...stationPair('rear', '后机腹架', 1.05, 4.4, 'AIM-7M', 'AIM-54C'),
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
  return loadout;
}

export function validateLoadout(aircraft, loadout, limit) {
  if (!loadout || typeof loadout !== 'object' || Array.isArray(loadout)) return null;
  const { stations } = AIRFRAME_LOADOUTS[aircraft];
  const entries = Object.entries(loadout);
  if (!entries.length || entries.length > limit) return null;
  if (entries.some(([id, weapon]) => !stations.some(point => point.id === id && point.weapons.includes(weapon)))) return null;
  return Object.fromEntries(stations.filter(point => Object.hasOwn(loadout, point.id)).map(point => [point.id, loadout[point.id]]));
}
