'use strict';

let csrfToken = '';
let dashData = {};

// Handle URL parameters for messages immediately
const params = new URLSearchParams(window.location.search);
if (params.get('msg') === 'already_subscribed') {
    document.getElementById('topNotification').classList.remove('hidden');
}

// --- Custom Modal Dialog (replaces browser prompt/alert) ---
function showCustomPrompt(message, callback) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
        <div class="glass-card modal-card">
            <div class="modal-header">
                <h3>Input Required</h3>
                <button class="close-modal" id="promptClose"><i class="fas fa-times"></i></button>
            </div>
            <p style="font-size:0.9rem; color:var(--fg-muted); margin-bottom:1.5rem;">${message}</p>
            <div class="manager-field">
                <input type="password" id="promptInput" class="search-input" placeholder="Enter value" autocomplete="off">
            </div>
            <div style="display:flex; gap:0.5rem; margin-top:1rem;">
                <button class="outline-btn" style="flex:1;" id="promptCancel">Cancel</button>
                <button class="main-btn" style="flex:1;" id="promptConfirm">Confirm</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#promptInput');
    input.focus();

    function close(value) {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 300);
        callback(value);
    }

    overlay.querySelector('#promptClose').onclick = () => close(null);
    overlay.querySelector('#promptCancel').onclick = () => close(null);
    overlay.querySelector('#promptConfirm').onclick = () => close(input.value);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        if (e.key === 'Escape') close(null);
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
    });
}

// --- API Helpers ---
async function apiAction(url, body = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrfToken },
        body: new URLSearchParams({ ...body, _csrf: csrfToken }),
        credentials: 'same-origin',
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(data.error || 'Action failed');
        err.requires_2fa = !!data.requires_2fa;
        throw err;
    }
    return res.json();
}

