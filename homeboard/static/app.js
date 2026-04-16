/* ────────────────────────────────────────────────────────────────────────
   HomeBoard — app.js
   ──────────────────────────────────────────────────────────────────────── */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  tasks:         [],
  users:         [],
  editTaskId:    null,   // null = creating new
  dragTaskId:    null,
};

// ── API helpers ───────────────────────────────────────────────────────────
async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`${method} ${path} → ${res.status}: ${txt}`);
  }
  return res.status === 204 ? null : res.json();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
async function loadAll() {
  try {
    const [tasks, users] = await Promise.all([
      apiFetch('GET', '/tasks'),
      apiFetch('GET', '/users'),
    ]);
    state.tasks = tasks;
    state.users = users;
    renderBoard();
    renderSettings();
  } catch (err) {
    console.error('loadAll failed:', err);
  }
}

// ── Avatar helpers ────────────────────────────────────────────────────────
const AV_COLORS = ['--av0','--av1','--av2','--av3','--av4','--av5','--av6'];

function avColor(idx) {
  return `var(${AV_COLORS[idx % AV_COLORS.length]})`;
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function initials(name) {
  return name.trim().charAt(0).toUpperCase();
}

// ── Board rendering ───────────────────────────────────────────────────────
function renderBoard() {
  ['todo', 'inprogress', 'done'].forEach(status => {
    const list  = document.getElementById(`list-${status}`);
    const count = document.getElementById(`cnt-${status}`);
    const tasks = state.tasks.filter(t => t.status === status);

    count.textContent = tasks.length;
    list.innerHTML = '';
    tasks.forEach(t => list.appendChild(makeCard(t)));
  });
}

function makeCard(task) {
  const card = document.createElement('div');
  card.className = 'card';
  card.draggable  = true;
  card.dataset.id     = task.id;
  card.dataset.status = task.status;

  // Assigned user avatars
  const assigned = state.users.filter(u => (task.assigned_user_ids || []).includes(u.id));
  const avatarHtml = assigned.slice(0, 5).map((u, i) =>
    `<span class="avatar" style="background:${avColor(state.users.indexOf(u))}"
           title="${escHtml(u.name)}">${initials(u.name)}</span>`
  ).join('');

  // Due date
  let dueHtml = '';
  if (task.due_date) {
    const d   = new Date(task.due_date + 'T00:00:00');
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const overdue = d < now && task.status !== 'done';
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    dueHtml = `<span class="card-due${overdue ? ' overdue' : ''}">
                 ${overdue ? '⚠ ' : '📅 '}${label}
               </span>`;
  }

  card.innerHTML = `
    <div class="card-title">${escHtml(task.title)}</div>
    <div class="card-meta">
      ${dueHtml}
      <div class="card-avatars">${avatarHtml}</div>
    </div>`;

  // Click → open edit modal
  card.addEventListener('click', () => openModal(task));

  // Drag events
  card.addEventListener('dragstart', e => {
    state.dragTaskId = task.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(task.id));
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    state.dragTaskId = null;
    document.querySelectorAll('.card-list').forEach(l => l.classList.remove('drop-target'));
  });

  return card;
}

// ── Drag & Drop (column drop zones) ──────────────────────────────────────
function initDragDrop() {
  document.querySelectorAll('.card-list').forEach(list => {
    list.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
    });

    list.addEventListener('dragleave', e => {
      if (!list.contains(e.relatedTarget)) {
        list.classList.remove('drop-target');
      }
    });

    list.addEventListener('drop', async e => {
      e.preventDefault();
      list.classList.remove('drop-target');

      const id = state.dragTaskId;
      if (id === null) return;
      const newStatus = list.dataset.status;
      const task = state.tasks.find(t => t.id === id);
      if (!task || task.status === newStatus) return;

      // Optimistic update
      task.status = newStatus;
      renderBoard();

      try {
        const updated = await apiFetch('PATCH', `/tasks/${id}/status`, { status: newStatus });
        // Sync back server response
        const idx = state.tasks.findIndex(t => t.id === id);
        if (idx !== -1) state.tasks[idx] = updated;
        renderBoard();
      } catch (err) {
        console.error('Status update failed, reverting:', err);
        await loadAll();
      }
    });
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────
function openModal(task) {
  state.editTaskId = task ? task.id : null;

  const overlay    = document.getElementById('modal-overlay');
  const heading    = document.getElementById('modal-heading');
  const titleInput = document.getElementById('f-title');
  const dueInput   = document.getElementById('f-due');
  const notesInput = document.getElementById('f-notes');
  const deleteBtn  = document.getElementById('task-delete-btn');
  const assignGrid = document.getElementById('f-assignees');

  heading.textContent = task ? 'Edit Task' : 'New Task';
  titleInput.value    = task ? task.title    : '';
  dueInput.value      = task ? (task.due_date || '')  : '';
  notesInput.value    = task ? (task.notes   || '')  : '';
  deleteBtn.classList.toggle('hidden', !task);

  // Render assignee pills
  assignGrid.innerHTML = '';
  state.users.forEach((user, i) => {
    const isChecked = task && (task.assigned_user_ids || []).includes(user.id);
    const pill = document.createElement('label');
    pill.className = 'assignee-pill' + (isChecked ? ' checked' : '');

    pill.innerHTML = `
      <input type="checkbox" value="${user.id}" ${isChecked ? 'checked' : ''} />
      <span class="pill-dot" style="${isChecked ? `background:${avColor(i)};border-color:${avColor(i)}` : ''}"></span>
      <span>${escHtml(user.name)}</span>`;

    const cb = pill.querySelector('input[type=checkbox]');
    cb.addEventListener('change', () => {
      const dot = pill.querySelector('.pill-dot');
      if (cb.checked) {
        pill.classList.add('checked');
        dot.style.background   = avColor(i);
        dot.style.borderColor  = avColor(i);
      } else {
        pill.classList.remove('checked');
        dot.style.background   = '';
        dot.style.borderColor  = '';
      }
    });

    assignGrid.appendChild(pill);
  });

  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => titleInput.focus());
}

