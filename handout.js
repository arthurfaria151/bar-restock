(function () {
  'use strict';
  window.BarRestockHandout = function (api) {
    const $ = s => document.querySelector(s);
    const base = (window.BarRestockHandoutConfig?.apiBase || '').replace(/\/$/,'');
    let session = null, current = null, controller = null, retry = null, active = false;
    let edit = null, archive = null, before = null, requestBusy = false;

    function status(message) { $('#handoutStatus').textContent = message; }
    function connection(message) { $('#handoutConnection').textContent = message; }
    async function request(path,options = {}) {
      const response = await fetch(base+path,{...options,cache:'no-store',headers:{'Content-Type':'application/json',...(session ? {Authorization:`Bearer ${session.token}`} : {}),...options.headers}});
      const value = await response.json();
      if(!response.ok) {
        if(response.status===401 && path!=='/api/login') api.onAuthRequired();
        const error = new Error(value.error || 'Handout connection failed');error.value=value;error.status=response.status;throw error;
      }
      return value;
    }
    function stop() {controller?.abort();controller=null;clearTimeout(retry);retry=null;}
    function render() {
      $('#handoutUnavailable').hidden = !!base;
      $('#handoutShared').hidden = !base || !session;
      $('#handoutComposer').hidden = !session || current?.user?.canEdit===false || !!archive;
      $('#handoutEditForm').hidden = !edit || !!archive || !session || current?.user?.canEdit===false;
      $('#handoutIdentity').textContent = session ? session.user.name : '';
      if(!current || !session) return;
      const day=archive || current;
      $('#handoutBookings').innerHTML=(day.bookings || []).length ? '<h3>Approved bookings for this business day</h3>'+(day.bookings || []).map(b=>`<article class="booking-card"><h4>${api.escapeHtml(b.name)}</h4>${window.BarRestockBookingUI.details(b,api.escapeHtml)}${window.BarRestockBookingUI.tasks(b,api.escapeHtml,!!archive || current.user.canEdit===false || Date.parse(b.endAt)<=Date.now())}</article>`).join('') : '';
      $('#handoutDate').textContent = `${day.date} · ${archive ? 'Archived handout' : 'Current business day'}`;
      $('#handoutClose').textContent = `Closes at ${String(current.closeHour).padStart(2,'0')}:${String(current.closeMinute).padStart(2,'0')} Brisbane time (Australia/Brisbane).`;
      $('#handoutBack').hidden=!archive;
      $('#handoutDownload').hidden=!archive;
      // Draft editing is a separate form, so incoming notes never overwrite typed text.
      $('#handoutEntries').innerHTML=day.entries.length ? day.entries.map(entry=>`<article class="handout-entry"><div class="handout-entry-head"><strong>${api.escapeHtml(entry.authorName)}</strong><span>${api.escapeHtml(new Date(entry.updatedAt).toLocaleString('en-AU',{timeZone:'Australia/Brisbane'}))} · ${api.escapeHtml(entry.updatedByName)}</span></div><p class="handout-entry-text">${api.escapeHtml(entry.text)}</p>${!archive && current.user.canEdit ? `<div class="handout-entry-actions"><button type="button" class="btn btn-ghost btn-sm" data-handout-edit="${api.escapeHtml(entry.id)}">Edit</button><button type="button" class="btn btn-ghost btn-sm" data-handout-delete="${api.escapeHtml(entry.id)}">Delete</button></div>` : ''}</article>`).join('') : '<p class="empty-state">No handout notes yet.</p>';
    }
    function accept(value) {
      const rolled = current && current.date !== value.date;
      current=value;
      if(edit && edit.date!==current.date) status('The previous day is archived. Your draft is kept; add it to today’s handout when ready.');
      else if(edit && current.entries.find(e=>e.id===edit.id)?.version!==edit.version) status('This note changed while you were editing. Your draft is kept; review the live note before saving.');
      render();
      if(rolled && session) loadArchives().catch(error=>status(error.message));
    }
    async function live() {
      if(!active || !session || !base) return;
      controller=new AbortController();
      const signal=controller.signal;
      try {
        const response=await fetch(base+'/api/events',{headers:{Authorization:`Bearer ${session.token}`},signal,cache:'no-store'});
        if(response.status===401) {api.onAuthRequired();return;}
        if(!response.ok || !response.body) throw new Error('Live connection unavailable');
        connection('Live');
        const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
        while(!signal.aborted) {
          const {value,done}=await reader.read();if(done) break;
          buffer+=decoder.decode(value,{stream:true});let boundary;
          while((boundary=buffer.indexOf('\n\n'))>=0) {
            const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            const line=event.split('\n').find(l=>l.startsWith('data: '));
            if(line) accept(JSON.parse(line.slice(6)));
          }
        }
        if(!signal.aborted) throw new Error('Live connection closed');
      } catch(error) {
        if(signal.aborted) return;
        connection('Reconnecting — unsaved drafts are kept');
        retry=setTimeout(live,3000);
      }
    }
    async function open() {
      render();if(!base || !session) return;
      try {accept(await request('/api/handout'));stop();live();await loadArchives();}
      catch(error) {connection('Connection unavailable');status(error.message+' — any draft is kept.');}
    }
    async function loadArchives(append=false) {
      const values=await request('/api/archives'+(append && before ? '?before='+before : ''));
      if(!append) $('#handoutArchiveList').innerHTML='';
      for(const item of values.archives) {
        const button=document.createElement('button');button.type='button';button.className='btn btn-secondary btn-sm';button.dataset.handoutArchive=item.date;button.textContent=item.date;$('#handoutArchiveList').appendChild(button);
      }
      before=values.archives.at(-1)?.date || null;
      $('#handoutMoreArchives').hidden=values.archives.length<60;
      $('#handoutArchiveEmpty').hidden=!!$('#handoutArchiveList').children.length;
    }
    function signOut(clearDraft=true) {
      stop();session=null;archive=null;
      if(clearDraft) {edit=null;$('#handoutText').value='';$('#handoutEditForm').hidden=true;}
      current=null;connection('Signed out');render();
    }
    async function save(action,body) {
      if(requestBusy || !api.roleId() || !current || !session) return false;
      requestBusy=true;$('#handoutShared').querySelectorAll('button[type=submit],textarea').forEach(b=>b.disabled=true);
      status('Saving…');
      try {
        const result=await request(action.path,{method:action.method,body:JSON.stringify({...body,mutationId:body.mutationId || crypto.randomUUID()})});
        accept(result.handout);status('Saved — visible to everyone');return true;
      } catch(error) {
        if(error.value?.handout) accept(error.value.handout);
        status(error.value?.error==='NOTE_CHANGED' ? 'This note changed. Your draft is kept. Review the live note or add your draft as a new note.' : error.value?.error==='DAY_CLOSED' ? 'The previous day is archived. Your draft is kept; add it to today’s handout.' : error.message+' — your draft is kept.');return false;
      } finally {requestBusy=false;$('#handoutShared').querySelectorAll('button[type=submit],textarea').forEach(b=>b.disabled=false);}
    }
    let composerMutation=null;
    $('#handoutBookings').addEventListener('change',async e=> {
      const select=e.target.closest('[data-booking-task]');if(!select || archive || !current || current.user.canEdit===false)return;
      select.disabled=true;
      const saved=await api.updateBookingTask(select.dataset.bookingId,{taskId:select.dataset.bookingTask,taskVersion:Number(select.dataset.taskVersion),taskStatus:select.value});
      status(saved?'Preparation task saved — visible to the team.':'The task change was not saved. Refresh and try again.');
      await open();
    });
    $('#handoutComposer').addEventListener('submit',async e=> {
      e.preventDefault();const text=$('#handoutText').value;
      if(!text.trim() || !current) return;
      if(!composerMutation || composerMutation.text!==text || composerMutation.date!==current.date) composerMutation={text,date:current.date,mutationId:crypto.randomUUID()};
      if(await save({path:'/api/entries',method:'POST'},composerMutation)) {$('#handoutText').value='';composerMutation=null;}
    });
    $('#handoutEntries').addEventListener('click',async e=> {
      const button=e.target.closest('[data-handout-edit],[data-handout-delete]');if(!button || !current || archive || !api.roleId()) return;
      const entry=current.entries.find(item=>item.id===(button.dataset.handoutEdit || button.dataset.handoutDelete));if(!entry) return;
      if(button.dataset.handoutDelete) {
        if(confirm('Delete this handout note?')) await save({path:'/api/entries/'+entry.id,method:'DELETE'},{date:current.date,version:entry.version});
      } else {
        if(edit && $('#handoutEditText').value!==edit.text && !confirm('Replace your unsaved editing draft?')) return;
        edit={...entry,date:current.date};$('#handoutEditText').value=entry.text;$('#handoutEditForm').hidden=false;$('#handoutEditText').focus();
      }
    });
    $('#handoutEditForm').addEventListener('submit',async e=> {
      e.preventDefault();if(!edit) return;
      const text=$('#handoutEditText').value;
      if(!edit.mutation || edit.mutation.text!==text) edit.mutation={text,mutationId:crypto.randomUUID()};
      if(await save({path:'/api/entries/'+edit.id,method:'PUT'},{...edit.mutation,date:edit.date,version:edit.version})) {edit=null;$('#handoutEditForm').hidden=true;}
    });
    $('#handoutEditCancel').addEventListener('click',()=> {
      if(edit && $('#handoutEditText').value!==edit.text && !confirm('Discard your unsaved edit?')) return;
      edit=null;$('#handoutEditForm').hidden=true;
    });
    $('#handoutEditAsNew').addEventListener('click',async ()=> {
      if(!edit || !current) return;
      const text=$('#handoutEditText').value;
      if(!edit.asNewMutation || edit.asNewMutation.text!==text || edit.asNewMutation.date!==current.date) edit.asNewMutation={text,date:current.date,mutationId:crypto.randomUUID()};
      const body=edit.asNewMutation;
      if(await save({path:'/api/entries',method:'POST'},body)) {edit=null;$('#handoutEditForm').hidden=true;}
    });
    $('#handoutArchiveList').addEventListener('click',async e=> {
      const button=e.target.closest('[data-handout-archive]');if(!button) return;
      try {archive=(await request('/api/archives/'+button.dataset.handoutArchive)).day;render();}
      catch(error) {status(error.message);}
    });
    $('#handoutMoreArchives').addEventListener('click',()=>loadArchives(true).catch(error=>status(error.message)));
    $('#handoutBack').addEventListener('click',()=>{archive=null;render();});
    $('#handoutDownload').addEventListener('click',async ()=> {
      if(!archive || !session) return;
      try {
        const response=await fetch(base+'/api/archives/'+archive.date+'.md',{headers:{Authorization:`Bearer ${session.token}`},cache:'no-store'});
        if(!response.ok) throw new Error('Archive download failed');
        const text=await response.text();const filename=`handout-${archive.date}.md`;
        if(api.saveFile) await api.saveFile(text,filename);
        else {const link=document.createElement('a');const url=URL.createObjectURL(new Blob([text],{type:'text/markdown'}));link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      } catch(error) {status(error.message);}
    });
    render();
    return {
      onTabChange(tab) {active=tab==='handout';if(active) open();else stop();},
      canSignOut() {return !($('#handoutText').value || edit) || confirm('Sign out and discard unsaved handout drafts?');},
      discardDrafts() {edit=null;$('#handoutText').value='';$('#handoutEditText').value='';composerMutation=null;},
      onRoleChange() {if(!api.roleId()){active=false;signOut(false);} else {session=api.session();render();}},
    };
  };
})();
