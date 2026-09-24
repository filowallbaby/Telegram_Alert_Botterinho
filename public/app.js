'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram?.WebApp;
  const initData = tg?.initData || '';
  const state = { events: [], mode: 'active', category: 'all', loadedMode: 'active', cursor: null, busy: false,
    map: null, layer: null, fitted: false, categories: {}, timeZone: 'Europe/Rome', generation: 0 };
  const statuses = { active: 'Active', resolved: 'Resolved', expired: 'Expired', removed: 'Removed' };
  const date = (timestamp) => timestamp ? new Intl.DateTimeFormat('en-GB', {
    timeZone: state.timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(timestamp * 1000) : '-';
  const age = (timestamp) => {
    const minutes = Math.max(0, Math.floor((Date.now() / 1000 - timestamp) / 60));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
    return date(timestamp);
  };
  const el = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  function showError(message) { $('error').textContent = message; $('error').hidden = false; }
  async function api(params) {
    const response = await fetch(`/api/events?${new URLSearchParams(params)}`, {
      headers: { 'X-Telegram-Init-Data': initData }, cache: 'no-store',
      signal: AbortSignal.timeout(18000)
    });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || (!Array.isArray(data.events) && !data.event)) {
      const error = new Error(data.error || 'The service is not available right now.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function mapInit(config) {
    if (state.map || !window.L) {
      if (!window.L) {
        $('map-warning').hidden = false;
        $('map-warning').textContent = "The map library didn't load. You can still use the list of reports.";
      }
      return;
    }
    state.map = L.map('map', { scrollWheelZoom: true }).setView(config.center, config.zoom);
    // Plain browser requests with visible attribution, as the OSM tile policy asks. No prefetching.
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(state.map);
    tiles.on('tileerror', () => {
      $('map-warning').hidden = false;
      $('map-warning').textContent = 'Some map tiles failed to load. The list of reports below is still up to date.';
    });
    state.layer = L.layerGroup().addTo(state.map);
    tg?.onEvent?.('viewportChanged', () => state.map.invalidateSize());
    window.addEventListener('resize', () => state.map.invalidateSize());
  }
  function safeTelegramLink(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 't.me'; }
    catch { return false; }
  }
  function details(event) {
    const root = $('detail-content'); root.replaceChildren();
    root.append(el('h2', '', `${state.categories[event.category]?.label || event.category} · #${event.id}`));
    root.append(el('span', `pill ${event.status}`, statuses[event.status] || event.status));
    if (event.description) root.append(el('p', 'detail-note', event.description));
    const table = el('dl', 'details');
    const rows = [
      ['Reported', date(event.observed_at)], ['By', event.reported_by],
      ['Coordinates', `${event.latitude.toFixed(5)}, ${event.longitude.toFixed(5)}`],
      ['Confirmations', String(event.confirmations)], ['Last confirmed', date(event.last_confirmed_at)],
      ['Expires', date(event.expires_at)]
    ];
    if (event.status === 'resolved') rows.push(['Resolved', date(event.resolved_at)]);
    for (const [label, value] of rows) table.append(el('dt', '', label), el('dd', '', value));
    root.append(table);
    root.append(el('p', 'muted', event.status === 'expired'
      ? "Nobody updated this report in time, so it's unclear whether the problem is still there."
      : 'Reported and confirmed by group members, not by an official source.'));
    if (event.message_url && safeTelegramLink(event.message_url)) {
      const link = el('a', 'telegram-link', 'Open the report in the group');
      link.href = event.message_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.addEventListener('click', (click) => {
        if (tg?.openTelegramLink) { click.preventDefault(); tg.openTelegramLink(event.message_url); }
      });
      root.append(link);
    }
    if (!$('detail').open) $('detail').showModal();
  }
  function render() {
    const filtered = state.events.filter(event => state.category === 'all' || event.category === state.category);
    $('count').textContent = String(filtered.length);
    $('confirm-count').textContent = String(filtered.reduce((sum, event) => sum + event.confirmations, 0));
    $('empty').hidden = filtered.length !== 0;
    $('events').replaceChildren();
    state.layer?.clearLayers();
    const bounds = [];
    for (const event of filtered) {
      const config = state.categories[event.category] || { label: event.category, color: '#586a61' };
      const card = el('button', 'event-card'); card.type = 'button';
      const top = el('div', 'event-top'); const dot = el('span', 'dot');
      dot.style.backgroundColor = config.color;
      top.append(dot, el('span', '', config.label), el('span', 'event-id', `#${event.id}`));
      card.append(top, el('p', 'event-description', event.description || 'No note. Open the details for the exact location.'));
      const bottom = el('div', 'event-bottom');
      bottom.append(el('span', `pill ${event.status}`, statuses[event.status]),
        el('span', '', age(event.observed_at)), el('span', '', `${event.confirmations} ${event.confirmations === 1 ? 'confirmation' : 'confirmations'}`));
      card.append(bottom); card.addEventListener('click', () => details(event));
      $('events').append(card);
      if (state.layer) {
        const point = [event.latitude, event.longitude]; bounds.push(point);
        const marker = L.circleMarker(point, { radius: 9, weight: 3, color: '#ffffff',
          fillColor: config.color, fillOpacity: event.status === 'active' ? .95 : .55 }).addTo(state.layer);
        const popup = el('div', '');
        popup.append(el('div', 'popup-title', `${config.label} · #${event.id}`), el('div', '', `${statuses[event.status]} · ${age(event.observed_at)}`));
        const button = el('button', '', 'Details'); button.type = 'button';
        button.addEventListener('click', () => details(event)); popup.append(button);
        marker.bindPopup(popup);
      }
    }
    if (state.map && bounds.length && !state.fitted) {
      state.map.fitBounds(bounds, { padding: [35, 35], maxZoom: 14 }); state.fitted = true;
    }
    $('more').hidden = !state.cursor;
    $('pagination-note').textContent = state.cursor
      ? 'Only part of the reports is shown. Use "Load more reports" to add the rest to the map and the list.'
      : state.loadedMode === 'active' ? '' : 'This range includes resolved and expired reports too.';
  }
  function applyConfig(data) {
    $('title').textContent = data.title; document.title = data.title;
    state.categories = data.categories;
    if (data.time_zone) state.timeZone = data.time_zone;
    if ($('category').options.length === 1) {
      for (const [key, value] of Object.entries(data.categories)) {
        const option = el('option', '', value.label); option.value = key; $('category').append(option);
      }
    }
  }
  async function load(append = false) {
    if (state.busy || !initData) return;
    state.busy = true; $('refresh').disabled = true; $('more').disabled = true;
    document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = true; });
    $('error').hidden = true;
    try {
      const params = { mode: state.mode };
      if (append && state.cursor) params.before = String(state.cursor);
      const data = await api(params);
      applyConfig(data);
      state.events = append ? [...state.events, ...data.events].filter((event, i, all) => all.findIndex(item => item.id === event.id) === i) : data.events;
      state.cursor = data.next_cursor; state.loadedMode = data.mode;
      $('access').hidden = true; $('application').hidden = false;
      mapInit(data); render(); state.generation++;
      $('updated').textContent = `Updated ${date(data.generated_at)}. Refreshes every 2 minutes while the map is open.`;
      state.map?.invalidateSize();
      if (state.generation === 1) {
        // start_param only decides which report to open. The API still checks the signature and membership.
        const start = tg?.initDataUnsafe?.start_param || '';
        const match = /^event_(\d+)$/.exec(start);
        if (match) {
          const existing = state.events.find(event => event.id === Number(match[1]));
          if (existing) details(existing);
          else {
            try { const found = await api({ id: match[1] }); details(found.event); }
            catch (error) { showError(error.message); }
          }
        }
      }
    } catch (error) {
      state.mode = state.loadedMode;
      document.querySelectorAll('[data-mode]').forEach(button => {
        const selected = button.dataset.mode === state.mode; button.setAttribute('aria-pressed', String(selected));
        if (selected) $('period-label').textContent = button.textContent;
      });
      const message = error.name === 'TimeoutError' ? 'The server is not responding. Try again in a moment.' : (error.message || 'Connection error.');
      if (!$('application').hidden) {
        showError(`${message} The reports on screen may be out of date.`);
        // Access was revoked, so don't leave private data on screen.
        if (error.status === 401 || error.status === 403) {
          $('application').hidden = true; $('access').hidden = false;
          $('access-text').textContent = message; state.events = []; state.layer?.clearLayers();
          $('events').replaceChildren(); $('detail-content').replaceChildren(); $('detail').close();
        }
      } else { $('access-text').textContent = message; $('retry-access').hidden = false; }
    } finally {
      state.busy = false; $('refresh').disabled = false; $('more').disabled = false;
      document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = false; });
    }
  }
  $('close-detail').addEventListener('click', () => $('detail').close());
  $('detail').addEventListener('click', (event) => { if (event.target === $('detail')) $('detail').close(); });
  $('refresh').addEventListener('click', () => load());
  $('retry-access').addEventListener('click', () => load());
  $('more').addEventListener('click', () => load(true));
  $('category').addEventListener('change', () => { state.category = $('category').value; render(); });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    if (state.busy) return;
    state.mode = button.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    $('period-label').textContent = button.textContent;
    load();
  }));
  if (!initData) {
    $('access-text').textContent = "Open the Telegram bot and tap Map. A plain browser link can't prove you're in the group.";
    return;
  }
  tg.ready(); tg.expand();
  load();
  setInterval(() => { if (!document.hidden && state.mode === 'active') load(); }, 120000);
})();
