function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function renderWebControlHtml(csrfToken: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="qx-csrf-token" content="${escapeHtml(csrfToken)}">
  <title>QX 影视 Web 控制台</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar">
    <div>
      <p class="eyebrow">QX 影视</p>
      <h1>Web 控制台</h1>
    </div>
    <p id="connection-status" class="status">连接中…</p>
  </header>
  <nav class="tabs" aria-label="控制台页面">
    <button type="button" data-page="now">正在播放</button>
    <button type="button" data-page="search">搜索</button>
    <button type="button" data-page="live">直播</button>
    <button type="button" data-page="downloads">下载</button>
    <button type="button" data-page="cast">投屏</button>
    <button type="button" data-page="settings">安全状态</button>
  </nav>
  <main>
    <section data-section="now" class="panel">
      <div class="section-heading"><div><p class="eyebrow">Playback</p><h2>正在播放</h2></div><button type="button" data-action="refresh-now">刷新</button></div>
      <p id="now-title" class="hero-title">暂无播放</p>
      <p id="now-meta" class="muted">等待播放状态</p>
      <div class="progress"><span id="now-progress"></span></div>
      <div class="controls">
        <button type="button" data-action="pause">暂停</button>
        <button type="button" data-action="stop">停止</button>
        <label>跳转 <input id="seek-position" type="number" min="0" step="1" value="0"><button type="button" data-action="seek">执行</button></label>
        <label>音量 <input id="volume-value" type="range" min="0" max="1" step="0.05" value="1"><button type="button" data-action="volume">设置</button></label>
      </div>
    </section>
    <section data-section="search" class="panel" hidden>
      <div class="section-heading"><div><p class="eyebrow">Library</p><h2>搜索</h2></div></div>
      <form id="search-form" class="inline-form"><input id="search-query" type="search" maxlength="120" placeholder="输入片名"><button type="submit">搜索</button></form>
      <div id="search-results" class="rows"><p class="muted">输入关键词开始搜索。</p></div>
      <div id="detail-result" class="detail" hidden></div>
    </section>
    <section data-section="live" class="panel" hidden>
      <div class="section-heading"><div><p class="eyebrow">Live</p><h2>直播</h2></div><button type="button" data-action="refresh-live">刷新</button></div>
      <div id="live-results" class="rows"><p class="muted">正在读取频道。</p></div>
    </section>
    <section data-section="downloads" class="panel" hidden>
      <div class="section-heading"><div><p class="eyebrow">Downloads</p><h2>下载</h2></div><button type="button" data-action="refresh-downloads">刷新</button></div>
      <div id="download-results" class="rows"><p class="muted">正在读取下载状态。</p></div>
    </section>
    <section data-section="cast" class="panel" hidden>
      <div class="section-heading"><div><p class="eyebrow">Cast</p><h2>投屏</h2></div><button type="button" data-action="refresh-cast">刷新</button></div>
      <div id="cast-results" class="rows"><p class="muted">正在读取设备。</p></div>
    </section>
    <section data-section="settings" class="panel" hidden>
      <div class="section-heading"><div><p class="eyebrow">Safety</p><h2>安全状态</h2></div><button type="button" data-action="refresh-status">刷新</button></div>
      <dl id="safe-status" class="status-grid"><dt>读取中</dt><dd>—</dd></dl>
      <div class="security-card">
        <h3>PIN / LAN security</h3>
        <p id="lan-warning" class="warning">LAN control is disabled by default. Enabling it allows trusted devices on the same private network to reach this console; a PIN is required.</p>
        <dl id="web-security" class="status-grid"><dt>PIN</dt><dd>Loading</dd></dl>
        <div class="controls">
          <button type="button" data-action="regenerate-pin">Regenerate PIN</button>
          <label><input id="allow-lan" type="checkbox"> Allow LAN Control</label>
          <button type="button" data-action="save-lan">Save LAN setting</button>
        </div>
        <form id="pin-form" class="inline-form">
          <input id="pin-value" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit PIN">
          <label><input id="permission-read" type="checkbox" checked> Read</label>
          <label><input id="permission-control" type="checkbox"> Control</label>
          <label><input id="permission-push" type="checkbox"> Push</label>
          <button type="submit">Log in</button>
        </form>
        <p id="pin-message" class="muted"></p>
        <div id="web-sessions" class="rows"><p class="muted">No authorized sessions.</p></div>
        <button type="button" data-action="revoke-all-sessions">Revoke all sessions</button>
      </div>
    </section>
  </main>
  <script src="/app.js" defer></script>
</body>
</html>`;
}

export const WEB_CONTROL_STYLES = `
:root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #20242b; background: #f3f5f7; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
.topbar { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; padding: 28px clamp(18px, 5vw, 72px) 20px; background: #17212b; color: #f7fafc; }
h1, h2, p { margin: 0; }
h1 { font-size: clamp(1.4rem, 3vw, 2rem); letter-spacing: -.02em; }
h2 { font-size: 1.25rem; }
.eyebrow { color: #6f8191; font-size: .72rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.topbar .eyebrow { color: #a9bbc9; }
.status { color: #a9bbc9; font-size: .86rem; }
.tabs { display: flex; gap: 8px; overflow-x: auto; padding: 12px clamp(18px, 5vw, 72px); background: #fff; border-bottom: 1px solid #dfe5ea; }
button { min-height: 40px; padding: 8px 14px; border: 1px solid #c7d1da; border-radius: 8px; background: #fff; color: #20242b; cursor: pointer; font: inherit; }
button:hover, button:focus-visible { border-color: #336b8f; outline: 3px solid #c4e1f2; }
.tabs button[aria-current="page"] { background: #1f5e84; border-color: #1f5e84; color: #fff; }
main { width: min(980px, 100%); margin: 0 auto; padding: 24px clamp(18px, 5vw, 72px) 48px; }
.panel { padding: clamp(18px, 4vw, 30px); border: 1px solid #dfe5ea; border-radius: 14px; background: #fff; box-shadow: 0 10px 28px rgba(23, 33, 43, .06); }
.section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 22px; }
.hero-title { margin-top: 10px; font-size: clamp(1.5rem, 5vw, 2.5rem); font-weight: 700; }
.muted { color: #667582; }
.progress { height: 8px; margin: 24px 0; overflow: hidden; border-radius: 999px; background: #e6edf2; }
.progress span { display: block; height: 100%; width: 0; background: #4c8eae; transition: width .2s ease; }
.controls, .inline-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
label { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; }
input { min-height: 40px; max-width: 100%; padding: 8px 10px; border: 1px solid #c7d1da; border-radius: 8px; font: inherit; }
input[type="range"] { min-height: 0; padding: 0; }
.inline-form input { flex: 1 1 220px; }
.rows { display: grid; gap: 10px; margin-top: 18px; }
.row { display: flex; justify-content: space-between; gap: 14px; align-items: center; padding: 14px; border: 1px solid #e4e9ed; border-radius: 10px; }
.row-main { min-width: 0; }
.row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
.row-meta { margin-top: 4px; color: #667582; font-size: .86rem; }
.detail { margin-top: 24px; padding-top: 20px; border-top: 1px solid #e4e9ed; }
.detail h3 { margin: 0 0 8px; }
.episode-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.security-card { margin-top: 24px; padding-top: 20px; border-top: 1px solid #e4e9ed; }
.security-card h3 { margin: 0 0 8px; }
.warning { margin: 12px 0; padding: 12px; border-left: 4px solid #c98928; background: #fff7e6; color: #6a4a18; }
.security-card .rows { margin: 18px 0; }
.status-grid { display: grid; grid-template-columns: minmax(140px, .7fr) 1fr; gap: 0; margin: 0; }
.status-grid dt, .status-grid dd { margin: 0; padding: 12px 0; border-bottom: 1px solid #e4e9ed; }
.status-grid dt { color: #667582; }
.status-grid dd { overflow-wrap: anywhere; font-weight: 600; }
@media (max-width: 600px) { .topbar { padding-top: 20px; } .topbar, .section-heading { align-items: flex-start; flex-direction: column; } .row { align-items: flex-start; flex-direction: column; } .controls label { width: 100%; } }
`;

export const WEB_CONTROL_APP_JS = `
(() => {
  const csrf = document.querySelector('meta[name="qx-csrf-token"]')?.getAttribute('content') || '';
  const statusNode = document.getElementById('connection-status');
  const pages = [...document.querySelectorAll('[data-page]')];
  const sections = [...document.querySelectorAll('[data-section]')];
  const text = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value == null ? '' : String(value); };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
  const api = async (path, options = {}) => {
    const headers = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) };
    if (options.method && options.method !== 'GET') headers['x-csrf-token'] = csrf;
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || value.error || '请求失败');
    return value;
  };
  const setPage = (page) => {
    pages.forEach((node) => node.setAttribute('aria-current', node.getAttribute('data-page') === page ? 'page' : 'false'));
    sections.forEach((node) => { node.hidden = node.getAttribute('data-section') !== page; });
  };
  const renderNow = (value) => {
    if (!value) return;
    text('now-title', value.title || '暂无播放');
    text('now-meta', [value.live ? '直播' : '点播', value.episode || '', value.status || ''].filter(Boolean).join(' · '));
    const progress = value.duration > 0 ? Math.min(100, Math.max(0, value.currentTime / value.duration * 100)) : 0;
    const node = document.getElementById('now-progress'); if (node) node.style.width = progress + '%';
    const seek = document.getElementById('seek-position'); if (seek && document.activeElement !== seek) seek.value = String(Math.floor(value.currentTime || 0));
    const volume = document.getElementById('volume-value'); if (volume && document.activeElement !== volume) volume.value = String(value.volume == null ? 1 : value.volume);
  };
  const renderSearch = (value) => {
    const node = document.getElementById('search-results'); if (!node) return;
    node.innerHTML = (value?.items || []).map((item) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(item.title) + '</div><div class="row-meta">' + esc([item.year, item.remark].filter(Boolean).join(' · ')) + '</div></div><button type="button" data-detail-id="' + esc(item.id) + '">详情</button></div>').join('') || '<p class="muted">没有结果。</p>';
    node.querySelectorAll('[data-detail-id]').forEach((button) => button.addEventListener('click', () => loadDetail(button.getAttribute('data-detail-id'))));
  };
  const loadDetail = async (id) => {
    if (!id) return;
    try {
      const value = await api('/api/detail?id=' + encodeURIComponent(id));
      const detail = value.detail; const node = document.getElementById('detail-result'); if (!node) return;
      node.hidden = false;
      node.innerHTML = '<h3>' + esc(detail.title) + '</h3><p class="muted">' + esc([detail.year, detail.overview].filter(Boolean).join(' · ')) + '</p><div class="episode-list">' + (detail.episodes || []).map((episode) => '<button type="button" data-line="' + episode.lineIndex + '" data-episode="' + episode.episodeIndex + '">' + esc(episode.lineName + ' / ' + episode.name) + '</button>').join('') + '</div>';
      node.querySelectorAll('[data-line]').forEach((button) => button.addEventListener('click', async () => { await api('/api/play-episode', { method: 'POST', body: JSON.stringify({ lineIndex: Number(button.getAttribute('data-line')), episodeIndex: Number(button.getAttribute('data-episode')) }) }); await loadNow(); }));
    } catch (error) { text('detail-result', error.message); }
  };
  const renderLive = (value) => {
    const node = document.getElementById('live-results'); if (!node) return;
    node.innerHTML = (value?.channels || []).map((channel) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(channel.name) + '</div><div class="row-meta">' + esc([channel.group, channel.sourceName].filter(Boolean).join(' · ')) + '</div></div><div class="episode-list">' + (channel.streams || []).map((stream) => '<button type="button" data-channel="' + esc(channel.id) + '" data-stream="' + esc(stream.id) + '">' + esc(stream.label) + '</button>').join('') + '</div></div>').join('') || '<p class="muted">暂无直播频道。</p>';
    node.querySelectorAll('[data-channel]').forEach((button) => button.addEventListener('click', async () => { await api('/api/live-channel', { method: 'POST', body: JSON.stringify({ channelId: button.getAttribute('data-channel'), streamId: button.getAttribute('data-stream') }) }); await loadNow(); }));
  };
  const renderDownloads = (value) => {
    const node = document.getElementById('download-results'); if (!node) return;
    node.innerHTML = (value?.tasks || []).map((task) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(task.title) + '</div><div class="row-meta">' + esc([task.filename, task.status, task.error].filter(Boolean).join(' · ')) + '</div></div><span>' + esc(task.completedBytes == null || task.totalBytes == null ? '—' : task.completedBytes + ' / ' + task.totalBytes) + '</span></div>').join('') || '<p class="muted">暂无下载任务。</p>';
  };
  const renderCast = (value) => {
    const node = document.getElementById('cast-results'); if (!node) return;
    node.innerHTML = (value?.devices || []).map((device) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(device.friendlyName) + '</div><div class="row-meta">' + esc([device.manufacturer, device.model].filter(Boolean).join(' · ')) + '</div></div><button type="button" data-cast-id="' + esc(device.deviceId) + '">投屏当前播放</button></div>').join('') || '<p class="muted">暂无设备。</p>';
    node.querySelectorAll('[data-cast-id]').forEach((button) => button.addEventListener('click', async () => { await api('/api/cast', { method: 'POST', body: JSON.stringify({ deviceId: button.getAttribute('data-cast-id') }) }); await loadCast(); }));
  };
  const renderStatus = (value) => {
    const node = document.getElementById('safe-status'); if (!node || !value) return;
    node.innerHTML = [['监听地址', value.host + ':' + value.port], ['运行中', value.listening ? '是' : '否'], ['界面就绪', value.uiReady ? '是' : '否'], ['局域网控制', value.lanControl], ['能力', Object.keys(value.capabilities || {}).filter((key) => value.capabilities[key]).join('、') || '无']].map((pair) => '<dt>' + esc(pair[0]) + '</dt><dd>' + esc(pair[1]) + '</dd>').join('');
  };
  const renderSecurity = (value) => {
    const node = document.getElementById('web-security'); if (!node || !value) return;
    const toggle = document.getElementById('allow-lan'); if (toggle) toggle.checked = Boolean(value.allowLan);
    node.innerHTML = [['PIN configured', value.pinConfigured ? 'yes' : 'no'], ['LAN control', value.allowLan ? 'enabled' : 'disabled'], ['Session', value.authenticated ? (value.session?.permissions || []).join(', ') : 'not logged in'], ['Setup PIN', value.setupPinAvailable ? 'available on this local page' : 'regenerate locally']].map((pair) => '<dt>' + esc(pair[0]) + '</dt><dd>' + esc(pair[1]) + '</dd>').join('');
    const sessions = document.getElementById('web-sessions'); if (!sessions) return;
    sessions.innerHTML = (value.sessions || []).map((session) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(session.current ? 'Current browser' : 'Authorized browser') + '</div><div class="row-meta">' + esc((session.permissions || []).join(', ') + ' · expires ' + new Date(session.expiresAt).toLocaleString()) + '</div></div><button type="button" data-revoke-session="' + esc(session.id) + '">Revoke</button></div>').join('') || '<p class="muted">No authorized sessions.</p>';
    sessions.querySelectorAll('[data-revoke-session]').forEach((button) => button.addEventListener('click', async () => { await api('/api/security/sessions/revoke', { method: 'POST', body: JSON.stringify({ id: button.getAttribute('data-revoke-session') }) }); await loadSecurity(); }));
  };
  const loadNow = async () => { const value = await api('/api/now-playing'); renderNow(value.nowPlaying); };
  const loadLive = async () => { const value = await api('/api/live-channels'); renderLive(value.live); };
  const loadDownloads = async () => { const value = await api('/api/downloads'); renderDownloads(value.downloads); };
  const loadCast = async () => { const value = await api('/api/cast-devices'); renderCast(value.cast); };
  const loadStatus = async () => { const value = await api('/api/safe-status'); renderStatus(value.status); };
  const loadSecurity = async () => { const value = await api('/api/security/status'); renderSecurity(value); try { const setup = await api('/api/security/setup-pin'); if (setup.pin) text('pin-message', 'New PIN: ' + setup.pin + ' (store it safely; it will not be shown again)'); } catch (_) {} };
  pages.forEach((node) => node.addEventListener('click', () => { const page = node.getAttribute('data-page'); if (page) setPage(page); }));
  document.getElementById('search-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const query = document.getElementById('search-query')?.value || ''; try { const value = await api('/api/search?q=' + encodeURIComponent(query)); renderSearch(value.search); } catch (error) { text('search-results', error.message); } });
  document.querySelectorAll('[data-action="pause"]').forEach((node) => node.addEventListener('click', async () => { await api('/api/pause', { method: 'POST', body: '{}' }); await loadNow(); }));
  document.querySelectorAll('[data-action="stop"]').forEach((node) => node.addEventListener('click', async () => { await api('/api/stop', { method: 'POST', body: '{}' }); await loadNow(); }));
  document.querySelectorAll('[data-action="seek"]').forEach((node) => node.addEventListener('click', async () => { await api('/api/seek', { method: 'POST', body: JSON.stringify({ position: Number(document.getElementById('seek-position')?.value || 0) }) }); await loadNow(); }));
  document.querySelectorAll('[data-action="volume"]').forEach((node) => node.addEventListener('click', async () => { await api('/api/volume', { method: 'POST', body: JSON.stringify({ volume: Number(document.getElementById('volume-value')?.value || 1) }) }); await loadNow(); }));
  document.querySelectorAll('[data-action="refresh-now"]').forEach((node) => node.addEventListener('click', loadNow));
  document.querySelectorAll('[data-action="refresh-live"]').forEach((node) => node.addEventListener('click', loadLive));
  document.querySelectorAll('[data-action="refresh-downloads"]').forEach((node) => node.addEventListener('click', loadDownloads));
  document.querySelectorAll('[data-action="refresh-cast"]').forEach((node) => node.addEventListener('click', loadCast));
  document.querySelectorAll('[data-action="refresh-status"]').forEach((node) => node.addEventListener('click', loadStatus));
  document.querySelector('[data-action="regenerate-pin"]')?.addEventListener('click', async () => { try { const value = await api('/api/security/regenerate-pin', { method: 'POST', body: '{}' }); text('pin-message', 'New PIN: ' + value.pin + ' (store it safely; it will not be shown again)'); await loadSecurity(); } catch (error) { text('pin-message', error.message); } });
  document.querySelector('[data-action="save-lan"]')?.addEventListener('click', async () => { try { await api('/api/security/settings', { method: 'POST', body: JSON.stringify({ allowLan: Boolean(document.getElementById('allow-lan')?.checked) }) }); text('pin-message', 'LAN setting saved. The console may reconnect on its new address.'); await loadSecurity(); } catch (error) { text('pin-message', error.message); } });
  document.getElementById('pin-form')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const permissions = ['read', 'control', 'push'].filter((permission) => document.getElementById('permission-' + permission)?.checked); await api('/auth/pin', { method: 'POST', body: JSON.stringify({ pin: document.getElementById('pin-value')?.value || '', permissions }) }); text('pin-message', 'Logged in.'); await loadSecurity(); await loadNow(); } catch (error) { text('pin-message', error.message); } });
  document.querySelector('[data-action="revoke-all-sessions"]')?.addEventListener('click', async () => { try { await api('/api/security/sessions/revoke-all', { method: 'POST', body: '{}' }); await loadSecurity(); } catch (error) { text('pin-message', error.message); } });
  const connect = () => {
    try {
      const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      socket.addEventListener('open', () => { if (statusNode) statusNode.textContent = '已连接'; });
      socket.addEventListener('message', (event) => { try { const value = JSON.parse(event.data); if (value.type === 'state') { renderNow(value.snapshot.nowPlaying); renderLive(value.snapshot.live); renderDownloads(value.snapshot.downloads); renderCast(value.snapshot.cast); renderStatus(value.snapshot.status); } } catch (_) {} });
      socket.addEventListener('close', () => { if (statusNode) statusNode.textContent = '连接已断开'; window.setTimeout(connect, 1500); });
    } catch (_) { if (statusNode) statusNode.textContent = '连接失败'; }
  };
  setPage('now');
  Promise.all([loadNow(), loadLive(), loadDownloads(), loadCast(), loadStatus(), loadSecurity()]).catch((error) => { if (statusNode) statusNode.textContent = error.message; });
  connect();
})();
`;
