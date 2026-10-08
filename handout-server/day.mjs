export const TIME_ZONE = 'Australia/Brisbane';
const OFFSET = 10 * 60 * 60 * 1000; // Brisbane is UTC+10 year-round.
export function cutoffMinutes(hour = 2, minute = 0) {
  hour = Number(hour); minute = Number(minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid Brisbane closing time');
  return hour * 60 + minute;
}
export function businessDate(now = Date.now(), cutoff = 120) {
  return new Date(Number(now) + OFFSET - cutoff * 60000).toISOString().slice(0, 10);
}
export function nextClose(now = Date.now(), cutoff = 120) {
  const date = businessDate(now, cutoff);
  return Date.parse(date + 'T00:00:00Z') + 86400000 - OFFSET + cutoff * 60000;
}
export function nextDate(date) {
  return new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
}
export function archiveFile(day, closedAt, cutoff = 120) {
  const time = `${String(Math.floor(cutoff/60)).padStart(2,'0')}:${String(cutoff%60).padStart(2,'0')}`;
  const lines = [`# Bot bar handout — ${day.date}`, '', `Business-day end: ${time} (${TIME_ZONE})`, `Archived: ${closedAt}`, `Revision: ${day.revision}`, ''];
  for (const entry of day.entries) lines.push(`## ${entry.authorName}`, '', entry.text, '', `Last edited by ${entry.updatedByName} at ${entry.updatedAt}`, '');
  if (!day.entries.length) lines.push('No notes were recorded for this business day.', '');
  return lines.join('\n');
}
export function applyEntry(day, action, body, actor, now = Date.now(), newId = crypto.randomUUID()) {
  if (body.date !== day.date) return { error: 'DAY_CLOSED', status: 409 };
  const next = structuredClone(day);
  const at = new Date(now).toISOString();
  if (action.type !== 'delete' && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000)) return { error: 'Enter a note of 1–8000 characters.', status: 400 };
  if (action.type === 'add') {
    if (next.entries.length >= 200) return { error: 'This handout already has 200 notes.', status: 400 };
    next.entries.push({ id: newId, text: body.text.trim(), authorId: actor.id, authorName: actor.name, updatedById: actor.id, updatedByName: actor.name, updatedAt: at, version: 1 });
  } else {
    const index = next.entries.findIndex(e => e.id === action.id);
    if (index < 0) return { error: 'NOTE_CHANGED', status: 409 };
    const entry = next.entries[index];
    if (body.version !== entry.version) return { error: 'NOTE_CHANGED', status: 409 };
    if (action.type === 'delete') next.entries.splice(index, 1);
    else next.entries[index] = { ...entry, text: body.text.trim(), updatedById: actor.id, updatedByName: actor.name, updatedAt: at, version: entry.version + 1 };
  }
  next.revision++;
  return { day: next };
}
