export function windowBoundsForState({
  collapsedPosition = null,
  collapsedSize,
  expandedSize,
  isExpanded,
  margin = 18,
  workArea,
}) {
  const defaultCollapsedPosition = {
    x: workArea.x + workArea.width - collapsedSize.width - margin,
    y: workArea.y + workArea.height - collapsedSize.height - margin,
  };
  const collapsed = clampPosition(
    collapsedPosition || defaultCollapsedPosition,
    collapsedSize,
    workArea,
  );
  const size = isExpanded ? expandedSize : collapsedSize;
  const position = isExpanded
    ? {
        x: collapsed.x + collapsedSize.width - expandedSize.width,
        y: collapsed.y + collapsedSize.height - expandedSize.height,
      }
    : collapsed;
  const clamped = clampPosition(position, size, workArea);
  return { ...clamped, width: size.width, height: size.height };
}

export function windowResizePolicyForState({
  collapsedSize,
  expandedMinSize,
  isExpanded,
  workArea,
}) {
  if (!isExpanded) {
    return {
      resizable: true,
      minWidth: collapsedSize.width,
      minHeight: collapsedSize.height,
      maxWidth: collapsedSize.width,
      maxHeight: collapsedSize.height,
    };
  }

  return {
    resizable: true,
    minWidth: Math.min(expandedMinSize.width, workArea.width),
    minHeight: Math.min(expandedMinSize.height, workArea.height),
    maxWidth: workArea.width,
    maxHeight: workArea.height,
  };
}

export function windowAlwaysOnTopForState({ isExpanded }) {
  return !isExpanded;
}

function clampPosition(position, size, workArea) {
  return {
    x: clamp(position.x, workArea.x, workArea.x + workArea.width - size.width),
    y: clamp(position.y, workArea.y, workArea.y + workArea.height - size.height),
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(Math.round(value), minimum), Math.max(minimum, maximum));
}
