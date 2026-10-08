const EDGE_CURVES = { handoff: 4, assist: -5, context: 5, parallel: -4 };
const GROUP_NODE_WIDTH = 126;
const GROUP_NODE_HEIGHT = 105;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function assignGroupMemberCanvasPositions(members = [], manualPositions = {}, { canvasWidth = 1000, canvasHeight = 600 } = {}) {
  const positions = {};
  const occupied = [];
  const safeWidth = Math.max(1, canvasWidth);
  const safeHeight = Math.max(1, canvasHeight);
  const isPoint = (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y);
  const collides = (point) => occupied.some((other) => {
    // Canvas coordinates and node dimensions share the same zoom transform,
    // so collision testing in the unscaled coordinate system is exact.
    const horizontalGap = Math.abs(point.x - other.x) * safeWidth / 100;
    const verticalGap = Math.abs(point.y - other.y) * safeHeight / 100;
    return horizontalGap < GROUP_NODE_WIDTH && verticalGap < GROUP_NODE_HEIGHT;
  });

  // Preserve free dragged positions, then place remaining members into the
  // nearest unoccupied natural slot.
  for (const member of members) {
    const point = manualPositions[member.id];
    if (!isPoint(point) || collides(point)) continue;
    positions[member.id] = point;
    occupied.push(point);
  }

  const unplaced = members.filter((member) => !positions[member.id]);
  const canvasArea = safeWidth * safeHeight;
  const spacing = Math.sqrt((GROUP_NODE_WIDTH * GROUP_NODE_HEIGHT * 2.5) / canvasArea) * 100;
  let candidateIndex = 0;
  for (const member of unplaced) {
    let point = null;
    while (!point) {
      const radius = spacing * Math.sqrt(candidateIndex + 1);
      const angle = candidateIndex * GOLDEN_ANGLE;
      candidateIndex += 1;
      const candidate = {
        x: 50 + Math.cos(angle) * radius * safeHeight / safeWidth,
        y: 50 + Math.sin(angle) * radius,
      };
      if (!collides(candidate)) { point = candidate; break; }
    }
    positions[member.id] = point;
    occupied.push(point);
  }
  return positions;
}

export function groupMemberCanvasPositionsOverlap(first, second, { canvasWidth = 1000, canvasHeight = 600 } = {}) {
  if (![first?.x, first?.y, second?.x, second?.y].every(Number.isFinite)) return false;
  return Math.abs(first.x - second.x) * Math.max(1, canvasWidth) / 100 < GROUP_NODE_WIDTH &&
    Math.abs(first.y - second.y) * Math.max(1, canvasHeight) / 100 < GROUP_NODE_HEIGHT;
}

export function createGroupPreviewEdgeGeometry(edge, positions) {
  const from = positions[edge.from];
  const to = positions[edge.to];
  if (!Number.isFinite(from?.x) || !Number.isFinite(from?.y) || !Number.isFinite(to?.x) || !Number.isFinite(to?.y)) return null;
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const distance = Math.hypot(deltaX, deltaY) || 1;
  let curve = EDGE_CURVES[edge.type] || 0;
  // If another node sits in the direct corridor, bend away from it so links do not cover avatars.
  for (const [id, point] of Object.entries(positions)) {
    if (id === edge.from || id === edge.to || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    const projection = ((point.x - from.x) * deltaX + (point.y - from.y) * deltaY) / (distance * distance);
    if (projection <= .12 || projection >= .88) continue;
    const cross = deltaX * (point.y - from.y) - deltaY * (point.x - from.x);
    const corridor = Math.abs(cross) / distance;
    if (corridor < 13) curve += (cross >= 0 ? -1 : 1) * (14 - corridor);
  }
  curve = Math.max(-22, Math.min(22, curve));
  const controlX = (from.x + to.x) / 2 + (-deltaY / distance) * curve;
  const controlY = (from.y + to.y) / 2 + (deltaX / distance) * curve;
  return { ...edge, d: `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`, labelX: (from.x + 2 * controlX + to.x) / 4, labelY: (from.y + 2 * controlY + to.y) / 4 };
}
