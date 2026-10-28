import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';

export class CoverQueue extends EventEmitter {
  constructor({execute, persist = () => {}, now = Date.now, cooldownMs = 180000, maxPending = 2}) {
    super(); this.execute = execute; this.persist = persist; this.now = now; this.cooldownMs = cooldownMs; this.maxPending = maxPending;
    this.jobs = new Map(); this.pending = []; this.active = null; this.last = new Map(); this.closed = false;
  }
  save(job) {this.persist(job); this.emit(job.id, job);}
  get(owner, id) {const j = this.jobs.get(id); if (!j || j.owner !== owner) throw Error('Task not found in this conversation'); return j;}
  submit(owner, request) {
    if (this.closed) throw Error('Cover worker is stopping');
    const signature = JSON.stringify(request);
    for (const j of this.jobs.values()) if (j.owner === owner && j.signature === signature && ['queued', 'running'].includes(j.status)) return j;
    if (this.pending.length >= this.maxPending) throw Error('Cover queue is full; try later');
    const at = this.now();
    if (at - (this.last.get(owner) ?? -Infinity) < this.cooldownMs) throw Error('Please wait three minutes before requesting another cover');
    const job = {id: `cover-${randomUUID()}`, owner, request, signature, status: 'queued', createdAt: at};
    this.last.set(owner, at); this.jobs.set(job.id, job); this.pending.push(job); this.save(job); this.pump(); return job;
  }
  async pump() {
    if (this.active || this.closed) return;
    const job = this.pending.shift(); if (!job) return;
    this.active = job; job.status = 'running'; this.save(job);
    const ctl = new AbortController(); job.abort = ctl;
    try {job.result = await this.execute(job, ctl.signal); job.status = ctl.signal.aborted ? 'cancelled' : 'complete';}
    catch {job.status = ctl.signal.aborted ? 'cancelled' : 'failed';}
    finally {delete job.abort; job.completedAt = this.now(); this.save(job); this.active = null; this.prune(); this.pump();}
  }
  prune() {
    const done = [...this.jobs.values()].filter(j => !['queued', 'running'].includes(j.status)).sort((a, b) => b.completedAt - a.completedAt);
    for (const job of done.slice(100)) this.jobs.delete(job.id);
    const cutoff = this.now() - 86400000;
    for (const [k, at] of this.last) if (at < cutoff) this.last.delete(k);
  }
  cancel(owner, id) {
    const job = this.get(owner, id);
    if (job.status === 'queued') {this.pending = this.pending.filter(j => j !== job); job.status = 'cancelled'; job.completedAt = this.now(); this.save(job);}
    else if (job.status === 'running') job.abort.abort();
    return job;
  }
  wait(owner, id, ms) {
    const job = this.get(owner, id);
    if (!['queued', 'running'].includes(job.status) || ms <= 0) return Promise.resolve(job);
    return new Promise(resolve => {
      const done = j => {if (!['queued', 'running'].includes(j.status)) finish(j);};
      const finish = j => {clearTimeout(timer); this.off(id, done); resolve(j);};
      const timer = setTimeout(() => finish(this.get(owner, id)), ms);
      this.on(id, done);
    });
  }
  close() {
    this.closed = true;
    for (const job of this.pending) {job.status = 'cancelled'; job.completedAt = this.now(); this.save(job);}
    this.pending = []; this.active?.abort?.abort();
  }
}
