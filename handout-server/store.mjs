import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { businessDate, nextDate, archiveFile, applyEntry } from './day.mjs';
export class HandoutStore {
  constructor(directory, cutoff = 120) {
    this.directory = directory; this.cutoff = cutoff;
    this.archiveDirectory = join(directory,'archives');
    mkdirSync(this.archiveDirectory,{ recursive:true,mode:0o700 });
    this.db = new DatabaseSync(join(directory,'handout.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, entries TEXT NOT NULL DEFAULT '[]', closed_at TEXT, archive TEXT);
      CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    // Recreate any file whose DB commit completed before a power interruption.
    for (const row of this.db.prepare('SELECT date, archive FROM days WHERE closed_at IS NOT NULL').all()) this.writeArchive(row);
  }
  writeArchive(row) {
    const path = join(this.archiveDirectory,`handout-${row.date}.md`);
    writeFileSync(path+'.tmp',row.archive,{mode:0o600}); renameSync(path+'.tmp',path);
  }
  get(date) {
    const row = this.db.prepare('SELECT * FROM days WHERE date=?').get(date);
    return row ? { date:row.date,revision:row.revision,entries:JSON.parse(row.entries),closedAt:row.closed_at } : null;
  }
  ensureDay(now = Date.now()) {
    const today = businessDate(now,this.cutoff);
    let date = this.db.prepare('SELECT MAX(date) AS date FROM days').get().date || today;
    if (date > today) throw new Error('The server clock is earlier than the current handout');
    const files = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      while (date <= today) {
        this.db.prepare('INSERT OR IGNORE INTO days(date) VALUES(?)').run(date);
        if (date < today) {
          const day = this.get(date);
          if (!day.closedAt) {
            const closedAt = new Date(Date.parse(date+'T00:00:00Z') + 86400000 - 10*3600000 + this.cutoff*60000).toISOString();
            const archive = archiveFile(day,closedAt,this.cutoff);
            this.db.prepare('UPDATE days SET closed_at=?,archive=? WHERE date=? AND closed_at IS NULL').run(closedAt,archive,date);
            files.push({date,archive});
          }
        }
        date = nextDate(date);
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    for (const file of files) this.writeArchive(file);
    return {day:this.get(today),rolled:files.length>0};
  }
  mutate(action, body, actor, now = Date.now()) {
    const {day} = this.ensureDay(now);
    if (typeof body.mutationId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.mutationId)) return {error:'Invalid save identifier',status:400};
    const cacheId = actor.id+':'+body.mutationId;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT response FROM mutations WHERE id=?').get(cacheId);
      if (previous) { this.db.exec('COMMIT'); return JSON.parse(previous.response); }
      const result = applyEntry(day,action,body,actor,now);
      if (result.day) {
        this.db.prepare('UPDATE days SET revision=?,entries=? WHERE date=? AND closed_at IS NULL').run(result.day.revision,JSON.stringify(result.day.entries),day.date);
        this.db.prepare('INSERT INTO mutations(id,response,created_at) VALUES(?,?,?)').run(cacheId,JSON.stringify(result),now);
        this.db.prepare('DELETE FROM mutations WHERE created_at < ?').run(now-7*86400000);
      }
      this.db.exec('COMMIT'); return result;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  archives(before = '9999-99-99') {
    return this.db.prepare('SELECT date,closed_at AS closedAt,revision FROM days WHERE closed_at IS NOT NULL AND date < ? ORDER BY date DESC LIMIT 60').all(before);
  }
  archive(date) { return this.db.prepare('SELECT archive FROM days WHERE date=? AND closed_at IS NOT NULL').get(date)?.archive || null; }
  close() { this.db.close(); }
}
