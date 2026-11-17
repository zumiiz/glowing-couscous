/* ========================================
   입어봄 — app.js
   IndexedDB 기반 디지털 옷장 SPA
   ======================================== */

// ─── IndexedDB (Dexie-free, raw API) ───────────────────────
const DB_NAME = 'IbeobomDB';
const DB_VERSION = 1;
let db;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains('clothes')) {
                const cs = d.createObjectStore('clothes', { keyPath: 'id' });
                cs.createIndex('category', 'category', { unique: false });
                cs.createIndex('isSample', 'isSample', { unique: false });
            }
            if (!d.objectStoreNames.contains('coords')) {
                const co = d.createObjectStore('coords', { keyPath: 'id' });
                co.createIndex('tag', 'tag', { unique: false });
            }
            if (!d.objectStoreNames.contains('meta')) {
                d.createObjectStore('meta', { keyPath: 'key' });
            }
        };
        req.onsuccess = e => { db = e.target.result; resolve(db); };
        req.onerror = e => reject(e.target.error);
    });
}

function dbTx(store, mode = 'readonly') {
    const tx = db.transaction(store, mode);
    return tx.objectStore(store);
}

function dbGetAll(store) {
    return new Promise((resolve, reject) => {
        const req = dbTx(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function dbGet(store, key) {
    return new Promise((resolve, reject) => {
        const req = dbTx(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function dbPut(store, data) {
    return new Promise((resolve, reject) => {
        const req = dbTx(store, 'readwrite').put(data);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function dbDelete(store, key) {
    return new Promise((resolve, reject) => {
        const req = dbTx(store, 'readwrite').delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// ─── Utility ───────────────────────────────────────────────
function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function showToast(msg) {
    let toast = document.querySelector('.toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

// ─── State ─────────────────────────────────────────────────
let allClothes = [];      // { id, name, category, imageData (base64), isSample }
let allCoords = [];        // { id, name, tag, items: { 상의: id, 하의: id, 아우터: id|null, 신발: id|null } }
let currentFilter = 'all';
let currentSavedFilter = 'all';

// 코디 빌더 상태
const coordState = { 상의: { items: [], idx: -1 }, 하의: { items: [], idx: -1 }, 아우터: { items: [], idx: -1 }, 신발: { items: [], idx: -1 } };
let editingCoordId = null; // 코디 수정 시

// ─── Tab Navigation ────────────────────────────────────────
function setupTabs() {
    const btns = document.querySelectorAll('.nav-btn');
    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            const tab = document.getElementById('tab-' + btn.dataset.tab);
            if (tab) tab.classList.add('active');
            if (btn.dataset.tab === 'coordinate') refreshCoordBuilder();
            if (btn.dataset.tab === 'saved') renderSavedCoords();
        });
    });
}

function switchTab(tabName) {
    const btn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`);
    if (btn) btn.click();
}

// ─── Closet: Render ────────────────────────────────────────
function renderCloset() {
    const grid = document.getElementById('clothesGrid');
    const empty = document.getElementById('closetEmpty');
    const sampleBtn = document.getElementById('btnClearSamples');
    grid.innerHTML = '';

    let filtered = allClothes;
    if (currentFilter !== 'all') {
        filtered = allClothes.filter(c => c.category === currentFilter);
    }

    if (filtered.length === 0) {
        empty.style.display = 'block';
        empty.textContent = allClothes.length === 0
            ? '등록된 옷이 없습니다. 옷을 등록해 보세요!'
            : `'${currentFilter}' 카테고리에 등록된 옷이 없습니다.`;
    } else {
        empty.style.display = 'none';
    }

    const hasSamples = allClothes.some(c => c.isSample);
    sampleBtn.style.display = hasSamples ? 'inline-flex' : 'none';

    filtered.forEach(item => {
        const card = document.createElement('div');
        card.className = 'clothes-card' + (item.isSample ? ' sample-item' : '');
        card.innerHTML = `
            <img class="clothes-card-img" src="${item.imageData}" alt="${item.name}">
            <div class="clothes-card-info">
                <div class="clothes-card-name">${item.name}</div>
                <div class="clothes-card-cat">${item.category}</div>
            </div>`;
        card.addEventListener('click', () => openEditModal(item));
        grid.appendChild(card);
    });
}

// ─── Closet: Filter ────────────────────────────────────────
function setupClosetFilter() {
    document.getElementById('closetFilter').addEventListener('click', e => {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        document.querySelectorAll('#closetFilter .filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentFilter = chip.dataset.category;
        renderCloset();
    });
}

// ─── Closet: Add Clothes ──────────────────────────────────
let pendingFile = null;
let pendingCategory = null;

function setupAddClothes() {
    const modal = document.getElementById('modalAddClothes');
    const fileInput = document.getElementById('fileInput');
    const uploadArea = document.getElementById('uploadArea');
    const preview = document.getElementById('previewImg');
    const placeholder = document.getElementById('uploadPlaceholder');
    const nameInput = document.getElementById('clothesName');
    const errorEl = document.getElementById('formError');

    document.getElementById('btnAddClothes').addEventListener('click', () => openAddModal());

    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => handleFileSelect(e.target.files[0]));

    // drag & drop
    uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.style.borderColor = 'var(--green)'; });
    uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; });
    uploadArea.addEventListener('drop', e => {
        e.preventDefault();
        uploadArea.style.borderColor = '';
        if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
    });

    // category buttons
    document.getElementById('categorySelect').addEventListener('click', e => {
        const btn = e.target.closest('.cat-btn');
        if (!btn) return;
        document.querySelectorAll('#categorySelect .cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        pendingCategory = btn.dataset.cat;
    });

    document.getElementById('modalAddClose').addEventListener('click', () => closeModal(modal));
    document.getElementById('modalAddCancel').addEventListener('click', () => closeModal(modal));

    document.getElementById('modalAddSave').addEventListener('click', async () => {
        const name = nameInput.value.trim();
        errorEl.style.display = 'none';
        if (!pendingFile) { showError(errorEl, '사진을 선택해 주세요.'); return; }
        if (!name) { showError(errorEl, '옷 이름을 입력해 주세요.'); return; }
        if (!pendingCategory) { showError(errorEl, '카테고리를 선택해 주세요.'); return; }

        const imageData = await blobToBase64(pendingFile);
        const item = { id: uid(), name, category: pendingCategory, imageData, isSample: false };
        await dbPut('clothes', item);
        allClothes.push(item);
        renderCloset();
        closeModal(modal);
        showToast('옷이 등록되었습니다.');
    });
}

function handleFileSelect(file) {
    const errorEl = document.getElementById('formError');
    errorEl.style.display = 'none';

    if (!file) return;
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
        showError(errorEl, '지원하지 않는 형식입니다. JPG, PNG, WebP만 가능합니다.');
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        showError(errorEl, '파일 크기가 5MB를 초과합니다. 더 작은 파일을 선택해 주세요.');
        return;
    }

    pendingFile = file;
    const preview = document.getElementById('previewImg');
    const placeholder = document.getElementById('uploadPlaceholder');
    const uploadArea = document.getElementById('uploadArea');
    preview.src = URL.createObjectURL(file);
    preview.style.display = 'block';
    placeholder.style.display = 'none';
    uploadArea.classList.add('has-file');
}

function openAddModal() {
    pendingFile = null;
    pendingCategory = null;
    const modal = document.getElementById('modalAddClothes');
    document.getElementById('fileInput').value = '';
    document.getElementById('clothesName').value = '';
    document.getElementById('previewImg').style.display = 'none';
    document.getElementById('uploadPlaceholder').style.display = '';
    document.getElementById('uploadArea').classList.remove('has-file');
    document.getElementById('formError').style.display = 'none';
    document.querySelectorAll('#categorySelect .cat-btn').forEach(b => b.classList.remove('active'));
    openModal(modal);
}

// ─── Closet: Edit / Delete ─────────────────────────────────
let editingClothesId = null;
let editCategory = null;

function setupEditClothes() {
    const modal = document.getElementById('modalEditClothes');

    document.getElementById('editCategorySelect').addEventListener('click', e => {
        const btn = e.target.closest('.cat-btn');
        if (!btn) return;
        document.querySelectorAll('#editCategorySelect .cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        editCategory = btn.dataset.cat;
    });

    document.getElementById('modalEditClose').addEventListener('click', () => closeModal(modal));
    document.getElementById('modalEditCancel').addEventListener('click', () => closeModal(modal));

    document.getElementById('modalEditSave').addEventListener('click', async () => {
        const name = document.getElementById('editClothesName').value.trim();
        const errorEl = document.getElementById('editFormError');
        errorEl.style.display = 'none';
        if (!name) { showError(errorEl, '옷 이름을 입력해 주세요.'); return; }
        if (!editCategory) { showError(errorEl, '카테고리를 선택해 주세요.'); return; }

        const item = allClothes.find(c => c.id === editingClothesId);
        if (!item) return;
        item.name = name;
        item.category = editCategory;
        await dbPut('clothes', item);
        renderCloset();
        closeModal(modal);
        showToast('옷 정보가 수정되었습니다.');
    });

    document.getElementById('modalEditDelete').addEventListener('click', () => {
        // 연결된 코디 확인
        const linked = allCoords.filter(co => Object.values(co.items).includes(editingClothesId));
        let msg = '이 옷을 삭제하시겠습니까?';
        if (linked.length > 0) {
            msg = `이 옷은 ${linked.length}개의 코디에 사용되고 있습니다. 삭제하면 해당 코디에서도 제거됩니다. 삭제하시겠습니까?`;
        }
        showConfirm('옷 삭제', msg, async () => {
            // 코디에서 해당 옷 제거
            for (const co of linked) {
                for (const [cat, id] of Object.entries(co.items)) {
                    if (id === editingClothesId) co.items[cat] = null;
                }
                // 상의 또는 하의가 없으면 코디 삭제
                if (!co.items['상의'] || !co.items['하의']) {
                    await dbDelete('coords', co.id);
                    allCoords = allCoords.filter(c => c.id !== co.id);
                } else {
                    await dbPut('coords', co);
                }
            }
            await dbDelete('clothes', editingClothesId);
            allClothes = allClothes.filter(c => c.id !== editingClothesId);
            renderCloset();
            closeModal(document.getElementById('modalEditClothes'));
            showToast('옷이 삭제되었습니다.');
        });
    });
}

function openEditModal(item) {
    editingClothesId = item.id;
    editCategory = item.category;
    const modal = document.getElementById('modalEditClothes');
    document.getElementById('editPreviewImg').src = item.imageData;
    document.getElementById('editClothesName').value = item.name;
    document.getElementById('editFormError').style.display = 'none';
    document.querySelectorAll('#editCategorySelect .cat-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.cat === item.category);
    });
    openModal(modal);
}

// ─── Clear Samples ─────────────────────────────────────────
function setupClearSamples() {
    document.getElementById('btnClearSamples').addEventListener('click', () => {
        showConfirm('샘플 옷 삭제', '샘플 옷을 모두 삭제하시겠습니까? 샘플 옷이 포함된 코디도 삭제됩니다.', async () => {
            const sampleIds = allClothes.filter(c => c.isSample).map(c => c.id);
            // 코디 중 샘플 옷 포함 → 삭제
            for (const co of [...allCoords]) {
                const usedSample = Object.values(co.items).some(id => sampleIds.includes(id));
                if (usedSample) {
                    await dbDelete('coords', co.id);
                    allCoords = allCoords.filter(c => c.id !== co.id);
                }
            }
            for (const id of sampleIds) {
                await dbDelete('clothes', id);
            }
            allClothes = allClothes.filter(c => !c.isSample);
            renderCloset();
            showToast('샘플 옷이 삭제되었습니다.');
        });
    });
}

// ─── Coordinate Builder ────────────────────────────────────
function refreshCoordBuilder() {
    const categories = ['상의', '하의', '아우터', '신발'];
    categories.forEach(cat => {
        coordState[cat].items = allClothes.filter(c => c.category === cat);
        // 현재 idx 유효성
        if (coordState[cat].items.length === 0) {
            coordState[cat].idx = -1;
        } else if (coordState[cat].idx >= coordState[cat].items.length) {
            coordState[cat].idx = 0;
        } else if (coordState[cat].idx < 0 && (cat === '상의' || cat === '하의')) {
            coordState[cat].idx = 0;
        }
    });
    renderAllSlots();
}

function renderAllSlots() {
    renderSlot('상의', document.querySelector('#slotTop .slot-img-wrap'));
    renderSlot('하의', document.querySelector('#slotBottom .slot-img-wrap'));
    renderSlot('아우터', document.querySelector('#slotOuter .slot-img-wrap'));
    renderSlot('신발', document.querySelector('#slotShoes .slot-img-wrap'));
}

function renderSlot(cat, wrap) {
    if (!wrap) return;
    const state = coordState[cat];
    const isOptional = cat === '아우터' || cat === '신발';
    wrap.innerHTML = '';

    if (state.items.length === 0) {
        const ph = document.createElement('div');
        ph.style.textAlign = 'center';
        const msg = document.createElement('p');
        msg.className = 'slot-placeholder';
        msg.textContent = `등록된 ${cat}가 없습니다`;
        ph.appendChild(msg);
        const btn = document.createElement('button');
        btn.className = 'slot-placeholder-btn';
        btn.textContent = '+ 옷 등록하기';
        btn.addEventListener('click', e => {
            e.stopPropagation();
            switchTab('closet');
            setTimeout(() => openAddModal(), 200);
        });
        ph.appendChild(btn);
        wrap.appendChild(ph);
        return;
    }

    if (state.idx < 0) {
        // 선택 안 함 (optional만)
        const ph = document.createElement('p');
        ph.className = 'slot-placeholder';
        ph.textContent = '선택 안 함';
        wrap.appendChild(ph);
        return;
    }

    const item = state.items[state.idx];
    if (!item) return;
    const img = document.createElement('img');
    img.src = item.imageData;
    img.alt = item.name;
    wrap.appendChild(img);
    const nameEl = document.createElement('span');
    nameEl.className = 'slot-name';
    nameEl.textContent = item.name;
    wrap.appendChild(nameEl);
}

function navigateSlot(cat, dir) {
    const state = coordState[cat];
    if (state.items.length === 0) return;
    const isOptional = cat === '아우터' || cat === '신발';
    const minIdx = isOptional ? -1 : 0;
    const maxIdx = state.items.length - 1;

    if (dir === 'next') {
        state.idx = state.idx >= maxIdx ? minIdx : state.idx + 1;
    } else {
        state.idx = state.idx <= minIdx ? maxIdx : state.idx - 1;
    }

    const slotMap = { '상의': '#slotTop', '하의': '#slotBottom', '아우터': '#slotOuter', '신발': '#slotShoes' };
    renderSlot(cat, document.querySelector(`${slotMap[cat]} .slot-img-wrap`));
}

function setupCoordArrows() {
    document.querySelectorAll('.arrow-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            navigateSlot(btn.dataset.cat, btn.dataset.dir);
        });
    });
}

// ─── Swipe support ─────────────────────────────────────────
function setupSwipe() {
    document.querySelectorAll('.slot-img-wrap').forEach(wrap => {
        let startX = 0, startY = 0;
        const cat = wrap.dataset.cat;
        if (!cat) return;

        wrap.addEventListener('touchstart', e => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        wrap.addEventListener('touchend', e => {
            const dx = e.changedTouches[0].clientX - startX;
            const dy = e.changedTouches[0].clientY - startY;
            if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
                navigateSlot(cat, dx < 0 ? 'next' : 'prev');
            }
        }, { passive: true });
    });
}

// ─── Random Coordinate ─────────────────────────────────────
function setupRandomCoord() {
    document.getElementById('btnRandomCoord').addEventListener('click', () => {
        const cats = ['상의', '하의', '아우터', '신발'];
        cats.forEach(cat => {
            const state = coordState[cat];
            if (state.items.length === 0) return;
            const isOptional = cat === '아우터' || cat === '신발';
            if (isOptional && Math.random() < 0.3) {
                state.idx = -1; // 30% 확률로 선택 안 함
            } else {
                state.idx = Math.floor(Math.random() * state.items.length);
            }
        });
        renderAllSlots();
        showToast('랜덤 코디가 생성되었습니다!');
    });
}

// ─── Save Coordinate ───────────────────────────────────────
let pendingCoordTag = null;

function setupSaveCoord() {
    const modal = document.getElementById('modalSaveCoord');

    document.getElementById('btnSaveCoord').addEventListener('click', () => {
        // 상의와 하의 체크
        if (coordState['상의'].idx < 0 || coordState['상의'].items.length === 0) {
            showToast('상의를 선택해 주세요.'); return;
        }
        if (coordState['하의'].idx < 0 || coordState['하의'].items.length === 0) {
            showToast('하의를 선택해 주세요.'); return;
        }
        openSaveCoordModal();
    });

    document.getElementById('tagSelect').addEventListener('click', e => {
        const btn = e.target.closest('.tag-btn');
        if (!btn) return;
        document.querySelectorAll('#tagSelect .tag-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        pendingCoordTag = btn.dataset.tag;
    });

    document.getElementById('modalCoordClose').addEventListener('click', () => closeModal(modal));
    document.getElementById('modalCoordCancel').addEventListener('click', () => closeModal(modal));

    document.getElementById('modalCoordSave').addEventListener('click', async () => {
        const name = document.getElementById('coordName').value.trim();
        const errorEl = document.getElementById('coordFormError');
        errorEl.style.display = 'none';
        if (!name) { showError(errorEl, '코디 이름을 입력해 주세요.'); return; }
        if (!pendingCoordTag) { showError(errorEl, '상황 태그를 선택해 주세요.'); return; }

        const items = {};
        ['상의', '하의', '아우터', '신발'].forEach(cat => {
            const state = coordState[cat];
            items[cat] = (state.idx >= 0 && state.items[state.idx]) ? state.items[state.idx].id : null;
        });

        if (editingCoordId) {
            // 수정
            const co = allCoords.find(c => c.id === editingCoordId);
            if (co) {
                co.name = name;
                co.tag = pendingCoordTag;
                co.items = items;
                await dbPut('coords', co);
                showToast('코디가 수정되었습니다.');
            }
            editingCoordId = null;
        } else {
            // 새 저장
            const coord = { id: uid(), name, tag: pendingCoordTag, items };
            await dbPut('coords', coord);
            allCoords.push(coord);
            showToast('코디가 저장되었습니다!');
        }

        closeModal(modal);
        renderSavedCoords();
    });
}

function openSaveCoordModal() {
    pendingCoordTag = null;
    editingCoordId = null;
    const modal = document.getElementById('modalSaveCoord');
    document.getElementById('coordName').value = '';
    document.getElementById('coordFormError').style.display = 'none';
    document.querySelectorAll('#tagSelect .tag-btn').forEach(b => b.classList.remove('active'));
    openModal(modal);
}

// ─── Saved Coords: Render ──────────────────────────────────
function renderSavedCoords() {
    const grid = document.getElementById('savedGrid');
    const empty = document.getElementById('savedEmpty');
    grid.innerHTML = '';

    let filtered = allCoords;
    if (currentSavedFilter !== 'all') {
        filtered = allCoords.filter(co => co.tag === currentSavedFilter);
    }

    if (filtered.length === 0) {
        empty.style.display = 'block';
        empty.textContent = allCoords.length === 0
            ? '저장한 코디가 없습니다. 코디를 만들어 보세요!'
            : `'${currentSavedFilter}' 태그의 코디가 없습니다.`;
    } else {
        empty.style.display = 'none';
    }

    filtered.forEach(co => {
        const card = document.createElement('div');
        card.className = 'saved-card';

        const previewDiv = document.createElement('div');
        previewDiv.className = 'saved-card-preview';
        const slots = ['상의', '하의', '아우터', '신발'];
        slots.forEach(cat => {
            const itemId = co.items[cat];
            const item = itemId ? allClothes.find(c => c.id === itemId) : null;
            if (item) {
                const img = document.createElement('img');
                img.src = item.imageData;
                img.alt = item.name;
                previewDiv.appendChild(img);
            } else {
                const emptySlot = document.createElement('div');
                emptySlot.className = 'empty-slot';
                emptySlot.textContent = cat;
                previewDiv.appendChild(emptySlot);
            }
        });

        const info = document.createElement('div');
        info.className = 'saved-card-info';
        info.innerHTML = `
            <div class="saved-card-name">${co.name}</div>
            <span class="saved-card-tag">${co.tag}</span>`;

        card.appendChild(previewDiv);
        card.appendChild(info);
        card.addEventListener('click', () => openCoordDetail(co));
        grid.appendChild(card);
    });
}

// ─── Saved Filter ──────────────────────────────────────────
function setupSavedFilter() {
    document.getElementById('savedFilter').addEventListener('click', e => {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        document.querySelectorAll('#savedFilter .filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentSavedFilter = chip.dataset.tag;
        renderSavedCoords();
    });
}

// ─── Coord Detail ──────────────────────────────────────────
let detailCoordId = null;

function setupCoordDetail() {
    const modal = document.getElementById('modalCoordDetail');
    document.getElementById('modalDetailClose').addEventListener('click', () => closeModal(modal));
    document.getElementById('modalDetailCloseBtn').addEventListener('click', () => closeModal(modal));

    document.getElementById('modalDetailDelete').addEventListener('click', () => {
        showConfirm('코디 삭제', '이 코디를 삭제하시겠습니까?', async () => {
            await dbDelete('coords', detailCoordId);
            allCoords = allCoords.filter(c => c.id !== detailCoordId);
            closeModal(modal);
            renderSavedCoords();
            showToast('코디가 삭제되었습니다.');
        });
    });

    document.getElementById('modalDetailEdit').addEventListener('click', () => {
        const co = allCoords.find(c => c.id === detailCoordId);
        if (!co) return;
        closeModal(modal);
        // 코디 빌더로 이동하고 해당 코디 불러오기
        loadCoordToBuilder(co);
        switchTab('coordinate');
    });
}

function openCoordDetail(co) {
    detailCoordId = co.id;
    document.getElementById('detailCoordName').textContent = co.name;
    document.getElementById('detailCoordTag').textContent = co.tag;

    const container = document.getElementById('detailItems');
    container.innerHTML = '';

    const slots = ['상의', '하의', '아우터', '신발'];
    slots.forEach(cat => {
        const itemId = co.items[cat];
        const item = itemId ? allClothes.find(c => c.id === itemId) : null;
        if (item) {
            const div = document.createElement('div');
            div.className = 'detail-item';
            div.innerHTML = `
                <img src="${item.imageData}" alt="${item.name}">
                <div class="detail-item-label">${cat}</div>
                <div class="detail-item-name">${item.name}</div>`;
            container.appendChild(div);
        }
    });

    openModal(document.getElementById('modalCoordDetail'));
}

function loadCoordToBuilder(co) {
    editingCoordId = co.id;
    refreshCoordBuilder();

    ['상의', '하의', '아우터', '신발'].forEach(cat => {
        const state = coordState[cat];
        const targetId = co.items[cat];
        if (targetId) {
            const idx = state.items.findIndex(c => c.id === targetId);
            state.idx = idx >= 0 ? idx : (state.items.length > 0 ? 0 : -1);
        } else {
            state.idx = (cat === '아우터' || cat === '신발') ? -1 : 0;
        }
    });

    renderAllSlots();

    // 저장 버튼 열기 -> 코디 저장 모달에 기존 정보 채우기
    setTimeout(() => {
        const modal = document.getElementById('modalSaveCoord');
        document.getElementById('coordName').value = co.name;
        document.getElementById('coordFormError').style.display = 'none';
        pendingCoordTag = co.tag;
        document.querySelectorAll('#tagSelect .tag-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tag === co.tag);
        });
        openModal(modal);
    }, 400);
}

// ─── Modal Helpers ─────────────────────────────────────────
function openModal(el) { el.classList.add('active'); }
function closeModal(el) { el.classList.remove('active'); }

function showError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
}

// ─── Confirm Modal ─────────────────────────────────────────
let confirmResolve = null;

function setupConfirm() {
    document.getElementById('confirmCancel').addEventListener('click', () => {
        closeModal(document.getElementById('modalConfirm'));
    });
    document.getElementById('confirmOk').addEventListener('click', () => {
        closeModal(document.getElementById('modalConfirm'));
        if (confirmResolve) confirmResolve();
    });
}

function showConfirm(title, msg, onOk) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = msg;
    confirmResolve = onOk;
    openModal(document.getElementById('modalConfirm'));
}

// ─── Onboarding ────────────────────────────────────────────
async function checkOnboarding() {
    const visited = await dbGet('meta', 'visited');
    if (visited) return;

    const modal = document.getElementById('modalOnboarding');
    modal.style.display = '';
    openModal(modal);

    document.getElementById('btnOnboardingSample').addEventListener('click', async () => {
        await loadSampleClothes();
        await dbPut('meta', { key: 'visited', value: true });
        closeModal(modal);
        modal.style.display = 'none';
        renderCloset();
        showToast('샘플 옷이 등록되었습니다.');
    });

    document.getElementById('btnOnboardingOwn').addEventListener('click', async () => {
        await dbPut('meta', { key: 'visited', value: true });
        closeModal(modal);
        modal.style.display = 'none';
        openAddModal();
    });
}

// ─── Sample Clothes (SVG-based placeholders) ───────────────
function createSampleSVG(label, color, bgColor) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
        <rect width="300" height="300" fill="${bgColor}" rx="12"/>
        <text x="150" y="155" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="16" font-weight="600" fill="${color}">${label}</text>
    </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

async function loadSampleClothes() {
    const samples = [
        { name: '흰색 셔츠', category: '상의', color: '#5B8C6A', bg: '#F0F7F2' },
        { name: '스트라이프 티', category: '상의', color: '#4A6B8A', bg: '#EDF2F7' },
        { name: '니트 조끼', category: '상의', color: '#8B6B4A', bg: '#F7F0E8' },
        { name: '청바지', category: '하의', color: '#3A5E8C', bg: '#E8F0F7' },
        { name: '베이지 슬랙스', category: '하의', color: '#7A6B5A', bg: '#F5F0E8' },
        { name: '검정 치마', category: '하의', color: '#3A3A3A', bg: '#EDEDED' },
        { name: '가디건', category: '아우터', color: '#6A5B8C', bg: '#F0EDF7' },
        { name: '트렌치코트', category: '아우터', color: '#8C7A5B', bg: '#F7F2E8' },
        { name: '흰 운동화', category: '신발', color: '#5B7A6A', bg: '#EDF7F0' },
        { name: '로퍼', category: '신발', color: '#6B4A3A', bg: '#F2EBE5' },
    ];
    for (const s of samples) {
        const item = {
            id: uid(),
            name: s.name,
            category: s.category,
            imageData: createSampleSVG(s.name, s.color, s.bg),
            isSample: true
        };
        await dbPut('clothes', item);
        allClothes.push(item);
    }
}

// ─── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await openDB();
    allClothes = await dbGetAll('clothes');
    allCoords = await dbGetAll('coords');

    setupTabs();
    setupClosetFilter();
    setupAddClothes();
    setupEditClothes();
    setupClearSamples();
    setupCoordArrows();
    setupSwipe();
    setupRandomCoord();
    setupSaveCoord();
    setupSavedFilter();
    setupCoordDetail();
    setupConfirm();

    renderCloset();
    renderSavedCoords();

    await checkOnboarding();
});
