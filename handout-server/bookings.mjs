export const managesBookings = actor => ['admin','manager'].includes(actor.role);
const taskLabels={todo:'Not started',progress:'In progress',blocked:'Blocked',done:'Completed'};
export const taskStatuses=Object.keys(taskLabels);
const fail=(error,status=400)=>({error,status});
function localTime(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at=Date.parse(value+'+10:00');
  return Number.isFinite(at) && new Date(at+36000000).toISOString().slice(0,16)===value ? new Date(at).toISOString() : null;
}
function fields(body) {
  const text=(key,max)=>typeof body[key]==='string' ? body[key].trim().slice(0,max) : '';
  const number=(key,max)=>Number.isInteger(body[key]) && body[key]>=0 && body[key]<=max ? body[key] : null;
  const value={name:text('name',120),contact:text('contact',200),area:text('area',120),drinks:text('drinks',2000),requests:text('requests',2000),customTasks:text('customTasks',2000),guests:number('guests',10000),tables:number('tables',200),poolTables:number('poolTables',50),tab:body.tab===true,tabCents:number('tabCents',100000000),startAt:localTime(body.start),endAt:localTime(body.end)};
  if(!value.name || !value.startAt || !value.endAt || Object.values(value).some(v=>v===null)) return fail('Enter a booking name, valid Brisbane start/end times and non-negative quantities.');
  if(value.endAt<=value.startAt || Date.parse(value.endAt)-Date.parse(value.startAt)>14*86400000) return fail('The end must follow the start, within 14 days.');
  if(!value.tab)value.tabCents=0;
  if(value.customTasks.split('\n').filter(t=>t.trim()).length>20) return fail('Use up to 20 additional preparation tasks.');
  return value;
}
function tasksFor(value,previous=[]) {
  const wanted=[['confirm','Confirm booking details and arrival time']];
  if(value.area)wanted.push(['area',`Prepare ${value.area} for the booking`]);
  if(value.tables)wanted.push(['tables',`Arrange ${value.tables} table${value.tables===1?'':'s'}`],['signs',`Put booking signs on ${value.tables} reserved table${value.tables===1?'':'s'}`]);
  if(value.poolTables)wanted.push(['pool',`Reserve ${value.poolTables} pool table${value.poolTables===1?'':'s'}`]);
  if(value.tab)wanted.push(['tab',`Set up the bar tab${value.tabCents ? ' · $'+(value.tabCents/100).toFixed(2) : ' · confirm the limit'}`]);
  if(value.drinks)wanted.push(['drinks',`Prepare requested drinks: ${value.drinks}`]);
  if(value.requests)wanted.push(['requests',`Check special requests: ${value.requests}`]);
  for(const text of [...new Set(value.customTasks.split('\n').map(t=>t.trim()).filter(Boolean))]) wanted.push([previous.find(t=>t.custom && t.text===text)?.id || crypto.randomUUID(),text,true]);
  return wanted.map(([id,text,custom=false])=> {
    const old=previous.find(t=>t.id===id);
    return old?.text===text ? old : {id,text,custom,status:'todo',version:(old?.version || 0)+1};
  });
}
export function changeBooking(previous,action,body,actor,now=Date.now(),id=crypto.randomUUID()) {
  if(actor.canEdit===false)return fail('This account has viewing access.',403);
  const manager=managesBookings(actor),at=new Date(now).toISOString();
  let next;
  if(action==='create' || action==='edit') {
    if(action==='edit') {
      if(!previous)return fail('Booking not found.',404);
      if(!(manager || previous.status==='pending' && previous.requestedBy.id===actor.id))return fail('Only managers can change an approved booking.',403);
      if(body.version!==previous.version)return fail('This booking changed. Reload before saving your draft.',409);
    }
    const value=fields(body);if(value.error)return value;
    if(Date.parse(value.endAt)<=now || previous && Date.parse(previous.endAt)<=now)return fail('Past bookings are read-only.',409);
    if(previous && !['pending','approved'].includes(previous.status))return fail('This booking is no longer active.',409);
    next={...(previous || {}),...value,id:previous?.id || id,status:previous?.status || (manager?'approved':'pending'),requestedBy:previous?.requestedBy || {id:actor.id,name:actor.name},createdAt:previous?.createdAt || at,tasks:tasksFor(value,previous?.tasks)};
    if(!previous && manager)next.reviewedBy={id:actor.id,name:actor.name,at};
  } else {
    if(!previous)return fail('Booking not found.',404);
    next=structuredClone(previous);
    if(action==='task') {
      if(previous.status!=='approved' || Date.parse(previous.endAt)<=now)return fail('Tasks can be updated only for active approved bookings.',409);
      const task=next.tasks.find(t=>t.id===body.taskId);
      if(!task || task.version!==body.taskVersion)return fail('This task changed. Reload before updating it.',409);
      if(!taskStatuses.includes(body.taskStatus))return fail('Choose a valid task status.');
      task.status=body.taskStatus;task.version++;task.updatedBy={id:actor.id,name:actor.name};task.updatedAt=at;
    } else {
      if(body.version!==previous.version)return fail('This booking changed. Reload before saving.',409);
      const transitions={approve:['pending','approved'],reject:['pending','rejected'],cancel:['approved','cancelled'],withdraw:['pending','cancelled']};
      const transition=transitions[action];if(!transition || previous.status!==transition[0])return fail('This booking cannot make that change.',409);
      if(action==='withdraw' ? !(manager || previous.requestedBy.id===actor.id) : !manager)return fail('Manager or admin approval is required.',403);
      if(['approve','cancel'].includes(action) && Date.parse(previous.endAt)<=now)return fail('Past bookings are read-only.',409);
      next.status=transition[1];next.reviewedBy={id:actor.id,name:actor.name,at};next.reviewNote=typeof body.reviewNote==='string'?body.reviewNote.trim().slice(0,1000):'';
    }
  }
  next.version=(previous?.version || 0)+1;next.updatedAt=at;
  next.history=[...(previous?.history || []),{action,by:actor.name,at}].slice(-100);
  return {booking:next};
}
export function bookingsForDay(bookings,date,cutoff=120) {
  const start=Date.parse(date+'T00:00:00Z')-36000000+cutoff*60000,end=start+86400000;
  return bookings.filter(b=>b.status==='approved' && Date.parse(b.startAt)<end && Date.parse(b.endAt)>start);
}
export function bookingLines(booking) {
  const format=at=>new Date(at).toLocaleString('en-AU',{timeZone:'Australia/Brisbane',dateStyle:'short',timeStyle:'short'});
  return [`### ${booking.name}`,`${format(booking.startAt)} – ${format(booking.endAt)} (Brisbane)`, `Guests: ${booking.guests} · Tables: ${booking.tables} · Pool tables: ${booking.poolTables}`,`Area: ${booking.area || 'Not specified'}`,`Bar tab: ${booking.tab ? booking.tabCents ? '$'+(booking.tabCents/100).toFixed(2) : 'Yes — limit to confirm' : 'No'}`,`Drinks: ${booking.drinks || 'Not specified'}`,`Requests: ${booking.requests || 'None'}`,...booking.tasks.map(t=>`- [${t.status==='done'?'x':' '}] ${t.text} — ${taskLabels[t.status]}`),''];
}
