(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const ui = {
    body: document.body,
    connectForm: $('#connect-form'), bridgeUrl: $('#bridge-url'), bridgeKey: $('#bridge-key'), connectError: $('#connect-error'),
    connectedDetails: $('#connected-details'), hostStatus: $('#host-status'), disconnect: $('#disconnect-button'),
    pill: $('#connection-pill'), pillLabel: $('#connection-label'), sessions: $('#session-list'), newSession: $('#new-session'),
    title: $('#conversation-title'), empty: $('#conversation-empty'), messages: $('#message-list'), notice: $('#task-notice'),
    runState: $('#run-state'), stop: $('#stop-task'), promptForm: $('#prompt-form'), prompt: $('#prompt-input'), send: $('#send-button'),
    charCount: $('#char-count'), demo: $('#demo-button'), toast: $('#toast'), toggleKey: $('#toggle-key')
  };

  const state = {
    bridgeUrl: '', key: '', connected: false, sessions: [], activeId: '', pollTimer: null,
    isSending: false, isDemo: false, lastHistorySignature: '', toastTimer: null
  };

  const demoSessions = [
    { sessionId: 'demo-a', title: '整理项目更新说明', updatedAt: Date.now() - 900000, running: false },
    { sessionId: 'demo-b', title: '检查 Android 构建日志', updatedAt: Date.now() - 4600000, running: true },
    { sessionId: 'demo-c', title: '梳理一周待办', updatedAt: Date.now() - 86400000, running: false }
  ];
  const demoMessages = {
    'demo-a': [
      { role: 'user', text: '请把最近的版本更新整理成三条简短说明。' },
      { role: 'assistant', text: '好的。我会先查看项目里的版本记录，再把主要变更、兼容性和升级提醒压缩成三条。' }
    ],
    'demo-b': [
      { role: 'user', text: '检查最近一次 Android 构建日志，指出最先出现的错误。' },
      { role: 'assistant', text: '我正在读取构建日志。演示模式只展示示例，不会连接设备、读取项目或实际执行任务。' }
    ],
    'demo-c': [
      { role: 'user', text: '把本周待办按优先级归纳一下。' },
      { role: 'assistant', text: '请连接真实的 DSH 桥接服务后再发送任务。' }
    ]
  };

  function toast(message, isError = false) {
    ui.toast.textContent = message;
    ui.toast.classList.toggle('error', isError);
    ui.toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 3100);
  }

  function setStatus(online, label, demo = false) {
    ui.pill.classList.toggle('is-online', online && !demo);
    ui.pill.classList.toggle('is-offline', !online && !demo);
    ui.pillLabel.textContent = label;
    ui.body.classList.toggle('is-demo', demo);
  }

  function messageError(error) {
    const text = String(error?.message || error || '连接失败');
    return text.length > 240 ? `${text.slice(0, 237)}…` : text;
  }

  function checkedUrl(value) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('请输入有效的桥接服务地址。'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('桥接地址必须使用 HTTPS。');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (location.protocol === 'https:' && url.protocol !== 'https:' && !loopback) {
      throw new Error('公开 HTTPS 网页不能安全调用 HTTP 桥接地址；请给桥接服务配置 HTTPS。');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('地址中不要包含用户名、密码、查询参数或片段。');
    return url.toString().replace(/\/$/, '');
  }

  async function api(path, options = {}) {
    const response = await fetch(`${state.bridgeUrl}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${state.key}` },
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit'
    });
    let data;
    try { data = await response.json(); } catch { throw new Error(`桥接服务返回了无法识别的响应（HTTP ${response.status}）。`); }
    if (!response.ok || data?.ok === false) {
      const detail = data?.error?.message || data?.message || `请求失败（HTTP ${response.status}）`;
      throw new Error(detail);
    }
    return data;
  }

  function setConnected(connected) {
    state.connected = connected;
    ui.connectedDetails.hidden = !connected;
    ui.newSession.disabled = !connected;
    ui.prompt.disabled = !connected || !state.activeId || state.isDemo;
    ui.send.disabled = !connected || !state.activeId || state.isDemo || state.isSending;
    ui.stop.disabled = !connected || !state.activeId || state.isDemo;
    if (!connected) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      state.sessions = [];
      state.activeId = '';
      state.lastHistorySignature = '';
      ui.sessions.replaceChildren();
      ui.messages.hidden = true;
      ui.empty.hidden = false;
      ui.notice.hidden = true;
      ui.title.textContent = '任务工作区';
      ui.prompt.placeholder = '连接 DSH 并选择一个会话后输入任务…';
      renderSessions();
      renderMessages([]);
      ui.runState.textContent = '等待连接';
    }
  }

  function setNotice(message, isError = false) {
    ui.notice.textContent = message;
    ui.notice.classList.toggle('is-error', isError);
    ui.notice.hidden = !message;
  }

  function localTime(value) {
    const date = new Date(value || Date.now());
    if (!Number.isFinite(date.getTime())) return '最近更新';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function sessionTitle(session) {
    const title = String(session.title || '').trim();
    if (title) return title;
    return session.blank ? '新会话' : `会话 ${String(session.sessionId || '').slice(0, 8)}`;
  }

  function renderSessions() {
    if (!state.sessions.length) {
      const wrapper = document.createElement('div');
      wrapper.className = 'empty-sessions';
      const orbit = document.createElement('span'); orbit.className = 'empty-orbit';
      const label = document.createElement('p'); label.textContent = state.connected ? '暂无会话，点击 ＋ 新建' : '连接后显示 DSH 会话';
      wrapper.append(orbit, label);
      ui.sessions.replaceChildren(wrapper);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const session of state.sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `session-item${session.sessionId === state.activeId ? ' active' : ''}`;
      const indicator = document.createElement('span'); indicator.className = 'session-indicator';
      const content = document.createElement('span'); content.className = 'session-item-content';
      const title = document.createElement('span'); title.className = 'session-item-title'; title.textContent = sessionTitle(session);
      const meta = document.createElement('span'); meta.className = 'session-item-meta'; meta.textContent = `${session.running ? '正在运行 · ' : ''}${localTime(session.updatedAt)}`;
      content.append(title, meta); button.append(indicator, content);
      button.addEventListener('click', () => selectSession(session.sessionId));
      fragment.append(button);
    }
    ui.sessions.replaceChildren(fragment);
  }

  function renderMessages(messages) {
    if (!messages.length) {
      ui.messages.hidden = true;
      ui.empty.hidden = false;
      return;
    }
    ui.empty.hidden = true;
    ui.messages.hidden = false;
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      const role = message.role === 'user' ? 'user' : 'assistant';
      const row = document.createElement('article');
      row.className = `message ${role}`;
      const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = role === 'user' ? '我' : 'D';
      const bubble = document.createElement('div'); bubble.className = 'message-bubble';
      const label = document.createElement('div'); label.className = 'message-role'; label.textContent = role === 'user' ? '任务' : 'DSH';
      const text = document.createElement('div'); text.textContent = message.text || '';
      bubble.append(label, text); row.append(avatar, bubble); fragment.append(row);
    }
    ui.messages.replaceChildren(fragment);
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function updateComposer() {
    const count = ui.prompt.value.length;
    ui.charCount.textContent = `${count.toLocaleString('zh-CN')} / 8,000`;
    ui.send.disabled = !state.connected || !state.activeId || state.isDemo || state.isSending || !ui.prompt.value.trim();
  }

  async function loadSessions(keepSelection = true) {
    const data = await api('/v1/sessions');
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (!keepSelection || !state.sessions.some(s => s.sessionId === state.activeId)) {
      state.activeId = state.sessions[0]?.sessionId || '';
    }
    renderSessions();
    if (state.activeId) await loadHistory();
    else {
      ui.title.textContent = '任务工作区';
      ui.prompt.disabled = true;
      ui.send.disabled = true;
      renderMessages([]);
    }
  }

  async function loadHistory() {
    if (!state.activeId) return;
    const requestedId = state.activeId;
    const data = await api(`/v1/sessions/${encodeURIComponent(requestedId)}/history`);
    if (requestedId !== state.activeId) return;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const signature = JSON.stringify(messages.map(m => [m.role, m.text]));
    if (signature !== state.lastHistorySignature) {
      state.lastHistorySignature = signature;
      renderMessages(messages);
    }
    ui.title.textContent = state.sessions.find(s => s.sessionId === state.activeId)?.title || 'DSH 会话';
    const running = state.sessions.find(s => s.sessionId === state.activeId)?.running;
    ui.runState.textContent = running ? '正在执行' : '已连接';
    ui.runState.classList.toggle('is-running', Boolean(running));
    if (running) ui.prompt.placeholder = 'DSH 正在执行；新消息会排队…';
    else ui.prompt.placeholder = '输入要交给 DSH 的任务…';
    ui.prompt.disabled = false;
    ui.stop.disabled = false;
    updateComposer();
  }

  async function selectSession(id) {
    if (!state.connected || !id) return;
    state.activeId = id;
    state.lastHistorySignature = '';
    renderSessions();
    ui.title.textContent = sessionTitle(state.sessions.find(s => s.sessionId === id) || { sessionId: id });
    if (state.isDemo) {
      renderMessages(demoMessages[id] || []);
      return;
    }
    ui.empty.hidden = false;
    ui.messages.hidden = true;
    ui.empty.querySelector('h3').textContent = '正在读取会话…';
    try { await loadHistory(); }
    catch (error) { setNotice(`无法读取记录：${messageError(error)}`, true); }
    finally { ui.empty.querySelector('h3').textContent = '先连上设备，再开始任务'; }
  }

  async function startPoll() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (!state.connected || !state.activeId || document.hidden) return;
      try {
        await loadSessions(true);
      } catch (error) {
        ui.runState.textContent = '同步暂时中断';
        ui.runState.classList.remove('is-running');
        setNotice(`与 DSH 同步失败：${messageError(error)}`, true);
      }
    }, 4500);
  }

  async function connect(event) {
    event.preventDefault();
    ui.connectError.hidden = true;
    ui.connectError.textContent = '';
    try {
      state.bridgeUrl = checkedUrl(ui.bridgeUrl.value);
      state.key = ui.bridgeKey.value.trim();
      if (state.key.length < 16) throw new Error('访问密钥看起来过短，请使用桥接服务生成的完整密钥。');
      ui.connectForm.querySelector('button[type="submit"]').disabled = true;
      ui.connectForm.querySelector('.button-text').textContent = '正在验证…';
      const status = await api('/v1/status');
      if (!status.dshReady) throw new Error('桥接服务已响应，但暂时连不上 DSH 主机。请检查目标 DSH 是否在运行、启动令牌是否有效。');
      state.isDemo = false;
      setConnected(true);
      setStatus(true, 'DSH 已连接');
      ui.hostStatus.textContent = 'DSH 主机在线';
      await loadSessions(false);
      if (!state.activeId) {
        ui.runState.textContent = '已连接 · 新建会话';
        ui.prompt.placeholder = '创建或选择会话后输入任务…';
      }
      ui.prompt.disabled = !state.activeId;
      ui.send.disabled = !state.activeId;
      setNotice('连接成功。发送的任务会在目标 DSH 主机执行；手机端原生授权仍由设备本身处理。');
      startPoll();
      toast('已安全连接到 DSH 桥接服务。');
    } catch (error) {
      state.key = '';
      ui.bridgeKey.value = '';
      ui.connectError.textContent = messageError(error);
      ui.connectError.hidden = false;
      setStatus(false, '连接失败');
      setConnected(false);
    } finally {
      const button = ui.connectForm.querySelector('button[type="submit"]');
      button.disabled = false;
      ui.connectForm.querySelector('.button-text').textContent = '连接 DSH';
    }
  }

  async function createSession() {
    if (!state.connected || state.isDemo) return;
    try {
      const data = await api('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const id = data.session?.sessionId;
      if (!id) throw new Error('DSH 没有返回会话 ID。');
      state.activeId = id;
      state.lastHistorySignature = '';
      await loadSessions(true);
      setNotice('已创建新会话。手机端的操控权限和确认仍由 DSH Go 原生界面管理。');
      toast('新会话已创建。');
      ui.prompt.focus();
      updateComposer();
    } catch (error) { toast(`新建失败：${messageError(error)}`, true); }
  }

  async function sendPrompt(event) {
    event.preventDefault();
    const text = ui.prompt.value.trim();
    if (!text || !state.activeId || state.isSending || state.isDemo) return;
    state.isSending = true;
    updateComposer();
    ui.runState.textContent = '正在发送';
    ui.runState.classList.add('is-running');
    setNotice('正在将任务提交给 DSH…');
    try {
      const data = await api(`/v1/sessions/${encodeURIComponent(state.activeId)}/prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
      });
      ui.prompt.value = '';
      updateComposer();
      const request = data.requestId ? `（请求 ${data.requestId.slice(0, 8)}）` : '';
      setNotice(`任务已提交给 DSH${request}。如果需要手机权限或关键操作确认，请在目标设备的 DSH Go 原生界面处理。`);
      await loadSessions(true);
      toast('任务已发送。');
    } catch (error) {
      setNotice(`任务未能确认送达：${messageError(error)}。请先检查会话状态，不要盲目重复发送。`, true);
      toast('发送失败，请先核对会话状态。', true);
    } finally {
      state.isSending = false;
      ui.runState.classList.remove('is-running');
      updateComposer();
    }
  }

  async function stopTask() {
    if (!state.connected || !state.activeId || state.isDemo) return;
    try {
      await api(`/v1/sessions/${encodeURIComponent(state.activeId)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setNotice('已向 DSH 发送停止请求。已发生的操作无法撤回，请在目标设备检查当前状态。');
      toast('已发送停止请求。');
      await loadSessions(true);
    } catch (error) { toast(`停止请求失败：${messageError(error)}`, true); }
  }

  function disconnect() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.key = '';
    state.bridgeUrl = '';
    state.connected = false;
    state.isDemo = false;
    state.activeId = '';
    state.sessions = [];
    state.lastHistorySignature = '';
    ui.bridgeKey.value = '';
    ui.bridgeUrl.value = '';
    ui.connectError.hidden = true;
    ui.prompt.value = '';
    setConnected(false);
    setStatus(false, '尚未连接');
    setNotice('已断开网页与桥接服务的连接。');
    toast('已断开连接；访问密钥已从当前页面内存清除。');
  }

  function enableDemo() {
    clearInterval(state.pollTimer);
    state.isDemo = true;
    state.connected = true;
    state.key = '';
    state.sessions = demoSessions;
    state.activeId = demoSessions[0].sessionId;
    state.lastHistorySignature = '';
    setStatus(false, '演示数据', true);
    setConnected(true);
    ui.connectedDetails.hidden = false;
    ui.hostStatus.textContent = '本地模拟 · 不连接设备';
    ui.newSession.disabled = true;
    ui.prompt.disabled = true;
    ui.send.disabled = true;
    ui.stop.disabled = true;
    ui.prompt.placeholder = '演示模式不可发送真实任务';
    ui.title.textContent = demoSessions[0].title;
    ui.runState.textContent = '仅供预览';
    ui.empty.hidden = true;
    renderSessions();
    renderMessages(demoMessages[state.activeId]);
    setNotice('演示模式只展示示例消息；没有访问网络、连接 DSH 或执行任何任务。');
    toast('已进入本地演示模式。');
  }

  ui.connectForm.addEventListener('submit', connect);
  ui.disconnect.addEventListener('click', disconnect);
  ui.newSession.addEventListener('click', createSession);
  ui.promptForm.addEventListener('submit', sendPrompt);
  ui.prompt.addEventListener('input', updateComposer);
  ui.stop.addEventListener('click', stopTask);
  ui.demo.addEventListener('click', enableDemo);
  ui.toggleKey.addEventListener('click', () => {
    const hidden = ui.bridgeKey.type === 'password';
    ui.bridgeKey.type = hidden ? 'text' : 'password';
    ui.toggleKey.textContent = hidden ? '隐藏' : '显示';
    ui.toggleKey.setAttribute('aria-label', hidden ? '隐藏访问密钥' : '显示访问密钥');
  });
  window.addEventListener('pagehide', () => { state.key = ''; clearInterval(state.pollTimer); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.connected && !state.isDemo) void loadSessions(true).catch(() => {}); });

  setStatus(false, '尚未连接');
  renderSessions();
})();