function closeModal() {
  document.getElementById('modal-overlay').setAttribute('aria-hidden', 'true');
  state.editTaskId = null;
}

async function saveTask() {
  const titleVal = document.getElementById('f-title').value.trim();
  if (!titleVal) {
    document.getElementById('f-title').focus();
    return;
  }

  const payload = {
    title:             titleVal,
    due_date:          document.getElementById('f-due').value   || null,
    notes:             document.getElementById('f-notes').value.trim() || null,
    assigned_user_ids: Array.from(
      document.querySelectorAll('#f-assignees input[type=checkbox]:checked')
    ).map(cb => parseInt(cb.value, 10)),
  };

  try {
    if (state.editTaskId) {
      const updated = await apiFetch('PUT', `/tasks/${state.editTaskId}`, payload);
      const idx = state.tasks.findIndex(t => t.id === state.editTaskId);
      if (idx !== -1) state.tasks[idx] = updated;
    } else {
      const created = await apiFetch('POST', '/tasks', payload);
      state.tasks.push(created);
    }
    closeModal();
    renderBoard();
  } catch (err) {
    console.error('saveTask failed:', err);
  }
}

async function deleteTask() {
  if (!state.editTaskId) return;
  if (!confirm('Delete this task? This cannot be undone.')) return;
  try {
    await apiFetch('DELETE', `/tasks/${state.editTaskId}`);
    state.tasks = state.tasks.filter(t => t.id !== state.editTaskId);
    closeModal();
    renderBoard();
  } catch (err) {
    console.error('deleteTask failed:', err);
  }
}

// ── Settings ──────────────────────────────────────────────────────────────
function renderSettings() {
  const list = document.getElementById('user-list');
  list.innerHTML = '';

  if (!state.users.length) {
    list.innerHTML = '<p style="font-size:.82rem;color:var(--text-3);padding:4px 0">No team members yet.</p>';
    return;
  }

  state.users.forEach((user, i) => {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <div class="user-row-left">
        <span class="avatar" style="background:${avColor(i)};width:26px;height:26px;font-size:.65rem">
          ${initials(user.name)}
        </span>
        <span class="user-row-name">${escHtml(user.name)}</span>
      </div>
      <button class="user-del-btn" title="Remove ${escHtml(user.name)}">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </button>`;

    row.querySelector('.user-del-btn').addEventListener('click', () => deleteUser(user.id, user.name));
    list.appendChild(row);
  });
}

async function addUser() {
  const input = document.getElementById('new-user-input');
  const name  = input.value.trim();
  if (!name) { input.focus(); return; }
  try {
    const user = await apiFetch('POST', '/users', { name });
    state.users.push(user);
    input.value = '';
    renderSettings();
  } catch (err) {
    console.error('addUser failed:', err);
  }
}

async function deleteUser(id, name) {
  if (!confirm(`Remove "${name}"? They will be unassigned from all tasks.`)) return;
  try {
    await apiFetch('DELETE', `/users/${id}`);
    state.users = state.users.filter(u => u.id !== id);
    // Strip assignments from local task state so UI stays consistent
    state.tasks.forEach(t => {
      t.assigned_user_ids = (t.assigned_user_ids || []).filter(uid => uid !== id);
    });
    renderSettings();
    renderBoard();
  } catch (err) {
    console.error('deleteUser failed:', err);
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b  => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initDragDrop();

  // Board controls
  document.getElementById('add-task-btn').addEventListener('click', () => openModal(null));

  // Modal controls
  document.getElementById('modal-close')   .addEventListener('click', closeModal);
  document.getElementById('modal-cancel')  .addEventListener('click', closeModal);
  document.getElementById('task-save-btn') .addEventListener('click', saveTask);
  document.getElementById('task-delete-btn').addEventListener('click', deleteTask);

  // Close on overlay click
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Keyboard: Escape to close, Ctrl+Enter to save
  document.addEventListener('keydown', e => {
    const overlayOpen = document.getElementById('modal-overlay').getAttribute('aria-hidden') === 'false';
    if (!overlayOpen) return;
    if (e.key === 'Escape') closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveTask();
  });

  // Settings controls
  document.getElementById('add-user-btn').addEventListener('click', addUser);
  document.getElementById('new-user-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addUser();
  });

  // Load data
  loadAll();
});
