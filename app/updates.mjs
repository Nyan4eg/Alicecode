import { app } from 'electron';
import electronUpdater from 'electron-updater';

export function createUpdates(publish) {
  const enabled = app.isPackaged && process.platform === 'win32';
  const version = app.getVersion();
  let state = { enabled, version, phase: 'idle' };
  let checking;
  const { autoUpdater } = electronUpdater;

  function update(phase, fields = {}) {
    state = { enabled, version, phase, ...fields };
    publish(state);
  }

  function check() {
    if (!enabled || ['downloading', 'ready', 'installing'].includes(state.phase)) return;
    checking ??= autoUpdater.checkForUpdates().catch(reportError).finally(() => { checking = undefined; });
    return checking;
  }

  function reportError(error) {
    console.warn('Update failed:', error.message);
    update('error');
  }

  function start() {
    if (!enabled) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', () => update('checking'));
    autoUpdater.on('update-not-available', () => update('current'));
    autoUpdater.on('update-available', info => update('downloading', { nextVersion: info.version }));
    autoUpdater.on('download-progress', info => update('downloading', {
      nextVersion: state.nextVersion, percent: Math.floor(info.percent),
    }));
    autoUpdater.on('update-downloaded', info => update('ready', { nextVersion: info.version }));
    autoUpdater.on('error', reportError);
    setTimeout(check, 2000).unref();
    setInterval(check, 4 * 60 * 60 * 1000).unref();
  }

  function install() {
    if (state.phase !== 'ready') return;
    update('installing', { nextVersion: state.nextVersion });
    autoUpdater.quitAndInstall(true, true);
  }

  return { snapshot: () => state, start, check, install };
}
