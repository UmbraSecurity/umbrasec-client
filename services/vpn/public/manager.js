'use strict';

let csrfToken = '';
let currentRouting = 'standard';

// --- Custom Modal Dialog (replaces browser alert) ---
function showCustomAlert(message, type) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    const iconClass = type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
    const iconColor = type === 'error' ? '#ef4444' : 'var(--quantum-3)';
    overlay.innerHTML = `
        <div class="glass-card modal-card" style="max-width:420px; padding:2rem; background:rgba(10,10,15,0.95); border:1px solid var(--glass-border); border-radius:24px;">
            <div style="text-align:center;">
                <i class="fas ${iconClass}" style="font-size:2rem; color:${iconColor}; margin-bottom:1rem; display:block;"></i>
                <p style="font-size:0.9rem; color:var(--fg-muted); margin-bottom:1.5rem;">${message}</p>
                <button class="main-btn" id="alertOk" style="min-width:120px;">OK</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    function close() {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 300);
    }

    overlay.querySelector('#alertOk').onclick = close;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    overlay.querySelector('#alertOk').focus();
}

async function loadManager() {
    try {
        const res = await fetch('/api/dashboard', { credentials: 'same-origin' });
        if (res.status === 401) {
            window.location.href = 'https://portal.umbrasec.one/login';
            return;
        }
        if (!res.ok) throw new Error('Network backbone failure: ' + res.status);

        const data = await res.json();

        const subStatusEl = document.getElementById('subStatus');
        const subBox = document.getElementById('subBox');

        const status = (data.subscriptionStatus || '').toLowerCase();

        if (status === 'active' || status === 'lifetime') {
            subStatusEl.textContent = 'ACCESS GRANTED';
            subStatusEl.style.color = 'var(--quantum-3)';
            subBox.style.borderColor = 'rgba(45, 212, 191, 0.3)';

            if (data.hasProfile) {
                document.getElementById('hasProfile').classList.remove('hidden');
                loadRouting();
            } else {
                document.getElementById('noProfile').classList.remove('hidden');
            }
        } else {
            subStatusEl.textContent = 'ACCESS REVOKED';
            subStatusEl.style.color = '#ef4444';
            subBox.style.borderColor = 'rgba(239, 68, 68, 0.3)';
            document.getElementById('expiryDetail').textContent = 'Active lease required';
            document.getElementById('subAction').classList.remove('hidden');
            document.getElementById('locked').classList.remove('hidden');
        }

        document.getElementById('loadingText').classList.add('hidden');
        document.getElementById('managerContent').classList.remove('hidden');

    } catch (err) {
        console.error('VPN Manager Error:', err);
        document.getElementById('loadingText').innerHTML = '<span style="color:#ef4444">Critical error: Neural link unstable. Please reload.</span>';
    }
}

document.getElementById('provisionBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('provisionBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Establishing Tunnel...';

    try {
        const cr = await fetch('/api/csrf', { credentials: 'same-origin' });
        const cd = await cr.json();

        const res = await fetch('/api/vpn/provision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': cd.csrfToken },
            body: '_csrf=' + encodeURIComponent(cd.csrfToken),
            credentials: 'same-origin',
        });

        if (res.ok) {
            window.location.reload();
        } else {
            const errData = await res.json();
            showCustomAlert(errData.error || 'Protocol establishment failed.', 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-plus"></i> Establish Tunnel Profile';
        }
    } catch (err) {
        showCustomAlert('Backbone interruption: ' + err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-plus"></i> Establish Tunnel Profile';
    }
});

// --- Routing Mode ---
async function loadRouting() {
    try {
        const res = await fetch('/api/vpn/routing', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        currentRouting = data.routing_mode || 'standard';
        updateRoutingUI();
        document.getElementById('routingSection').classList.remove('hidden');
    } catch (e) {
        console.warn('Routing fetch failed:', e.message);
    }
}

function updateRoutingUI() {
    const modes = { 'standard': 'routeStandard', 'multi-hop': 'routeMultihop', 'tor': 'routeTor' };
    for (const [mode, id] of Object.entries(modes)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        if (mode === currentRouting) {
            btn.style.borderColor = 'var(--quantum-1)';
            btn.style.background = 'rgba(45, 212, 191, 0.08)';
        } else {
            btn.style.borderColor = 'var(--border-color)';
            btn.style.background = 'var(--bg-glass)';
        }
    }
    const labels = { 'standard': 'Direct connection active', 'multi-hop': 'Multi-hop chain active', 'tor': 'TOR routing active' };
    document.getElementById('routingStatus').textContent = labels[currentRouting] || '';
}

async function setRouting(mode) {
    if (mode === currentRouting) return;
    const statusEl = document.getElementById('routingStatus');
    statusEl.textContent = 'Switching routing protocol...';
    try {
        const cr = await fetch('/api/csrf', { credentials: 'same-origin' });
        const cd = await cr.json();

        const res = await fetch('/api/vpn/routing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': cd.csrfToken },
            body: JSON.stringify({ routing_mode: mode }),
            credentials: 'same-origin',
        });
        if (!res.ok) {
            const err = await res.json();
            statusEl.textContent = 'Error: ' + (err.error || 'Failed to switch routing');
            statusEl.style.color = '#ef4444';
            setTimeout(() => { statusEl.style.color = 'var(--fg-muted)'; updateRoutingUI(); }, 3000);
            return;
        }
        const data = await res.json();
        currentRouting = mode;
        updateRoutingUI();
        if (data.reconnecting) {
            statusEl.textContent = 'Routing switched — your VPN will reconnect momentarily';
        } else {
            statusEl.textContent = 'Routing protocol updated. Reconnect your VPN to apply.';
        }
        statusEl.style.color = 'var(--quantum-3)';
        setTimeout(() => { statusEl.style.color = 'var(--fg-muted)'; updateRoutingUI(); }, 5000);
    } catch (e) {
        statusEl.textContent = 'Network error: ' + e.message;
        statusEl.style.color = '#ef4444';
    }
}

loadManager();
