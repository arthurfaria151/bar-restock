/* Binder content is venue reference material, never executable instructions. */
(function () {
  'use strict';
  window.BarRestockBinder = function (api) {
    const data = window.BarRestockBinderData;
    const KEY = 'bar-restock-checklists-v1';
    const $ = (s) => document.querySelector(s);
    const esc = api.escapeHtml;
    let selected = data.checklists[0].id;
    let date = today();
    let noteOriginal = '';
    let pending = 0;
    const statuses = {todo:'Not started',progress:'In progress',blocked:'Blocked',done:'Completed'};
    let statusFilter = 'all';
    function today() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    function validDate(value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const d = new Date(`${value}T12:00:00Z`);
      return !isNaN(d) && d.toISOString().slice(0,10) === value;
    }
    function period(list) {
      if (list.cadence === 'monthly') return date.slice(0,7);
      if (list.cadence === 'weekly') {
        const d = new Date(`${date}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - (d.getUTCDay()+6)%7);
        return d.toISOString().slice(0,10);
      }
      return date;
    }
    const list = () => data.checklists.find(c => c.id === selected);
    const recordKey = () => `${selected}:${period(list())}`;
    function load() {
      const raw = api.loadJson(KEY, {});
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }
    function record() {
      const value = load()[recordKey()];
      return value && typeof value === 'object' ? value : {};
    }
    function checks(value) {
      return value.checked && typeof value.checked === 'object' && !Array.isArray(value.checked) ? value.checked : {};
    }
    function periodLabel() {
      const p = period(list());
      return list().cadence === 'weekly' ? `Week starting ${p} (Monday)` : list().cadence === 'monthly' ? `Month ${p}` : `Date ${p}`;
    }
    function taskStatus(value,id) {
      const saved=value.statuses?.[id]?.status;
      return Object.hasOwn(statuses,saved) ? saved : checks(value)[id] ? 'done' : 'todo';
    }
    function filterTasks() {
      const query=$('#checklistSearch').value.trim().toLowerCase();
      let visible=0;
      $('#checklistTasks').querySelectorAll('.checklist-item').forEach(row=> {
        row.hidden=(statusFilter!=='all' && row.dataset.status!==statusFilter) || !row.querySelector('.checklist-task-text').textContent.toLowerCase().includes(query);
        if(!row.hidden) visible++;
      });
      $('#checklistTasks').querySelectorAll('.checklist-group').forEach(group=> {
        group.hidden=![...group.querySelectorAll('.checklist-item')].some(row=>!row.hidden);
      });
      $('#checklistEmpty').hidden=visible>0;
      $('#checklistFilters').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.statusFilter===statusFilter)));
    }
    function updateProgress() {
      const r = record();
      const items = list().sections.flatMap(s => s.items);
      const counts={todo:0,progress:0,blocked:0,done:0};
      items.forEach(item=>counts[taskStatus(r,item.id)]++);
      $('#checklistProgress').textContent = `${counts.done} of ${items.length} complete · ${periodLabel()}`;
      $('#checklistPercent').textContent = `${Math.round(counts.done/items.length*100)}%`;
      $('#checklistMeter').max = items.length;
      $('#checklistMeter').value = counts.done;
      $('#checklistFilters').querySelectorAll('[data-status-filter]').forEach(button=> {
        const filter=button.dataset.statusFilter;
        button.querySelector('span').textContent=filter==='all'?items.length:counts[filter];
      });
      $('#checklistTasks').querySelectorAll('.checklist-item').forEach(row=> {
        const input=row.querySelector('input[data-check]'),select=row.querySelector('select[data-task-status]');
        const status=taskStatus(r,input.dataset.check);
        row.dataset.status=status;
        input.checked=status==='done';select.value=status;
        input.disabled=select.disabled=!api.roleId() || pending>0;
        row.classList.toggle('is-done',status==='done');
      });
      $('#checklistTasks').querySelectorAll('.checklist-group').forEach(group=> {
        const rows=[...group.querySelectorAll('.checklist-item')];
        group.querySelector('.checklist-group-count').textContent=`${rows.filter(row=>row.dataset.status==='done').length} / ${rows.length}`;
      });
      filterTasks();
    }
    function renderChecklist() {
      const c = list();
      $('#checklistPicker').value = selected;
      $('#checklistDate').value = date;
      $('#checklistInstructions').innerHTML = c.instructions.length ? `<div class="binder-note"><h3>Before you begin</h3><ol>${c.instructions.map(t=>`<li>${esc(t)}</li>`).join('')}</ol></div>` : '';
      $('#checklistTasks').innerHTML = c.sections.map(s=>`<section class="checklist-group"><header class="checklist-group-head"><h3>${esc(s.title)}</h3><span class="checklist-group-count"></span></header><div class="checklist-items">${s.items.map(i=>`<div class="checklist-item"><label class="checklist-task"><input type="checkbox" data-check="${esc(i.id)}" /><span class="checklist-task-text">${esc(i.text)}</span></label><select class="task-status" data-task-status="${esc(i.id)}" aria-label="Status: ${esc(i.text)}">${Object.entries(statuses).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></div>`).join('')}</div></section>`).join('');
      noteOriginal = typeof record().note === 'string' ? record().note : '';
      $('#checklistNotes').value = noteOriginal;
      $('#checklistNotesStatus').textContent = '';
      $('#checklistSource').textContent = `From the Bot bar binder: ${c.source}`;
      updateProgress();
    }
    async function save(change) {
      if (!api.roleId() || pending) return false;
      const key = recordKey();
      pending++;
      // Keep the user's tick visible while waiting for the storage lock.
      // The completion count changes only after the write succeeds.
      $('#checklistTasks').querySelectorAll('input[data-check],select[data-task-status]').forEach(input => { input.disabled = true; });
      try {
        return await api.withStorageLock(() => {
          if (!api.roleId()) return false;
          const values = load();
          const current = values[key] && typeof values[key] === 'object' ? values[key] : {};
          const next = { ...current, checked: { ...checks(current) }, statuses: { ...(current.statuses || {}) } };
          if (change(next, current) === false) return false;
          next.updatedAt = new Date().toISOString();
          values[key] = next;
          return api.saveJson(KEY, values);
        });
      } finally {
        pending--;
        updateProgress();
      }
    }
    function renderProcedures() {
      const query = $('#procedureSearch').value.trim().toLowerCase();
      const topic = $('#procedureTopic').value;
      const docs = data.procedures.filter(p => (!topic || p.topic === topic) &&
        (!query || [p.title,p.topic,...p.sections.flatMap(s=>[s.title,...s.items])].join(' ').toLowerCase().includes(query)));
      $('#procedureCount').textContent = `${docs.length} ${docs.length === 1 ? 'procedure' : 'procedures'}`;
      $('#proceduresRoot').innerHTML = docs.length ? docs.map(p=>`<details class="binder-document"${query ? ' open' : ''}><summary><span><strong>${esc(p.title)}</strong><small>${esc(p.topic)}${p.pages.length ? ` · ${p.pages.length} source pages` : ''}</small></span></summary><div class="binder-document-body">${p.sections.map(s=>`<section class="binder-section"><h3>${esc(s.title)}</h3><ul>${s.items.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></section>`).join('')}${p.source ? `<p class="binder-source">Source: ${esc(p.source)}</p>` : ''}${p.pages.length ? `<details class="binder-originals"><summary>View original binder pages</summary>${p.pages.map(page=>`<figure><figcaption>${esc(page.title)}</figcaption><a href="${esc(api.asset(page.image))}" target="_blank" rel="noopener" aria-label="Open full-size ${esc(page.title)}"><img src="${esc(api.asset(page.image))}" alt="${esc(page.title)}" loading="lazy" /></a></figure>`).join('')}</details>` : ''}</div></details>`).join('') : '<p class="empty-state">No procedures match this search.</p>';
    }
    $('#checklistPicker').innerHTML = data.checklists.map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    $('#procedureTopic').innerHTML = '<option value="">All topics</option>'+[...new Set(data.procedures.map(p=>p.topic))].map(t=>`<option>${esc(t)}</option>`).join('');
    $('#checklistPicker').addEventListener('change', e=> {
      if (!api.roleId() || pending) { e.target.value = selected; return; }
      selected = e.target.value; renderChecklist();
    });
    $('#checklistDate').addEventListener('change', e=> {
      if (!api.roleId() || pending || !validDate(e.target.value)) { e.target.value = date; return; }
      date = e.target.value; renderChecklist();
    });
    $('#checklistTasks').addEventListener('change', async e=> {
      const input = e.target.closest('input[data-check],select[data-task-status]');
      if (!input) return;
      const id = input.dataset.check || input.dataset.taskStatus;
      const status = input.matches('select') ? input.value : input.checked ? 'done' : 'todo';
      if (!Object.hasOwn(statuses,status) || !list().sections.some(s=>s.items.some(i=>i.id === id))) return;
      await save(next=> {
        const change={status,at:new Date().toISOString(),role:api.roleId()};
        next.statuses[id]=change;
        if(status==='done') next.checked[id]={at:change.at,role:change.role};
        else delete next.checked[id];
      });
      updateProgress();
    });
    $('#checklistNotesForm').addEventListener('submit', async e=> {
      e.preventDefault();
      const note = $('#checklistNotes').value.trim().slice(0,2000);
      if (await save((next,current)=> {
        if ((current.note || '') !== noteOriginal) {
          api.showToast('Notes changed in another tab — reload this checklist before saving');
          return false;
        }
        next.note = note;
      })) {
        noteOriginal = note;
        $('#checklistNotesStatus').textContent = 'Notes saved';
      }
    });
    $('#checklistReset').addEventListener('click', async ()=> {
      if (!api.roleId() || pending || !confirm('Reset all task statuses for this checklist and period? Notes and other periods will be kept.')) return;
      if (await save(next=> { next.checked = {}; next.statuses = {}; })) api.showToast('Task statuses reset');
    });
    $('#checklistSearch').addEventListener('input',filterTasks);
    $('#checklistFilters').addEventListener('click',e=> {const button=e.target.closest('[data-status-filter]');if(button){statusFilter=button.dataset.statusFilter;filterTasks();}});
    $('#procedureSearch').addEventListener('input', renderProcedures);
    $('#procedureTopic').addEventListener('change', renderProcedures);
    window.addEventListener('storage', e=> { if (e.key === KEY || e.key === null) updateProgress(); });
    renderChecklist();
    renderProcedures();
    return {
      onTabChange(tab) { if (tab === 'checklist') renderChecklist(); if (tab === 'procedures') renderProcedures(); },
      onRoleChange() { updateProgress(); $('#checklistNotesForm button').disabled = !api.roleId(); $('#checklistReset').disabled = !api.roleId(); },
    };
  };
})();
