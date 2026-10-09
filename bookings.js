(function(){
 'use strict';
 const statuses={todo:'Not started',progress:'In progress',blocked:'Blocked',done:'Completed'};
 const time=value=>new Date(value).toLocaleString('en-AU',{timeZone:'Australia/Brisbane',dateStyle:'medium',timeStyle:'short'});
 const money=value=>new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format(value/100);
 window.BarRestockBookingUI={
  details(b,esc) {return `<div class="booking-facts"><span><strong>${b.guests}</strong> guests</span><span><strong>${b.tables}</strong> tables</span><span><strong>${b.poolTables}</strong> pool tables</span><span>${esc(b.area || 'Area not specified')}</span><span>Tab: ${b.tab ? b.tabCents ? money(b.tabCents) : 'Limit to confirm' : 'No'}</span></div><p class="booking-time">${esc(time(b.startAt))} – ${esc(time(b.endAt))} · Brisbane</p>${b.drinks?`<p><strong>Drinks:</strong> ${esc(b.drinks)}</p>`:''}${b.requests?`<p><strong>Special requests:</strong> ${esc(b.requests)}</p>`:''}`;},
  tasks(b,esc,readonly=false) {const done=b.tasks.filter(t=>t.status==='done').length;return `<div class="checklist-group booking-tasks"><header class="checklist-group-head"><h4>Preparation tasks</h4><span class="checklist-group-count">${done} / ${b.tasks.length}</span></header>${b.tasks.map(t=>`<div class="checklist-item" data-status="${t.status}"><span class="checklist-task"><span class="booking-task-dot" aria-hidden="true">${t.status==='done'?'✓':'○'}</span><span class="checklist-task-text">${esc(t.text)}</span></span>${readonly ? `<span class="task-status">${statuses[t.status]}</span>` : `<select class="task-status" data-booking-task="${esc(t.id)}" data-booking-id="${esc(b.id)}" data-task-version="${t.version}" aria-label="Status: ${esc(t.text)}">${Object.entries(statuses).map(([id,label])=>`<option value="${id}"${id===t.status?' selected':''}>${label}</option>`).join('')}</select>`}</div>`).join('')}</div>`;}
 };
 window.BarRestockBookings=function(api){
  const $=s=>document.querySelector(s),esc=api.escapeHtml,ui=window.BarRestockBookingUI;
  const base=(window.BarRestockHandoutConfig?.apiBase || '').replace(/\/$/,'');
  let records=[],serverNow=Date.now(),loadedAt=Date.now(),active=false,timer=null,filter='future',editing=null,busy=false,dirty=false,saveAttempt=null;
  const manager=()=>['admin','manager'].includes(api.roleId());
  const now=()=>serverNow+Date.now()-loadedAt;
  function message(text){$('#bookingStatus').textContent=text;}
  function setBusy(value){busy=value;$('#bookingForm').querySelectorAll('input,textarea,button').forEach(el=>el.disabled=value);$('#bookingList').querySelectorAll('select,button').forEach(el=>el.disabled=value);if(!value)$('#bookingTabValue').disabled=!$('#bookingTab').checked;}
  async function request(path,options={}){
   const session=api.session();if(!session)throw new Error('Enter your PIN to use bookings.');
   const response=await fetch(base+path,{...options,cache:'no-store',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.token}});
   const result=await response.json();if(!response.ok){if(response.status===401)api.onAuthRequired();throw new Error(response.status===404?'The Pi needs the bookings update. Your draft is kept.':result.error || 'Booking could not be saved.');}return result;
  }
  function period(b){return Date.parse(b.endAt)<=now()?'past':Date.parse(b.startAt)<=now()?'present':'future';}
  function render(){
   $('#bookingNew').textContent=manager()?'New booking':'Request booking';
   $('#bookingSubmit').textContent=editing?'Save changes':manager()?'Create approved booking':'Send request';
   const readonly=api.session()?.user.canEdit===false;
   $('#bookingNew').disabled=!api.roleId() || readonly;
   $('#bookingEditor').hidden=!api.roleId() || readonly;
   $('#bookingFilters').querySelectorAll('button').forEach(button=>{
    const kind=button.dataset.bookingFilter;
    const count=records.filter(b=>kind==='requests'?b.status==='pending':kind==='history'?['cancelled','rejected'].includes(b.status):b.status==='approved' && period(b)===kind).length;
    button.querySelector('span').textContent=count;button.setAttribute('aria-pressed',String(kind===filter));
   });
   const query=$('#bookingSearch').value.trim().toLowerCase();
   let visible=records.filter(b=>(filter==='requests'?b.status==='pending':filter==='history'?['cancelled','rejected'].includes(b.status):b.status==='approved' && period(b)===filter) && (!query || [b.name,b.area,b.drinks,b.requests].join(' ').toLowerCase().includes(query)));
   if(filter==='past' || filter==='history')visible=[...visible].reverse();
   $('#bookingList').innerHTML=visible.length?visible.map(b=>{
    const past=period(b)==='past',canEdit=!readonly && !past && (manager() && ['pending','approved'].includes(b.status) || b.status==='pending' && b.requestedBy.id===api.session()?.user.id);
    const actions=[];
    if(canEdit)actions.push(['edit','Edit details']);
    if(!readonly && manager() && b.status==='pending'){if(!past)actions.push(['approve','Approve']);actions.push(['reject','Decline']);}
    if(!readonly && !past && manager() && b.status==='approved')actions.push(['cancel','Cancel booking']);
    if(!readonly && b.status==='pending' && b.requestedBy.id===api.session()?.user.id)actions.push(['withdraw','Withdraw request']);
    return `<article class="booking-card" data-booking="${esc(b.id)}"><header class="booking-card-head"><h3>${esc(b.name)}</h3><span class="booking-badge booking-${b.status}">${b.status==='pending'?'Awaiting approval':b.status==='rejected'?'Declined':b.status==='approved'?'Approved':'Cancelled'}</span></header>${ui.details(b,esc)}${b.contact?`<p><strong>Contact:</strong> ${esc(b.contact)}</p>`:''}<p class="binder-source">Requested by ${esc(b.requestedBy.name)}${b.reviewedBy?` · Reviewed by ${esc(b.reviewedBy.name)}`:''}</p>${b.reviewNote?`<p class="binder-note">${esc(b.reviewNote)}</p>`:''}${ui.tasks(b,esc,readonly || b.status!=='approved' || past)}${actions.length?`<div class="binder-actions">${actions.map(([action,label])=>`<button type="button" class="btn ${action==='approve'?'btn-primary':'btn-secondary'} btn-sm" data-booking-action="${action}" data-booking-id="${esc(b.id)}">${label}</button>`).join('')}</div>`:''}</article>`;
   }).join(''):`<p class="empty-state">${query?'No bookings match your search.':filter==='requests'?'No requests awaiting approval.':'No bookings in this view.'}</p>`;
  }
  async function refresh(){
   if(!api.roleId() || !base)return;
   try{const value=await request('/api/bookings');records=value.bookings;serverNow=Date.parse(value.now);loadedAt=Date.now();render();$('#bookingConnection').textContent='Shared · updated '+new Date().toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'});}
   catch(error){$('#bookingConnection').textContent='Connection unavailable';message(error.message+' Unsaved form details are kept.');}
  }
  const local=iso=>new Date(Date.parse(iso)+36000000).toISOString().slice(0,16);
  function fill(b){
   editing=b?{id:b.id,version:b.version}:null;saveAttempt=null;
   $('#bookingForm').reset();
   for(const [key,id] of Object.entries({name:'bookingName',contact:'bookingContact',area:'bookingArea',drinks:'bookingDrinks',requests:'bookingRequests',customTasks:'bookingCustomTasks',guests:'bookingGuests',tables:'bookingTables',poolTables:'bookingPoolTables'}))$('#'+id).value=b?.[key] ?? (['guests','tables','poolTables'].includes(key)?0:'');
   $('#bookingStart').value=b?local(b.startAt):'';$('#bookingEnd').value=b?local(b.endAt):'';$('#bookingTab').checked=b?.tab || false;$('#bookingTabValue').value=b?.tabCents?b.tabCents/100:'';$('#bookingTabValue').disabled=!$('#bookingTab').checked;
   dirty=false;$('#bookingEditor').open=true;render();$('#bookingName').focus();
  }
  function formValue(){return {name:$('#bookingName').value,contact:$('#bookingContact').value,start:$('#bookingStart').value,end:$('#bookingEnd').value,area:$('#bookingArea').value,guests:Number($('#bookingGuests').value),tables:Number($('#bookingTables').value),poolTables:Number($('#bookingPoolTables').value),tab:$('#bookingTab').checked,tabCents:Math.round(Number($('#bookingTabValue').value)*100),drinks:$('#bookingDrinks').value,requests:$('#bookingRequests').value,customTasks:$('#bookingCustomTasks').value,...(editing?{version:editing.version}:{})};}
  async function mutate(id,action,body){
   if(busy || !api.roleId())return false;
   setBusy(true);
   try {await request('/api/bookings'+(id?'/'+id+(action==='edit'?'':'/'+action):''),{method:id?'PUT':'POST',body:JSON.stringify({...body,mutationId:body.mutationId || crypto.randomUUID()})});await refresh();message(action==='create'&&!manager()?'Request sent — waiting for manager/admin approval.':'Booking saved — shared with the team.');return true;}
   catch(error){message(error.message+' Your draft is kept.');return false;}
   finally{setBusy(false);}
  }
  async function updateTask(id,task){
   const result=await mutate(id,'task',task);return result;
  }
  $('#bookingNew').addEventListener('click',()=>{if(dirty && !confirm('Discard your unsaved booking draft?'))return;fill(null);});
  $('#bookingForm').addEventListener('input',()=>{dirty=true;});
  $('#bookingTab').addEventListener('change',()=>{$('#bookingTabValue').disabled=!$('#bookingTab').checked;});
  $('#bookingForm').addEventListener('submit',async e=>{
   e.preventDefault();if(busy || !api.roleId())return;const value=formValue(),signature=JSON.stringify(value);
   if(!saveAttempt || saveAttempt.signature!==signature)saveAttempt={signature,mutationId:crypto.randomUUID()};
   if(await mutate(editing?.id,editing?'edit':'create',{...value,mutationId:saveAttempt.mutationId})){dirty=false;editing=null;saveAttempt=null;$('#bookingEditor').open=false;$('#bookingForm').reset();$('#bookingTabValue').disabled=true;}
  });
  $('#bookingFormCancel').addEventListener('click',()=>{if(dirty && !confirm('Discard your unsaved booking draft?'))return;dirty=false;editing=null;saveAttempt=null;$('#bookingEditor').open=false;});
  $('#bookingFilters').addEventListener('click',e=>{const button=e.target.closest('[data-booking-filter]');if(button){filter=button.dataset.bookingFilter;render();}});
  $('#bookingSearch').addEventListener('input',render);$('#bookingRefresh').addEventListener('click',refresh);
  $('#bookingList').addEventListener('click',async e=>{
   const button=e.target.closest('[data-booking-action]');if(!button || busy)return;const b=records.find(b=>b.id===button.dataset.bookingId);if(!b)return;const action=button.dataset.bookingAction;
   if(action==='edit'){if(dirty&&!confirm('Discard your unsaved booking draft?'))return;fill(b);$('#bookingEditor').scrollIntoView({block:'start',behavior:'smooth'});return;}
   let reviewNote='';if(['reject','cancel'].includes(action)){reviewNote=prompt(action==='reject'?'Reason for declining (optional):':'Reason for cancellation (optional):');if(reviewNote===null)return;}
   if(action==='withdraw' && !confirm('Withdraw this booking request?'))return;
   await mutate(b.id,action,{version:b.version,reviewNote});
  });
  $('#bookingList').addEventListener('change',async e=>{const select=e.target.closest('[data-booking-task]');if(select){await updateTask(select.dataset.bookingId,{taskId:select.dataset.bookingTask,taskVersion:Number(select.dataset.taskVersion),taskStatus:select.value});render();}});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  return {updateTask,onTabChange(tab){active=tab==='bookings';clearInterval(timer);if(active){refresh();timer=setInterval(()=>{if(!busy)refresh();},15000);}},onRoleChange(){if(!api.roleId()){active=false;clearInterval(timer);records=[];}render();},canSignOut(){return !dirty || confirm('Sign out and discard your unsaved booking draft?');},discardDrafts(){dirty=false;editing=null;saveAttempt=null;$('#bookingForm').reset();$('#bookingEditor').open=false;}};
 };
})();
