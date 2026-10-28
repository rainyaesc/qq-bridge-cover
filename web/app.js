'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { csrf: '', revision: null, saved: null, draft: null, defaults: null, catalog: {}, busy: false, conflict: false, active: 'clip' };
  const fields = new Map();
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
  function set(object, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let target = object;
    for (const key of keys) target = target[key] ??= {};
    target[last] = value;
  }
  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = String(content);
    return element;
  }
  function append(parent, ...children) { parent.append(...children.filter(Boolean)); return parent; }
  function showNotice(message, success = false, retry = false) {
    const box = $('notice');
    box.replaceChildren(node('span', '', message));
    box.className = success ? 'notice success' : 'notice';
    box.hidden = false;
    if (retry) {
      const button = node('button', '', '重新加载设置');
      button.type = 'button';
      button.addEventListener('click', () => {
        if (dirty() && !window.confirm('重新加载会放弃当前未保存的修改。继续加载吗？')) return;
        bootstrap();
      });
      box.append(button);
    }
  }
  function hideNotice() { $('notice').hidden = true; }
  function dirty() { return !!state.saved && JSON.stringify(state.draft) !== JSON.stringify(state.saved); }
  function updateStatus(message, kind) {
    const status = $('save-status');
    status.textContent = message || (state.conflict ? '配置已在其他窗口更新' : state.busy ? '正在保存…' : dirty() ? '有未保存的修改' : '设置已同步');
    status.className = `save-status ${kind || (state.conflict ? 'error' : dirty() ? 'dirty' : 'success')}`;
    $('save').disabled = !state.saved || !dirty() || state.busy || state.conflict;
    $('restore').disabled = !state.defaults || state.busy || state.conflict;
  }
  async function api(path, options = {}) {
    const headers = { 'Accept': 'application/json', 'X-Cover-CSRF': state.csrf, ...options.headers };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    let data;
    try { data = await response.json(); } catch {
      const error = new Error('服务器未返回有效的 JSON，请稍后重试。');
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.field = data?.error?.field;
      throw error;
    }
    return data;
  }
  const definitions = [
    { id: 'clip', number: '01', title: '默认片段', description: '设置翻唱时长、片段选择与下载音质', fields: [
      ['defaultSeconds', '默认片段时长', 'range', 5, 45, 1, '秒', '未指定时长时，使用这个值；不能超过片段时长上限。'],
      ['maxSeconds', '片段时长上限', 'range', 5, 45, 1, '秒', '限制单次处理长度，兼顾生成速度与资源占用。'],
      ['preferChorus', '优先选择副歌', 'toggle', '有可用副歌信息时优先截取副歌，否则使用备用起点。'],
      ['fallbackStart', '备用片段起点', 'range', 0, 7200, 1, '秒', '没有可用副歌信息时，从歌曲的这个时间点开始。'],
      ['downloadQuality', '下载音质', 'select', [['standard', '标准音质'], ['exhigh', '极高音质'], ['lossless', '无损音质']], '实际可用音质取决于歌曲资源与账号权限。']
    ] },
    { id: 'uvr', number: '02', title: '人声分离 UVR', description: '将原唱与伴奏分离，再交给音色转换模型', fields: [
      ['uvr.modelId', '分离模型', 'catalog', 'uvr', '仅列出项目发现的模型；请按当前环境选择。'],
      ['uvr.device', '推理设备', 'select', [['directml', 'DirectML · GPU'], ['cpu', 'CPU']], '设备可用性以实际任务运行结果为准。'],
      ['uvr.deviceId', 'GPU 设备编号', 'number', 0, 7, 1, '', '仅 DirectML 使用；第一块设备通常为 0。'],
      ['uvr.overlap', '分离窗口重叠', 'select', [[0.25, '25% · 较快'], [0.5, '50% · 均衡'], [0.75, '75% · 较细致']], '较高的重叠比例会增加处理时间。', true],
      ['uvr.denoise', '分离降噪', 'toggle', '对分离结果进行降噪；可能同时影响部分人声细节。'],
      ['uvr.compensate', '分离补偿', 'compensate']
    ] },
    { id: 'rvc', number: '03', title: '音色转换 RVC', description: '选择已配置的 RVC 音色模型与转换参数', fields: [
      ['rvc.modelId', '音色模型', 'catalog', 'rvc', '这里使用 RVC 转换模型，不支持直接导入任意 TTS 模型。'],
      ['rvc.indexId', '检索索引', 'catalog', 'indices', '索引应与音色模型配套。未选择索引时，检索实际关闭。'],
      ['rvc.pitch', '音高偏移', 'range', -12, 12, 1, '半音', '正值升调，负值降调；0 保持原始音高。'],
      ['rvc.f0Method', '音高提取方式', 'select', [['rmvpe', 'RMVPE'], ['pm', 'Parselmouth (PM)']], '当前环境已核实支持的音高提取方式。'],
      ['rvc.indexRate', '索引检索比例', 'range', 0, 1, 0.01, '', '提高模型音色特征的参与程度；仅选择索引后生效。'],
      ['rvc.protect', '辅音与呼吸保护', 'range', 0, 0.5, 0.01, '', '较低值通常提供更强保护；0.5 关闭保护。'],
      ['rvc.rmsMixRate', '音量包络混合', 'range', 0, 1, 0.01, '', '0 更接近输入音量包络，1 更接近转换后的音量包络。'],
      ['rvc.resampleSr', '输出重采样', 'select', [[0, '保持模型采样率'], [32000, '32,000 Hz'], [40000, '40,000 Hz'], [44100, '44,100 Hz'], [48000, '48,000 Hz']], '通常保持模型采样率即可。', true]
    ] },
    { id: 'mix', number: '04', title: '混音与输出', description: '平衡人声与伴奏，设置片段边缘与输出电平', fields: [
      ['mix.vocalGain', '转换人声音量', 'range', 0, 2, 0.01, '倍', '1.00 为原始增益，0 静音。'],
      ['mix.instrumentalGain', '伴奏音量', 'range', 0, 2, 0.01, '倍', '控制伴奏与人声之间的相对音量。'],
      ['mix.fadeIn', '片段淡入', 'range', 0, 2, 0.01, '秒', '平滑处理片段开头。'],
      ['mix.fadeOut', '片段淡出', 'range', 0, 2, 0.01, '秒', '平滑处理片段结尾。'],
      ['mix.limit', '输出峰值上限', 'range', 0.5, 1, 0.01, '', '混音输出使用此峰值上限控制电平。']
    ] }
  ];
  function onChange(path, value) {
    set(state.draft, path, value);
    clearErrors();
    if (!state.conflict) hideNotice();
    updateDependentFields();
    updateStatus();
  }
  function labelFor(path, title) {
    const label = node('label', '', title);
    label.htmlFor = `input-${path}`;
    return label;
  }
  function switchControl(path, checked, onInput) {
    const wrapper = node('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.id = `input-${path}`; input.checked = checked;
    input.setAttribute('aria-label', path === 'uvr.compensate' ? '按模型自动补偿' : definitions.flatMap(p => p.fields).find(f => f[0] === path)?.[1] || path);
    input.addEventListener('change', () => onInput(input.checked));
    wrapper.append(input, node('span', 'switch-track'));
    return wrapper;
  }
  function numericControl(path, min, max, step, unit, withRange = true) {
    const row = node('div', 'range-row');
    const number = document.createElement('input');
    number.className = 'control-number'; number.type = 'number'; number.id = `input-${path}`;
    number.min = min; number.max = max; number.step = step; number.value = get(state.draft, path) ?? '';
    const range = document.createElement('input');
    range.type = 'range'; range.min = min; range.max = max; range.step = step; range.value = number.value;
    range.setAttribute('aria-label', definitions.flatMap(p => p.fields).find(f => f[0] === path)?.[1] || '分离补偿');
    range.addEventListener('input', () => { number.value = range.value; onChange(path, Number(range.value)); });
    number.addEventListener('input', () => { if (number.value !== '') range.value = number.value; onChange(path, number.value === '' ? null : Number(number.value)); });
    if (withRange) row.append(range);
    row.append(append(node('div', 'number-unit'), number, unit ? node('span', '', unit) : null));
    return { row, number, range: withRange ? range : null };
  }
  function createField(definition) {
    const [path, title, type, ...args] = definition;
    const wrapper = node('div', 'field');
    wrapper.dataset.field = path;
    const label = append(node('div', 'field-label'), labelFor(path, title));
    const value = get(state.draft, path);
    let input, range;
    if (type === 'toggle') {
      const text = append(node('div'), label, node('p', 'field-hint', args[0]));
      const control = switchControl(path, !!value, checked => onChange(path, checked));
      input = control.querySelector('input');
      wrapper.append(append(node('div', 'toggle-row'), text, control));
    } else {
      wrapper.append(label);
      if (type === 'range' || type === 'number') {
        const [min, max, step, unit, hint] = args;
        const numeric = numericControl(path, min, max, step, unit, type === 'range');
        input = numeric.number; range = numeric.range;
        wrapper.append(numeric.row);
        if (type === 'range') wrapper.append(append(node('div', 'range-labels'), node('span', '', `${min}${unit ? ' ' + unit : ''}`), node('span', '', `${max}${unit ? ' ' + unit : ''}`)));
        wrapper.append(node('p', 'field-hint', hint));
      } else if (type === 'select' || type === 'catalog') {
        input = document.createElement('select'); input.className = 'control-select'; input.id = `input-${path}`;
        let options;
        if (type === 'catalog') {
          options = (state.catalog[args[0]] || []).map(item => [item.id, `${item.label || String(item.id).split(/[\\/]/).pop()}${item.available === false ? '（不可用）' : ''}`, item.available === false]);
          if (path === 'rvc.indexId' && !options.some(option => option[0] === '')) options.unshift(['', '不使用索引 · 检索关闭', false]);
          if (!options.some(option => String(option[0]) === String(value ?? ''))) options.unshift([value ?? '', value ? `${String(value).split(/[\\/]/).pop()}（当前配置，未在目录中发现）` : '暂无可用模型', false]);
        } else {
          options = args[0].map(option => [...option]);
          if (value !== undefined && !options.some(option => String(option[0]) === String(value))) options.unshift([value, `${value}（当前配置，不在可选范围）`, true]);
        }
        for (const [id, text, unavailable] of options) {
          const option = node('option', '', text); option.value = String(id); option.disabled = !!unavailable; input.append(option);
        }
        input.value = String(value ?? '');
        input.addEventListener('change', () => onChange(path, type === 'select' && args[2] ? Number(input.value) : input.value));
        wrapper.append(input, node('p', 'field-hint', args[1]));
        if (path === 'rvc.indexId') { const note = node('div', 'inline-info'); note.id = 'index-note'; wrapper.append(note); }
      } else if (type === 'compensate') {
        const autoLabel = node('label', 'compact-check');
        const auto = document.createElement('input'); auto.type = 'checkbox'; auto.checked = value == null; auto.id = 'compensate-auto';
        autoLabel.append(auto, node('span', '', '按模型自动'));
        const numeric = numericControl(path, 0.5, 2, 0.01, '倍');
        input = numeric.number; range = numeric.range;
        if (value == null) { input.value = '1'; range.value = '1'; }
        auto.addEventListener('change', () => onChange(path, auto.checked ? null : Number(input.value || 1)));
        wrapper.append(autoLabel, numeric.row, node('p', 'field-hint', '自动模式使用模型的推荐补偿；关闭后可手动指定。'));
      }
    }
    const error = node('p', 'field-error'); error.hidden = true; error.id = `error-${path}`;
    wrapper.append(error);
    if (input) input.setAttribute('aria-describedby', error.id);
    fields.set(path, { wrapper, input, range, error, definition });
    return wrapper;
  }
  function renderSettings() {
    fields.clear();
    $('panels').replaceChildren();
    for (const section of definitions) {
      const panel = node('section', 'panel'); panel.id = `panel-${section.id}`; panel.hidden = section.id !== state.active;
      panel.setAttribute('aria-label', section.title);
      panel.append(append(node('div', 'panel-heading'), node('span', 'panel-number', section.number), append(node('div'), node('h2', '', section.title), node('p', '', section.description))));
      for (const field of section.fields) panel.append(createField(field));
      $('panels').append(panel);
    }
    $('loading').hidden = true; $('panels').hidden = false;
    updateDependentFields(); updateStatus();
  }
  function updateDependentFields() {
    if (!state.draft) return;
    const compensate = fields.get('uvr.compensate');
    if (compensate) { compensate.input.disabled = state.draft.uvr.compensate == null; compensate.range.disabled = compensate.input.disabled; }
    const device = fields.get('uvr.deviceId');
    if (device) device.input.disabled = state.draft.uvr.device !== 'directml';
    const index = fields.get('rvc.indexRate');
    if (index) { index.input.disabled = !state.draft.rvc.indexId; index.range.disabled = index.input.disabled; }
    if ($('index-note')) $('index-note').textContent = state.draft.rvc.indexId ? '已选择索引。请确保该索引与当前音色模型匹配。' : '当前未使用索引，索引检索比例不会生效。';
  }
  function clearErrors() {
    for (const { wrapper, input, error } of fields.values()) { wrapper.classList.remove('invalid'); error.hidden = true; input?.removeAttribute('aria-invalid'); }
  }
  function fieldError(path, message) {
    const field = fields.get(String(path).replace(/^settings\./, ''));
    if (!field) return;
    field.error.textContent = message; field.error.hidden = false; field.wrapper.classList.add('invalid'); field.input?.setAttribute('aria-invalid', 'true');
  }
  function validate() {
    clearErrors();
    let first;
    for (const [path, field] of fields) {
      const value = get(state.draft, path);
      const type = field.definition[2];
      if ((type === 'range' || type === 'number' || type === 'compensate') && !(path === 'uvr.compensate' && value === null)) {
        const min = Number(field.input.min), max = Number(field.input.max), step = Number(field.input.step);
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (step === 1 && !Number.isInteger(value))) {
          fieldError(path, `请输入 ${min} 至 ${max} 之间的${step === 1 ? '整数' : '数值'}。`);
          first ||= path;
        }
      }
    }
    if (state.draft.defaultSeconds > state.draft.maxSeconds) { fieldError('defaultSeconds', '默认片段时长不能超过片段时长上限。'); first ||= 'defaultSeconds'; }
    if (first) {
      activate(definitions.find(section => section.fields.some(field => field[0] === first)).id);
      fields.get(first).input?.focus(); return false;
    }
    return true;
  }
  function activate(id) {
    state.active = id;
    document.querySelectorAll('[data-tab]').forEach(button => { const active = button.dataset.tab === id; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    definitions.forEach(section => { const panel = $(`panel-${section.id}`); if (panel) panel.hidden = section.id !== id; });
  }
  function renderHealth(health) {
    $('health').replaceChildren();
    const rows = [
      ['↔', '翻唱桥接', health?.bridge?.ok === true ? '连接正常' : health?.bridge?.ok === false ? '连接失败' : '尚未确认', health?.bridge?.ok],
      ['♫', '网易云音乐', health?.netease?.configured === false ? '未配置' : health?.netease?.loggedIn === true ? '已登录' : health?.netease?.loggedIn === false ? '未登录' : '尚未确认', health?.netease?.configured === false ? false : health?.netease?.loggedIn],
      ['⌘', 'Python', health?.runtime?.python === true ? '已就绪' : health?.runtime?.python === false ? '未发现' : '尚未确认', health?.runtime?.python],
      ['≋', 'FFmpeg', health?.runtime?.ffmpeg === true ? '已就绪' : health?.runtime?.ffmpeg === false ? '未发现' : '尚未确认', health?.runtime?.ffmpeg]
    ];
    for (const [icon, name, label, ok] of rows) $('health').append(append(node('div', 'health-row'), node('span', 'health-icon', icon), node('span', 'health-name', name), node('span', `health-badge ${ok === true ? 'ok' : ok === false ? 'warn' : ''}`, label)));
  }
  function adopt(data) {
    if (!data || !data.settings || data.revision === undefined) throw new Error('设置数据不完整，请检查项目服务。');
    state.revision = data.revision; state.saved = copy(data.settings); state.draft = copy(data.settings); state.defaults = data.defaults ? copy(data.defaults) : null; state.catalog = data.catalog || {}; state.conflict = false;
    renderSettings(); renderHealth(data.health);
    $('check').disabled = false; $('refresh-jobs').disabled = false;
  }
  async function bootstrap() {
    $('save').disabled = true; $('restore').disabled = true; hideNotice();
    try { adopt(await api('/api/bootstrap')); } catch (error) { showNotice(error.message || '设置加载失败，请检查服务连接。', false, true); updateStatus('设置加载失败', 'error'); if (!state.saved) { $('loading').replaceChildren(node('span', '', '设置暂时无法读取，请使用上方按钮重新加载。')); } }
  }
  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const statuses = { queued: '等待中', pending: '等待中', running: '处理中', processing: '处理中', complete: '已完成', completed: '已完成', succeeded: '已完成', success: '已完成', done: '已完成', failed: '失败', error: '失败', cancelled: '已取消', canceled: '已取消' };
  const stages = { queued: '任务排队', download: '下载歌曲', downloading: '下载歌曲', clip: '截取片段', clipping: '截取片段', uvr: '人声分离', separate: '人声分离', separation: '人声分离', rvc: '音色转换', conversion: '音色转换', mix: '混音输出', mixing: '混音输出', done: '处理完成', completed: '处理完成' };
  async function loadJobs() {
    const button = $('refresh-jobs'); button.disabled = true; button.textContent = '刷新中…';
    try {
      const data = await api('/api/jobs');
      if (!Array.isArray(data.items)) throw new Error('任务数据格式不完整。');
      $('jobs').replaceChildren(); $('job-count').textContent = data.items.length ? String(data.items.length) : '';
      if (!data.items.length) $('jobs').append(node('p', 'empty', '还没有翻唱任务\n发起任务后，可以在这里查看进度。'));
      for (const item of data.items) {
        const status = String(item.status || '');
        const style = ['complete', 'completed', 'succeeded', 'success', 'done'].includes(status) ? 'ok' : ['failed', 'error'].includes(status) ? 'failed' : ['running', 'processing'].includes(status) ? 'running' : '';
        const card = node('article', 'job');
        card.append(append(node('div', 'job-top'), node('span', 'job-id', `# ${String(item.id ?? '未知任务')}`), node('span', `job-status ${style}`, statuses[status] || status || '状态未知')));
        card.append(node('div', 'job-stage', `${stages[item.stage] || item.stage || '等待任务状态'}${item.voiceId ? ' · ' + String(item.voiceId).split(/[\\/]/).pop() : ''}`));
        card.append(node('div', 'job-meta', `${Number.isFinite(item.seconds) ? item.seconds + ' 秒 · ' : ''}${formatTime(item.updatedAt || item.createdAt)}`));
        if (item.error) card.append(node('p', 'job-error', typeof item.error === 'object' ? item.error.message || '任务失败' : String(item.error)));
        $('jobs').append(card);
      }
      $('jobs-time').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 手动刷新任务状态`;
    } catch (error) { $('jobs').replaceChildren(node('p', 'empty', error.message || '任务读取失败，请重试。')); $('job-count').textContent = ''; }
    finally { button.disabled = !state.csrf; button.textContent = '刷新 ↻'; }
  }
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.saved || state.busy || state.conflict || !validate()) return;
    state.busy = true; updateStatus('正在保存…'); hideNotice();
    // Capture the submitted draft; fields are disabled until the response arrives.
    const payload = { revision: state.revision, settings: copy(state.draft) };
    $('panels').querySelectorAll('input,select').forEach(input => { input.disabled = true; });
    try {
      adopt(await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
      showNotice('设置已保存，将用于下一次翻唱。', true); updateStatus('已保存 · 下一次翻唱生效', 'success');
    } catch (error) {
      if (error.status === 409) { state.conflict = true; showNotice('配置已被其他窗口修改。请重新加载最新设置后再编辑；当前修改尚未保存。', false, true); }
      else { showNotice(error.message || '保存失败，请稍后重试。'); if (error.field) { fieldError(error.field, error.message); const path = String(error.field).replace(/^settings\./, ''); const section = definitions.find(part => part.fields.some(field => field[0] === path)); if (section) activate(section.id); } }
      updateStatus(state.conflict ? '配置冲突 · 请重新加载' : '保存失败 · 修改仍未保存', 'error');
    } finally {
      state.busy = false;
      $('panels').querySelectorAll('input,select').forEach(input => { input.disabled = false; });
      updateDependentFields();
      $('save').disabled = !dirty() || state.conflict; $('restore').disabled = !state.defaults || state.conflict;
    }
  });
  $('restore').addEventListener('click', () => { if (!state.defaults || state.busy || state.conflict) return; state.draft = copy(state.defaults); hideNotice(); renderSettings(); updateStatus(dirty() ? '推荐值已载入草稿 · 保存后生效' : '当前已为推荐设置', dirty() ? 'dirty' : 'success'); });
  $('check').addEventListener('click', async () => {
    const button = $('check'); button.disabled = true; button.textContent = '检测中…';
    try { renderHealth(await api('/api/check', { method: 'POST' })); } catch (error) { showNotice(error.message || '环境检测失败，请稍后重试。'); }
    finally { button.disabled = false; button.textContent = '重新检测 ↻'; }
  });
  $('refresh-jobs').addEventListener('click', loadJobs);
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => activate(button.dataset.tab)));
  window.addEventListener('beforeunload', (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  async function init() {
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('会话初始化失败，请重新加载页面。');
      const data = await response.json();
      if (!data.csrfToken) throw new Error('会话缺少校验信息，请重新加载页面。');
      state.csrf = data.csrfToken;
      await bootstrap();
      await loadJobs();
    } catch (error) { showNotice(error.message || '无法连接工作台，请重新加载页面。'); $('loading').replaceChildren(node('span', '', '工作台会话无法建立，请刷新页面重试。')); updateStatus('连接失败', 'error'); }
  }
  init();
})();
