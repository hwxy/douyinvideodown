import { inspectPage } from './extractor.js';
import { isDouyinPage, isMediaUrl, formatDuration, formatBytes, downloadError } from './lib.js';

const $ = id => document.getElementById(id);
let video = null;
let sourceTabId = null;
let activeDownloadId = null;
let pollTimer = null;
let detecting = false;
let startingDownload = false;
let detectionVersion = 0;

function setStatus(message, state = 'idle') {
  $('status').dataset.state = state;
  $('status-label').textContent = message;
  document.body.dataset.state = state;
}

function resetProgress() {
  clearInterval(pollTimer);
  pollTimer = null;
  activeDownloadId = null;
  $('progress-area').hidden = true;
  $('progress-fill').style.width = '0%';
}

function updateButtons() {
  $('download-btn').disabled = !video || detecting || startingDownload || activeDownloadId !== null;
  $('refresh-btn').disabled = detecting || startingDownload || activeDownloadId !== null;
  $('refresh-btn').setAttribute('aria-busy', String(detecting));
}

function showVideo(result) {
  video = result.video && isMediaUrl(result.video.url) ? result.video : null;
  $('video-card').dataset.ready = String(Boolean(video));
  $('video-title').textContent = video?.title || '打开一个抖音视频';
  const resolution = video?.width && video?.height ? `${video.width} × ${video.height}` : '原视频画质';
  $('video-meta').textContent = video
    ? `${resolution}  ·  ${formatDuration(video.duration)}  ·  MP4`
    : '在视频页面播放几秒，再点击重新识别。';
  $('download-btn').textContent = '下载 MP4';
  setStatus(video ? '已找到当前视频' : (result.reason || '暂未找到视频，请先播放几秒。'), video ? 'ready' : 'empty');
  updateButtons();
}

async function detect() {
  if (detecting || startingDownload || activeDownloadId !== null) return;
  const version = ++detectionVersion;
  detecting = true;
  video = null;
  sourceTabId = null;
  resetProgress();
  updateButtons();
  setStatus('正在识别当前页面…', 'loading');
  $('video-title').textContent = '让喜欢的片刻，留下来。';
  $('video-meta').textContent = '正在寻找当前播放的视频';
  $('video-card').dataset.ready = 'false';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isDouyinPage(tab.url)) {
      $('page-host').textContent = '等待打开抖音';
      showVideo({ reason: '请在抖音视频页面点击插件。' });
      return;
    }
    $('page-host').textContent = new URL(tab.url).hostname;
    sourceTabId = tab.id;
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: inspectPage
    });
    if (version !== detectionVersion) return;
    showVideo(result || { reason: '读取页面失败，请刷新视频页面后重试。' });
  } catch {
    showVideo({ reason: '暂时无法读取页面，请刷新抖音页面后再试。' });
    setStatus('暂时无法读取页面，请刷新抖音页面后再试。', 'error');
  } finally {
    detecting = false;
    updateButtons();
  }
}

async function checkDownload() {
  const id = activeDownloadId;
  if (id === null) return;
  try {
    const [item] = await chrome.downloads.search({ id });
    if (activeDownloadId !== id) return;
    if (!item) {
      finishDownload('下载记录已移除，可以重新下载。', 'empty');
      return;
    }
    $('progress-area').hidden = false;
    if (item.state === 'complete') {
      $('progress-fill').style.width = '100%';
      $('progress-text').textContent = `${formatBytes(Math.max(item.fileSize || 0, item.totalBytes || 0, item.bytesReceived || 0))} · 已保存`;
      $('download-btn').textContent = '再次下载';
      finishDownload('下载完成，可在下载记录中查看。', 'success');
    } else if (item.state === 'interrupted') {
      $('progress-text').textContent = '下载已停止';
      finishDownload(downloadError(item.error), item.error === 'USER_CANCELED' ? 'idle' : 'error');
    } else {
      const percent = item.totalBytes > 0 ? Math.min(99, Math.floor(item.bytesReceived / item.totalBytes * 100)) : 0;
      $('progress-fill').style.width = `${percent}%`;
      $('progress-text').textContent = item.totalBytes > 0
        ? `${formatBytes(item.bytesReceived)} / ${formatBytes(item.totalBytes)} · ${percent}%`
        : `${formatBytes(item.bytesReceived)} · 正在下载`;
      setStatus(item.paused ? '下载已暂停，请在下载记录中继续。' : '正在下载，关闭面板后也会继续。', 'downloading');
    }
  } catch {
    finishDownload('请打开下载记录查看下载状态。', 'idle');
  }
}

function finishDownload(message, state) {
  clearInterval(pollTimer);
  pollTimer = null;
  activeDownloadId = null;
  setStatus(message, state);
  updateButtons();
}

$('download-btn').addEventListener('click', async () => {
  if (!video || startingDownload || activeDownloadId !== null) return;
  startingDownload = true;
  resetProgress();
  updateButtons();
  setStatus('正在读取视频，请保持视频页打开…', 'loading');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_VIDEO', video, tabId: sourceTabId });
    if (!response?.ok || !Number.isInteger(response.id)) {
      setStatus(response?.error || '未能开始下载，请重新识别后再试。', 'error');
      return;
    }
    if (response.video) showVideo({ video: response.video });
    activeDownloadId = response.id;
    setStatus('下载已开始，关闭面板后也会继续。', 'downloading');
    await checkDownload();
    if (activeDownloadId !== null) pollTimer = setInterval(checkDownload, 750);
  } catch {
    setStatus('未能开始下载，请关闭插件面板后重试。', 'error');
  } finally {
    startingDownload = false;
    updateButtons();
  }
});

$('refresh-btn').addEventListener('click', detect);
$('downloads-btn').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://downloads/' }));
$('help-btn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('help.html') }));
chrome.downloads.onChanged.addListener(delta => {
  if (delta.id === activeDownloadId) void checkDownload();
});
window.addEventListener('unload', () => clearInterval(pollTimer));
void detect();
