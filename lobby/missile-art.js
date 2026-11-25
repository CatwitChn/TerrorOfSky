// Top-down game art in the same meter-based model coordinates as the aircraft.
// Fins give the full span and one half-outline from root (0) to tip (1).
// The second coordinate of each point is the fraction of the length from nose to tail.
const models = {
  // U.S. Air Force AIM-9M art and Air Combat Command fact sheet.
  'AIM-9M': {
    length: 2.87, diameter: 0.127, noseColor: '#495a5c',
    nose: [[0, 0], [.008, .62], [.018, .89], [.033, 1], [.21, 1]],
    fins: [
      { span: .34, outline: [[0,.10],[.43,.145],[1,.237],[.88,.267],[.45,.241],[0,.242]] },
      { span: .56, outline: [[0,.754],[.86,.866],[1,.919],[.91,.971],[.58,.965],[0,.98]] },
    ],
    bands: [[.248, '#d0ad58'], [.643, '#8e6e53']],
  },
  // R-73E appearance from Rosoboronexport and U.S. Army ODIN.
  'R-73': {
    length: 2.90, diameter: 0.17, noseColor: '#596969',
    nose: [[0, 0], [.012, .57], [.025, .83], [.052, .96], [.087, 1], [.105, 1]],
    fins: [
      { span: .235, outline: [[0,.059],[.75,.069],[1,.087],[.9,.108],[0,.103]] },
      { span: .29, outline: [[0,.13],[.78,.159],[1,.193],[.72,.219],[0,.215]] },
      { span: .41, outline: [[0,.208],[.56,.232],[1,.285],[.86,.321],[0,.316]] },
      { span: .51, outline: [[0,.774],[.87,.841],[1,.879],[.92,.968],[.64,.971],[0,.976]] },
    ],
    bands: [[.119, '#89989a'], [.709, '#a2aeb0']],
  },
  // U.S. Air Force AIM-7F/M Sparrow art and fact sheet.
  'AIM-7M': {
    length: 3.64, diameter: 0.203, noseColor: '#d0d6ce',
    nose: [[0, 0], [.036, .43], [.077, .75], [.124, .94], [.164, 1], [.212, 1]],
    fins: [
      { span: 1.016, outline: [[0,.356],[.35,.405],[1,.552],[.93,.599],[0,.602]] },
      { span: .59, outline: [[0,.837],[.86,.883],[1,.924],[.88,.972],[0,.979]] },
    ],
    bands: [[.259, '#cea954'], [.714, '#8f7055']],
  },
  // Figures for the short-body R-27R1 exterior in the Rosoboronexport catalog.
  'R-27R': {
    length: 4.08, diameter: .23, noseColor: '#dbe0d7',
    nose: [[0, 0], [.038, .37], [.082, .72], [.124, .93], [.161, 1], [.199, 1]],
    fins: [
      { span: .37, outline: [[0,.201],[.76,.233],[1,.26],[.8,.29],[0,.286]] },
      { span: .972, outline: [[0,.405],[.39,.359],[.83,.342],[1,.359],[.96,.509],[.69,.547],[0,.59]] },
      { span: .774, outline: [[0,.805],[.59,.852],[1,.894],[.91,.966],[0,.975]] },
    ],
    bands: [[.304, '#a9b2af'], [.74, '#8b989b']],
  },
  // NAVAIR AIM-54C dimensions and U.S. Navy exterior photos.
  'AIM-54C': {
    length: 3.96, diameter: .38, noseColor: '#e3dfcc',
    nose: [[0, 0], [.035, .29], [.088, .58], [.146, .82], [.205, .97], [.233, 1], [.278, 1]],
    fins: [
      { span: .92, outline: [[0,.286],[.38,.368],[1,.691],[.96,.751],[0,.761]] },
      { span: .79, outline: [[0,.801],[.85,.859],[1,.893],[.93,.972],[0,.978]] },
    ],
    bands: [[.301, '#c7a154'], [.769, '#957557']],
  },
};

const drawings = new Map();

function mirroredContour(points) {
  const path = new Path2D();
  path.moveTo(...points[0]);
  for (const [x, z] of points.slice(1)) path.lineTo(x, z);
  for (const [x, z] of [...points].reverse()) path.lineTo(-x, z);
  path.closePath();
  return path;
}

export function getMissileArt(type) {
  if (drawings.has(type)) return drawings.get(type);
  const model = models[type];
  if (!model || !Object.hasOwn(models, type)) return null;
  const { length, diameter, nose, fins } = model;
  const radius = diameter / 2;
  const station = position => (position - .5) * length;
  const nosePoints = nose.map(([position, width]) => [width * radius, station(position)]);
  const bodyPoints = [...nosePoints.slice(-1), [radius, station(.975)], [radius * .87, station(1)]];
  const body = mirroredContour([...nosePoints.slice(0, -1), ...bodyPoints]);
  const radome = mirroredContour(nosePoints);
  const wings = new Path2D();
  const finPoints = fins.map(({ span, outline }) =>
    outline.map(([width, position]) => [width * span / 2, station(position)]));
  for (const points of finPoints) wings.addPath(mirroredContour(points));
  const art = { length, diameter, body, radome, wings, nosePoints, bodyPoints, finPoints, noseColor: model.noseColor,
    bands: model.bands.map(([position, color]) => [station(position), color]) };
  drawings.set(type, art);
  return art;
}

export function paintMissileArt(context, art, iconColor) {
  context.save();
  if (iconColor) {
    context.fillStyle = iconColor;
    context.fill(art.wings);
    context.fill(art.body);
    // Give the narrow shaft enough coverage when the HUD scales it below a pixel.
    context.lineJoin = 'round';
    context.strokeStyle = iconColor;
    context.lineWidth = .15;
    context.stroke(art.body);
  } else {
    const radius = art.diameter / 2;
    context.lineJoin = 'round';
    context.lineWidth = .046;
    context.strokeStyle = '#2b383c';
    context.fillStyle = '#a0adb0';
    context.stroke(art.wings);
    context.fill(art.wings);
    const metal = context.createLinearGradient(-radius, 0, radius, 0);
    metal.addColorStop(0, '#879698');
    metal.addColorStop(.34, '#f7f4df');
    metal.addColorStop(1, '#a2adab');
    context.stroke(art.body);
    context.fillStyle = metal;
    context.fill(art.body);
    context.fillStyle = art.noseColor;
    context.fill(art.radome);
    context.save();
    context.clip(art.body);
    for (const [z, color] of art.bands) {
      context.fillStyle = color;
      context.fillRect(-radius, z, art.diameter, .045);
    }
    context.restore();
  }
  context.restore();
}
