(function () {
  // ── Electron-safe replacements for prompt / alert / confirm ──────────────
  function _modal({ msg, hasInput, defaultVal = '', danger = false, hasCancel = true }) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('_eModal');
      const msgEl   = document.getElementById('_eMsg');
      const input   = document.getElementById('_eInput');
      const okBtn   = document.getElementById('_eOk');
      const cancelBtn = document.getElementById('_eCancel');
      msgEl.textContent = msg;
      input.style.display = hasInput ? '' : 'none';
      input.value = defaultVal;
      cancelBtn.style.display = hasCancel ? '' : 'none';
      okBtn.style.background = danger ? '#e53e3e' : '#5dd1ff';
      okBtn.style.borderColor = danger ? '#e53e3e' : '#5dd1ff';
      okBtn.style.color = danger ? '#fff' : '#000';
      overlay.classList.add('on');
      if (hasInput) setTimeout(() => input.focus(), 50);
      function finish(val) {
        overlay.classList.remove('on');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        resolve(val);
      }
      function onOk() { finish(hasInput ? input.value : true); }
      function onCancel() { finish(hasInput ? null : false); }
      function onKey(e) { if (e.key === 'Enter') finish(input.value); if (e.key === 'Escape') finish(null); }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
    });
  }
  const showPrompt  = (msg, def) => _modal({ msg, hasInput: true, defaultVal: def || '', hasCancel: true });
  const showAlert   = (msg)      => _modal({ msg, hasInput: false, hasCancel: false });
  const showConfirm = (msg, danger = false) => _modal({ msg, hasInput: false, hasCancel: true, danger });
  // ─────────────────────────────────────────────────────────────────────────

  const loginScreen = document.getElementById('loginScreen');
  const appShell = document.getElementById('appShell');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const loginAttemptsBanner = document.getElementById('loginAttempts');
  const attemptValue = document.getElementById('attemptValue');
  const loginButton = document.getElementById('loginButton');
  const contactMeBtn = document.getElementById('contactMeBtn');
  const contactPanel = null; // old inline contact panel removed; modal is handled in portal.html
  const logoutBtn = document.getElementById('logoutBtn');
  const adminOpenBtn = document.getElementById('adminOpenBtn');
  const sessionUsername = document.getElementById('sessionUsername');
  const timeLeftBadge = document.getElementById('timeLeftBadge');
  const displayNameInput = document.getElementById('displayNameInput');
  const saveDisplayNameBtn = document.getElementById('saveDisplayName');
  const liveStreamNameInput = document.getElementById('liveStreamNameInput');
  const saveLiveStreamNameBtn = document.getElementById('saveLiveStreamName');

  const adminPanel = document.getElementById('adminPanel');
  const closeAdminBtn = document.getElementById('closeAdminBtn');
  const createUserForm = document.getElementById('createUserForm');
  const userDurationSelect = document.getElementById('userDuration');
  const customDurationWrap = document.getElementById('customDurationWrap');
  const userCustomDurationInput = document.getElementById('userCustomDuration');
  const refreshCustomersBtn = document.getElementById('refreshCustomersBtn');
  const deleteExpiredBtn = document.getElementById('deleteExpiredBtn');
  const usersList = document.getElementById('usersList');
  const adminSearchInput = document.getElementById('adminSearchInput');
  const adminEmptyState = document.getElementById('adminEmptyState');
  const totalUsersStat = document.getElementById('totalUsersStat');
  const activeUsersStat = document.getElementById('activeUsersStat');
  const waitingUsersStat = document.getElementById('waitingUsersStat');
  const expiringUsersStat = document.getElementById('expiringUsersStat');

  let loginAttempts = 0;
  let countdownInterval = null;
  let heartbeatInterval = null;
  let customerRefreshInterval = null;
  let currentUser = null;
  let cachedUsers = [];

  const API_BASE = '';

  const AUTH_ENDPOINTS = {
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    status: '/api/auth/status',
    users: '/api/users',
  };

  const apiUrl = (path) => `${API_BASE}${path}`;

  // Contact Admin is now a modal in portal.html. Old dropdown/panel behavior removed.
  if (contactMeBtn) {
    contactMeBtn.removeAttribute('aria-controls');
    contactMeBtn.removeAttribute('aria-expanded');
  }

  function getDisplayNameStorageKey(username) {
    return `tiktok-display-name:${String(username || 'default').toLowerCase()}`;
  }

  function getStoredDisplayName(username) {
    try {
      const value = localStorage.getItem(getDisplayNameStorageKey(username));
      return (value || '').trim() || 'Host';
    } catch (err) {
      return 'Host';
    }
  }

  function saveDisplayNameForCurrentUser() {
    if (!currentUser || !displayNameInput) return;
    const value = (displayNameInput.value || '').trim() || 'Host';
    try {
      localStorage.setItem(getDisplayNameStorageKey(currentUser.username), value);
    } catch (err) {
      // ignore storage errors
    }
    displayNameInput.value = value;
  }

  function getLiveStreamNameStorageKey(username) {
    return `tiktok-live-stream-name:${String(username || 'default').toLowerCase()}`;
  }

  function getStoredLiveStreamName(username) {
    try {
      const value = localStorage.getItem(getLiveStreamNameStorageKey(username));
      return (value || '').trim();
    } catch (err) {
      return '';
    }
  }

  function saveLiveStreamNameForCurrentUser() {
    if (!currentUser || !liveStreamNameInput) return;
    const value = String(liveStreamNameInput.value || '').trim().replace(/^@+/, '');
    try {
      localStorage.setItem(getLiveStreamNameStorageKey(currentUser.username), value);
    } catch (err) {
      // ignore storage errors
    }
    liveStreamNameInput.value = value;
  }

  function generateDeviceId() {
    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
      deviceId = 'device_' + Math.random().toString(36).slice(2) + '_' + Date.now();
      localStorage.setItem('deviceId', deviceId);
    }
    return deviceId;
  }

  function updateAttemptsUI() {
    if (!attemptValue || !loginAttemptsBanner) return;
    attemptValue.textContent = loginAttempts.toString();
    if (loginAttempts > 0) {
      loginAttemptsBanner.classList.remove('hidden');
    } else {
      loginAttemptsBanner.classList.add('hidden');
    }
  }

  function showLoginError(message) {
    if (!loginError) return;
    loginError.textContent = message;
    loginError.classList.remove('hidden');
  }

  function clearLoginError() {
    if (!loginError) return;
    loginError.classList.add('hidden');
    loginError.textContent = '';
  }

  function formatTimeLeft(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return 'Expired';
    }
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days >= 30) {
      const months = Math.floor(days / 30);
      const remainingDays = days % 30;
      return remainingDays ? `${months}mo ${remainingDays}d` : `${months}mo`;
    }
    if (days > 0) {
      const remainingHours = hours % 24;
      return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
    }
    if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    }
    if (minutes > 0) {
      const remainingSeconds = seconds % 60;
      return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    return `${seconds}s`;
  }

  function formatDurationLabel(durationMinutes = 30) {
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return '30 minutes';
    }
    if (durationMinutes >= 1440) {
      const days = durationMinutes / 1440;
      if (days >= 30) {
        const months = days / 30;
        return `${months >= 12 ? (months / 12).toFixed(1) + ' years' : months.toFixed(1) + ' months'}`;
      }
      return `${days.toFixed(1)} days`;
    }
    if (durationMinutes >= 60) {
      const hours = durationMinutes / 60;
      return `${hours.toFixed(1)} hours`;
    }
    return `${durationMinutes} minutes`;
  }

  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  function startCountdown(expiresAt) {
    stopCountdown();

    if (!timeLeftBadge) return;

    if (!expiresAt) {
      timeLeftBadge.textContent = 'Awaiting activation';
      timeLeftBadge.classList.remove('hidden');
      return;
    }

    const expiry = new Date(expiresAt).getTime();

    function tick() {
      const diff = expiry - Date.now();
      if (diff <= 0) {
        timeLeftBadge.textContent = 'Expired';
        stopCountdown();
        handleUnauthenticated();
        return;
      }
      timeLeftBadge.textContent = `Time left: ${formatTimeLeft(diff)}`;
      timeLeftBadge.classList.remove('hidden');
    }

    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  async function performLogin(username, password) {
    try {
      const response = await fetch(apiUrl(AUTH_ENDPOINTS.login), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, deviceId: generateDeviceId() }),
      });

      const data = await response.json();

      if (!response.ok) {
        loginAttempts += 1;
        updateAttemptsUI();

        if (response.status === 429) {
          showLoginError(data.error || 'Too many attempts. Try again shortly.');
        } else {
          showLoginError(data.error || 'Invalid username or password');
        }
        return false;
      }

      loginAttempts = 0;
      updateAttemptsUI();
      clearLoginError();
      await fetchAuthStatus();
      return true;
    } catch (error) {
      console.error('Login error:', error);
      showLoginError('Network issue. Please try again.');
      return false;
    }
  }

  async function handleLogout() {
    try {
      await fetch(apiUrl(AUTH_ENDPOINTS.logout), {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      console.warn('Logout error:', error);
    }
    localStorage.removeItem('deviceId');

    if (adminPanel && adminPanel.classList.contains('active')) {
      adminPanel.classList.remove('active');
      document.body.style.overflow = '';
      if (customerRefreshInterval) {
        clearInterval(customerRefreshInterval);
        customerRefreshInterval = null;
      }
    }

    handleUnauthenticated();
  }

  function handleAuthenticated(user) {
    currentUser = user;
    if (loginScreen) loginScreen.classList.add('hidden');

    if (user.role === 'admin') {
      if (appShell) appShell.classList.add('hidden');
      openAdminPanel();
      return;
    }

    if (appShell) appShell.classList.remove('hidden');

    // "Make Video only" restriction: hide Mode 1 / Mode 2 so the user can only
    // open Make Video. Admins are never restricted.
    const restrictToMakeVideo = user.role !== 'admin' && Boolean(user.makeVideoOnly);
    const hostBtnEl = document.getElementById('openHost');
    const remoteBtnEl = document.getElementById('openRemote');
    if (hostBtnEl) hostBtnEl.classList.toggle('hidden', restrictToMakeVideo);
    if (remoteBtnEl) remoteBtnEl.classList.toggle('hidden', restrictToMakeVideo);

    if (sessionUsername) {
      sessionUsername.textContent = `@${user.username}`;
      sessionUsername.classList.remove('hidden');
    }

    if (displayNameInput) {
      displayNameInput.value = getStoredDisplayName(user.username);
    }
    if (liveStreamNameInput) {
      liveStreamNameInput.value = getStoredLiveStreamName(user.username);
    }

    if (logoutBtn) {
      logoutBtn.classList.remove('hidden');
    }

    if (adminOpenBtn) {
      adminOpenBtn.classList.add('hidden');
    }

    if (user.role === 'admin') {
      stopCountdown();
      if (timeLeftBadge) {
        timeLeftBadge.textContent = 'Admin access';
        timeLeftBadge.classList.remove('hidden');
      }
    } else if (user.expiresAt) {
      startCountdown(user.expiresAt);
      const timeLeft = formatTimeLeft(new Date(user.expiresAt).getTime() - Date.now());
      window.dispatchEvent(new CustomEvent('userAuthenticated', {
        detail: { timeLeft: timeLeft }
      }));
    } else if (timeLeftBadge) {
      timeLeftBadge.textContent = 'Activates on first login';
      timeLeftBadge.classList.remove('hidden');
    }

    if (!heartbeatInterval) {
      heartbeatInterval = setInterval(fetchAuthStatus, 15000);
    }
  }

  function handleUnauthenticated() {
    currentUser = null;
    stopCountdown();
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Stop overlay service if running (Android APK) when time expires
    if (window.AndroidOverlayBridge && typeof window.AndroidOverlayBridge.stopOverlay === 'function') {
      try { window.AndroidOverlayBridge.stopOverlay(); } catch (e) {}
    }
    // Unlock overlay session so user can use on another device
    if (typeof window.__unlockOverlay === 'function') {
      try { window.__unlockOverlay(); } catch (e) {}
    }

    if (sessionUsername) sessionUsername.classList.add('hidden');
    if (timeLeftBadge) timeLeftBadge.classList.add('hidden');
    if (logoutBtn) logoutBtn.classList.add('hidden');
    if (adminOpenBtn) adminOpenBtn.classList.add('hidden');

    if (appShell) appShell.classList.add('hidden');
    if (loginScreen) loginScreen.classList.remove('hidden');

    if (displayNameInput) {
      displayNameInput.value = 'Host';
    }
    if (liveStreamNameInput) {
      liveStreamNameInput.value = '';
    }

    closeAdminPanel();
  }

  async function fetchAuthStatus() {
    try {
      const response = await fetch(apiUrl(AUTH_ENDPOINTS.status), {
        credentials: 'include',
      });
      const data = await response.json();

      if (!response.ok || !data.authenticated) {
        handleUnauthenticated();
        return null;
      }

      handleAuthenticated(data.user);
      return data.user;
    } catch (error) {
      console.warn('Auth status error:', error);
      return null;
    }
  }

  function openAdminPanel() {
    if (!currentUser || currentUser.role !== 'admin') return;
    if (!adminPanel) return;

    adminPanel.classList.add('active');
    document.body.style.overflow = 'hidden';
    loadCustomers();

    if (!customerRefreshInterval) {
      customerRefreshInterval = setInterval(loadCustomers, 30000);
    }
  }

  function closeAdminPanel() {
    if (!adminPanel) return;
    adminPanel.classList.remove('active');
    document.body.style.overflow = '';
    if (customerRefreshInterval) {
      clearInterval(customerRefreshInterval);
      customerRefreshInterval = null;
    }
    if (currentUser && currentUser.role === 'admin') {
      handleUnauthenticated();
    }
  }

  function toggleCustomDurationInput() {
    const isCustom = userDurationSelect && userDurationSelect.value === 'custom';
    if (customDurationWrap) {
      customDurationWrap.style.display = isCustom ? 'block' : 'none';
    }
    if (userCustomDurationInput) {
      userCustomDurationInput.required = !!isCustom;
      if (!isCustom) userCustomDurationInput.value = '';
    }
  }

  function getSelectedDurationMinutes() {
    if (userDurationSelect && userDurationSelect.value === 'custom') {
      const customMinutes = parseInt(userCustomDurationInput?.value || '', 10);
      if (!Number.isFinite(customMinutes) || customMinutes < 1 || customMinutes > 525600) {
        return null;
      }
      return customMinutes;
    }
    const duration = parseInt(userDurationSelect?.value || '', 10);
    if (!Number.isFinite(duration) || duration < 1 || duration > 525600) {
      return null;
    }
    return duration;
  }

  async function createCustomer(event) {
    event.preventDefault();
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value.trim();
    const duration = getSelectedDurationMinutes();
    const addonCheckbox = document.getElementById('newUserAddon');
    const addonEnabled = addonCheckbox ? addonCheckbox.checked : false;
    const makeVideoOnlyCheckbox = document.getElementById('newUserMakeVideoOnly');
    const makeVideoOnly = makeVideoOnlyCheckbox ? makeVideoOnlyCheckbox.checked : false;
    const submitButton = createUserForm?.querySelector('button[type="submit"]');

    if (!username || !password) {
      await showAlert('Username and password are required');
      return;
    }

    if (!duration) {
      await showAlert('Invalid duration selected. Use 1 to 525600 minutes.');
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Saving...';
    }

    try {
      const response = await fetch(apiUrl(AUTH_ENDPOINTS.users), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, duration, addonEnabled, makeVideoOnly }),
      });
      const data = await response.json();

      if (data.success || response.ok) {
        await showAlert('User created successfully!');
        event.target.reset();
        toggleCustomDurationInput();
        loadCustomers();
      } else {
        await showAlert(data.error || 'Failed to create user');
      }
    } catch (error) {
      await showAlert('Failed to create user: ' + error.message);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Save customer';
      }
    }
  }

  async function loadCustomers() {
    if (!usersList) return;
    try {
      const response = await fetch(apiUrl(AUTH_ENDPOINTS.users), {
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) {
        return;
      }

      cachedUsers = data.users || [];
      renderCustomers(cachedUsers);
    } catch (error) {
      console.error('Load customers error:', error);
    }
  }

  function formatDateTime(value) {
    if (!value) return 'Never';
    const d = new Date(value);
    if (isNaN(d.getTime())) return 'Never';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  // A user is "online" if their last heartbeat (/status, every 15s) is recent.
  const ONLINE_WINDOW_MS = 60 * 1000;

  function renderCustomers(users) {
    if (!usersList) return;
    usersList.innerHTML = '';

    const filtered = (users || []).filter((user) => user.role !== 'admin');
    const now = Date.now();
    const stats = { total: filtered.length, active: 0, waiting: 0, expiring: 0 };

    filtered.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.dataset.userId = user.id;
      row.dataset.username = user.username.toLowerCase();

      const expiresAt = user.expiresAt ? new Date(user.expiresAt).getTime() : null;
      const isActive = Boolean(user.isActive);
      const isExpiringSoon = Boolean(
        expiresAt && expiresAt > now && expiresAt - now <= 6 * 60 * 60 * 1000
      );
      const timeLeft = expiresAt ? formatTimeLeft(expiresAt - now) : 'Awaiting first login';
      const lastSeenMs = user.lastSeen ? new Date(user.lastSeen).getTime() : null;
      const isOnline = lastSeenMs != null && now - lastSeenMs <= ONLINE_WINDOW_MS;
      const lastLoginText = formatDateTime(user.lastLogin);
      const tiktokUser = String(user.tiktokUsername || '').replace(/^@+/, '');
      const tiktokText = tiktokUser ? '@' + tiktokUser : '—';

      if (isActive) {
        stats.active += 1;
      } else {
        stats.waiting += 1;
      }
      if (isExpiringSoon) {
        stats.expiring += 1;
      }

      row.innerHTML = `
        <div>
          <strong>${user.username}</strong>
          <div class="user-meta">
            Duration: ${formatDurationLabel(user.durationMinutes)}<br />
            Time left: ${timeLeft}<br />
            Status: ${isActive ? 'Active' : user.expiresAt ? 'Inactive' : 'Pending activation'}<br />
            Latest login: ${lastLoginText}<br />
            TikTok: ${tiktokText}
          </div>
          <div class="user-tags">
            <span class="user-tag ${isActive ? 'active' : 'pending'}">${isActive ? 'Active' : 'Waiting'}</span>
            <span class="user-tag" style="background:${isOnline ? 'rgba(40,199,111,0.18)' : 'rgba(140,140,140,0.18)'};color:${isOnline ? '#28c76f' : '#9aa4b2'};">${isOnline ? '🟢 Online' : '⚪ Offline'}</span>
            ${isExpiringSoon ? '<span class="user-tag expiring">Expiring</span>' : ''}
            <span class="user-tag ${user.addonEnabled ? 'addon-on' : 'addon-off'}" data-action="toggle-addon" style="cursor: pointer;" title="Click to toggle overlay add-on">${user.addonEnabled ? 'Add-on: ON' : 'Add-on: OFF'}</span>
            <span class="user-tag ${user.makeVideoOnly ? 'addon-on' : 'addon-off'}" data-action="toggle-makevideo-only" style="cursor: pointer;" title="When ON, this user can only use Make Video (no Mode 1 / Mode 2)">${user.makeVideoOnly ? 'Video-only: ON' : 'Video-only: OFF'}</span>
          </div>
        </div>
        <div class="user-actions">
          <button class="play-corgi" data-action="play-corgi">🐶 Corgi</button>
          <button class="add-day" data-action="add-day">+ Days</button>
          <button class="remove-day" data-action="remove-day">- Days</button>
          <button class="edit-pass" data-action="edit-pass">Edit pass</button>
          <button class="delete-user" data-action="delete-user">Delete</button>
        </div>
      `;

      usersList.appendChild(row);
    });

    if (totalUsersStat) totalUsersStat.textContent = stats.total;
    if (activeUsersStat) activeUsersStat.textContent = stats.active;
    if (waitingUsersStat) waitingUsersStat.textContent = stats.waiting;
    if (expiringUsersStat) expiringUsersStat.textContent = stats.expiring;

    if (adminEmptyState) {
      const messageNode = adminEmptyState.querySelector('p');
      const defaultText = adminEmptyState.dataset.defaultText || 'No customers yet.';

      if (filtered.length === 0) {
        adminEmptyState.style.display = 'block';
        if (messageNode) messageNode.textContent = defaultText;
        return;
      }

      adminEmptyState.style.display = 'none';
      if (messageNode) messageNode.textContent = defaultText;
    }
  }

  function filterCustomers(term) {
    if (!usersList) return;
    const normalized = term.trim().toLowerCase();
    let visibleCount = 0;
    const rows = usersList.querySelectorAll('.user-row');
    rows.forEach((row) => {
      const username = row.dataset.username || '';
      const matches = username.includes(normalized);
      row.style.display = matches ? 'flex' : 'none';
      if (matches) visibleCount += 1;
    });

    if (!adminEmptyState) return;
    const messageNode = adminEmptyState.querySelector('p');
    const defaultText = adminEmptyState.dataset.defaultText || 'No customers yet.';

    if (rows.length === 0) {
      adminEmptyState.style.display = 'block';
      if (messageNode) messageNode.textContent = defaultText;
      return;
    }

    if (normalized && visibleCount === 0) {
      adminEmptyState.style.display = 'block';
      if (messageNode) messageNode.textContent = `No matches for "${term}"`;
    } else {
      adminEmptyState.style.display = 'none';
      if (messageNode) messageNode.textContent = defaultText;
    }
  }

  async function extendUserDays(userId) {
    const daysInput = await showPrompt('Enter number of days to add:');
    if (!daysInput) return;
    const days = parseInt(daysInput, 10);
    if (isNaN(days) || days <= 0) {
      await showAlert('Please enter a valid positive number.');
      return;
    }
    try {
      const response = await fetch(apiUrl(`/api/users/${userId}/extend`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ days }),
      });
      const data = await response.json();
      if (!response.ok) {
        await showAlert(data.error || 'Unable to extend user');
        return;
      }
      loadCustomers();
    } catch (error) {
      await showAlert('Network error. Please try again.');
    }
  }

  async function removeUserDays(userId) {
    const daysInput = await showPrompt('Enter number of days to remove:');
    if (!daysInput) return;
    const days = parseInt(daysInput, 10);
    if (isNaN(days) || days <= 0) {
      await showAlert('Please enter a valid positive number.');
      return;
    }
    try {
      const response = await fetch(apiUrl(`/api/users/${userId}/extend`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ days: -days }),
      });
      const data = await response.json();
      if (!response.ok) {
        await showAlert(data.error || 'Unable to remove days');
        return;
      }
      loadCustomers();
    } catch (error) {
      await showAlert('Network error. Please try again.');
    }
  }

  async function updateUserPassword(userId) {
    const password = await showPrompt('Enter a new password (min 6 characters):');
    if (!password) return;
    if (password.length < 6) {
      await showAlert('Password must be at least 6 characters long.');
      return;
    }
    try {
      const response = await fetch(apiUrl(`/api/users/${userId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (!response.ok) {
        await showAlert(data.error || 'Unable to update password');
        return;
      }
      await showAlert('Password updated.');
    } catch (error) {
      await showAlert('Network error. Please try again.');
    }
  }

  async function deleteUser(userId) {
    if (!await showConfirm('Delete this customer? This cannot be undone.', true)) return;
    try {
      const response = await fetch(apiUrl(`/api/users/${userId}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) {
        await showAlert(data.error || 'Unable to delete user');
        return;
      }
      loadCustomers();
    } catch (error) {
      await showAlert('Network error. Please try again.');
    }
  }

  async function toggleUserAddon(userId, tagEl) {
    const isCurrentlyOn = tagEl.classList.contains('addon-on');
    const newState = !isCurrentlyOn;
    try {
      const response = await fetch(apiUrl(`/api/users/${userId}/addon`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: newState }),
      });
      const data = await response.json();
      if (!response.ok) {
        await showAlert(data.error || 'Unable to update add-on access');
        return;
      }
      // Update tag in place
      tagEl.classList.toggle('addon-on', newState);
      tagEl.classList.toggle('addon-off', !newState);
      tagEl.textContent = newState ? 'Add-on: ON' : 'Add-on: OFF';
      // Update cached user data
      const user = cachedUsers.find(u => String(u.id) === String(userId));
      if (user) user.addonEnabled = newState;
    } catch (error) {
      await showAlert('Network error. Please try again.');
    }
  }

  async function toggleUserMakeVideoOnly(userId, tagEl) {
    const isCurrentlyOn = tagEl.classList.contains('addon-on');
    const newState = !isCurrentlyOn;
    try {
      const response = await fetch(apiUrl(`/api/users/${userId}/makevideo-only`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: newState }),
      });
      const data = await response.json();
      if (!response.ok) {
        await showAlert(data.error || 'Unable to update Make Video-only access');
        return;
      }
      // Update tag in place
      tagEl.classList.toggle('addon-on', newState);
      tagEl.classList.toggle('addon-off', !newState);
      tagEl.textContent = newState ? 'Video-only: ON' : 'Video-only: OFF';
      // Update cached user data
      const user = cachedUsers.find(u => String(u.id) === String(userId));
      if (user) user.makeVideoOnly = newState;
    } catch (error) {
      await showAlert('Network error. Please try again.');
    }
  }

  // Trigger a one-shot gift animation on the customer's live app (mode1).
  async function playCustomerGift(userId, giftId, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      const response = await fetch(apiUrl(`/api/users/${userId}/play-gift`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ giftId }),
      });
      const data = await response.json();
      if (!response.ok) {
        await showAlert(data.error || 'Unable to play gift');
        return;
      }
      // Delivery depends on the customer's live WebSocket connection, NOT the
      // Online/Offline badge (which only tracks the HTTP heartbeat). `delivered`
      // is the number of live screens that actually received it.
      if (data.delivered > 0) {
        flashButton(btnEl, '✅ Sent');
      } else {
        await showAlert('Corgi sent, but the customer has no live screen connected right now, so nothing played.');
      }
    } catch (error) {
      await showAlert('Network error. Please try again.');
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  // Brief inline confirmation on a button without a blocking dialog.
  function flashButton(btnEl, text) {
    if (!btnEl) return;
    const original = btnEl.textContent;
    btnEl.textContent = text;
    setTimeout(() => { btnEl.textContent = original; }, 1500);
  }

  async function deleteExpiredUsers() {
    if (!await showConfirm('Delete all expired customers?', true)) return;
    try {
      const response = await fetch(apiUrl('/api/users/expired'), {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) {
        await showAlert(data.error || 'Unable to delete expired users');
        return;
      }
      await showAlert(data.message || 'Expired users removed');
      loadCustomers();
    } catch (error) {
      await showAlert('Network error. Please try again.');
    }
  }

  function bindEvents() {
    if (loginForm) {
      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value.trim();
        if (!username || !password) {
          showLoginError('Username and password are required');
          return;
        }
        if (loginButton) loginButton.disabled = true;
        await performLogin(username, password);
        if (loginButton) loginButton.disabled = false;
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', handleLogout);
    }

    if (adminOpenBtn) {
      adminOpenBtn.addEventListener('click', openAdminPanel);
    }

    if (closeAdminBtn) {
      closeAdminBtn.addEventListener('click', closeAdminPanel);
    }

    if (createUserForm) {
      createUserForm.addEventListener('submit', createCustomer);
    }

    if (userDurationSelect) {
      userDurationSelect.addEventListener('change', toggleCustomDurationInput);
      toggleCustomDurationInput();
    }

    if (refreshCustomersBtn) {
      refreshCustomersBtn.addEventListener('click', loadCustomers);
    }

    if (deleteExpiredBtn) {
      deleteExpiredBtn.addEventListener('click', deleteExpiredUsers);
    }

    if (adminSearchInput) {
      adminSearchInput.addEventListener('input', (event) => {
        filterCustomers(event.target.value);
      });
    }

    if (saveDisplayNameBtn) {
      saveDisplayNameBtn.addEventListener('click', saveDisplayNameForCurrentUser);
    }

    if (saveLiveStreamNameBtn) {
      saveLiveStreamNameBtn.addEventListener('click', saveLiveStreamNameForCurrentUser);
    }

    if (displayNameInput) {
      displayNameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          saveDisplayNameForCurrentUser();
        }
      });
      displayNameInput.addEventListener('blur', saveDisplayNameForCurrentUser);
    }

    if (usersList) {
      usersList.addEventListener('click', (event) => {
        const actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.getAttribute('data-action');
        const row = actionEl.closest('.user-row');
        if (!row) return;
        const userId = row.dataset.userId;
        if (!userId) return;

        if (action === 'add-day') {
          extendUserDays(userId);
        } else if (action === 'remove-day') {
          removeUserDays(userId);
        } else if (action === 'edit-pass') {
          updateUserPassword(userId);
        } else if (action === 'delete-user') {
          deleteUser(userId);
        } else if (action === 'toggle-addon') {
          toggleUserAddon(userId, actionEl);
        } else if (action === 'toggle-makevideo-only') {
          toggleUserMakeVideoOnly(userId, actionEl);
        } else if (action === 'play-corgi') {
          playCustomerGift(userId, 'corgi', actionEl);
        }
      });
    }
  }

  bindEvents();
  fetchAuthStatus();
})();
