/** Runs in the video page. Keep this function self-contained for injection. */
export async function readVideoBlob(source) {
  const limit = 512 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const url = new URL(source);
    const host = url.hostname;
    const cdn = ['douyinvod.com', 'douyinvod.com.cn'].some(d => host === d || host.endsWith(`.${d}`));
    const play = (host === 'douyin.com' || host.endsWith('.douyin.com') || host.endsWith('.snssdk.com')) &&
      /^\/aweme\/v1\/play\/?$/.test(url.pathname);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || (!cdn && !play)) {
      return { ok: false, error: '没有有效的视频源，请重新识别。' };
    }
    // Use the playing page's normal fetch context and referrer. The native
    // downloader receives a local Blob, never the CDN URL that rejects it.
    const response = await fetch(url.href, { credentials: 'omit', signal: controller.signal });
    if (!response.ok) return { ok: false, error: `视频源返回 ${response.status}，请刷新视频页后再试。` };
    const length = Number(response.headers.get('content-length')) || 0;
    if (length > limit) {
      await response.body?.cancel();
      return { ok: false, error: '该视频超过 512 MB，暂不支持保存。' };
    }
    const range = response.headers.get('content-range');
    const match = range?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (response.status === 206 && (!match || Number(match[1]) !== 0 || Number(match[2]) + 1 !== Number(match[3]))) {
      await response.body?.cancel();
      return { ok: false, error: '视频源只返回了部分内容，请重新播放后再试。' };
    }
    const parts = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) {
            await reader.cancel();
            return { ok: false, error: '该视频超过 512 MB，暂不支持保存。' };
          }
          parts.push(value);
        }
      } finally { reader.releaseLock(); }
    } else {
      const data = await response.arrayBuffer();
      size = data.byteLength;
      if (size > limit) return { ok: false, error: '该视频超过 512 MB，暂不支持保存。' };
      parts.push(data);
    }
    if ((length && size !== length) || (match && size !== Number(match[3]))) {
      return { ok: false, error: '视频内容不完整，请重新播放后再试。' };
    }
    const blob = new Blob(parts, { type: 'video/mp4' });
    const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (prefix.length < 12 || String.fromCharCode(...prefix.slice(4, 8)) !== 'ftyp') {
      return { ok: false, error: '视频源没有返回完整的 MP4 文件，请刷新页面后重试。' };
    }
    const localUrl = URL.createObjectURL(blob);
    // The worker revokes it after completion; this also cleans up if its
    // lifetime ends before it receives the completion event.
    setTimeout(() => URL.revokeObjectURL(localUrl), 10 * 60 * 1000);
    return { ok: true, url: localUrl, size: blob.size, type: blob.type };
  } catch {
    return { ok: false, error: controller.signal.aborted
      ? '读取视频超时，请检查网络后再试。'
      : '未能读取视频，请保持视频页打开，播放几秒后重试。' };
  } finally {
    clearTimeout(timer);
  }
}
