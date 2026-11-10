import { isMediaUrl, isDouyinPage, makeFilename } from './lib.js';
import { inspectPage } from './extractor.js';
import { readVideoBlob } from './reader.js';

const localDownloads = new Map();
chrome.downloads.onChanged.addListener(delta => {
  if (!['complete', 'interrupted'].includes(delta.state?.current)) return;
  const entry = localDownloads.get(delta.id);
  if (!entry) return;
  localDownloads.delete(delta.id);
  chrome.scripting.executeScript({
    target: { tabId: entry.tabId },
    world: 'ISOLATED',
    func: url => URL.revokeObjectURL(url),
    args: [entry.url]
  }).catch(() => {});
});

// Read through the actual page, then give Chrome a local file to save. The
// browser never has to repeat the CDN request without its webpage context.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'DOWNLOAD_VIDEO') return;
  const shown = message.video;
  if (!shown || !isMediaUrl(shown.url) || !Number.isInteger(message.tabId)) {
    respond({ ok: false, error: '没有有效的抖音视频页，请关闭面板后重新识别。' });
    return;
  }
  (async () => {
    // Signed addresses are short lived. Read the actual player again when
    // Download is clicked, without silently switching to a different video.
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: message.tabId }, world: 'ISOLATED', func: inspectPage
    });
    const video = result?.video;
    if (!video || !isMediaUrl(video.url) || !isDouyinPage(result.pageUrl)) {
      respond({ ok: false, error: '请回到视频页播放几秒，再重新识别。' });
      return;
    }
    if (shown.videoId && video.videoId !== shown.videoId) {
      respond({ ok: false, error: '页面已切换到另一个视频，请重新识别。' });
      return;
    }
    const [{ result: local } = {}] = await chrome.scripting.executeScript({
      target: { tabId: message.tabId }, world: 'ISOLATED', func: readVideoBlob, args: [video.url]
    });
    const origin = new URL(result.pageUrl).origin;
    if (!local?.ok) {
      respond({ ok: false, error: local?.error || '未能读取视频，请播放几秒后重试。' });
      return;
    }
    if (typeof local.url !== 'string' || !local.url.startsWith(`blob:${origin}/`) ||
        !Number.isFinite(local.size) || local.size < 12 || local.size > 512 * 1024 * 1024 || local.type !== 'video/mp4') {
      respond({ ok: false, error: '读取的视频文件无效，请重新识别。' });
      return;
    }
    const id = await chrome.downloads.download({
      url: local.url,
      filename: makeFilename(video.title, video.videoId),
      conflictAction: 'uniquify',
      saveAs: true
    });
    localDownloads.set(id, { tabId: message.tabId, url: local.url });
    respond({ ok: true, id, video });
  })().catch(() => respond({ ok: false, error: '未能开始保存，请保持视频页打开并重试。若取消了保存窗口，可以再次下载。' }));
  return true;
});
