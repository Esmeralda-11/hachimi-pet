(() => {
  const POLL_MS = 2500;
  const $ = (id) => document.getElementById(id);

  const el = {
    statusDot: $('status-dot'),
    statusBadge: $('status-badge'),
    activeSummary: $('active-summary'),
    powerSwitch: $('power-switch'),
    btnRestart: $('btn-restart'),
    btnWave: $('btn-wave'),
    controlsCard: $('controls-card'),
    togglePetVisible: $('toggle-pet-visible'),
    toggleTrayVisible: $('toggle-tray-visible'),
    temperamentGroup: $('temperament-group'),
    scaleSlider: $('scale-slider'),
    scaleValue: $('scale-value'),
    packsActivePill: $('packs-active-pill'),
    packsContainer: $('packs-container'),
    workshopLink: $('workshop-link'),
    btnCopyWorkshop: $('btn-copy-workshop'),
    toast: $('toast'),
    toastText: $('toast-text'),
    toastClose: $('toast-close'),
  };

  const state = {
    status: null,
    localBusy: null,       // 'starting' | 'stopping' | 'restarting' | 'selecting' | null
    pendingTileKey: '',    // `${packId}:${variantId}`
    draggingScale: false,
    packsSignature: '',
    collapsedPacks: new Set(),
    pollGen: 0,
    pollTimer: null,
    scaleTimer: null,
    toastTimer: null,
  };

  // ---------- Theme Sync (Host tokens + standalone prefers-color-scheme) ----------
  const urlParams = new URLSearchParams(window.location.search);
  const forcedTheme = urlParams.get('theme');
  const darkMql = window.matchMedia('(prefers-color-scheme: dark)');

  function luminanceFromComputedColor(computed) {
    const lower = String(computed || '').trim().toLowerCase();
    // oklch(L C H) / oklab(L a b): first channel is perceptual lightness in 0..1 or 0%..100%
    if (lower.startsWith('oklch(') || lower.startsWith('oklab(')) {
      const m = lower.match(/\(\s*([\d.]+)(%?)/);
      if (!m) return null;
      const raw = Number(m[1]);
      if (!Number.isFinite(raw)) return null;
      return m[2] === '%' ? raw / 100 : raw;
    }
    // lab(L a b) / lch(L C H): lightness is 0..100 (or 0%..100%)
    if (lower.startsWith('lab(') || lower.startsWith('lch(')) {
      const m = lower.match(/\(\s*([\d.]+)(%?)/);
      if (!m) return null;
      const raw = Number(m[1]);
      if (!Number.isFinite(raw)) return null;
      return raw / 100;
    }
    const nums = (lower.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return null;
    const scale = lower.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function syncTheme() {
    if (forcedTheme === 'dark' || forcedTheme === 'light') {
      document.documentElement.dataset.theme = forcedTheme;
      return;
    }

    const hostBg = document.documentElement.style.getPropertyValue('--background').trim();
    if (hostBg) {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background)';
      document.documentElement.appendChild(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      const lum = luminanceFromComputedColor(computed);
      if (lum !== null) {
        document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
        return;
      }
    }

    document.documentElement.dataset.theme = darkMql.matches ? 'dark' : 'light';
  }

  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
  darkMql.addEventListener('change', syncTheme);

  // ---------- Secure Sidecar Fetch ----------
  async function apiFetch(path, { method = 'GET', body } = {}) {
    const fetcher = window.sidecar?.fetch
      ? window.sidecar.fetch.bind(window.sidecar)
      : window.fetch.bind(window);
    const options = { method };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const res = await fetcher(path, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error(data?.error || `请求失败（HTTP ${res.status}）`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  // ---------- Toast ----------
  function showToast(message, { isError = false, duration = 3600 } = {}) {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    el.toastText.textContent = message;
    el.toast.classList.toggle('is-error', isError);
    el.toast.classList.remove('hidden');
    if (duration > 0) {
      state.toastTimer = setTimeout(hideToast, duration);
    }
  }

  function hideToast() {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    el.toast.classList.add('hidden');
  }

  el.toastClose.addEventListener('click', hideToast);

  // ---------- Slider CSS Custom Property Sync ----------
  function syncSliderVisual(percent) {
    const clamped = Math.min(140, Math.max(35, Math.round(percent)));
    el.scaleSlider.value = String(clamped);
    el.scaleSlider.setAttribute('aria-valuetext', `${clamped}%`);
    el.scaleSlider.style.setProperty('--attr-min', el.scaleSlider.min || '35');
    el.scaleSlider.style.setProperty('--attr-max', el.scaleSlider.max || '140');
    el.scaleSlider.style.setProperty('--control-value', String(clamped));
    el.scaleValue.textContent = `${clamped}%`;
  }

  syncSliderVisual(85);

  // ---------- Render Helpers ----------
  function findActiveMeta(status) {
    const packs = Array.isArray(status?.packs) ? status.packs : [];
    const pack = packs.find((p) => p.id === status.activePackId) || packs[0] || null;
    const variant = pack?.variants?.find((v) => v.id === status.activeVariantId) || pack?.variants?.[0] || null;
    return { pack, variant };
  }

  function computePacksSignature(packs) {
    return (packs || [])
      .map((p) => `${p.id}:${p.name}|${(p.variants || []).map((v) => `${v.id}:${v.name}:${v.thumbUrl}`).join(',')}`)
      .join('||');
  }

  function buildPacksDom(packs) {
    el.packsContainer.textContent = '';
    if (!packs || packs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'packs-loading';
      empty.textContent = '暂无可用形象包';
      el.packsContainer.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const pack of packs) {
      const details = document.createElement('details');
      details.className = 'pack-group';
      details.dataset.packId = pack.id;
      details.open = !state.collapsedPacks.has(pack.id);
      details.addEventListener('toggle', () => {
        if (details.open) {
          state.collapsedPacks.delete(pack.id);
        } else {
          state.collapsedPacks.add(pack.id);
        }
      });

      const summary = document.createElement('summary');
      summary.className = 'pack-summary';
      summary.innerHTML =
        '<svg class="icon pack-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">' +
        '<path d="M4.5 6.25 8 9.75l3.5-3.5" />' +
        '</svg>';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'pack-name';
      nameSpan.textContent = pack.name;

      const countSpan = document.createElement('span');
      countSpan.className = 'pack-count';
      countSpan.textContent = `${pack.variants.length} 个`;

      summary.append(nameSpan, countSpan);
      details.appendChild(summary);

      const grid = document.createElement('div');
      grid.className = 'avatar-grid';

      for (const variant of pack.variants) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'avatar-tile';
        tile.dataset.packId = pack.id;
        tile.dataset.variantId = variant.id;
        tile.setAttribute('aria-pressed', 'false');
        tile.title = `${pack.name} · ${variant.name}`;

        const thumbWrap = document.createElement('span');
        thumbWrap.className = 'avatar-thumb-wrap';

        const img = document.createElement('img');
        img.className = 'avatar-thumb';
        img.src = variant.thumbUrl;
        img.alt = variant.name;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => {
          thumbWrap.classList.add('is-fallback');
        });

        const fallback = document.createElement('span');
        fallback.className = 'avatar-fallback';
        fallback.style.background = variant.color || '#8B7BF7';
        fallback.setAttribute('aria-hidden', 'true');

        thumbWrap.append(img, fallback);

        const label = document.createElement('span');
        label.className = 'avatar-name';
        label.textContent = variant.name;

        const check = document.createElement('span');
        check.className = 'avatar-check';
        check.setAttribute('aria-hidden', 'true');
        check.innerHTML =
          '<svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M2.5 6.2 5 8.7 9.5 3.6" />' +
          '</svg>';

        tile.append(thumbWrap, label, check);
        grid.appendChild(tile);
      }

      details.appendChild(grid);
      frag.appendChild(details);
    }

    el.packsContainer.appendChild(frag);
  }

  function syncPackActiveStates(status, busy) {
    const activePackId = status?.activePackId || '';
    const activeVariantId = status?.activeVariantId || '';
    const tiles = el.packsContainer.querySelectorAll('.avatar-tile');
    for (const tile of tiles) {
      const pId = tile.dataset.packId;
      const vId = tile.dataset.variantId;
      const isActive = pId === activePackId && vId === activeVariantId;
      const key = `${pId}:${vId}`;
      tile.classList.toggle('is-active', isActive);
      tile.classList.toggle('is-pending', state.pendingTileKey === key);
      tile.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      tile.disabled = Boolean(busy);
    }
  }

  function render() {
    const st = state.status;
    if (!st) return;

    const effectiveBusy = state.localBusy || st.busyAction || null;
    const isBusy = Boolean(effectiveBusy);
    const running = Boolean(st.running);

    // Hero status indicator & badge
    el.statusDot.classList.remove('is-on', 'is-off', 'is-busy');
    el.statusBadge.classList.remove('is-on', 'is-off', 'is-busy');

    if (effectiveBusy === 'starting') {
      el.statusDot.classList.add('is-busy');
      el.statusBadge.classList.add('is-busy');
      el.statusBadge.textContent = '启动中…';
    } else if (effectiveBusy === 'stopping') {
      el.statusDot.classList.add('is-busy');
      el.statusBadge.classList.add('is-busy');
      el.statusBadge.textContent = '关闭中…';
    } else if (effectiveBusy === 'restarting') {
      el.statusDot.classList.add('is-busy');
      el.statusBadge.classList.add('is-busy');
      el.statusBadge.textContent = '重启中…';
    } else if (effectiveBusy === 'selecting') {
      el.statusDot.classList.add('is-busy');
      el.statusBadge.classList.add('is-busy');
      el.statusBadge.textContent = '切换中…';
    } else if (running) {
      el.statusDot.classList.add('is-on');
      el.statusBadge.classList.add('is-on');
      el.statusBadge.textContent = '运行中';
    } else {
      el.statusDot.classList.add('is-off');
      el.statusBadge.classList.add('is-off');
      el.statusBadge.textContent = '已关闭';
    }

    const { pack, variant } = findActiveMeta(st);
    const activeLabel = pack && variant ? `${pack.name} · ${variant.name}` : '未选择形象';
    el.activeSummary.textContent = running ? `当前形象：${activeLabel}` : `上次形象：${activeLabel}`;

    if (pack && variant) {
      el.packsActivePill.textContent = activeLabel;
      el.packsActivePill.classList.remove('hidden');
    } else {
      el.packsActivePill.classList.add('hidden');
    }

    // Hero switch & action buttons
    const switchOn = effectiveBusy === 'starting' || effectiveBusy === 'restarting'
      ? true
      : effectiveBusy === 'stopping'
        ? false
        : running;
    el.powerSwitch.setAttribute('aria-checked', switchOn ? 'true' : 'false');
    el.powerSwitch.disabled = isBusy;

    el.btnRestart.disabled = isBusy;
    el.btnWave.disabled = isBusy || !running;

    // Quick Controls
    const settings = st.settings || {};
    const controlsDisabled = isBusy || !running;
    el.controlsCard.classList.toggle('is-offline', !running);

    el.togglePetVisible.setAttribute('aria-checked', settings.petHidden ? 'false' : 'true');
    el.togglePetVisible.disabled = controlsDisabled;

    el.toggleTrayVisible.setAttribute('aria-checked', settings.trayHidden ? 'false' : 'true');
    el.toggleTrayVisible.disabled = controlsDisabled;

    const currentTemp = settings.temperament || 'daily';
    for (const btn of el.temperamentGroup.querySelectorAll('.seg-btn')) {
      const active = btn.dataset.temperament === currentTemp;
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
      btn.disabled = controlsDisabled;
    }

    el.scaleSlider.disabled = controlsDisabled;
    if (!state.draggingScale) {
      const scalePct = Math.round((Number(settings.mainScale) || 0.85) * 100);
      syncSliderVisual(scalePct);
    }

    // Packs Grid (rebuild only when pack list or thumbs change)
    const sig = computePacksSignature(st.packs);
    if (sig !== state.packsSignature) {
      state.packsSignature = sig;
      buildPacksDom(st.packs);
    }
    syncPackActiveStates(st, isBusy);

    // Footer Workshop Link
    if (st.workshopUrl) {
      el.workshopLink.href = st.workshopUrl;
    }
  }

  // ---------- Polling ----------
  async function refreshStatus({ silent = true } = {}) {
    const gen = ++state.pollGen;
    try {
      const data = await apiFetch('/api/status', { method: 'GET' });
      if (gen !== state.pollGen) return;
      state.status = data;
      render();
    } catch (err) {
      if (!silent) showToast(err.message || '无法读取桌宠状态', { isError: true });
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (document.hidden || state.localBusy || state.draggingScale) return;
      refreshStatus({ silent: true });
    }, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.localBusy) {
      refreshStatus({ silent: true });
    }
  });

  // ---------- Actions ----------
  async function triggerPower(action) {
    if (state.localBusy) return;
    state.localBusy = action === 'on' ? 'starting' : action === 'off' ? 'stopping' : 'restarting';
    state.pollGen += 1;
    render();
    try {
      const res = await apiFetch('/api/power', { method: 'POST', body: { action } });
      if (res?.status) state.status = res.status;
    } catch (err) {
      if (err?.payload?.status) state.status = err.payload.status;
      showToast(err.message || '桌宠电源操作失败', { isError: true });
    } finally {
      state.localBusy = null;
      render();
    }
  }

  el.powerSwitch.addEventListener('click', () => {
    const running = Boolean(state.status?.running);
    triggerPower(running ? 'off' : 'on');
  });

  el.btnRestart.addEventListener('click', () => {
    triggerPower('restart');
  });

  el.btnWave.addEventListener('click', async () => {
    if (state.localBusy || !state.status?.running) return;
    el.btnWave.disabled = true;
    try {
      await apiFetch('/api/wave', { method: 'POST', body: {} });
      showToast('已向桌宠挥手打招呼', { isError: false, duration: 2000 });
    } catch (err) {
      showToast(err.message || '打招呼失败', { isError: true });
    } finally {
      render();
    }
  });

  async function patchSettings(patch, prevSettings = null) {
    if (!state.status?.running) {
      if (prevSettings && state.status?.settings) {
        state.status.settings = { ...state.status.settings, ...prevSettings };
        render();
      }
      showToast('请先开启桌宠主开关', { isError: true });
      return;
    }
    state.pollGen += 1;
    try {
      const res = await apiFetch('/api/settings', { method: 'POST', body: patch });
      if (res?.status) {
        state.status = res.status;
      } else if (res?.settings && state.status) {
        state.status.settings = { ...state.status.settings, ...res.settings };
      }
      render();
    } catch (err) {
      if (err?.payload?.status) {
        state.status = err.payload.status;
      } else if (prevSettings && state.status?.settings) {
        state.status.settings = { ...state.status.settings, ...prevSettings };
      }
      showToast(err.message || '保存设置失败', { isError: true });
      render();
    }
  }

  el.togglePetVisible.addEventListener('click', () => {
    const currentlyHidden = Boolean(state.status?.settings?.petHidden);
    const nextHidden = !currentlyHidden;
    const prev = { petHidden: currentlyHidden };
    if (state.status?.settings) state.status.settings.petHidden = nextHidden;
    render();
    patchSettings({ petHidden: nextHidden }, prev);
  });

  el.toggleTrayVisible.addEventListener('click', () => {
    const currentlyHidden = Boolean(state.status?.settings?.trayHidden);
    const nextHidden = !currentlyHidden;
    const prev = { trayHidden: currentlyHidden };
    if (state.status?.settings) state.status.settings.trayHidden = nextHidden;
    render();
    patchSettings({ trayHidden: nextHidden }, prev);
  });

  el.temperamentGroup.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    const temperament = btn.dataset.temperament;
    const prevTemp = state.status?.settings?.temperament;
    if (!temperament || temperament === prevTemp) return;
    if (state.status?.settings) state.status.settings.temperament = temperament;
    render();
    patchSettings({ temperament }, prevTemp ? { temperament: prevTemp } : null);
  });

  el.temperamentGroup.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const btns = Array.from(el.temperamentGroup.querySelectorAll('.seg-btn:not(:disabled)'));
    const idx = btns.indexOf(document.activeElement);
    if (idx === -1 || btns.length === 0) return;
    event.preventDefault();
    const nextIdx = (idx + (event.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
    btns[nextIdx].focus();
    btns[nextIdx].click();
  });

  el.scaleSlider.addEventListener('pointerdown', () => {
    state.draggingScale = true;
  });

  window.addEventListener('pointerup', () => {
    state.draggingScale = false;
  });

  window.addEventListener('pointercancel', () => {
    state.draggingScale = false;
  });

  el.scaleSlider.addEventListener('input', () => {
    const pct = Number(el.scaleSlider.value);
    syncSliderVisual(pct);
    if (state.scaleTimer) clearTimeout(state.scaleTimer);
    state.scaleTimer = setTimeout(() => {
      const mainScale = Math.round(pct) / 100;
      patchSettings({ mainScale });
    }, 160);
  });

  el.scaleSlider.addEventListener('change', () => {
    state.draggingScale = false;
    if (state.scaleTimer) {
      clearTimeout(state.scaleTimer);
      state.scaleTimer = null;
    }
    const pct = Number(el.scaleSlider.value);
    syncSliderVisual(pct);
    patchSettings({ mainScale: Math.round(pct) / 100 });
  });

  el.packsContainer.addEventListener('click', async (event) => {
    const tile = event.target.closest('.avatar-tile');
    if (!tile || tile.disabled || state.localBusy) return;
    const packId = tile.dataset.packId;
    const variantId = tile.dataset.variantId;
    if (!packId || !variantId) return;

    const alreadyActive =
      state.status?.running &&
      state.status?.activePackId === packId &&
      state.status?.activeVariantId === variantId;
    if (alreadyActive) return;

    const wasOff = !state.status?.running;
    state.localBusy = wasOff ? 'starting' : 'selecting';
    state.pendingTileKey = `${packId}:${variantId}`;
    state.pollGen += 1;
    render();

    try {
      const res = await apiFetch('/api/select', {
        method: 'POST',
        body: { packId, variantId },
      });
      if (res?.status) state.status = res.status;
    } catch (err) {
      if (err?.payload?.status) state.status = err.payload.status;
      showToast(err.message || '切换角色形象失败', { isError: true });
    } finally {
      state.localBusy = null;
      state.pendingTileKey = '';
      render();
    }
  });

  el.btnCopyWorkshop.addEventListener('click', async () => {
    const url = state.status?.workshopUrl || el.workshopLink.href;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch { /* fallback below */ }

    if (!copied) {
      try {
        const input = document.createElement('input');
        input.value = url;
        input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(input);
        input.select();
        copied = document.execCommand('copy');
        input.remove();
      } catch {
        copied = false;
      }
    }

    if (copied) {
      el.btnCopyWorkshop.textContent = '已复制';
      showToast('已复制设置工坊地址', { duration: 1800 });
      setTimeout(() => {
        el.btnCopyWorkshop.textContent = '复制地址';
      }, 1500);
    } else {
      showToast(`请手动复制：${url}`, { isError: true });
    }
  });

  // ---------- Bootstrap ----------
  refreshStatus({ silent: false }).finally(startPolling);
})();
