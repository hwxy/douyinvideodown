export function isDouyinPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'));
  } catch {
    return false;
  }
}

export function isMediaUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 16000) return false;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        (url.port && url.port !== '443')) return false;
    const host = url.hostname;
    if (['douyinvod.com', 'douyinvod.com.cn'].some(
      domain => host === domain || host.endsWith(`.${domain}`))) return true;
    return (host === 'douyin.com' || host.endsWith('.douyin.com') ||
      host === 'snssdk.com' || host.endsWith('.snssdk.com')) &&
      /^\/aweme\/v1\/play\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function makeFilename(title, videoId) {
  // Strip path separators, control characters and Windows-reserved characters.
  // Array.from truncates by Unicode code point, preserving surrogate pairs.
  let name = String(title || '抖音视频').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
  name = Array.from(name).slice(0, 70).join('').trim() || '抖音视频';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `视频_${name}`;
  const id = /^\d{8,24}$/.test(String(videoId)) ? `_${videoId}` : '';
  return `${name}${id}.mp4`;
}

export function formatDuration(value) {
  if (!Number.isFinite(value) || value <= 0) return '时长待识别';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function downloadError(reason) {
  if (reason === 'USER_CANCELED') return '下载已取消，可以再次点击下载。';
  if (reason === 'USER_SHUTDOWN') return '浏览器已停止下载，请重新下载。';
  if (/^SERVER_/.test(reason || '')) return '视频源暂时不可用，请回到视频页播放后重新识别。';
  if (/^NETWORK_/.test(reason || '')) return '网络中断，请检查网络后重试。';
  if (/^FILE_/.test(reason || '')) return '文件未能保存，请检查保存位置和磁盘空间。';
  return '下载未完成，请打开下载记录查看原因，或重新识别后重试。';
}
