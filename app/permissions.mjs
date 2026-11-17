export function consent(turn, details, choose, hooks) {
  if (turn.stop || !hooks.isActive()) return { outcome: { outcome: 'cancelled' } };
  if (turn.approval === 'bypass' && turn.mode === 'code') {
    hooks.record(details, true, true);
    return choose(true);
  }
  return new Promise(resolvePermission => {
    turn.permissions.push({ details, choose, resolvePermission });
    hooks.changed();
  });
}
