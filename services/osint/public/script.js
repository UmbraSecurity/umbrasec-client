function showOnionWarning() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
        <div style="background:rgba(10,10,15,0.95);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:2rem;max-width:400px;text-align:center;">
            <i class="fas fa-shield-halved" style="font-size:2rem;color:#fca5a5;margin-bottom:1rem;display:block;"></i>
            <p style="color:#fca5a5;font-weight:600;margin-bottom:0.5rem;">Tor Browser Required</p>
            <p style="color:#94a3b8;font-size:0.85rem;margin-bottom:1.5rem;">This is an .onion link. You need the Tor Browser to access it.</p>
            <button style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:0.6rem 2rem;border-radius:8px;cursor:pointer;font-weight:500;" onclick="this.closest('div').parentElement.remove()">OK</button>
        </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

document.addEventListener('DOMContentLoaded', () => {
    const scanBtn = document.getElementById('scan-btn');
    const loadingOverlay = document.getElementById('loading-overlay');
    const reportsContainer = document.getElementById('reports-container');
    const errorMessage = document.getElementById('error-message');
    const systemStatus = document.getElementById('system-status');

    const inputs = {
        real_name: document.getElementById('input-realname'),
        username: document.getElementById('input-username'),
        email: document.getElementById('input-email'),
        phone: document.getElementById('input-phone'),
        domain: document.getElementById('input-domain'),
        ip: document.getElementById('input-ip'),
        address: document.getElementById('input-address'),
        crypto: document.getElementById('input-crypto')
    };

    // Add enter key support to all inputs
    Object.values(inputs).forEach(input => {
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    scanBtn.click();
                }
            });
        }
    });

    scanBtn.addEventListener('click', async () => {
        const payload = {};
        let hasInput = false;

        for (const [key, el] of Object.entries(inputs)) {
            if (el && el.value.trim()) {
                payload[key] = el.value.trim();
                hasInput = true;
            }
        }

        if (!hasInput) {
            showError('Please enter at least one target value.');
            return;
        }

        setLoadingState(true);
        hideError();
        reportsContainer.innerHTML = '';

        try {
            const queryParams = new URLSearchParams(payload).toString();
            const url = `/api/run-osint?${queryParams}`;
            
            const response = await fetch(url);
            const json = await response.json();

            if (!response.ok) {
                showError(json.error || 'Failed to fetch intelligence report.');
                setLoadingState(false);
                return;
            }

            if (json.results && json.results.length > 0) {
                json.results.forEach(report => {
                    const reportEl = generateReportHtml(report);
                    reportsContainer.appendChild(reportEl);
                });
            } else {
                showError('No actionable intelligence gathered.');
            }

        } catch (e) {
            showError(`Network error: ${e.message}`);
        } finally {
            setLoadingState(false);
        }
    });

    function showError(msg) {
        errorMessage.textContent = msg;
        errorMessage.classList.remove('hidden');
    }

    function hideError() {
        errorMessage.classList.add('hidden');
    }

    function setLoadingState(isLoading) {
        Object.values(inputs).forEach(input => {
            if (input) input.disabled = isLoading;
        });
        scanBtn.disabled = isLoading;
        if (isLoading) {
            loadingOverlay.classList.remove('hidden');
            systemStatus.textContent = 'ANALYZING';
            systemStatus.className = 'value info';
            scanBtn.textContent = 'Processing...';
        } else {
            loadingOverlay.classList.add('hidden');
            systemStatus.textContent = 'READY';
            systemStatus.className = 'value success';
            scanBtn.textContent = 'Gather Intel';
        }
    }

    function generateReportHtml(report) {
        const card = document.createElement('div');
        card.className = 'report-card';

        // Header
        let html = `
            <div class="report-header">
                <div class="report-target">${escapeHtml(report.target)}</div>
                <div class="badge-container">
                    <div class="badge">${escapeHtml(report.type)}</div>
                    ${report.inferred ? '<div class="badge badge-inferred">Auto-Discovered</div>' : ''}
                </div>
            </div>
            <div class="report-body">
        `;

        if (report.error) {
            html += `<div style="color: var(--error-color); font-weight: 600;">Error: ${escapeHtml(report.error)}</div></div>`;
            card.innerHTML = html;
            return card;
        }

        const data = report.data || {};

        const risks = [];

        // Risk Analysis
        if (data.darkweb && data.darkweb.length > 0) {
            risks.push({ level: 'High', title: 'Dark Web Exposure', desc: `Target found on ${data.darkweb.length} .onion sites. Potential data breach or illicit activity.` });
        }
        if (report.type === 'ip' && data.openPorts) {
            const criticalPorts = [21, 22, 23, 3389, 445];
            const exposed = data.openPorts.filter(p => criticalPorts.includes(p));
            if (exposed.length > 0) {
                risks.push({ level: 'High', title: 'Critical Ports Open', desc: `Ports ${exposed.join(', ')} are exposed to the public internet.` });
            }
        }
        if (report.type === 'email') {
            if (data.mx === null) {
                risks.push({ level: 'Low', title: 'Invalid MX Records', desc: 'Domain does not have valid mail configuration (may be spoofed or inactive).' });
            }
            if (data.gravatar && data.gravatar.name) {
                risks.push({ level: 'Medium', title: 'Identity Leak (Gravatar)', desc: 'Email is associated with a public name/profile.' });
            }
        }
        if (data.scrapedEmails && data.scrapedEmails.length > 0) {
            risks.push({ level: 'Medium', title: 'Email Scraping', desc: `Found ${data.scrapedEmails.length} email addresses exposed in clearnet scrape.` });
        }
        if (data.subdomains && data.subdomains.length > 10) {
            risks.push({ level: 'Low', title: 'Large Subdomain Footprint', desc: `Target has a large attack surface (${data.subdomains.length} subdomains).` });
        }
        if (report.type === 'crypto' && data.balance && data.balance.n_tx > 0) {
            risks.push({ level: 'Low', title: 'Active Crypto Wallet', desc: `Wallet has ${data.balance.n_tx} transactions, indicating active usage.` });
        }

        if (risks.length > 0) {
            html += `<div class="report-section risk-assessment">
                <div class="section-title" style="color: var(--error-color);">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                    Risk Assessment & Information Leaks
                </div>
                <div class="risk-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem;">
            `;
            risks.forEach(r => {
                const colorVar = r.level === 'High' ? 'var(--error-color)' : (r.level === 'Medium' ? 'var(--warning-color)' : 'var(--info-color)');
                const bgVar = r.level === 'High' ? 'var(--error-bg)' : (r.level === 'Medium' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(14, 165, 233, 0.1)');
                html += `
                    <div class="risk-card" style="border-left: 3px solid ${colorVar}; background: ${bgVar}; padding: 1rem; border-radius: var(--radius-sm); border-top: 1px solid rgba(255,255,255,0.05); border-right: 1px solid rgba(255,255,255,0.05); border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <div style="font-size: 0.75rem; text-transform: uppercase; font-weight: 800; color: ${colorVar}; margin-bottom: 0.3rem; letter-spacing: 0.5px;">${r.level} RISK</div>
                        <div style="font-weight: 700; font-family: var(--font-mono); color: var(--text-primary); margin-bottom: 0.4rem; font-size: 0.95rem;">${escapeHtml(r.title)}</div>
                        <div style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.4;">${escapeHtml(r.desc)}</div>
                    </div>
                `;
            });
            html += `</div></div>`;
        }

        // IP Data
        if (report.type === 'ip') {
            if (data.geolocation) {
                html += `
                    <div class="report-section">
                        <div class="section-title">Geolocation & ISP</div>
                        <div class="data-grid">
                            <div class="data-item"><div class="data-label">Country</div><div class="data-value">${escapeHtml(data.geolocation.country || 'N/A')}</div></div>
                            <div class="data-item"><div class="data-label">Region/City</div><div class="data-value">${escapeHtml(data.geolocation.region || '')} / ${escapeHtml(data.geolocation.city || '')}</div></div>
                            <div class="data-item"><div class="data-label">ISP</div><div class="data-value">${escapeHtml(data.geolocation.isp || 'N/A')}</div></div>
                            <div class="data-item"><div class="data-label">Organization (ASN)</div><div class="data-value">${escapeHtml(data.geolocation.org || 'N/A')} (${escapeHtml(data.geolocation.asn || 'N/A')})</div></div>
                            ${data.geolocation.lat && data.geolocation.lon ? `<div class="data-item"><div class="data-label">Coordinates</div><div class="data-value">${escapeHtml(data.geolocation.lat)}, ${escapeHtml(data.geolocation.lon)}</div></div>` : ''}
                        </div>
                    </div>
                `;
            }
            if (data.reverseDns && data.reverseDns.length > 0) {
                html += `<div class="report-section"><div class="section-title">Reverse DNS (PTR)</div><div class="tag-cloud">`;
                data.reverseDns.forEach(host => {
                    html += `<span class="platform-tag">${escapeHtml(host)}</span>`;
                });
                html += `</div></div>`;
            }
            if (data.openPorts && data.openPorts.length > 0) {
                html += `<div class="report-section"><div class="section-title">Open Ports (Fast Scan)</div><div class="tag-cloud">`;
                data.openPorts.forEach(port => {
                    html += `<span class="platform-tag" style="background: rgba(16, 185, 129, 0.1); color: var(--success-color); border-color: rgba(16, 185, 129, 0.3);">Port ${port}</span>`;
                });
                html += `</div></div>`;
            }
        }

        // Web Scraping & SSL Data (Generic for IP and Domain)
        if (data.ssl) {
            html += `<div class="report-section"><div class="section-title">SSL/TLS Certificate</div><div class="data-grid">`;
            if (data.ssl.subject) html += `<div class="data-item"><div class="data-label">Subject</div><div class="data-value">${escapeHtml(data.ssl.subject.CN || JSON.stringify(data.ssl.subject))}</div></div>`;
            if (data.ssl.issuer) html += `<div class="data-item"><div class="data-label">Issuer</div><div class="data-value">${escapeHtml(data.ssl.issuer.CN || JSON.stringify(data.ssl.issuer))}</div></div>`;
            if (data.ssl.valid_to) html += `<div class="data-item"><div class="data-label">Valid Until</div><div class="data-value">${escapeHtml(data.ssl.valid_to)}</div></div>`;
            html += `</div></div>`;
            if (data.ssl.altNames && data.ssl.altNames.length > 0) {
                html += `<div class="report-section"><div class="section-title">Subject Alt Names (SAN)</div><div class="tag-cloud">`;
                data.ssl.altNames.forEach(san => {
                    html += `<span class="platform-tag">${escapeHtml(san)}</span>`;
                });
                html += `</div></div>`;
            }
        }

        if (data.scraped) {
            if (data.pageTitle || data.pageDescription) {
                html += `<div class="report-section"><div class="section-title">Web Metadata</div><div class="data-grid">`;
                if (data.pageTitle) html += `<div class="data-item" style="grid-column: 1 / -1;"><div class="data-label">Page Title</div><div class="data-value">${escapeHtml(data.pageTitle)}</div></div>`;
                if (data.pageDescription) html += `<div class="data-item" style="grid-column: 1 / -1;"><div class="data-label">Meta Description</div><div class="data-value">${escapeHtml(data.pageDescription)}</div></div>`;
                html += `</div></div>`;
            }
            if (data.scrapedEmails && data.scrapedEmails.length > 0) {
                html += `<div class="report-section"><div class="section-title">Extracted Emails</div><div class="tag-cloud">`;
                data.scrapedEmails.forEach(e => {
                    html += `<span class="platform-tag" style="background: rgba(245, 158, 11, 0.1); color: var(--warning-color); border-color: rgba(245, 158, 11, 0.3);">${escapeHtml(e)}</span>`;
                });
                html += `</div></div>`;
            }
            if (data.analyticsIds && data.analyticsIds.length > 0) {
                html += `<div class="report-section"><div class="section-title">Tracking IDs</div><div class="tag-cloud">`;
                data.analyticsIds.forEach(id => {
                    html += `<span class="platform-tag" style="background: rgba(239, 68, 68, 0.1); color: var(--error-color); border-color: rgba(239, 68, 68, 0.3);">${escapeHtml(id)}</span>`;
                });
                html += `</div></div>`;
            }
        }

        // Domain DNS
        if (report.type === 'domain') {
            if (data.whois) {
                html += `<div class="report-section"><div class="section-title">WHOIS Registration Data</div>
                <pre style="background: var(--bg-input); padding: 1rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); font-size: 0.8rem; overflow-x: auto; color: var(--text-secondary); max-height: 200px; overflow-y: auto;">${escapeHtml(data.whois)}</pre>
                </div>`;
            }

            if (data.robotsTxt) {
                html += `<div class="report-section"><div class="section-title">Robots.txt (Exposed Paths)</div>
                <pre style="background: var(--bg-input); padding: 1rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); font-size: 0.8rem; overflow-x: auto; color: var(--warning-color); max-height: 200px; overflow-y: auto;">${escapeHtml(data.robotsTxt)}</pre>
                </div>`;
            }

            if (data.dns) {
                html += `<div class="report-section"><div class="section-title">DNS Records</div><div class="data-grid">`;
                for (const [recordType, records] of Object.entries(data.dns)) {
                    if (records && records.length > 0) {
                        html += `<div class="data-item"><div class="data-label">${escapeHtml(recordType.toUpperCase())}</div><div class="data-value">${records.map(r => escapeHtml(r)).join('<br>')}</div></div>`;
                    }
                }
                html += `</div></div>`;
            }

            if (data.webHeaders && Object.keys(data.webHeaders).length > 0) {
                html += `<div class="report-section"><div class="section-title">HTTP Headers (Fingerprint)</div><div class="data-grid">`;
                for (const [hKey, hVal] of Object.entries(data.webHeaders)) {
                    html += `<div class="data-item"><div class="data-label">${escapeHtml(hKey.toUpperCase())}</div><div class="data-value">${escapeHtml(hVal)}</div></div>`;
                }
                html += `</div></div>`;
            }

            if (data.subdomains && data.subdomains.length > 0) {
                html += `<div class="report-section"><div class="section-title">Subdomains (crt.sh Logs)</div><div class="tag-cloud">`;
                data.subdomains.forEach(sub => {
                    html += `<span class="platform-tag">${escapeHtml(sub)}</span>`;
                });
                html += `</div></div>`;
            }
        }

        // Email MX
        if (report.type === 'email') {
            html += `
                <div class="report-section">
                    <div class="section-title">Mail Exchanger (MX) Validation</div>
                    <div class="data-grid">
                        <div class="data-item">
                            <div class="data-label">Status</div>
                            <div class="data-value" style="color: ${data.mx ? 'var(--success-color)' : 'var(--error-color)'}">
                                ${data.mx ? `Valid (Can receive mail via ${escapeHtml(data.mx[0])})` : 'Invalid / No MX Records'}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        // Username Platforms
        if (report.type === 'username') {
            html += `<div class="report-section"><div class="section-title">Platform Footprint</div>`;
            if (data.platforms && data.platforms.length > 0) {
                html += `<div class="tag-cloud">`;
                data.platforms.forEach(p => {
                    html += `<a href="${escapeHtml(p.url)}" target="_blank" class="platform-tag">${escapeHtml(p.name)} ↗</a>`;
                });
                html += `</div>`;
            } else {
                html += `<div style="color: var(--text-secondary); font-size: 0.9rem;">No public footprints found on tracked platforms.</div>`;
            }
            html += `</div>`;
        }
        
        // Real Name Info
        if (report.type === 'real_name') {
            html += `
                <div class="report-section">
                    <div class="section-title">Real Name Verification</div>
                    <div class="data-grid">
                        <div class="data-item"><div class="data-label">Searched Name</div><div class="data-value">${escapeHtml(report.target)}</div></div>
                    </div>
                </div>
            `;
        }

        // Address Info
        if (report.type === 'address') {
            html += `
                <div class="report-section">
                    <div class="section-title">Physical Location Intelligence</div>
                    <div class="data-grid">
                        <div class="data-item"><div class="data-label">Target Address</div><div class="data-value">${escapeHtml(report.target)}</div></div>
            `;
            if (data.geocoding) {
                html += `
                        <div class="data-item"><div class="data-label">Standardized Address</div><div class="data-value">${escapeHtml(data.geocoding.displayName)}</div></div>
                        <div class="data-item"><div class="data-label">Coordinates</div><div class="data-value">${escapeHtml(data.geocoding.lat)}, ${escapeHtml(data.geocoding.lon)}</div></div>
                `;
            }
            html += `
                    </div>
                </div>
            `;
        }

        // Crypto Info
        if (report.type === 'crypto') {
            html += `
                <div class="report-section">
                    <div class="section-title">Cryptocurrency Analysis</div>
                    <div class="data-grid">
                        <div class="data-item"><div class="data-label">Detected Address</div><div class="data-value">${escapeHtml(report.target)}</div></div>
                        <div class="data-item"><div class="data-label">Likely Network</div><div class="data-value">${escapeHtml(data.cryptoType || 'Unknown')}</div></div>
                    </div>
                </div>
            `;
            if (data.balance) {
                html += `
                    <div class="report-section">
                        <div class="section-title">Wallet Statistics (BTC)</div>
                        <div class="data-grid">
                            <div class="data-item"><div class="data-label">Final Balance</div><div class="data-value">${(data.balance.final_balance / 100000000).toFixed(8)} BTC</div></div>
                            <div class="data-item"><div class="data-label">Total Received</div><div class="data-value">${(data.balance.total_received / 100000000).toFixed(8)} BTC</div></div>
                            <div class="data-item"><div class="data-label">Total Transactions</div><div class="data-value">${escapeHtml(data.balance.n_tx)}</div></div>
                        </div>
                    </div>
                `;
            }
        }

        // Gravatar (For Email and Username)
        if (data.gravatar) {
            html += `
                <div class="report-section">
                    <div class="section-title">Identity Match (Gravatar)</div>
                    <div class="profile-card">
                        ${data.gravatar.photos && data.gravatar.photos.length > 0 ? `<img src="${escapeHtml(data.gravatar.photos[0])}" class="profile-img">` : ''}
                        <div class="profile-info">
                            <div class="profile-name">${escapeHtml(data.gravatar.name || 'Anonymous Profile')}</div>
                            ${data.gravatar.location ? `<div class="profile-loc">📍 ${escapeHtml(data.gravatar.location)}</div>` : ''}
                            ${data.gravatar.url ? `<a href="${escapeHtml(data.gravatar.url)}" target="_blank" style="font-size: 0.85rem; margin-top: 0.25rem;">View Profile</a>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }

        // Phone specific
        if (report.type === 'phone' && data.cleanPhone) {
            html += `
                <div class="report-section">
                    <div class="section-title">Phone Metadata</div>
                    <div class="data-grid">
                        <div class="data-item"><div class="data-label">Cleaned Number</div><div class="data-value">${escapeHtml(data.cleanPhone)}</div></div>
                        <div class="data-item"><div class="data-label">Country Code</div><div class="data-value">${data.hasCountryCode ? 'Detected' : 'Not Detected (Defaults may apply)'}</div></div>
                    </div>
                </div>
            `;
        }

        // Dark Web Data
        if (data.darkweb && data.darkweb.length > 0) {
            html += `<div class="report-section"><div class="section-title" style="color: var(--error-color);">Dark Web (.onion) Mentions</div><div class="link-list">`;
            data.darkweb.forEach(item => {
                const url = typeof item === 'string' ? item : item.url;
                const title = item.title || 'Hidden Service';
                const snippet = item.snippet ? `<div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px; font-weight: normal; line-height: 1.4;">${escapeHtml(item.snippet)}</div>` : '';
                
                html += `<div class="link-item" style="display: flex; flex-direction: column; align-items: flex-start; color: #fca5a5; border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.1); padding: 0.75rem; border-radius: var(--radius-sm);">
                    <div style="display: flex; gap: 0.5rem; align-items: center; width: 100%;">
                        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" style="flex-shrink: 0;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                        <a href="${escapeHtml(url)}" style="color: inherit; text-decoration: none; word-break: break-all; font-weight: 700;" onclick="showOnionWarning(); return false;">${escapeHtml(title)}</a>
                    </div>
                    <div style="font-family: var(--font-mono); font-size: 0.75rem; color: #fca5a5; opacity: 0.8; margin-top: 2px;">${escapeHtml(url)}</div>
                    ${snippet}
                </div>`;
            });
            html += `</div></div>`;
        }

        // Investigation Links
        if (report.links && report.links.length > 0) {
            html += `<div class="report-section"><div class="section-title">External Pivot Links & Leak Databases</div><div class="link-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0.5rem;">`;
            report.links.forEach(l => {
                const isBreach = /breach|leak|pwned|darknet|intelx|dehashed|snusbase/i.test(l.name);
                const style = isBreach ? `style="color: #fca5a5; border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.1);"` : '';
                html += `<a href="${escapeHtml(l.url)}" target="_blank" class="link-item" ${style}>
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" style="min-width: 16px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                    Search on ${escapeHtml(l.name)}
                </a>`;
            });
            html += `</div></div>`;
        }

        // Dorks
        if (report.dorks && report.dorks.length > 0) {
            html += `<div class="report-section"><div class="section-title">Search Dorks (Copy/Paste to Google)</div><div>`;
            report.dorks.forEach(d => {
                html += `
                    <div class="dork-item">
                        <div class="dork-desc">${escapeHtml(d.desc)}</div>
                        ${escapeHtml(d.query)}
                    </div>
                `;
            });
            html += `</div></div>`;
        }

        html += `</div>`; // End body
        card.innerHTML = html;
        return card;
    }

    function escapeHtml(unsafe) {
        if (!unsafe) return '';
        return unsafe
             .toString()
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }
});