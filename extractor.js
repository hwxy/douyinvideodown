/**
 * Runs inside the active tab through chrome.scripting.executeScript.
 * Keep every dependency inside this function: Chrome serializes its source.
 */
export function inspectPage() {
  const pageUrl = String(location.href);
  const pageHost = String(location.hostname).toLowerCase();
  const isDouyin = pageHost === 'douyin.com' || pageHost.endsWith('.douyin.com');
  const title = String(document.title || '抖音视频')
    .replace(/\s*[-–—|]\s*抖音\s*$/u, '')
    .trim()
    .slice(0, 500) || '抖音视频';
  const idPattern = /^\d{10,24}$/;
  const page = new URL(pageUrl);
  const pathId = page.pathname.match(/\/video\/(\d{10,24})(?:\/|$)/)?.[1];
  const queryId = ['modal_id', 'vid', 'aweme_id', 'item_id']
    .map((key) => page.searchParams.get(key))
    .find((id) => idPattern.test(id || ''));
  const videoId = pathId || queryId || '';
  const result = { pageUrl, title, videoId, platform: 'douyin', video: null, reason: '' };

  if (!isDouyin || !['https:', 'http:'].includes(page.protocol)) {
    result.reason = '请在抖音视频页面使用此插件。';
    return result;
  }

  const number = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const targetInUrl = (url) => {
    for (const key of ['__vid', 'aweme_id', 'awemeId', 'item_id', 'vid']) {
      const value = url.searchParams.get(key);
      if (idPattern.test(value || '')) return value;
    }
    return '';
  };
  const address = (raw) => {
    if (typeof raw !== 'string' || raw.length > 16000 || !raw.trim()) return null;
    try {
      const url = new URL(raw.trim(), pageUrl);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
        return null;
      }
      const host = url.hostname.toLowerCase();
      const cdn = host === 'douyinvod.com' || host.endsWith('.douyinvod.com') ||
        host === 'douyinvod.com.cn' || host.endsWith('.douyinvod.com.cn');
      const play = /^\/aweme\/v1\/play\/?$/.test(url.pathname) && (
        host === 'douyin.com' || host.endsWith('.douyin.com') ||
        host === 'snssdk.com' || host.endsWith('.snssdk.com')
      );
      if (!cdn && !play) return null;
      const id = targetInUrl(url);
      if (videoId && id && id !== videoId) return null;
      return { url: url.href, id };
    } catch {
      return null;
    }
  };
  const poster = (raw) => {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 16000) return '';
    try {
      const url = new URL(raw, pageUrl);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch {
      return '';
    }
  };
  const makeVideo = (url, details, source) => ({
    url: url.url,
    title: String(details.title || title).slice(0, 500),
    videoId: videoId || url.id || '',
    width: Math.round(number(details.width)),
    height: Math.round(number(details.height)),
    duration: number(details.duration),
    poster: poster(details.poster),
    source,
  });

  const viewportWidth = number(window.innerWidth) || number(document.documentElement?.clientWidth) || 1920;
  const viewportHeight = number(window.innerHeight) || number(document.documentElement?.clientHeight) || 1080;
  const pageVideos = Array.from(document.querySelectorAll('video')).slice(0, 100);
  const videos = pageVideos
    .map((video, index) => {
      const rect = video.getBoundingClientRect();
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(video) : null;
      const hidden = style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0');
      const area = hidden ? 0 : Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)) *
        Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
      return { video, index, area, playing: !video.paused && !video.ended };
    })
    .filter((entry) => entry.area > 0)
    .sort((a, b) => Number(b.playing) - Number(a.playing) || b.area - a.area || a.index - b.index);

  for (const { video } of videos) {
    const candidates = [video.currentSrc, video.src,
      ...Array.from(video.querySelectorAll('source')).slice(0, 20).map((source) => source.src)];
    let currentId = '';
    try { currentId = targetInUrl(new URL(video.currentSrc, pageUrl)); } catch { /* Not a URL yet. */ }
    const staleVideo = videoId && currentId && currentId !== videoId;
    for (let index = 0; index < candidates.length; index += 1) {
      const url = address(candidates[index]);
      if (!url || (staleVideo && url.id !== videoId)) continue;
      result.video = makeVideo(url, {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        poster: video.poster,
      }, index === 0 ? 'currentSrc' : 'source');
      return result;
    }
  }

  // Douyin can render through a canvas while its active video element is
  // hidden. An exact video identity is sufficient even without a visible rect;
  // an untagged or differently tagged hidden preload is never selected.
  if (videoId) {
    for (const video of pageVideos) {
      const url = address(video.currentSrc);
      if (url?.id !== videoId) continue;
      result.video = makeVideo(url, {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        poster: video.poster,
      }, 'matchedCurrentSrc');
      return result;
    }
  }

  // SSR metadata is a fallback only for a specific video. A feed can contain
  // many preloaded recommendations that must never be mistaken for this video.
  if (videoId) {
    const roots = [];
    const addJson = (raw) => {
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 3000000) return;
      try { roots.push(JSON.parse(raw)); return; } catch { /* May be percent encoded. */ }
      try { roots.push(JSON.parse(decodeURIComponent(raw))); } catch { /* Ignore non-JSON scripts. */ }
    };
    addJson(document.getElementById('RENDER_DATA')?.textContent);
    // Page globals are not shared with an extension's ISOLATED world. The
    // script elements are shared, so read only their serialized JSON literal.
    // Never evaluate a script or a JavaScript expression from the page.
    const readLiteral = (text, start) => {
      const stack = [];
      const quotedRoot = text[start] === '"';
      if (!quotedRoot && !['{', '['].includes(text[start])) return null;
      let quoted = false;
      let escaped = false;
      for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') {
            quoted = false;
            if (quotedRoot) return { raw: text.slice(start, i + 1), end: i + 1 };
          }
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') {
          if (stack.pop() !== (char === '}' ? '{' : '[')) return null;
          if (!stack.length) return { raw: text.slice(start, i + 1), end: i + 1 };
        }
      }
      return null;
    };
    const skipSpace = (text, start) => {
      while (start < text.length && /\s/.test(text[start])) start += 1;
      return start;
    };
    let scriptBytes = 0;
    for (const script of Array.from(document.querySelectorAll('script:not([src])')).slice(0, 200)) {
      if (script.id === 'RENDER_DATA') continue;
      const text = script.textContent || '';
      scriptBytes += text.length;
      if (scriptBytes > 4000000) break;
      if (text.length > 3000000 || !text.includes('window._ROUTER_DATA')) continue;
      let assignments = 0;
      for (let i = 0; i < text.length && assignments < 4; i += 1) {
        // Skip JavaScript string literals and comments to avoid interpreting
        // a quoted example or commented assignment as actual page metadata.
        if (['"', "'", '`'].includes(text[i])) {
          const quote = text[i];
          for (i += 1; i < text.length; i += 1) {
            if (text[i] === '\\') i += 1;
            else if (text[i] === quote) break;
          }
          continue;
        }
        if (text[i] === '/' && text[i + 1] === '/') {
          const end = text.indexOf('\n', i + 2);
          i = end < 0 ? text.length : end;
          continue;
        }
        if (text[i] === '/' && text[i + 1] === '*') {
          const end = text.indexOf('*/', i + 2);
          i = end < 0 ? text.length : end + 1;
          continue;
        }
        const marker = 'window._ROUTER_DATA';
        if (!text.startsWith(marker, i) || (i && /[\w$.]/.test(text[i - 1]))) continue;
        let start = skipSpace(text, i + marker.length);
        if (text[start] !== '=' || ['=', '>'].includes(text[start + 1])) continue;
        assignments += 1;
        start = skipSpace(text, start + 1);
        if (text.startsWith('JSON.parse', start)) {
          start = skipSpace(text, start + 'JSON.parse'.length);
          if (text[start] !== '(') continue;
          start = skipSpace(text, start + 1);
          if (text[start] !== '"') continue;
          const literal = readLiteral(text, start);
          if (!literal || text[skipSpace(text, literal.end)] !== ')') continue;
          try { addJson(JSON.parse(literal.raw)); } catch { /* Only JSON string literals are accepted. */ }
          i = literal.end;
        } else {
          const literal = readLiteral(text, start);
          if (!literal) continue;
          addJson(literal.raw);
          i = literal.end - 1;
        }
      }
    }

    const metadata = [];
    const addressKeys = ['play_addr', 'playAddr', 'play_addr_h264', 'playAddrH264', 'download_addr', 'downloadAddr'];
    const urlsFrom = (value, depth = 0) => {
      if (depth > 5 || value == null) return [];
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) return value.slice(0, 30).flatMap((item) => urlsFrom(item, depth + 1));
      if (typeof value !== 'object') return [];
      return ['url_list', 'urlList', 'UrlList', 'url', 'src'].flatMap((key) => urlsFrom(value[key], depth + 1));
    };
    const firstPoster = (value) => urlsFrom(value).find((url) => poster(url)) || '';
    const visited = new WeakSet();
    const stack = roots.map((value) => ({ value, depth: 0, id: '', details: {} }));
    let count = 0;
    while (stack.length && count < 10000) {
      const { value, depth, id: inheritedId, details: inheritedDetails } = stack.pop();
      count += 1;
      if (!value || typeof value !== 'object' || depth > 20 || visited.has(value)) continue;
      visited.add(value);
      const ownId = ['aweme_id', 'awemeId', 'awemeID', 'item_id', 'itemId', 'group_id', 'groupId', 'video_id', 'videoId', 'id']
        .map((key) => value[key])
        .find((id) => typeof id === 'string' && idPattern.test(id));
      const id = ownId || inheritedId;
      const details = id === videoId ? {
        ...inheritedDetails,
        ...(typeof value.desc === 'string' ? { title: value.desc } : {}),
        ...(number(value.width) ? { width: value.width } : {}),
        ...(number(value.height) ? { height: value.height } : {}),
        ...(number(value.duration) ? { duration: number(value.duration) / (number(value.duration) > 1000 ? 1000 : 1) } : {}),
        ...(value.cover || value.origin_cover || value.originCover ? {
          poster: firstPoster(value.cover || value.origin_cover || value.originCover),
        } : {}),
      } : inheritedDetails;
      for (const key of addressKeys) {
        for (const raw of urlsFrom(value[key])) {
          const url = address(raw);
          if (!url || (id !== videoId && url.id !== videoId)) continue;
          const size = value[key] && typeof value[key] === 'object' ? value[key] : {};
          metadata.push({ url, details: {
            ...details,
            width: number(size.width) || details.width,
            height: number(size.height) || details.height,
          }, rank: key.startsWith('download') ? 1 : 0 });
        }
      }
      const entries = Object.entries(value).slice(0, 300);
      // Preserve the order of the page's preferred play addresses.
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, child] = entries[i];
        if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1, id, details });
      }
    }
    metadata.sort((a, b) => a.rank - b.rank ||
      number(b.details.width) * number(b.details.height) - number(a.details.width) * number(a.details.height));
    if (metadata.length) {
      result.video = makeVideo(metadata[0].url, metadata[0].details, 'metadata');
      return result;
    }

    // Performance entries can include old and prefetched videos. Only accept
    // a resource that explicitly identifies the requested video in its URL.
    try {
      const entries = performance.getEntriesByType('resource').slice(-500).reverse();
      for (const entry of entries) {
        const url = address(entry.name);
        if (url?.id === videoId) {
          result.video = makeVideo(url, {}, 'performance');
          return result;
        }
      }
    } catch { /* Resource timing may be unavailable. */ }
  }

  result.reason = '暂未找到可下载的视频地址。请先播放视频几秒，再点击重新识别。';
  return result;
}
