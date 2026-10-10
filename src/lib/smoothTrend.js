// Monotone Hermite interpolation preserves each sample and cannot overshoot a segment.
export function smoothTrendPath(points = []) {
  const segments = [];
  let segment = [];
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || (segment.length && point.x <= segment.at(-1).x)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) segment.push(point);
  }
  if (segment.length) segments.push(segment);
  return segments.map(monotoneSegment).join(" ");
}

function monotoneSegment(points) {
  const f = value => Number(value.toFixed(3));
  let path = `M ${f(points[0].x)} ${f(points[0].y)}`;
  const slopes = points.slice(1).map((point, i) => (point.y - points[i].y) / (point.x - points[i].x));
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0] || 0;
    if (i === points.length - 1) return slopes.at(-1) || 0;
    const a = slopes[i - 1], b = slopes[i];
    if (a * b <= 0) return 0;
    const left = points[i].x - points[i - 1].x, right = points[i + 1].x - points[i].x;
    const w1 = 2 * right + left, w2 = right + 2 * left;
    return (w1 + w2) / (w1 / a + w2 / b);
  });
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], h = (b.x - a.x) / 3;
    path += ` C ${f(a.x + h)} ${f(a.y + tangents[i - 1] * h)} ${f(b.x - h)} ${f(b.y - tangents[i] * h)} ${f(b.x)} ${f(b.y)}`;
  }
  return path;
}
