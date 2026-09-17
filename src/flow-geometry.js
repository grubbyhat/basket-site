// Samples the simple M/L/H/V/C rails used by the capital flow into points with cumulative lengths,
// so coins can be positioned along them without depending on SVG DOM measurement.
function tokenize(d) {
  const tokens = [];
  let number = '';
  const flush = () => { if (number) { tokens.push(Number(number)); number = ''; } };
  for (const char of d) {
    if (char === ' ' || char === ',') flush();
    else if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')) { flush(); tokens.push(char); }
    else number += char;
  }
  flush();
  return tokens;
}

export function samplePath(d, curveSteps = 48) {
  const tokens = tokenize(d);
  const points = [];
  let x = 0, y = 0, command = 'M', index = 0;
  const push = (nextX, nextY) => { points.push([nextX, nextY]); x = nextX; y = nextY; };
  while (index < tokens.length) {
    const token = tokens[index];
    if (typeof token === 'string') { command = token; index += 1; continue; }
    if (command === 'M' || command === 'L') { push(tokens[index], tokens[index + 1]); index += 2; command = 'L'; }
    else if (command === 'H') { push(token, y); index += 1; }
    else if (command === 'V') { push(x, token); index += 1; }
    else if (command === 'C') {
      const [x1, y1, x2, y2, x3, y3] = tokens.slice(index, index + 6);
      const startX = x, startY = y;
      for (let step = 1; step <= curveSteps; step += 1) {
        const t = step / curveSteps, u = 1 - t;
        push(u * u * u * startX + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * startY + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      index += 6;
    } else throw new Error(`Unsupported path command: ${command}`);
  }
  if (points.length < 2) throw new Error('A rail needs at least two points');
  const lengths = [0];
  for (let p = 1; p < points.length; p += 1) lengths.push(lengths[p - 1] + Math.hypot(points[p][0] - points[p - 1][0], points[p][1] - points[p - 1][1]));
  return { points, lengths, length: lengths[lengths.length - 1] };
}

// Position and unit tangent at a fraction (0..1) of the sampled rail: [x, y, dx, dy].
export function pointAt(route, fraction) {
  const target = Math.min(Math.max(fraction, 0), 1) * route.length;
  let low = 0, high = route.lengths.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (route.lengths[middle] <= target) low = middle; else high = middle;
  }
  const [ax, ay] = route.points[low], [bx, by] = route.points[high];
  const span = route.lengths[high] - route.lengths[low];
  const t = span ? (target - route.lengths[low]) / span : 0;
  const size = Math.hypot(bx - ax, by - ay) || 1;
  return [ax + (bx - ax) * t, ay + (by - ay) * t, (bx - ax) / size, (by - ay) / size];
}