function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="fas ${type === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle'}" style="color:${type === 'error' ? '#ef4444' : 'var(--quantum-3)'}"></i> ${msg}`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// --- Profile Modal ---
function openProfile() {
    document.getElementById('profileUsername').textContent = dashData.username || '...';
    document.getElementById('profileEmail').textContent = dashData.email || '...';
    document.getElementById('profileAccountId').textContent = dashData.accountId || '...';
    document.getElementById('profileCreatedAt').textContent = dashData.createdAt ? new Date(dashData.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '...';
    document.getElementById('profileMailAddress').textContent = dashData.mailAddress || 'No mail account';
    document.getElementById('profileFields').classList.remove('hidden');
    document.getElementById('profileSuccess').classList.add('hidden');
    document.getElementById('deleteConfirm').classList.add('hidden');
    document.getElementById('editUsernameBox').classList.add('hidden');
    update2FAUI();
    document.getElementById('profileOverlay').classList.add('active');
}

function closeProfile() {
    document.getElementById('profileOverlay').classList.remove('active');
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('deletePassword').value = '';
}

function toggleEditUsername() {
    const box = document.getElementById('editUsernameBox');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) document.getElementById('newUsernameInput').value = dashData.username || '';
}

async function saveUsername() {
    const val = document.getElementById('newUsernameInput').value.trim();
    const pw = document.getElementById('usernameChangePassword').value;
    if (!val) return showToast('Username is required', 'error');
    if (!pw) return showToast('Password is required to change username', 'error');
    try {
        const data = await apiActionWith2FA('/api/user/update-username', { username: val, password: pw });
        const savedUsername = data.username || val;
        const savedEmail = data.email || `${savedUsername}@umbrasec.one`;
        showToast('Username and email updated');
        dashData.username = savedUsername;
        dashData.email = savedEmail;
        document.getElementById('profileUsername').textContent = savedUsername;
        document.getElementById('profileEmail').textContent = savedEmail;
        document.getElementById('welcomeUser').textContent = 'Welcome, ' + savedUsername;
        document.getElementById('editUsernameBox').classList.add('hidden');
        document.getElementById('usernameChangePassword').value = '';
        if (document.getElementById('profileMailAddress')) {
            document.getElementById('profileMailAddress').textContent = savedEmail;
        }
    } catch (err) { showToast(err.message, 'error'); }
}

function showDeleteConfirm() {
    document.getElementById('profileFields').classList.add('hidden');
    document.getElementById('deleteConfirm').classList.remove('hidden');
}

function cancelDelete() {
    document.getElementById('deleteConfirm').classList.add('hidden');
    document.getElementById('profileFields').classList.remove('hidden');
}

async function confirmDeleteAccount() {
    const pw = document.getElementById('deletePassword').value;
    if (!pw) return showToast('Password is required', 'error');
    const btn = document.getElementById('btnDeleteAccount');
    btn.disabled = true;
    btn.textContent = 'Deleting...';
    try {
        await apiActionWith2FA('/api/user/delete-account', { password: pw });
        showToast('Account deleted. Redirecting...');
        setTimeout(() => { window.location.href = 'https://portal.umbrasec.one/login'; }, 2000);
    } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Delete Forever';
    }
}

async function changePassword() {
    const currentPass = document.getElementById('currentPassword').value;
    const newPass = document.getElementById('newPassword').value;
    const confirmPass = document.getElementById('confirmPassword').value;
    const btn = document.getElementById('btnChangePass');

    if (!currentPass) return showToast('Current password required', 'error');
    if (!newPass) return showToast('New password required', 'error');
    if (newPass.length < 12) return showToast('New password must be at least 12 characters', 'error');
    if (newPass !== confirmPass) return showToast('Passwords do not match', 'error');

    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
        await apiActionWith2FA('/api/user/update-password', { current_password: currentPass, new_password: newPass });
        document.getElementById('profileFields').classList.add('hidden');
        document.getElementById('profileSuccess').classList.remove('hidden');
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Update Password';
    }
}

// --- 2FA ---
function update2FAUI() {
    const toggle = document.getElementById('toggle2FA');
    const track = document.getElementById('toggle2FATrack');
    const thumb = document.getElementById('toggle2FAThumb');
    const status = document.getElementById('2faStatus');
    const enabled = dashData.mfaEnabled;
    if (toggle) toggle.checked = enabled;
    if (track) track.style.background = enabled ? 'var(--quantum-3, #2dd4bf)' : 'var(--border)';
    if (thumb) thumb.style.left = enabled ? '22px' : '2px';
    if (status) status.textContent = enabled ? 'Enabled — codes sent to your UmbraSec mail for sensitive actions' : 'Disabled — no verification codes required';
}

async function toggle2FA(enable) {
    showCustomPrompt(
        enable ? 'Enter your password to enable email verification:' : 'Enter your password to disable email verification:',
        async (pw) => {
            if (!pw) {
                update2FAUI();
                return;
            }
            try {
                await apiAction(enable ? '/api/user/2fa/enable' : '/api/user/2fa/disable', { password: pw });
                dashData.mfaEnabled = enable;
                update2FAUI();
                showToast(enable ? '2FA enabled' : '2FA disabled');
            } catch (err) {
                showToast(err.message, 'error');
                dashData.mfaEnabled = !enable;
                update2FAUI();
            }
        }
    );
}

// Handle 2FA challenge on sensitive actions
async function apiActionWith2FA(url, body) {
    try {
        return await apiAction(url, body);
    } catch (err) {
        if (err.message?.includes('Verification code required') || err.requires_2fa) {
            await apiAction('/api/user/2fa/send-code', {});
            return new Promise((resolve, reject) => {
                showCustomPrompt('A verification code was sent to your email. Enter it here:', async (code) => {
                    if (!code) return reject(new Error('Verification cancelled'));
                    try {
                        const result = await apiAction(url, { ...body, verification_code: code });
                        resolve(result);
                    } catch (innerErr) {
                        reject(innerErr);
                    }
                });
            });
        }
        throw err;
    }
}

// --- Dashboard Load ---
async function loadDashboard() {
    const loadingText = document.getElementById('loadingText');
    const dashboardContent = document.getElementById('dashboardContent');

    try {
        const res = await fetch('/api/dashboard', { credentials: 'same-origin' });

        if (res.status === 401 || res.redirected) {
            window.location.href = '/login';
            return;
        }

        if (!res.ok) throw new Error('Failed to load session: ' + res.status);

        const data = await res.json();
        dashData = data;
        csrfToken = data.csrfToken;

        document.getElementById('welcomeUser').textContent = 'Welcome, ' + (data.username || 'User');
        document.getElementById('accountId').textContent = data.accountId || '---';

        const subStatusEl = document.getElementById('subStatusDisplay');
        const vpnBadge = document.getElementById('vpnStatusBadge');
        const driveBadge = document.getElementById('driveStatusBadge');
        const osintBadge = document.getElementById('osintStatusBadge');
        const statusCard = document.getElementById('statusCard');

        const status = (data.subscriptionStatus || '').trim().toLowerCase();

        const mailBadge = document.getElementById('mailStatusBadge');
        const mailLog = document.getElementById('mailAddressLog');

        if (status === 'active' || status === 'lifetime') {
            subStatusEl.textContent = 'ONLINE';
            subStatusEl.style.color = 'var(--quantum-3)';
            statusCard.classList.add('stat-active');

            vpnBadge.className = 'service-status status-active';
            vpnBadge.innerHTML = '<i class="fas fa-check-circle"></i> Service Ready';

            if (driveBadge) {
                driveBadge.className = 'service-status status-active';
                driveBadge.innerHTML = '<i class="fas fa-check-circle"></i> Service Ready';
            }

            if (osintBadge) {
                osintBadge.className = 'service-status status-alpha';
                osintBadge.innerHTML = '<i class="fas fa-flask"></i> Alpha';
            }

            if (mailBadge) {
                mailBadge.className = 'service-status status-active';
                mailBadge.innerHTML = '<i class="fas fa-check-circle"></i> Service Ready';
            }
            if (mailLog && data.mailAddress) {
                mailLog.innerHTML = '<span class="success">> Address: ' + data.mailAddress + '</span>';
            }

            if (status === 'lifetime') {
                document.getElementById('expiryCard').querySelector('h4').textContent = 'Membership';
                document.getElementById('expiryCard').querySelector('.icon i').className = 'fas fa-infinity';
                const el = document.getElementById('expiryDate');
                el.textContent = 'LIFETIME';
                el.style.color = 'cornflowerblue';
            } else if (data.subscriptionExpiresAt) {
                const exp = new Date(data.subscriptionExpiresAt);
                document.getElementById('expiryDate').textContent = exp.toLocaleDateString();
            } else {
                document.getElementById('expiryDate').textContent = 'Active';
            }

            document.getElementById('vpnLogState').innerHTML = '<span class="success">> Connection verified. Tunnel authorized.</span>';
        } else {
            subStatusEl.textContent = 'READY';
            subStatusEl.style.color = 'var(--quantum-2)';
            statusCard.style.borderColor = 'var(--glass-border)';
            document.getElementById('subscribeAction').classList.remove('hidden');

            vpnBadge.className = 'service-status status-coming-soon';
            vpnBadge.innerHTML = '<i class="fas fa-clock"></i> Awaiting Setup';

            if (driveBadge) {
                driveBadge.className = 'service-status status-coming-soon';
                driveBadge.innerHTML = '<i class="fas fa-clock"></i> Awaiting Setup';
            }

            if (osintBadge) {
                osintBadge.className = 'service-status status-alpha';
                osintBadge.innerHTML = '<i class="fas fa-flask"></i> Alpha';
            }

            if (mailBadge) {
                mailBadge.className = 'service-status status-coming-soon';
                mailBadge.innerHTML = '<i class="fas fa-clock"></i> Awaiting Setup';
            }
            if (mailLog) mailLog.innerHTML = '<span style="opacity:0.6">> Awaiting subscription activation...</span>';

            document.getElementById('vpnLogState').innerHTML = '<span style="opacity:0.6">> Security systems initialized. Awaiting subscription...</span>';
        }

        if (data.role === 'admin') {
            document.getElementById('adminLink').classList.remove('hidden');
        }

        // Handle URL parameters for other messages
        if (params.get('checkout') === 'success') {
            document.getElementById('messages').innerHTML = '<div class="glass-card" style="margin-bottom:2rem; border-color:var(--quantum-3); background:rgba(45,212,191,0.05); padding:1rem;">' +
                '<p style="color:var(--quantum-3); margin:0; font-weight:600;"><i class="fas fa-check-circle"></i> Protocol lease confirmed. Assets unlocked.</p></div>';
        } else if (params.get('msg') === 'subscribe') {
            document.getElementById('messages').innerHTML = '<div class="glass-card" style="margin-bottom:2rem; border-color:var(--quantum-2); background:rgba(239,68,68,0.05); padding:1rem;">' +
                '<p style="color:var(--quantum-2); margin:0; font-weight:600;"><i class="fas fa-exclamation-triangle"></i> Access Denied. Active protocol lease required for this operation.</p></div>';
        }

        loadingText.classList.add('hidden');
        dashboardContent.classList.remove('hidden');

    } catch (err) {
        console.error('Dashboard Error:', err);
        loadingText.innerHTML = '<span style="color:#ef4444"><i class="fas fa-triangle-exclamation"></i> Connection to secure enclave failed. Please reload.</span>';
    }
}

// Handle Sidebar active states
document.querySelectorAll('.sidebar-link').forEach(link => {
    link.addEventListener('click', function() {
        if (this.getAttribute('href').startsWith('#')) {
            document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
            this.classList.add('active');
        }
    });
});

loadDashboard();
