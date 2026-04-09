// Configuration
const CONFIG = {
    storageLimit: 100 * 1024 * 1024 * 1024,
    chunkSize: 32 * 1024 * 1024, // Default 32MB chunks
    maxChunks: 1000, // For files > 32GB, we'll increase chunkSize to keep chunk count manageable
    smallFileThreshold: 32 * 1024 * 1024, // Files under this size are single-chunk
};

// GLOBAL CONNECTION LIMITER
class Semaphore {
    constructor(max) {
        this.max = max;
        this.current = 0;
        this.waiting = [];
    }
    async acquire() {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        return new Promise(res => this.waiting.push(res));
    }
    release() {
        this.current--;
        if (this.waiting.length > 0) {
            this.current++;
            const next = this.waiting.shift();
            if (next) next();
        }
    }
}
const globalChunkSemaphore = new Semaphore(4); // Keep connections available for API calls and downloads

// SECURE PREVIEW CACHE
class PreviewStore {
    constructor() {
        this.dbName = 'UmbraDrivePreviews';
        this.storeName = 'cache';
        this.db = null;
    }

    async getDB() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async get(id) {
        const db = await this.getDB();
        return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    }

    async set(id, blob) {
        const db = await this.getDB();
        return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).put(blob, id);
            tx.oncomplete = () => resolve();
        });
    }

    async clear() {
        const db = await this.getDB();
        return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).clear();
            tx.oncomplete = () => resolve();
        });
    }
}

// PERSISTENT UPLOAD QUEUE
class PersistentQueue {
    constructor() {
        this.dbName = 'UmbraDriveUploads';
        this.storeName = 'pending';
        this.db = null;
    }

    async getDB() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
                }
            };
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async add(file, parentId, uploadId = null) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.add({
                file, // Storing Blobs in IndexedDB is supported in modern browsers
                name: file.name,
                size: file.size,
                type: file.type,
                parentId: parentId,
                uploadId: uploadId,
                relPath: file.webkitRelativePath || "",
                timestamp: Date.now()
            });
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => {
                console.error('[QUEUE] Add failed:', e.target.error);
                reject(e.target.error);
            };
        });
    }

    async updateUploadId(id, uploadId) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (data) {
                    data.uploadId = uploadId;
                    store.put(data);
                }
                resolve();
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    async remove(id) {
        const db = await this.getDB();
        return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).delete(id);
            tx.oncomplete = () => resolve();
        });
    }

    async getAll() {
        const db = await this.getDB();
        return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
        });
    }

    async clear() {
        const db = await this.getDB();
        return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).clear();
            tx.oncomplete = () => resolve();
        });
    }

    async cleanup() {
        const items = await this.getAll();
        const oneDay = 24 * 60 * 60 * 1000;
        const now = Date.now();
        for (const item of items) {
            // Also cleanup if it's not a valid Blob/File anymore
            if (now - item.timestamp > oneDay || !item.file) {
                await this.remove(item.id);
            }
        }
    }
}

class DriveApp {
    constructor() {
        this.shareToken = window.UMBRA_SHARE_TOKEN || null;
        this.isVisitor = !!this.shareToken;
        this.viewMode = localStorage.getItem('umbra_drive_view') || 'list';
        this.currentFolder = 'root';
        this.currentFilter = localStorage.getItem('umbra_drive_filter') || 'default';
        this.allFiles = []; // LOCAL CACHE OF ALL USER FILES
        this.selectedId = null;
        this.selectedIds = new Set();
        this.queue = new PersistentQueue();
        this.previews = new PreviewStore();
        this.activeTasks = new Map();
        this.init();
    }

