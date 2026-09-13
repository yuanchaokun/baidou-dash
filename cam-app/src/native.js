/* Native bridge for the 白豆 Cam iOS shell.
 * Bundled to www/native.js and loaded before the web app. It only defines
 * window.BAIDOU_APP (API base) and window.BaidouNative (file saving, sharing);
 * the web app picks these up and otherwise behaves exactly like the website. */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { KeepAwake } from '@capacitor-community/keep-awake';

if (Capacitor.isNativePlatform()) {
  const platform = Capacitor.getPlatform();
  document.documentElement.dataset.native = platform;
  window.BAIDOU_APP = { api: 'https://baidou.cam', platform };

  // 3 MiB chunks keep base64 boundaries aligned (multiple of 3 bytes) and bound memory use.
  const CHUNK = 3 * 1024 * 1024;
  const toBase64 = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
  async function writeBlob(path, blob, directory) {
    let first = true;
    for (let offset = 0; first || offset < blob.size; offset += CHUNK) {
      const data = await toBase64(blob.slice(offset, Math.min(offset + CHUNK, blob.size)));
      if (first) { await Filesystem.writeFile({ path, data, directory, recursive: true }); first = false; }
      else await Filesystem.appendFile({ path, data, directory });
    }
  }

  // Replaces the browser File System Access adapter: everything lands in the app's
  // Documents folder, which the Files app shows as "白豆 Cam" (UIFileSharingEnabled).
  const folder = { name: navigator.language.startsWith('zh') ? '文件 › 白豆 Cam' : 'Files › Baidou Cam' };
  const fs = {
    ok: true,
    handle: folder,
    async load() {},
    async choose() { return true; },
    async clear() {},
    async permitted() { return true; },
    async write(name, blob) { await writeBlob(name, blob, Directory.Documents); },
    name() { return folder.name; }
  };

  // Share sheet: lets the user save to Photos, send to WeChat, AirDrop, etc.
  async function share(blob, name, title) {
    const path = 'share/' + name;
    try {
      await writeBlob(path, blob, Directory.Cache);
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      await Share.share({ title: title || name, files: [uri] });
    } catch (_) {
      // Cancelled share sheets reject; nothing to do.
    } finally {
      Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {});
    }
  }

  window.BaidouNative = { platform, fs, share };

  // Keep the screen on while the camera is live or a recording is running.
  let awake = false;
  const syncAwake = () => {
    const rec = document.getElementById('view-rec'), idle = document.querySelector('#view-rec .idle');
    const on = !!rec && (rec.classList.contains('recording') || !!(idle && idle.classList.contains('off')));
    if (on === awake) return;
    awake = on;
    (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => {});
  };
  new MutationObserver(syncAwake).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class'] });
}
