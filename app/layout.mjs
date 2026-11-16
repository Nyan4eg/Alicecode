function width(value, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null;
}

export function normalizeLayout(value = {}) {
  return {
    sidebar: width(value?.sidebar, 150, 420),
    inspector: width(value?.inspector, 180, 720),
    inspectorVisible: value?.inspectorVisible !== false,
  };
}