    async safeFetch(url, options = {}, retries = 3) {
        let attempt = 0;
        while (attempt < retries) {
            try {
                if (!this.isVisitor) {
                    options.credentials = 'include';
                }
                const res = await fetch(url, options);
                const text = await res.text();
                let data = {};
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.substring(0, 100)}`);
                    return { success: true, text };
                }
                
                if (!res.ok) {
                    if (res.status === 409) return { ...data, conflict: true }; 
                    if (res.status === 401 || res.status === 403) {
                        if (!this.isVisitor && res.status === 401) window.location.href = 'https://portal.umbrasec.one/login';
                        throw new Error(data.error || `Auth Error ${res.status}`);
                    }
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                return data;
            } catch (err) {
                if (err.message.includes('Auth Error') || err.message.includes('File already exists') || err.conflict) throw err;
                attempt++;
                console.warn(`[FETCH] ${url} attempt ${attempt} failed: ${err.message}`);
                if (attempt >= retries) throw err;
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }

    async init() {
        // 1. Setup UI interaction IMMEDIATELY so buttons aren't "dead" during fetch
        this.setupEventListeners();
        this.setupContextMenu();

        // Double check: only treat as visitor if we are actually on a share path
        if (this.isVisitor && !window.location.pathname.includes('/s/')) {
            this.isVisitor = false;
            this.shareToken = null;
            document.body.classList.remove('visitor-mode');
        }

        if (this.isVisitor) {
            document.body.classList.add('visitor-mode');
            // Hide private UI and the sidebar toggle
            const privateSelectors = [
                '.app-sidebar', '.nav-right', '.new-action', '.search-box', '#menuToggle'
            ];
            privateSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => el.style.display = 'none');
            });
            
            // Adjust layout for visitor
            const mainLayout = document.querySelector('.main-layout');
            if (mainLayout) mainLayout.style.display = 'flex';
            const appContent = document.querySelector('.app-content');
            if (appContent) {
                appContent.style.maxWidth = '1200px';
                appContent.style.margin = '0 auto';
                appContent.style.width = '100%';
                appContent.style.padding = '0 20px';
            }

            // Fetch Share Info
            try {
                const info = await this.safeFetch(`/api/public/share/${this.shareToken}`);
                this.shareInfo = info;
                this.currentFolder = info.item_id;
                this.rootFolderId = info.item_id;
                document.title = `${info.name} — Shared Folder`;
                
                // Add a professional visitor header if not already present
                this.updateVisitorBanner();

            } catch (e) {
                this.showModal({ title: 'Invalid Link', body: 'This share link is invalid or has expired.', confirmText: 'Go Home', onConfirm: () => window.location.href = '/' });
            }
        } else {
            // Update active state in sidebar based on currentFilter
            document.querySelectorAll('.nav-item').forEach(l => {
                l.classList.toggle('active', l.getAttribute('data-filter') === this.currentFilter);
            });
        }

        if (!this.isVisitor) {
            this.setupSidebar();
            this.setupTasksUI();
            this.loadZKStatus();
        }
        
        // Ensure UI buttons match saved viewMode
        const vList = document.getElementById('viewList');
        const vGrid = document.getElementById('viewGrid');
        if(vList) vList.classList.toggle('active', this.viewMode === 'list');
        if(vGrid) vGrid.classList.toggle('active', this.viewMode === 'grid');

        await this.fetchAllData(); // Fetch everything initially (quota, basic list)
        
        if (!this.isVisitor && this.currentFilter === 'shares') {
            await this.refresh(); // Fetch share metadata specifically
        }

        if (!this.isVisitor) {
            // Handle Persistent Upload Resumption
            await this.queue.cleanup();
            const pending = await this.queue.getAll();
            if (pending.length > 0) {
                console.log(`[DRIVE] ${pending.length} pending tasks in queue.`);
            }
        }
    }

    updateVisitorBanner() {
        if (!this.isVisitor || !this.shareInfo) return;
        
        let banner = document.querySelector('.visitor-banner');
        if (!banner) {
            const appContent = document.querySelector('.app-content');
            banner = document.createElement('div');
            banner.className = 'visitor-banner';
            appContent.insertBefore(banner, appContent.firstChild);
        }

        const isAtRoot = this.currentFolder === this.rootFolderId;
        const currentFolderName = isAtRoot ? this.shareInfo.name : (this.allFiles.find(f => f.id === this.currentFolder)?.name || "Subfolder");

        banner.innerHTML = `
            <div class="visitor-banner-info">
                <i class="fa-solid ${isAtRoot ? 'fa-folder-open' : 'fa-folder'}"></i>
                <div class="banner-text">
                    <span class="banner-label">${isAtRoot ? 'Publicly Shared Folder' : 'Browsing Shared Folder'}</span>
                    <span class="banner-title">${currentFolderName}</span>
                </div>
            </div>
            <div class="visitor-banner-actions">
                <button class="btn-accent" onclick="drive.downloadFolderZip('${this.currentFolder}', '${currentFolderName}')">
                    <i class="fa-solid fa-file-zipper"></i> Download Folder (.zip)
                </button>
            </div>
        `;
    }

    downloadCurrentFolder() {
        const id = this.currentFolder;
        let name = "My Drive";
        if (id !== 'root') {
            const folder = this.allFiles.find(f => f.id === id);
            if (folder) name = folder.name;
        }
        this.downloadFolderZip(id, name);
    }

    async downloadFolderZip(id, name) {
        const task = this.addTask(name + '.zip', 'download');
        task.start();
        task.update(0, 'Zipping...');

        const url = this.isVisitor ? `/api/public/zip/${this.shareToken}/${id}` : `/api/zip/${id}`;

        try {
            const response = await fetch(url, { credentials: 'include', signal: task.abortController.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
            const reader = response.body.getReader();
            const chunks = [];
            let received = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (contentLength > 0) {
                    task.update((received / contentLength) * 100, `${this.formatSize(received)} / ${this.formatSize(contentLength)}`);
                } else {
                    task.update(0, `${this.formatSize(received)} downloaded...`);
                }
            }

            const blob = new Blob(chunks, { type: 'application/zip' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name + '.zip';
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(a.href);
            a.remove();

            task.complete(true, 'Done');
        } catch (err) {
            if (err.name === 'AbortError') {
                task.complete(false, 'Cancelled');
            } else {
                console.error('[ZIP DOWNLOAD] Error:', err);
                task.complete(false, 'Failed');
                this.showToast('Download failed: ' + err.message, 'error');
            }
        }
    }

    async resumeAll() {
        if (this.isVisitor) return;
        const pending = await this.queue.getAll();
        if (pending.length === 0) return;
        
        console.log(`[DRIVE] Attempting to resume ${pending.length} tasks...`);
        // Process in small batches of concurrency to not blow up the network immediately
        const CONCURRENCY = 3;
        let index = 0;

        const worker = async () => {
            while (index < pending.length) {
                const item = pending[index++];
                try {
                    const file = item.file instanceof File ? item.file : new File([item.file], item.name, { type: item.type });
                    await this.performUpload(file, item.parentId, null, item.id, item.uploadId);
                } catch (err) {
                    console.error('[RESUME] Failed:', item.name, err);
                }
            }
        };

        const workers = Array(Math.min(CONCURRENCY, pending.length)).fill(null).map(() => worker());
        await Promise.all(workers);
        this.fetchAllData();
    }
    setupTasksUI() {
        const panel = document.getElementById('tasksPanel');
        if (panel) {
            panel.classList.add('minimized');
            const header = panel.querySelector('.tasks-header');
            const clearBtn = document.createElement('span');
            clearBtn.innerHTML = '<i class="fa-solid fa-broom"></i>';
            clearBtn.title = 'Clear Completed';
            clearBtn.style.marginLeft = 'auto';
            clearBtn.style.marginRight = '10px';
            clearBtn.onclick = (e) => {
                e.stopPropagation();
                this.clearCompletedTasks();
            };
            header.insertBefore(clearBtn, document.getElementById('tasksChevron'));
        }
    }

    clearCompletedTasks() {
        const list = document.getElementById('tasksList');
        const items = list.querySelectorAll('.task-item');
        items.forEach(item => {
            const bar = item.querySelector('.task-progress-bar');
            if (bar && (bar.classList.contains('success') || bar.classList.contains('error'))) {
                item.remove();
            }
        });
        this.updateTaskVisibility();
    }

    updateTaskVisibility() {
        const activeList = document.getElementById('activeTasksList');
        const queuedList = document.getElementById('queuedTasksList');
        const activeTitle = document.getElementById('activeTitle');
        const queuedTitle = document.getElementById('queuedTitle');
        const panel = document.getElementById('tasksPanel');

        const activeCount = activeList ? activeList.children.length : 0;
        const queuedCount = queuedList ? queuedList.children.length : 0;

        if (activeTitle) activeTitle.style.display = activeCount > 0 ? 'block' : 'none';
        if (queuedTitle) queuedTitle.style.display = queuedCount > 0 ? 'block' : 'none';
        
        if (activeCount === 0 && queuedCount === 0) {
            // Auto-minimize when done, but only if not already minimized
            if (panel && panel.classList.contains('expanded')) this.toggleTasks();
            if (panel) panel.style.display = 'none';
        } else if (panel) {
            panel.style.display = 'flex';
        }
    }

    toggleTasks() {
        const panel = document.getElementById('tasksPanel');
        const chevron = document.getElementById('tasksChevron');
        if (!panel || !chevron) return;

        const isExpanded = panel.classList.contains('expanded');
        
        if (isExpanded) {
            panel.classList.remove('expanded');
            panel.classList.add('minimized');
            chevron.classList.remove('fa-chevron-down');
            chevron.classList.add('fa-chevron-up');
        } else {
            panel.classList.remove('minimized');
            panel.classList.add('expanded');
            chevron.classList.remove('fa-chevron-up');
            chevron.classList.add('fa-chevron-down');
        }
    }

    addTask(name, type = 'upload') {
        const id = Math.random().toString(36).substring(7);
        const activeList = document.getElementById('activeTasksList');
        const queuedList = document.getElementById('queuedTasksList');
        const panel = document.getElementById('tasksPanel');
        
        const item = document.createElement('div');
        item.className = 'task-item';
        item.id = `task-${id}`;

        const typeIcon = type === 'upload' ? 'fa-upload' : 'fa-download';
        const progressClass = type === 'upload' ? '' : 'download';

        item.innerHTML = `
            <div class="task-main">
                <div class="task-info">
                    <div class="task-name"><i class="fa-solid ${typeIcon}"></i> ${name}</div>
                    <div class="task-status" id="status-${id}">Queued...</div>
                </div>
                <div class="task-progress-container">
                    <div class="task-progress-bar ${progressClass}" id="bar-${id}"></div>
                </div>
            </div>
            <div class="task-parts" id="parts-${id}"></div>
            <button class="task-abort-btn" id="abort-${id}" title="Cancel Task"><i class="fa-solid fa-circle-xmark"></i></button>
        `;
        
        const abortController = new AbortController();

        const task = {
            id,
            name,
            type,
            abortController,
            aborted: false,
            setExpandable: () => {
                item.classList.add('expandable');
                const main = item.querySelector('.task-main');
                main.onclick = () => item.classList.toggle('expanded');
            },
            addPart: (partId, partName) => {
                const partsContainer = document.getElementById(`parts-${id}`);
                if (!partsContainer) return null;
                const partItem = document.createElement('div');
                partItem.className = 'task-part-item';
                partItem.id = `part-${id}-${partId}`;
                partItem.innerHTML = `
                    <div class="task-part-info">
                        <span>${partName}</span>
                        <span id="part-status-${id}-${partId}">Pending...</span>
                    </div>
                    <div class="task-part-progress">
                        <div class="task-part-bar" id="part-bar-${id}-${partId}"></div>
                    </div>
                `;
                partsContainer.appendChild(partItem);
                task.setExpandable();
                return {
                    update: (percent, statusText) => {
                        const status = document.getElementById(`part-status-${id}-${partId}`);
                        const bar = document.getElementById(`part-bar-${id}-${partId}`);
                        if (status) status.textContent = statusText || `${Math.round(percent)}%`;
                        if (bar) bar.style.width = `${percent}%`;
                    },
                    complete: (success = true) => {
                        const bar = document.getElementById(`part-bar-${id}-${partId}`);
                        const status = document.getElementById(`part-status-${id}-${partId}`);
                        if (bar) {
                            bar.style.width = '100%';
                            if (success) bar.classList.add('success');
                        }
                        if (status) status.textContent = success ? 'Done' : 'Failed';
                    }
                };
            },
            start: () => {
                if (activeList) {
                    activeList.prepend(item);
                    this.updateTaskVisibility();
                    const status = document.getElementById(`status-${id}`);
                    if (status) status.textContent = 'Starting...';
                }
            },
            update: (percent, message = null) => {
                const status = document.getElementById(`status-${id}`);
                const bar = document.getElementById(`bar-${id}`);
                
                // For large files, show 1 decimal place for smoother feedback
                const displayPercent = percent > 0 && percent < 99.9 ? percent.toFixed(1) : Math.round(percent);
                
                if (status) status.textContent = message || `${displayPercent}%`;
                if (bar) bar.style.width = `${percent}%`;
            },
            complete: (success = true, message = null) => {
                const status = document.getElementById(`status-${id}`);
                const bar = document.getElementById(`bar-${id}`);
                const abortBtn = document.getElementById(`abort-${id}`);
                if (status) status.textContent = message || (success ? 'Done' : 'Failed');
                if (bar) {
                    bar.style.width = '100%';
                    bar.classList.add(success ? 'success' : 'error');
                }
                if (abortBtn) abortBtn.style.display = 'none';
                
                this.activeTasks.delete(id);

                setTimeout(() => {
                    item.style.opacity = '0';
                    item.style.height = '0';
                    item.style.padding = '0';
                    setTimeout(() => {
                        item.remove();
                        this.updateTaskVisibility();
                    }, 500);
                }, 5000);
            }
        };

        const abortBtn = item.querySelector(`#abort-${id}`);
        if (abortBtn) {
            abortBtn.onclick = () => {
                task.aborted = true;
                abortController.abort();
                task.complete(false, 'Cancelled');
            };
        }

        // Always start in Queue list
        if (queuedList) {
            queuedList.prepend(item);
            this.updateTaskVisibility();
        }

        // Ensure panel is visible when a task is added
        if (panel) {
            panel.style.display = 'flex';
            // If it was minimized, expand it so the user sees the new task
            if (panel.classList.contains('minimized')) {
                this.toggleTasks();
            }
        }

        this.activeTasks.set(id, task);
        return task;
    }

    async getPreviewUrl(file) {
        if (!file || file.type === 'folder') return null;
        // Try cache first
        const cached = await this.previews.get(file.id);
        if (cached) return URL.createObjectURL(cached);

        // Fetch and cache
        try {
            // Using safeFetch ensures we handle auth errors and retries
            // But safeFetch currently returns text/json, we need a blob here
            // Let's modify it or just use fetch with same logic
            const res = await fetch(`/api/download/${file.id}`, { credentials: 'include' });
            if (!res.ok) {
                if (res.status === 401) window.location.href = 'https://portal.umbrasec.one/login';
                return null;
            }
            const blob = await res.blob();
            await this.previews.set(file.id, blob);
            return URL.createObjectURL(blob);
        } catch (e) {
            console.warn(`[PREVIEW] Failed to load: ${file.name}`, e);
            return null;
        }
    }

    async fetchAllData() {
        try {
            if (this.isVisitor) {
                // For visitors, we fetch ONLY the content of the current folder being viewed
                const url = `/api/public/list/${this.shareToken}?folder=${this.currentFolder === 'root' ? '' : this.currentFolder}`;
                const data = await this.safeFetch(url);
                this.allFiles = Array.isArray(data) ? data : [];
            } else {
                // For logged-in users, we fetch EVERYTHING for the user for local filtering/navigation
                const data = await this.safeFetch('/api/list-all');
                this.allFiles = Array.isArray(data) ? data : [];
                this.updateQuotaUI();
            }
            this.render(); // Perform local render
        } catch (err) { 
            console.error('Drive Fetch Error:', err); 
            this.allFiles = [];
            if (!this.isVisitor) this.updateQuotaUI();
            this.render(); // Still render (will show empty/error state)
            if (!this.isVisitor && err.message.includes('401')) window.location.href = 'https://portal.umbrasec.one/login';
        }
    }

    // LOCAL RENDER LOGIC
    render() {
        const filtered = this.getFilteredFiles();
        this.renderFiles(filtered);
        this.updateBreadcrumbs();
    }

    getFilteredFiles() {
        let results = Array.isArray(this.allFiles) ? [...this.allFiles] : [];

        if (this.isVisitor) {
            // For visitors, allFiles already contains only the items for the current folder
            // because we fetch on every folder change.
            results = results;
        } else {
            if (this.currentFilter === 'shares') {
                return []; // Shares are fetched separately via refresh()
            }
            if (this.currentFilter === 'starred') {
                results = results.filter(f => f.is_starred === 1 && f.is_trashed === 0);
            } else if (this.currentFilter === 'trash') {
                results = results.filter(f => f.is_trashed === 1);
            } else if (this.currentFilter === 'recent') {
                results = results.filter(f => f.is_trashed === 0)
                                 .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                                 .slice(0, 50);
            } else {
                results = results.filter(f => f.parent_id === this.currentFolder && f.is_trashed === 0);
            }
        }

        // Apply sort: folders first, then alphabetical
        return results.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return a.name.localeCompare(b.name);
        });
    }

    async resumeUploads(items) {
        if (this._isResuming) return;
        this._isResuming = true;
        
        console.log(`[DRIVE] Resuming ${items.length} uploads from persistent queue`);
        for (const item of items) {
            try {
                const file = item.file instanceof File ? item.file : new File([item.file], item.name, { type: item.type });
                await this.performUpload(file, item.parentId, null, item.id, item.uploadId);
            } catch (err) {
                console.error('[RESUME] Failed:', item.name, err);
            }
        }
        this._isResuming = false;
        await this.fetchAllData(); 
    }

    async purgeQueue() {
        this.showModal({
            title: 'Clear Upload Queue & Ghost Storage?',
            body: 'This will remove all pending uploads from your local browser cache AND clear the server-side ghost storage reservation. Any incomplete uploads will need to be restarted.',
            confirmText: 'Clear All',
            onConfirm: async () => {
                try {
                    // Abort all active tasks
                    this._abortBatch = true; // Signal to stop batch processing
                    for (const [id, task] of this.activeTasks.entries()) {
                        task.aborted = true;
                        task.abortController.abort();
                        task.complete(false, 'Cancelled');
                    }
                    this.activeTasks.clear();

                    await this.queue.clear();
                    await this.safeFetch('/api/upload/purge', { method: 'DELETE' });
                    this.showToast('Queue and ghost storage cleared', 'success');
                    
                    const activeList = document.getElementById('activeTasksList');
                    const queuedList = document.getElementById('queuedTasksList');
                    if (activeList) activeList.innerHTML = '';
                    if (queuedList) queuedList.innerHTML = '';
                    this.updateTaskVisibility();
                    this.updateQuotaUI();
                } catch (e) { this.showToast(e.message, 'error'); }
            }
        });
    }

    async refresh() {
        await this.fetchAllData();
        if (!this.isVisitor && this.currentFilter === 'shares') {
            try {
                const [sharesRes, dropsRes] = await Promise.all([
                    fetch('/api/share/list').then(r => r.json()).catch(() => []),
                    fetch('/api/drop/list').then(r => r.json()).catch(() => []),
                ]);
                const shares = Array.isArray(sharesRes) ? sharesRes : [];
                const dropsRaw = Array.isArray(dropsRes) ? dropsRes : (dropsRes.drops || []);
                const drops = dropsRaw.map(d => ({ ...d, _isDrop: true }));
                this.renderShareAndDropList(shares, drops);
                this.updateBreadcrumbs();
            } catch (e) {}
        }
    }

    // MODAL SYSTEM
    showModal({ title, body, confirmText = 'Confirm', onConfirm }) {
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalBody').innerHTML = body;
        const footer = document.getElementById('modalFooter');
        footer.innerHTML = `
            <button class="btn-secondary" onclick="drive.closeModal()">Cancel</button>
            <button class="btn-accent" id="modalConfirmBtn">${confirmText}</button>
        `;
        document.getElementById('modalConfirmBtn').onclick = () => {
            onConfirm();
            this.closeModal();
        };
        document.getElementById('modalOverlay').classList.add('show');
    }

    showPrompt({ title, message, placeholder, confirmText = 'Save', onConfirm }) {
        const body = `<div>${message}</div><input type="text" id="promptInput" placeholder="${placeholder}" autofocus>`;
        this.showModal({
            title, body, confirmText,
            onConfirm: () => {
                const val = document.getElementById('promptInput').value;
                if (val) onConfirm(val);
            }
        });
        setTimeout(() => {
            const input = document.getElementById('promptInput');
            if(input) input.focus();
        }, 100);
    }

    closeModal() { document.getElementById('modalOverlay').classList.remove('show'); }

    showToast(message, type = 'info') {
        const toast = document.getElementById('uploadToast');
        const title = document.getElementById('toastTitle');
        const bar = document.getElementById('toastBar');
        if(title) title.textContent = message;
        // Only set bar to 100% if success, otherwise don't touch it to avoid flickering 0%
        if(bar && type === 'success') bar.style.width = '100%';
        if(toast) {
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
        }
    }

    // --- Zero-Knowledge Encryption ---
    async loadZKStatus() {
        try {
            const data = await this.safeFetch('/api/zk/status');
            this.zkEnabled = data.enabled;
            this.zkHasKey = data.hasKey;
            this.updateZKUI();
        } catch (err) {
            console.warn('ZK status check failed:', err.message);
            // Hide the ZK card if it can't load (e.g. unauthenticated)
            const card = document.getElementById('zkCard');
            if (card) card.style.display = 'none';
        }
    }

    updateZKUI() {
        const toggle = document.getElementById('zkToggle');
        const status = document.getElementById('zkStatus');
        const keySection = document.getElementById('zkKeySection');
        const keyManage = document.getElementById('zkKeyManage');

        if (!toggle) return;

        toggle.checked = this.zkEnabled;

        if (this.zkEnabled) {
            status.innerHTML = '<span style="color:var(--accent);"><i class="fa-solid fa-lock"></i> Active</span> — Files are encrypted client-side before upload';
            status.style.color = 'var(--accent)';
            keySection.style.display = 'none';
            if (keyManage) keyManage.style.display = 'flex';
        } else if (this.zkHasKey) {
            status.textContent = 'Disabled — Your public key is saved. Toggle on to re-enable.';
            status.style.color = 'var(--text-muted)';
            keySection.style.display = 'none';
            if (keyManage) keyManage.style.display = 'flex';
        } else {
            status.textContent = 'Not configured — Upload your RSA public key to enable';
            status.style.color = 'var(--text-muted)';
            keySection.style.display = this.zkEnabled ? 'none' : 'block';
            if (keyManage) keyManage.style.display = 'none';
        }
    }

    async toggleZK(enabled) {
        try {
            if (enabled) {
                if (!this.zkHasKey) {
                    // Need a public key first
                    const keySection = document.getElementById('zkKeySection');
                    keySection.style.display = 'block';
                    document.getElementById('zkToggle').checked = false;
                    this.showToast('Upload your RSA public key first', 'info');
                    return;
                }
                await this.safeFetch('/api/zk/enable', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                this.zkEnabled = true;
                this.updateZKUI();
                this.showToast('Zero-knowledge encryption enabled', 'success');
            } else {
                await this.safeFetch('/api/zk/disable', { method: 'POST' });
                this.zkEnabled = false;
                this.updateZKUI();
                this.showToast('Zero-knowledge encryption disabled', 'info');
            }
        } catch (err) {
            this.showToast('Failed: ' + err.message, 'error');
            await this.loadZKStatus();
        }
    }

    async saveZKKey() {
        const keyInput = document.getElementById('zkPublicKey');
        const publicKey = keyInput.value.trim();
        if (!publicKey) {
            this.showToast('Please paste your RSA public key', 'error');
            return;
        }
        if (!publicKey.includes('-----BEGIN PUBLIC KEY-----')) {
            this.showToast('Invalid PEM format. Key must start with -----BEGIN PUBLIC KEY-----', 'error');
            return;
        }
        try {
            const endpoint = this._zkKeyIsUpdate ? '/api/zk/update-key' : '/api/zk/enable';
            await this.safeFetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ publicKey }),
            });
            this.zkEnabled = true;
            this.zkHasKey = true;
            this._zkKeyIsUpdate = false;
            keyInput.value = '';
            this.updateZKUI();
            this.showToast(this._zkKeyIsUpdate ? 'Public key updated' : 'Zero-knowledge encryption enabled with your public key', 'success');
        } catch (err) {
            this.showToast('Failed: ' + err.message, 'error');
        }
    }

    async changeZKKey() {
        const keySection = document.getElementById('zkKeySection');
        keySection.style.display = 'block';
        this._zkKeyIsUpdate = true;
        document.getElementById('zkPublicKey').value = '';
        document.getElementById('zkPublicKey').placeholder = 'Paste your new RSA public key (PEM format)...';
        document.getElementById('zkPublicKey').focus();
    }

    async deleteZKKey() {
        const confirmed = await new Promise(resolve => {
            this.showModal({
                title: 'Delete Public Key',
                body: 'Are you sure you want to delete your public key? Zero-knowledge encryption will be disabled and you will not be able to decrypt ZK-encrypted files without re-uploading the key.',
                confirmText: 'Delete Key',
                danger: true,
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });
        if (!confirmed) return;
        try {
            await this.safeFetch('/api/zk/delete-key', { method: 'POST' });
            this.zkEnabled = false;
            this.zkHasKey = false;
            this.updateZKUI();
            this.showToast('Public key deleted and ZK encryption disabled', 'info');
        } catch (err) {
            this.showToast('Failed: ' + err.message, 'error');
        }
    }

    // --- ZK Client-Side Crypto Helpers ---

    async _getZKPublicKey() {
        if (this._cachedZKPublicKey) return this._cachedZKPublicKey;
        const data = await this.safeFetch('/api/zk/public-key');
        const pemKey = data.publicKey;
        const pemBody = pemKey.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').replace(/\s/g, '');
        const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
        this._cachedZKPublicKey = await crypto.subtle.importKey(
            'spki', binaryDer.buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']
        );
        return this._cachedZKPublicKey;
    }

    async zkEncryptBlob(blob) {
        const publicKey = await this._getZKPublicKey();
        // Generate random AES-256-GCM key and IV
        const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
        // Encrypt the AES key with RSA-OAEP
        const encryptedAesKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawAesKey);
        // Encrypt the file data with AES-GCM
        const plaintext = await blob.arrayBuffer();
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
        // Build envelope: [2 bytes keyLen][encryptedAesKey][12 bytes IV][ciphertext]
        const keyLen = encryptedAesKey.byteLength;
        const envelope = new Uint8Array(2 + keyLen + 12 + ciphertext.byteLength);
        envelope[0] = (keyLen >> 8) & 0xff;
        envelope[1] = keyLen & 0xff;
        envelope.set(new Uint8Array(encryptedAesKey), 2);
        envelope.set(iv, 2 + keyLen);
        envelope.set(new Uint8Array(ciphertext), 2 + keyLen + 12);
        return new Blob([envelope]);
    }

    async zkDecryptBlob(encryptedBlob, privateKeyPem) {
        // Import the RSA private key
        const pemBody = privateKeyPem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
        const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
        const privateKey = await crypto.subtle.importKey(
            'pkcs8', binaryDer.buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']
        );
        // Parse envelope
        const buf = await encryptedBlob.arrayBuffer();
        const view = new Uint8Array(buf);
        const keyLen = (view[0] << 8) | view[1];
        const encryptedAesKey = buf.slice(2, 2 + keyLen);
        const iv = view.slice(2 + keyLen, 2 + keyLen + 12);
        const ciphertext = buf.slice(2 + keyLen + 12);
        // Decrypt AES key with RSA
        const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, encryptedAesKey);
        const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
        // Decrypt file data
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
        return new Blob([plaintext]);
    }

    _getStoredPrivateKey() {
        return sessionStorage.getItem('umbra_zk_private_key') || null;
    }

    _storePrivateKey(pem) {
        sessionStorage.setItem('umbra_zk_private_key', pem);
    }

    async promptForPrivateKey() {
        return new Promise((resolve) => {
            const existing = this._getStoredPrivateKey();
            this.showModal({
                title: 'Decrypt Zero-Knowledge File',
                body: `<p style="margin-bottom:10px;font-size:0.85rem;color:var(--text-dim);">This file is encrypted with your public key. Paste your RSA private key to decrypt it.</p>
                       <textarea id="zkPrivateKeyInput" rows="5" style="width:100%;font-family:monospace;font-size:0.75rem;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;resize:vertical;" placeholder="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----">${existing || ''}</textarea>
                       <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:0.78rem;color:var(--text-dim);cursor:pointer;"><input type="checkbox" id="zkRememberKey" ${existing ? 'checked' : ''}> Remember for this session</label>`,
                confirmText: 'Decrypt',
                onConfirm: () => {
                    const key = document.getElementById('zkPrivateKeyInput').value.trim();
                    const remember = document.getElementById('zkRememberKey').checked;
                    if (remember && key) this._storePrivateKey(key);
                    else if (!remember) sessionStorage.removeItem('umbra_zk_private_key');
                    resolve(key || null);
                },
                onCancel: () => resolve(null),
            });
        });
    }

    // --- Settings Modal ---

    openSettings() {
        const zkEnabled = this.zkEnabled;
        const zkHasKey = this.zkHasKey;
        this.showModal({
            title: 'Drive Settings',
            body: `
                <div style="display:flex;flex-direction:column;gap:16px;">
                    <div style="border:1px solid var(--border);border-radius:8px;padding:14px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <span style="font-weight:600;font-size:0.9rem;"><i class="fa-solid fa-shield-halved" style="color:var(--accent);margin-right:6px;"></i>Zero-Knowledge Encryption</span>
                            <span style="font-size:0.75rem;padding:2px 8px;border-radius:4px;background:${zkEnabled ? 'rgba(45,212,191,0.15)' : 'rgba(255,255,255,0.05)'};color:${zkEnabled ? '#2dd4bf' : 'var(--text-dim)'};">${zkEnabled ? 'Active' : 'Disabled'}</span>
                        </div>
                        <p style="font-size:0.8rem;color:var(--text-dim);margin-bottom:10px;">When enabled, files are encrypted client-side with your RSA public key before upload. The server never sees your unencrypted data.</p>
                        <div style="display:flex;gap:8px;flex-wrap:wrap;">
                            ${!zkEnabled && zkHasKey ? '<button class="btn-accent" onclick="drive.toggleZK(true);drive.closeModal();" style="font-size:0.8rem;padding:6px 12px;">Enable</button>' : ''}
                            ${zkEnabled ? '<button class="btn-secondary" onclick="drive.toggleZK(false);drive.closeModal();" style="font-size:0.8rem;padding:6px 12px;">Disable</button>' : ''}
                            ${zkHasKey ? '<button class="btn-secondary" onclick="drive.changeZKKey();drive.closeModal();" style="font-size:0.8rem;padding:6px 12px;"><i class="fa-solid fa-key"></i> Change Key</button>' : ''}
                            ${!zkHasKey ? '<button class="btn-accent" onclick="drive.closeModal();document.getElementById(\'zkKeySection\').style.display=\'block\';document.getElementById(\'zkPublicKey\').focus();" style="font-size:0.8rem;padding:6px 12px;"><i class="fa-solid fa-key"></i> Upload Public Key</button>' : ''}
                            ${zkHasKey ? '<button class="btn-secondary danger" onclick="drive.deleteZKKey();drive.closeModal();" style="font-size:0.8rem;padding:6px 12px;color:var(--danger);"><i class="fa-solid fa-trash"></i> Delete Key</button>' : ''}
                        </div>
                    </div>
                    <div style="border:1px solid var(--border);border-radius:8px;padding:14px;">
                        <span style="font-weight:600;font-size:0.9rem;"><i class="fa-solid fa-hard-drive" style="color:var(--accent);margin-right:6px;"></i>Storage</span>
                        <div style="margin-top:8px;font-size:0.8rem;color:var(--text-dim);" id="settingsStorageInfo">
                            ${document.getElementById('storageText')?.textContent || 'Loading...'}
                        </div>
                    </div>
                    <div style="border:1px solid var(--border);border-radius:8px;padding:14px;">
                        <span style="font-weight:600;font-size:0.9rem;"><i class="fa-solid fa-palette" style="color:var(--accent);margin-right:6px;"></i>Theme</span>
                        <div style="margin-top:8px;display:flex;gap:8px;">
                            <button class="btn-secondary" onclick="drive.setTheme('dark');drive.closeModal();" style="font-size:0.8rem;padding:6px 12px;"><i class="fa-solid fa-moon"></i> Dark</button>
                            <button class="btn-secondary" onclick="drive.setTheme('light');drive.closeModal();" style="font-size:0.8rem;padding:6px 12px;"><i class="fa-solid fa-sun"></i> Light</button>
                        </div>
                    </div>
                </div>`,
            confirmText: 'Close',
            onConfirm: () => {},
        });
    }

    setTheme(theme) {
        document.body.className = `theme-${theme}`;
        localStorage.setItem('umbra_drive_theme', theme);
        const icon = document.getElementById('themeIcon');
        if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }

    setupSidebar() {
        document.querySelectorAll('.nav-item').forEach(link => {
            link.onclick = (e) => {
                e.preventDefault();
                document.querySelectorAll('.nav-item').forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                this.currentFilter = link.getAttribute('data-filter');
                localStorage.setItem('umbra_drive_filter', this.currentFilter);
                this.currentFolder = 'root';
                
                if (this.currentFilter === 'shares') {
                    this.refresh();
                } else {
                    this.render(); // Local render
                }
                
                if (window.innerWidth <= 768) {
                    document.querySelector('.app-sidebar').classList.remove('active');
                }
            };
        });
    }

    toggleSidebar() {
        const sidebar = document.querySelector('.app-sidebar');
        sidebar.classList.toggle('active');
    }

    setupEventListeners() {
        const newBtn = document.getElementById('newBtn');
        if (newBtn) {
            newBtn.onclick = (e) => { e.stopPropagation(); document.getElementById('newDropdown').classList.toggle('show'); };
        }
        
        window.onclick = (e) => { 
            const drop = document.getElementById('newDropdown');
            if (drop) drop.classList.remove('show');
            const menu = document.getElementById('contextMenu');
            if (menu) menu.style.display = 'none';
            
            if (window.innerWidth <= 768) {
                const sidebar = document.querySelector('.app-sidebar');
                if (sidebar.classList.contains('active') && !sidebar.contains(e.target) && !document.getElementById('menuToggle').contains(e.target)) {
                    sidebar.classList.remove('active');
                }
            }
        };

        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            let searchTimeout;
            searchInput.oninput = (e) => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    const term = e.target.value.toLowerCase();
                    const filtered = this.getFilteredFiles().filter(f => (f.name || "").toLowerCase().includes(term));
                    this.renderFiles(filtered);
                }, 200);
            };
        }

        const dropZone = document.getElementById('dropZone');
        if (dropZone) {
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
                dropZone.addEventListener(name, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
            });
            ['dragenter', 'dragover'].forEach(name => {
                dropZone.addEventListener(name, () => dropZone.classList.add('drag-over'), false);
            });
            ['dragleave', 'drop'].forEach(name => {
                dropZone.addEventListener(name, () => dropZone.classList.remove('drag-over'), false);
            });
            dropZone.addEventListener('drop', async (e) => {
                dropZone.classList.remove('drag-over');
                const items = e.dataTransfer.items;
                if (items && items.length > 0) {
                    const files = await this.getAllFilesFromItems(items);
                    if (files.length > 0) this.performBatchUpload(files);
                }
            }, false);
        }
    }

    async getAllFilesFromItems(items) {
        const entries = [];
        const traverse = async (entry, path = "") => {
            if (entry.isFile) {
                const file = await new Promise((res) => entry.file(res));
                // We'll use a custom property for the path since webkitRelativePath is often read-only
                file.fullPath = path + entry.name;
                entries.push({ type: 'file', file, path: path + entry.name });
            } else if (entry.isDirectory) {
                entries.push({ type: 'folder', path: path + entry.name });
                const reader = entry.createReader();
                const readEntries = () => new Promise((res) => reader.readEntries(res));
                let results = await readEntries();
                while (results.length > 0) {
                    for (const child of results) {
                        await traverse(child, path + entry.name + "/");
                    }
                    results = await readEntries();
                }
            }
        };
        for (const item of items) {
            const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : item;
            if (entry) await traverse(entry);
        }
        return entries;
    }

    async uploadFolder() {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.onchange = (e) => {
            if (e.target.files.length > 0) {
                const entries = Array.from(e.target.files).map(f => ({
                    type: 'file',
                    file: f,
                    path: f.webkitRelativePath
                }));
                this.performBatchUpload(entries);
            }
        };
        input.click();
    }

    async performBatchUpload(entries) {
        if (!entries || entries.length === 0) return;
        this._abortBatch = false; // Reset abort flag
        
        const preparationTask = this.addTask('Preparing upload...', 'upload');
        preparationTask.start();
        preparationTask.update(0, 'Scanning existing drive structure...');

        // 0. PRE-POPULATE FOLDER CACHE: Use our local allFiles to avoid many redundant API calls
        const folders = {};
        if (Array.isArray(this.allFiles)) {
            this.allFiles.forEach(f => {
                if (f.type === 'folder' && f.is_trashed === 0) {
                    // We need a path-based key. For simplicity in batch upload, 
                    // we'll build it as we traverse folders below, but we can cache IDs by (parent_id + name)
                    folders[`${f.parent_id}:${f.name}`] = f.id;
                }
            });
        }

        const filesToUpload = [];
        const total = entries.length;
        
        // 1. Create Folders Sequentially to ensure hierarchy
        for (let i = 0; i < entries.length; i++) {
            if (this._abortBatch) {
                preparationTask.complete(false, 'Cancelled');
                return;
            }
            const entry = entries[i];
            let parentId = this.currentFolder;
            let cleanPath = entry.path;
            if (cleanPath.startsWith('/')) cleanPath = cleanPath.substring(1);
            const pathParts = cleanPath.split('/').filter(p => p !== "");
            
            const folderHierarchy = entry.type === 'folder' ? pathParts : pathParts.slice(0, -1);
            let currentPathKey = parentId; 
            
            for (const folderName of folderHierarchy) {
                const cacheKey = `${currentPathKey}:${folderName}`;
                if (!folders[cacheKey]) {
                    try {
                        const data = await this.safeFetch('/api/folder', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: folderName, parent_id: currentPathKey })
                        });
                        folders[cacheKey] = data.id;
                    } catch (err) { console.error('Folder creation error:', err); }
                }
                if (folders[cacheKey]) currentPathKey = folders[cacheKey];
            }
            
            // Final parent for the file/entry
            const finalParentId = currentPathKey;

            if (entry.type === 'file') {
                // LOCAL CACHE CHECK: Avoid adding to bulk-check if we KNOW it exists
                const fileExistsLocally = Array.isArray(this.allFiles) && this.allFiles.some(f => 
                    f.name === entry.file.name && f.parent_id === finalParentId && f.is_trashed === 0
                );
                
                if (fileExistsLocally) {
                    // Log it but don't even create a task for it
                    continue; 
                }

                const task = this.addTask(entry.file.name, 'upload');
                filesToUpload.push({ file: entry.file, parentId: finalParentId, task });
            }

            if (i % 100 === 0) {
                preparationTask.update((i / total) * 50, `Processing hierarchy: ${i}/${total}`);
            }
        }

        if (filesToUpload.length === 0) {
            preparationTask.complete(true, 'Nothing new to upload');
            this.showToast('All files already exist', 'info');
            return;
        }

        preparationTask.update(50, 'Checking existing files...');

        // 2. BULK CHECK: Pre-verify which files can be skipped (larger batch size)
        const bulkResults = {};
        const BATCH_SIZE = 100;
        for (let i = 0; i < filesToUpload.length; i += BATCH_SIZE) {
            if (this._abortBatch) {
                preparationTask.complete(false, 'Cancelled');
                return;
            }
            const batch = filesToUpload.slice(i, i + BATCH_SIZE);
            try {
                const res = await this.safeFetch('/api/upload/bulk-check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        files: batch.map(f => ({ 
                            name: f.file.name, 
                            type: 'file', 
                            parent_id: f.parentId 
                        }))
                    })
                });
                if (res) Object.assign(bulkResults, res);
            } catch (err) { console.error('Bulk check error:', err); }
            
            preparationTask.update(50 + ((i / filesToUpload.length) * 50), `Verifying: ${i}/${filesToUpload.length}`);
        }

        preparationTask.complete(true, 'Ready');

        // 3. Upload Files with Concurrency Limit
        const CONCURRENCY = 3;
        let processedIndex = 0; // Use a clean index for the workers

        const nextTask = () => {
            if (this._abortBatch) return null;
            if (processedIndex < filesToUpload.length) {
                return filesToUpload[processedIndex++];
            }
            return null;
        };

        const worker = async () => {
            let item;
            while ((item = await nextTask())) {
                const key = `${item.parentId}:${item.file.name}`;
                const bulkInfo = bulkResults[key];
                if (bulkInfo && bulkInfo.exists && !bulkInfo.is_trashed) {
                    if (item.task) item.task.complete(true, 'Skipped');
                    continue; 
                }

                try {
                    let queueId = null;
                    if (item.file.size <= 2 * 1024 * 1024 * 1024) {
                        queueId = await this.queue.add(item.file, item.parentId);
                    } else {
                        console.log(`[UPLOAD] Large file (${this.formatSize(item.file.size)}) in batch. Bypassing persistent queue.`);
                    }
                    await this.performUpload(item.file, item.parentId, null, queueId, null, item.task);
                } catch (err) {
                    console.error('Batch upload error:', item.file.name, err);
                }
            }
        };

        const workers = Array(Math.min(CONCURRENCY, filesToUpload.length)).fill(null).map(() => worker());
        await Promise.all(workers);
        
        this.showToast(`Batch processing complete`, 'success');
        this.fetchAllData();
    }

    // Recursive folder size calculation for UI
    calculateFolderSize(folderId) {
        let total = 0;
        const children = (this.allFiles || []).filter(f => f.parent_id === folderId);
        
        // If we are in trash view, we count trashed children. 
        // If we are in normal view, we only count non-trashed children.
        const isTrashView = this.currentFilter === 'trash';

        children.forEach(child => {
            if (isTrashView || child.is_trashed === 0) {
                if (child.type === 'folder') {
                    total += this.calculateFolderSize(child.id);
                } else {
                    total += (child.size || 0);
                }
            }
        });
        return total;
    }

    async performUpload(file, folderId = null, progressText = null, queueId = null, existingUploadId = null, existingTask = null) {
        const targetFolder = folderId || this.currentFolder;
        const task = existingTask || this.addTask(file.name, 'upload');
        if (task.aborted) return;
        task.start(); // Move to active list
        
        console.log(`[UPLOAD] Starting: ${file.name} (${this.formatSize(file.size)})`);
        
        try {
            if (task.aborted) throw new Error('Cancelled');
            let uploadId = existingUploadId;
            let completedChunks = [];
            
            // Dynamic Chunking for massive files
            let currentChunkSize = CONFIG.chunkSize;
            if (file.size > CONFIG.chunkSize * CONFIG.maxChunks) {
                currentChunkSize = Math.ceil(file.size / CONFIG.maxChunks);
            }
            const totalChunks = Math.ceil(file.size / currentChunkSize);

            if (!uploadId) {
                // Pre-check for single file uploads too
                const localMatch = Array.isArray(this.allFiles) && this.allFiles.find(f => f.name === file.name && f.parent_id === targetFolder && f.is_trashed === 0);
                if (localMatch) {
                    if (queueId) await this.queue.remove(queueId);
                    task.complete(true, 'Already exists');
                    return;
                }

                console.log(`[UPLOAD] Initializing: ${file.name}`);
                const initData = await this.safeFetch('/api/upload/init', {
                    signal: task.abortController.signal,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: file.name,
                        size: file.size,
                        parent_id: targetFolder,
                        mimetype: file.type,
                        total_chunks: totalChunks
                    })
                });
                
                if (initData.restored || initData.conflict || initData.error === 'File already exists') {
                    console.log(`[UPLOAD] Skip/Restore: ${file.name}`);
                    if (queueId) await this.queue.remove(queueId);
                    task.complete(true, initData.restored ? 'Restored' : 'File already exists, skipping...');
                    if (initData.restored) this.fetchAllData();
                    return;
                }
                
                uploadId = initData.uploadId;
                if (queueId) await this.queue.updateUploadId(queueId, uploadId);
                console.log(`[UPLOAD] Init Success: ${file.name} -> ${uploadId}`);
            } else {
                console.log(`[UPLOAD] Resuming: ${file.name} (${uploadId})`);
                try {
                    const statusData = await this.safeFetch(`/api/upload/status/${uploadId}`);
                    completedChunks = statusData.completed;
                    console.log(`[UPLOAD] Status: ${file.name} -> ${completedChunks.length}/${totalChunks} chunks`);
                } catch (err) {
                    if (err.message.includes('404')) {
                        console.warn(`[UPLOAD] Session lost, restarting: ${file.name}`);
                        return this.performUpload(file, folderId, progressText, queueId, null, task);
                    }
                    throw err;
                }
            }

            const CHUNK_CONCURRENCY = 4; // Parallel chunk uploads per file for max throughput
            let currentChunkIndex = 0;
            const partUI = new Map();
            
            // Mark pre-completed chunks in UI with batching for performance
            if (completedChunks.length > 0) {
                task.update(0, `Resuming: ${completedChunks.length}/${totalChunks} parts`);
                const fragment = document.createDocumentFragment();
                const partsContainer = document.getElementById(`parts-${task.id}`);
                
                completedChunks.forEach(idx => {
                    const partItem = document.createElement('div');
                    partItem.className = 'task-part-item';
                    partItem.id = `part-${task.id}-${idx}`;
                    partItem.innerHTML = `
                        <div class="task-part-info">
                            <span>Part ${idx + 1}</span>
                            <span>Done</span>
                        </div>
                        <div class="task-part-progress">
                            <div class="task-part-bar success" style="width: 100%"></div>
                        </div>
                    `;
                    fragment.appendChild(partItem);
                    partUI.set(idx, { update: () => {}, complete: () => {} }); // Dummy UI for completed
                });
                
                if (partsContainer) {
                    partsContainer.appendChild(fragment);
                    task.setExpandable();
                }
            }

            const chunkWorker = async () => {
                while (currentChunkIndex < totalChunks) {
                    if (task.aborted) throw new Error('Cancelled');
                    const i = currentChunkIndex++;
                    if (completedChunks.includes(i)) continue;

                    const start = i * currentChunkSize;
                    const end = Math.min(start + currentChunkSize, file.size);
                    let chunk = file.slice(start, end);

                    // ZK encryption: encrypt each chunk client-side
                    if (this.zkEnabled) {
                        try {
                            chunk = await this.zkEncryptBlob(chunk);
                        } catch (err) {
                            throw new Error('ZK encryption failed: ' + err.message);
                        }
                    }

                    // Add Part to UI if not already present
                    if (!partUI.has(i)) {
                        partUI.set(i, task.addPart(i, `Part ${i + 1}`));
                    }
                    const ui = partUI.get(i);
                    ui.update(0, 'Starting...');

                    // Retry logic for individual chunks
                    let attempts = 0;
                    const maxAttempts = 5;
                    while (attempts < maxAttempts) {
                        if (task.aborted) throw new Error('Cancelled');
                        try {
                            await globalChunkSemaphore.acquire();
                            try {
                                if (task.aborted) throw new Error('Cancelled');
                                await this.uploadChunk(uploadId, i, chunk, (p) => {
                                    if (!task.aborted) {
                                        // Calculate overall progress including current chunk
                                        const overallPercent = ((completedChunks.length + (p/100)) / totalChunks) * 100;
                                        task.update(overallPercent);
                                        ui.update(p, `${Math.round(p)}%`);
                                    }
                                }, task.abortController.signal);
                            } finally {
                                globalChunkSemaphore.release();
                            }
                            ui.complete(true);
                            break; // Success
                        } catch (err) {
                            if (err.message === 'Cancelled') throw err;
                            attempts++;
                            ui.update(0, `Retry ${attempts}...`);
                            console.warn(`[UPLOAD] Chunk ${i} attempt ${attempts} failed: ${err.message}`);
                            if (attempts >= maxAttempts) throw err;
                            await new Promise(r => setTimeout(r, 2000 * attempts)); // Exponential backoff
                        }
                    }
                    
                    if (task.aborted) throw new Error('Cancelled');
                    completedChunks.push(i);
                    task.update((completedChunks.length / totalChunks) * 100);
                }
            };

            const chunkWorkers = Array(Math.min(CHUNK_CONCURRENCY, totalChunks)).fill(null).map(() => chunkWorker());
            await Promise.all(chunkWorkers);

            if (task.aborted) throw new Error('Cancelled');
            task.update(100, 'Finalizing on server...');
            const completeHeaders = {};
            if (this.zkEnabled) completeHeaders['x-zk-encrypted'] = 'true';
            const completeData = await this.safeFetch(`/api/upload/complete/${uploadId}`, {
                signal: task.abortController.signal,
                method: 'POST',
                headers: completeHeaders,
            });

            if (queueId) await this.queue.remove(queueId);

            if (completeData.finalizing) {
                task.update(100, 'Processing in background...');
                // For background finalization, we'll poll for a bit until it shows up
                let attempts = 0;
                const poll = setInterval(async () => {
                    attempts++;
                    await this.fetchAllData();
                    const exists = this.allFiles.find(f => f.name === file.name && f.parent_id === targetFolder);
                    if (exists || attempts > 60) { // Stop after 5 mins or when found
                        clearInterval(poll);
                        task.complete(true, 'Done');
                    }
                }, 5000);
            } else {
                task.complete(true, 'Done');
                this.fetchAllData();
            }
            // Removed: return await completeRes.json();
        } catch (err) {
            console.error('Upload error:', err);
            task.complete(false, err.message);
            
            // If the error is fatal (e.g. Quota), we must remove it from queue 
            // so it doesn't loop forever on reload.
            if (err.message.includes('Quota') || err.message.includes('Unauthorized') || err.message.includes('exists')) {
                if (queueId) await this.queue.remove(queueId);
            }
            throw err;
        }
    }

    uploadChunk(uploadId, index, blob, onProgress, signal) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/upload/chunk/${uploadId}`, true);
            xhr.timeout = 600000; // 10 minute timeout per chunk (robust for large files)
            xhr.withCredentials = true; // Include auth cookies
            xhr.setRequestHeader('x-chunk-index', index);
            
            if (signal) {
                signal.addEventListener('abort', () => {
                    xhr.abort();
                    reject(new Error('Cancelled'));
                });
            }

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
            };

            xhr.onload = () => {
                if (xhr.status === 200) resolve();
                else reject(new Error('Chunk upload failed'));
            };
            xhr.ontimeout = () => reject(new Error('Upload timed out'));
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(blob);
        });
    }

    async performDownload(id, { decryptOnClient = false, rawEncrypted = false } = {}) {
        const file = this.allFiles.find(f => f.id === id);
        if (!file) return;

        // ZK files: default to downloading encrypted, prompt user for choice
        if (file.is_zk_encrypted && !decryptOnClient && !rawEncrypted) {
            return this._promptZKDownloadChoice(id);
        }

        const task = this.addTask(file.name + (rawEncrypted ? ' (encrypted)' : ''), 'download');
        task.start();
        task.update(0, 'Requesting...');

        let url = this.isVisitor ? `/api/public/download/${this.shareToken}/${id}` : `/api/download/${id}`;
        if (rawEncrypted && !file.is_zk_encrypted) url += '?raw=true';

        try {
            const response = await fetch(url, { credentials: 'include', signal: task.abortController.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
            const reader = response.body.getReader();
            const chunks = [];
            let received = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (contentLength > 0) {
                    task.update((received / contentLength) * 100, `${this.formatSize(received)} / ${this.formatSize(contentLength)}`);
                }
            }

            let blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });

            // ZK-encrypted file: decrypt client-side if requested
            const isZK = response.headers.get('X-ZK-Encrypted') === 'true';
            if (isZK && decryptOnClient) {
                task.update(100, 'Decrypting...');
                let privateKey = this._getStoredPrivateKey();
                if (!privateKey) {
                    privateKey = await this.promptForPrivateKey();
                }
                if (!privateKey) {
                    task.complete(false, 'Decryption cancelled');
                    return;
                }
                try {
                    blob = await this.zkDecryptBlob(blob, privateKey);
                } catch (err) {
                    console.error('[ZK] Decryption failed:', err);
                    task.complete(false, 'Decryption failed — wrong key?');
                    this.showToast('Decryption failed. Check your private key.', 'error');
                    sessionStorage.removeItem('umbra_zk_private_key');
                    return;
                }
            }

            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(a.href);
            a.remove();

            task.complete(true, 'Done');
        } catch (err) {
            if (err.name === 'AbortError') {
                task.complete(false, 'Cancelled');
            } else {
                console.error('[DOWNLOAD] Error:', err);
                task.complete(false, 'Failed');
                this.showToast('Download failed: ' + err.message, 'error');
            }
        }
    }

    _promptZKDownloadChoice(id) {
        this.showModal({
            title: 'Download Encrypted File',
            body: `<p style="font-size:0.85rem;color:var(--text-dim);margin-bottom:12px;">This file is zero-knowledge encrypted. How would you like to download it?</p>
                   <div style="display:flex;flex-direction:column;gap:8px;">
                       <button class="btn-accent" id="zkDlEncrypted" style="width:100%;padding:10px;font-size:0.85rem;"><i class="fa-solid fa-lock" style="margin-right:6px;"></i>Download Encrypted (default)</button>
                       <button class="btn-secondary" id="zkDlDecrypt" style="width:100%;padding:10px;font-size:0.85rem;"><i class="fa-solid fa-lock-open" style="margin-right:6px;"></i>Decrypt &amp; Download</button>
                   </div>
                   <p style="font-size:0.72rem;color:var(--text-muted);margin-top:10px;">Encrypted download preserves zero-knowledge protection. You can decrypt the file offline with your private key.</p>`,
            confirmText: 'Cancel',
            onConfirm: () => {},
        });
        setTimeout(() => {
            const encBtn = document.getElementById('zkDlEncrypted');
            const decBtn = document.getElementById('zkDlDecrypt');
            if (encBtn) encBtn.onclick = () => { this.closeModal(); this.performDownload(id, { rawEncrypted: true }); };
            if (decBtn) decBtn.onclick = () => { this.closeModal(); this.performDownload(id, { decryptOnClient: true }); };
        }, 50);
    }

    setupContextMenu() {
        const menu = document.getElementById('contextMenu');
        window.oncontextmenu = (e) => {
            const row = e.target.closest('.file-row, .file-card');
            if (row) {
                e.preventDefault();
                this.selectedId = row.getAttribute('data-id');
                
                if (this.isVisitor) {
                    // Hide all menu items except download for visitors
                    const items = menu.querySelectorAll('.menu-item');
                    items.forEach(item => {
                        const action = item.getAttribute('onclick') || "";
                        if (action.includes('download')) {
                            item.style.setProperty('display', 'flex', 'important');
                        } else {
                            item.style.setProperty('display', 'none', 'important');
                        }
                    });
                    menu.querySelectorAll('hr').forEach(hr => hr.style.setProperty('display', 'none', 'important'));
                } else {
                    // Reset visibility for regular users
                    menu.querySelectorAll('.menu-item, hr').forEach(el => el.style.display = '');
                }

                menu.style.top = `${e.clientY}px`;
                menu.style.left = `${e.clientX}px`;
                menu.style.display = 'block';
            }
        };
    }

    updateBreadcrumbs() {
        const bread = document.getElementById('breadcrumbArea');
        let label = this.isVisitor ? (this.shareInfo ? this.shareInfo.name : "Shared Folder") : "My Drive";
        const rootId = this.isVisitor ? this.rootFolderId : 'root';

        if (!this.isVisitor) {
            if (this.currentFilter === 'starred') label = "Starred";
            if (this.currentFilter === 'trash') label = "Recycle Bin";
            if (this.currentFilter === 'recent') label = "Recent";
            if (this.currentFilter === 'shares') label = "Public Shares";
        }
        
        let pathHtml = `<div class="breadcrumb-item" onclick="drive.enterFolder('${rootId}')">${label}</div>`;
        
        // If we are in a subfolder, try to reconstruct path from allFiles
        if (this.currentFolder !== rootId && (this.isVisitor || this.currentFilter === 'default')) {
            const hierarchy = [];
            let curr = this.allFiles.find(f => f.id === this.currentFolder);
            // In visitor mode, we might not have the parent in allFiles if it's the root or above
            // But we only care about descendants of rootId
            while (curr && curr.id !== rootId) {
                hierarchy.unshift(curr);
                if (curr.parent_id === rootId) break;
                curr = this.allFiles.find(f => f.id === curr.parent_id);
            }
            hierarchy.forEach(f => {
                pathHtml += ` <i class="fa-solid fa-chevron-right" style="font-size: 0.7rem; opacity: 0.5;"></i> <div class="breadcrumb-item" onclick="drive.enterFolder('${f.id}')">${f.name}</div>`;
            });
        }

        bread.innerHTML = pathHtml;
        if (!this.isVisitor && this.currentFilter === 'trash' && this.getFilteredFiles().length > 0) {
            bread.innerHTML += `<button class="nav-btn-alt" onclick="drive.emptyTrash()" style="margin-left: 20px; padding: 4px 12px; font-size: 0.75rem;">Empty Trash</button>`;
        }
    }

    setView(mode) {
        this.viewMode = mode;
        localStorage.setItem('umbra_drive_view', mode);
        const vList = document.getElementById('viewList');
        const vGrid = document.getElementById('viewGrid');
        if(vList) vList.classList.toggle('active', mode === 'list');
        if(vGrid) vGrid.classList.toggle('active', mode === 'grid');
        this.render();
    }

    renderFiles(data) {
        const container = document.getElementById('fileContainer');
        container.className = this.viewMode === 'list' ? 'file-list' : 'file-grid';
        container.innerHTML = '';
        
        if (this.currentFilter === 'shares') return this.renderShareList(data, container);
        
        if (data.length === 0) {
            container.innerHTML = `<div style="padding: 60px; text-align: center; color: var(--text-dim);"><i class="fa-solid fa-folder-open" style="font-size: 3rem; display: block; margin-bottom: 16px; opacity: 0.2;"></i>Empty.</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();
        if (this.viewMode === 'list') {
            const header = document.createElement('div');
            header.className = 'list-header';
            header.innerHTML = `
                <div style="padding-left: 16px;">Name</div><div>Modified</div><div>Size</div><div style="text-align: right;">Type</div>`;
            fragment.appendChild(header);
        }

        data.forEach(file => {
            const isFolder = file.type === 'folder';
            const icon = isFolder ? 'fa-folder' : this.getIcon(file.name);
            const el = document.createElement('div');
            el.className = (this.viewMode === 'list' ? 'file-row' : 'file-card') + (this.selectedIds.has(file.id) ? ' selected' : '');
            el.setAttribute('data-id', file.id);
            
            el.onclick = (e) => {
                this.handleItemClick(e, file);
            };
            
            if (this.viewMode === 'list') {
                const displaySize = isFolder ? this.calculateFolderSize(file.id) : file.size;
                const zkBadge = file.is_zk_encrypted ? '<span title="Zero-Knowledge Encrypted" style="margin-left:6px;font-size:0.65rem;padding:1px 5px;border-radius:4px;background:rgba(45,212,191,0.15);color:#2dd4bf;font-weight:600;"><i class="fa-solid fa-shield-halved"></i> ZK</span>' : '';
                el.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 12px; padding-left: 16px;"><i class="fa-solid ${icon}" style="color: ${isFolder ? 'var(--quantum-1)' : 'var(--text-dim)'}"></i><span>${file.name}</span>${zkBadge}</div>
                    <div style="color: var(--text-dim); font-size: 0.85rem;">${file.created_at ? file.created_at.split(' ')[0] : 'Today'}</div>
                    <div style="color: var(--text-dim); font-size: 0.85rem;">${this.formatSize(displaySize)}</div>
                    <div style="text-align: right; color: var(--text-dim); font-size: 0.75rem;">${file.type.toUpperCase()}</div>
                `;
            } else {
                const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes((file.name || "").split('.').pop().toLowerCase());
                el.innerHTML = `
                    <div class="grid-visual" id="grid-visual-${file.id}">
                        <i class="fa-solid ${icon}" style="color: ${isFolder ? 'var(--quantum-1)' : 'var(--text-dim)'}"></i>
                    </div>
                    <div class="name">${file.name}</div>
                `;
                if (isImg) {
                    this.getPreviewUrl(file).then(url => {
                        if (url) {
                            const visual = document.getElementById(`grid-visual-${file.id}`);
                            if (visual) visual.innerHTML = `<img src="${url}" class="grid-preview">`;
                        }
                    });
                }
            }
            fragment.appendChild(el);
        });
        container.appendChild(fragment);
    }

    handleItemClick(e, file) {
        const isMulti = e.ctrlKey || e.metaKey;
        const isFolder = file.type === 'folder';
        
        if (isMulti) {
            if (this.selectedIds.has(file.id)) {
                this.selectedIds.delete(file.id);
            } else {
                this.selectedIds.add(file.id);
            }
            this.render(); 
        } else {
            if (isFolder) {
                this.selectedIds.clear();
                this.enterFolder(file.id);
            } else {
                this.selectedIds.clear();
                this.selectedIds.add(file.id);
                this.showDetails(file.id);
                this.render();
            }
        }
    }

    renderGridView(files, container) {
        // Redundant - now integrated into renderFiles for consistency
    }

    toggleSelect(id, checked) {}

    toggleSelectAll(el) {
        const filtered = this.getFilteredFiles();
        if (this.selectedIds.size === filtered.length) {
            this.selectedIds.clear();
        } else {
            filtered.forEach(f => this.selectedIds.add(f.id));
        }
        this.render();
    }

    renderShareList(shares, container) {
        container.className = 'share-list';
        container.innerHTML = '';
        
        const header = document.createElement('div');
        header.className = 'list-header';
        header.innerHTML = `<div>Item</div><div class="desktop-only">Uses</div><div class="desktop-only">Expires</div><div style="text-align: right;">Action</div>`;
        container.appendChild(header);

        shares.forEach(s => {
            const row = document.createElement('div');
            row.className = 'file-row share-row';
            row.innerHTML = `
                <div class="share-info-main">
                    <div style="display: flex; align-items: center; gap: 10px; overflow: hidden;">
                        <i class="fa-solid fa-link" style="color: var(--quantum-1); flex-shrink: 0;"></i>
                        <b class="share-item-name">${s.item_name}</b>
                    </div>
                    <div class="mobile-only share-meta-mobile">
                        <span>${s.use_count} / ${s.max_uses || '∞'} uses</span>
                        <span>Expires: ${s.expires_at ? s.expires_at.split('T')[0] : 'Never'}</span>
                    </div>
                </div>
                <div class="desktop-only" style="color: var(--text-dim); font-size: 0.85rem;">${s.use_count} / ${s.max_uses || '∞'}</div>
                <div class="desktop-only" style="color: var(--text-dim); font-size: 0.85rem;">${s.expires_at ? s.expires_at.split('T')[0] : 'Never'}</div>
                <div style="text-align: right;">
                    <div class="share-actions">
                        <button class="icon-btn" onclick="drive.copyShareLink('${s.token}')" title="Copy Link"><i class="fa-solid fa-copy"></i></button>
                        <button class="nav-btn-alt" style="padding: 4px 12px; font-size: 0.75rem;" onclick="drive.revokeShare('${s.token}')">Revoke</button>
                    </div>
                </div>
            `;
            container.appendChild(row);
        });
    }

    renderShareAndDropList(shares, drops) {
        const container = document.getElementById('fileContainer');
        container.className = 'share-list';
        container.innerHTML = '';

        if (shares.length === 0 && drops.length === 0) {
            container.innerHTML = `<div style="padding: 60px; text-align: center; color: var(--text-dim);"><i class="fa-solid fa-share-nodes" style="font-size: 3rem; display: block; margin-bottom: 16px; opacity: 0.2;"></i>No public shares or file drops yet.</div>`;
            return;
        }

        // Shares section
        if (shares.length > 0) {
            const sharesHeader = document.createElement('div');
            sharesHeader.style.cssText = 'padding: 12px 16px; font-weight: 700; font-size: 0.85rem; color: var(--text-secondary); border-bottom: 1px solid var(--border-color);';
            sharesHeader.innerHTML = '<i class="fa-solid fa-link" style="margin-right: 6px;"></i> Public Shares';
            container.appendChild(sharesHeader);
            this.renderShareList(shares, container);
        }

        // Drops section
        if (drops.length > 0) {
            const dropsHeader = document.createElement('div');
            dropsHeader.style.cssText = 'padding: 12px 16px; font-weight: 700; font-size: 0.85rem; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); margin-top: 8px;';
            dropsHeader.innerHTML = '<i class="fa-solid fa-fire" style="margin-right: 6px; color: #ef4444;"></i> File Drops';
            container.appendChild(dropsHeader);

            drops.forEach(d => {
                const row = document.createElement('div');
                row.className = 'file-row share-row';
                const burned = d.is_burned;
                const expired = d.expires_at && new Date(d.expires_at) < new Date();
                const statusBadge = burned ? '<span style="color:#ef4444;font-size:0.7rem;font-weight:600;"><i class="fa-solid fa-fire"></i> Burned</span>'
                    : expired ? '<span style="color:var(--text-dim);font-size:0.7rem;font-weight:600;">Expired</span>'
                    : '<span style="color:#22c55e;font-size:0.7rem;font-weight:600;">Active</span>';
                row.innerHTML = `
                    <div class="share-info-main">
                        <div style="display: flex; align-items: center; gap: 10px; overflow: hidden;">
                            <i class="fa-solid fa-fire" style="color: ${burned ? '#6b7280' : '#ef4444'}; flex-shrink: 0;"></i>
                            <b class="share-item-name" style="${burned || expired ? 'opacity:0.5;' : ''}">${d.item_name || 'File'}</b>
                            ${statusBadge}
                        </div>
                        <div class="mobile-only share-meta-mobile">
                            <span>${d.download_count} / ${d.max_downloads || 1} downloads</span>
                            <span>Expires: ${d.expires_at ? new Date(d.expires_at).toLocaleDateString() : 'Never'}</span>
                        </div>
                    </div>
                    <div class="desktop-only" style="color: var(--text-dim); font-size: 0.85rem;">${d.download_count} / ${d.max_downloads || 1}</div>
                    <div class="desktop-only" style="color: var(--text-dim); font-size: 0.85rem;">${d.expires_at ? new Date(d.expires_at).toLocaleDateString() : 'Never'}</div>
                    <div style="text-align: right;">
                        <div class="share-actions">
                            ${!burned && !expired ? `<button class="icon-btn" onclick="drive.copyDropLink('${d.token}')" title="Copy Link"><i class="fa-solid fa-copy"></i></button>` : ''}
                            <button class="nav-btn-alt" style="padding: 4px 12px; font-size: 0.75rem;" onclick="drive.revokeDrop('${d.token}')">Delete</button>
                        </div>
                    </div>
                `;
                container.appendChild(row);
            });
        }
    }

    copyShareLink(token) {
        const url = `${window.location.origin}/s/${token}`;
        navigator.clipboard.writeText(url);
        this.showToast('Link copied to clipboard', 'success');
    }

    async emptyTrash() {
        this.showModal({
            title: 'Empty Recycle Bin?',
            body: 'All items in the trash will be permanently deleted. This cannot be undone.',
            confirmText: 'Empty Trash',
            onConfirm: async () => {
                try {
                    await this.safeFetch('/api/trash/empty', { method: 'DELETE' });
                    this.fetchAllData();
                    this.showToast('Recycle bin emptied', 'success');
                } catch (e) { this.showToast(e.message, 'error'); }
            }
        });
    }

    async contextAction(action) {
        const ids = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : [this.selectedId];
        if (ids.length === 0 || !ids[0]) return;

        if (action === 'download') {
            for (const id of ids) {
                const item = this.allFiles.find(f => f.id === id);
                if (item && item.type === 'folder') {
                    this.downloadFolderZip(item.id, item.name);
                } else {
                    await this.performDownload(id);
                }
            }
        }
        if (action === 'download_encrypted') {
            for (const id of ids) {
                const item = this.allFiles.find(f => f.id === id);
                if (item && item.type !== 'folder') {
                    await this.performDownload(id, { rawEncrypted: true });
                }
            }
        }
        if (action === 'star') {
            try {
                for (const id of ids) await this.safeFetch(`/api/star/${id}`, { method: 'POST' });
                this.fetchAllData();
            } catch(e){}
        }
        if (action === 'trash') {
            try {
                for (const id of ids) await this.safeFetch(`/api/trash/${id}`, { method: 'POST' });
                this.fetchAllData();
                this.showToast(`${ids.length} items moved to trash`, 'success');
            } catch(e){}
        }
        if (action === 'rename') {
            if (ids.length > 1) return this.showToast('Cannot rename multiple items at once', 'error');
            const id = ids[0];
            const file = this.allFiles.find(f => f.id === id);
            this.showPrompt({
                title: 'Rename Item', message: 'Enter new name:', placeholder: file ? file.name : '',
                onConfirm: async (name) => {
                    try {
                        await this.safeFetch(`/api/rename/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
                        this.fetchAllData();
                    } catch(e){ this.showToast(e.message, 'error'); }
                }
            });
        }
        if (action === 'move') this.showMovePickerBulk(ids);
        if (action === 'share') {
            if (ids.length > 1) return this.showToast('Cannot share multiple items at once', 'error');
            this.createShare(ids[0]);
        }
        if (action === 'drop') {
            if (ids.length > 1) return this.showToast('Cannot create drop for multiple items at once', 'error');
            this.createDrop(ids[0]);
        }
    }

    async showMovePickerBulk(ids) {
        if (!Array.isArray(this.allFiles)) return;
        const folders = this.allFiles.filter(f => f.type === 'folder' && f.is_trashed === 0);
        let folderOptions = `<option value="root">My Drive (Root)</option>`;
        folders.forEach(f => { if(!ids.includes(f.id)) folderOptions += `<option value="${f.id}">${f.name}</option>`; });
        const body = `<div style="margin-bottom: 15px;">Select destination for ${ids.length} items:</div><select id="moveDest" style="width: 100%; background: var(--bg-sidebar); border: 1px solid var(--border); padding: 12px; border-radius: 8px; color: white; outline: none;">${folderOptions}</select>`;
        this.showModal({
            title: 'Move Items', body, confirmText: 'Move Here',
            onConfirm: async () => {
                const dest = document.getElementById('moveDest').value;
                try {
                    for (const id of ids) {
                        await this.safeFetch(`/api/move/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: dest }) });
                    }
                    this.fetchAllData(); 
                    this.showToast(`${ids.length} items moved`, 'success');
                } catch (e) { this.showToast('Move failed: ' + e.message, 'error'); }
            }
        });
    }

    async createShare(id) {
        const file = this.allFiles.find(f => f.id === id);
        const isFile = file && file.type !== 'folder';
        const body = `
            <div style="margin-bottom: 15px;">Share options for <b>${file ? file.name : 'this item'}</b>:</div>
            <label style="font-size: 0.8rem; color: var(--text-dim);">Password (optional - recipient must enter to access)</label>
            <input type="password" id="sharePassword" placeholder="Leave empty for no password" style="margin-bottom: 12px;">
            <label style="font-size: 0.8rem; color: var(--text-dim);">Expiry (hours - leave empty for permanent)</label>
            <input type="number" id="shareExpiry" placeholder="24" style="margin-bottom: 12px;">
            <label style="font-size: 0.8rem; color: var(--text-dim);">Max Downloads (leave empty for unlimited)</label>
            <input type="number" id="shareUses" placeholder="Unlimited" style="margin-bottom: 12px;">
            ${isFile ? `<div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                <input type="checkbox" id="shareBurn" style="accent-color: var(--accent);">
                <label for="shareBurn" style="font-size: 0.8rem; color: var(--text-dim); cursor: pointer;">Burn after read (file permanently deleted after max downloads)</label>
            </div>
            <div id="burnWarning" style="display:none;margin-top:8px;padding:10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;font-size:0.78rem;color:var(--danger);">
                <i class="fa-solid fa-triangle-exclamation" style="margin-right:4px;"></i> <b>Warning:</b> The original file will be <b>permanently deleted</b> from your drive once the download limit is reached. This action cannot be undone.
            </div>` : ''}
        `;
        this.showModal({
            title: 'Share', body, confirmText: 'Create Link',
            onConfirm: async () => {
                const hours = document.getElementById('shareExpiry').value;
                const uses = document.getElementById('shareUses').value;
                const password = document.getElementById('sharePassword')?.value || '';
                const burn = document.getElementById('shareBurn')?.checked || false;
                try {
                    const data = await this.safeFetch(`/api/share/${id}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            expiry_hours: parseInt(hours) || null,
                            max_uses: parseInt(uses) || null,
                            password: password || undefined,
                            burn_after_read: burn,
                        })
                    });
                    const url = `${window.location.origin}/s/${data.token}`;
                    this.showModal({
                        title: 'Link Created',
                        body: `<div style="padding: 10px; background: var(--bg-sidebar); border-radius: 8px; word-break: break-all; font-family: monospace; font-size: 0.8rem;">${url}</div>
                        ${burn ? '<div style="margin-top: 10px; font-size: 0.75rem; color: var(--danger);"><i class="fa-solid fa-fire" style="margin-right: 4px;"></i> File will be permanently deleted after the download limit is reached.</div>' : ''}
                        ${password ? '<div style="margin-top: 6px; font-size: 0.75rem; color: var(--text-dim);"><i class="fa-solid fa-lock" style="margin-right: 4px;"></i> Password protected</div>' : ''}`,
                        confirmText: 'Copy to Clipboard',
                        onConfirm: () => { navigator.clipboard.writeText(url); this.showToast('Copied!', 'success'); }
                    });
                } catch (e) { this.showToast(e.message, 'error'); }
            }
        });
        // Wire up burn warning toggle
        setTimeout(() => {
            const burnCheck = document.getElementById('shareBurn');
            const burnWarn = document.getElementById('burnWarning');
            if (burnCheck && burnWarn) {
                burnCheck.addEventListener('change', () => { burnWarn.style.display = burnCheck.checked ? 'block' : 'none'; });
            }
        }, 50);
    }

    async newFolder() {
        this.showPrompt({
            title: 'New Folder', message: 'Enter folder name:', placeholder: 'Untitled Folder',
            onConfirm: async (name) => {
                try {
                    await this.safeFetch('/api/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent_id: this.currentFolder }) });
                    this.fetchAllData();
                } catch (e) { this.showToast(e.message, 'error'); }
            }
        });
    }

    async revokeShare(token) {
        this.showModal({
            title: 'Revoke Link?', body: 'The public share link will stop working immediately.',
            onConfirm: async () => { try { await this.safeFetch(`/api/share/${token}`, { method: 'DELETE' }); this.refresh(); } catch(e){ this.showToast(e.message, 'error'); } }
        });
    }

    // --- File Drops (Burn-After-Read) ---
    async createDrop(id) {
        const file = this.allFiles.find(f => f.id === id);
        if (!file || file.type === 'folder') {
            return this.showToast('File drops only work for files, not folders', 'error');
        }
        const body = `
            <div style="margin-bottom: 15px;">Create a secure file drop for <b>${file.name}</b>:</div>
            <label style="font-size: 0.8rem; color: var(--text-dim);">Password (optional - recipient must enter to download)</label>
            <input type="password" id="dropPassword" placeholder="Leave empty for no password" style="margin-bottom: 12px;">
            <label style="font-size: 0.8rem; color: var(--text-dim);">Expiry (hours)</label>
            <input type="number" id="dropExpiry" placeholder="24" value="24" style="margin-bottom: 12px;">
            <label style="font-size: 0.8rem; color: var(--text-dim);">Max Downloads</label>
            <input type="number" id="dropMaxDownloads" placeholder="1" value="1" style="margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                <input type="checkbox" id="dropBurn" checked style="accent-color: var(--accent);">
                <label for="dropBurn" style="font-size: 0.8rem; color: var(--text-dim); cursor: pointer;">Burn after read (file is permanently deleted after max downloads)</label>
            </div>
        `;
        this.showModal({
            title: 'Create Secure File Drop', body, confirmText: 'Create Drop',
            onConfirm: async () => {
                try {
                    const data = await this.safeFetch(`/api/drop/${id}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            password: document.getElementById('dropPassword').value || undefined,
                            expiry_hours: parseInt(document.getElementById('dropExpiry').value) || 24,
                            max_downloads: parseInt(document.getElementById('dropMaxDownloads').value) || 1,
                            burn_after_read: document.getElementById('dropBurn').checked,
                        })
                    });
                    const url = `${window.location.origin}/drop/${data.token}`;
                    this.showModal({
                        title: 'Drop Link Created',
                        body: `<div style="padding: 10px; background: var(--bg-sidebar); border-radius: 8px; word-break: break-all; font-family: monospace; font-size: 0.8rem;">${url}</div>
                        <div style="margin-top: 10px; font-size: 0.75rem; color: var(--text-dim);"><i class="fa-solid fa-fire" style="color: #ef4444; margin-right: 4px;"></i> ${document.getElementById('dropBurn').checked ? 'File will be permanently deleted after download limit is reached.' : 'File will remain after downloads.'}</div>`,
                        confirmText: 'Copy to Clipboard',
                        onConfirm: () => { navigator.clipboard.writeText(url); this.showToast('Drop link copied!', 'success'); }
                    });
                } catch (e) { this.showToast(e.message, 'error'); }
            }
        });
    }

    async listDrops() {
        try {
            const data = await this.safeFetch('/api/drop/list');
            return Array.isArray(data) ? data : (data.drops || []);
        } catch (e) { return []; }
    }

    async revokeDrop(token) {
        this.showModal({
            title: 'Delete File Drop?', body: 'The drop link will stop working immediately.',
            onConfirm: async () => {
                try {
                    await this.safeFetch(`/api/drop/${token}`, { method: 'DELETE' });
                    this.refresh();
                    this.showToast('File drop deleted', 'success');
                } catch(e) { this.showToast(e.message, 'error'); }
            }
        });
    }

    copyDropLink(token) {
        const url = `${window.location.origin}/drop/${token}`;
        navigator.clipboard.writeText(url);
        this.showToast('Drop link copied to clipboard', 'success');
    }

    uploadFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = (e) => { 
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                
                // Bypass persistent queue for files > 2GB to avoid browser database item limits
                if (file.size > 2 * 1024 * 1024 * 1024) {
                    console.log(`[UPLOAD] Large file (${this.formatSize(file.size)}) detected. Bypassing persistent queue for direct upload.`);
                    this.performUpload(file, this.currentFolder, null, null);
                    return;
                }

                this.queue.add(file, this.currentFolder).then(queueId => {
                    this.performUpload(file, this.currentFolder, null, queueId);
                }).catch(err => {
                    console.error('[UPLOAD] Failed to queue file:', err);
                    this.showToast('Failed to start upload: ' + err.message, 'error');
                });
            }
        };
        input.click();
    }

    enterFolder(id) { 
        this.currentFolder = id; 
        this.currentFilter = 'default'; 
        if (this.isVisitor) {
            this.fetchAllData().then(() => {
                this.updateVisitorBanner();
            });
        } else {
            this.render(); // Instant local render
        }
    }

    getIcon(n) {
        const e = (n || "").split('.').pop().toLowerCase();
        const m = { 'pdf': 'fa-file-pdf', 'png': 'fa-file-image', 'jpg': 'fa-file-image', 'zip': 'fa-file-zipper', 'cpp': 'fa-file-code', 'json': 'fa-file-shield', 'txt': 'fa-file-lines' };
        return m[e] || 'fa-file';
    }
    formatSize(b) { if (!b || b === 0) return '--'; const u = ['B','KB','MB','GB','TB']; let i = 0; while(b>=1024 && i < u.length - 1){b/=1024;i++;} return `${b.toFixed(1)} ${u[i]}`; }
    
    async updateQuotaUI() { 
        try {
            const stats = await this.safeFetch('/api/stats');
            const used = stats.used || 0;
            const total = stats.total || (100 * 1024 * 1024 * 1024);
            
            const bar = document.getElementById('storageBar');
            const text = document.getElementById('storageText');
            if(bar) bar.style.width = `${(used/total)*100}%`; 
            if(text) text.textContent = `${this.formatSize(used)} / ${this.formatSize(total)}`; 
        } catch (err) {
            console.error('Failed to update quota UI:', err);
        }
    }

    showDetails(id) {
        this.selectedId = id;
        if (!Array.isArray(this.allFiles)) return;
        const file = this.allFiles.find(f => f.id === id);
        if (!file) return;
        const sidebar = document.getElementById('detailsSidebar');
        const content = document.getElementById('detailsContent');
        if(!sidebar || !content) return;
        sidebar.classList.add('show');

        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes((file.name || "").split('.').pop().toLowerCase());
        const isPdf = (file.name || "").toLowerCase().endsWith('.pdf');
        const isText = (file.name || "").toLowerCase().endsWith('.txt') || (file.name || "").toLowerCase().endsWith('.log');

        let defaultPreview = `<div class="file-preview" id="detailPreview">
            <i class="fa-solid ${file.type === 'folder' ? 'fa-folder' : this.getIcon(file.name)}" style="font-size: 4rem; color: var(--quantum-1); opacity: 0.8;"></i>
        </div>`;

        content.innerHTML = `
            <div id="previewContainer">${defaultPreview}</div>
            <div style="text-align: center; margin: 24px 0;">
                <h4 style="word-break: break-all;">${file.name}</h4>
            </div>
            <hr>
            <div style="margin-top: 20px; display: flex; flex-direction: column; gap: 12px; font-size: 0.9rem;">
                <div style="display: flex; justify-content: space-between;"><span style="color: var(--text-dim)">Type</span><span>${file.type.toUpperCase()}</span></div>
                <div style="display: flex; justify-content: space-between;"><span style="color: var(--text-dim)">Size</span><span>${this.formatSize(file.type === 'folder' ? this.calculateFolderSize(file.id) : file.size)}</span></div>
                <div style="display: flex; justify-content: space-between;"><span style="color: var(--text-dim)">Created</span><span>${file.created_at ? file.created_at.split(' ')[0] : 'Today'}</span></div>
            </div>
            <div style="margin-top: 32px; display: grid; grid-template-columns: ${this.isVisitor ? '1fr' : '1fr 1fr'}; gap: 12px;">
                <button class="btn-secondary" onclick="drive.contextAction('download')" style="width: 100%;"><i class="fa-solid fa-download"></i> ${this.isVisitor ? ' Download File' : ''}</button>
                ${this.isVisitor ? '' : '<button class="btn-secondary" onclick="drive.contextAction(\'star\')" style="width: 100%;"><i class="fa-solid fa-star"></i></button>'}
            </div>
        `;

        if (isImage) {
            this.getPreviewUrl(file).then(url => {
                if (url) document.getElementById('previewContainer').innerHTML = `<div class="file-preview"><img src="${url}" style="max-width: 100%; border-radius: 8px; cursor: zoom-in;" onclick="window.open('${url}', '_blank')"></div>`;
            });
        } else if (isPdf) {
            this.getPreviewUrl(file).then(url => {
                if (url) document.getElementById('previewContainer').innerHTML = `<div class="file-preview"><iframe src="${url}" style="width: 100%; height: 250px; border: none; border-radius: 8px;"></iframe><button class="btn-secondary" style="width: 100%; margin-top: 8px;" onclick="window.open('${url}', '_blank')">Open Full PDF</button></div>`;
            });
        } else if (isText) {
            document.getElementById('previewContainer').innerHTML = `<div class="file-preview" style="max-height: 200px; overflow: hidden; background: #000; padding: 10px; border-radius: 8px; font-family: monospace; font-size: 0.75rem; color: #0f0; white-space: pre-wrap;" id="textPreview">Loading preview...</div>`;
            this.getPreviewUrl(file).then(async url => {
                if (url) {
                    const res = await fetch(url);
                    const t = await res.text();
                    const el = document.getElementById('textPreview');
                    if (el) el.textContent = t.substring(0, 1000) + (t.length > 1000 ? '...' : '');
                }
            });
        }
    }
    hideDetails() { const sidebar = document.getElementById('detailsSidebar'); if(sidebar) sidebar.classList.remove('show'); }
}

const drive = new DriveApp();
