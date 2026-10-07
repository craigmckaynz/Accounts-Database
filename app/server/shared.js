// Running from a shared folder (the company folder on the NAS): one person at a time.
//
// The program and the data sit in one folder that several computers can reach. Each computer runs its own
// copy of this server against the same data file, so two at once would corrupt it. The first to start leaves
// a note in the data folder saying who has it; anyone else is told and does not start. The note is refreshed
// every half minute and treated as abandoned after three, so a computer that crashed or lost its network does
// not lock everyone out. The server also stops by itself shortly after its window is closed, which hands the
// accounts back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BEAT_MS = 30_000;
const STALE_MS = 3 * 60_000;

export class InUseError extends Error {
  constructor(who) {
    super(`McKay Accounts is open on ${who.computer} (${who.user}) since ${new Date(who.since).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })}. Only one person can use it at a time.`);
    this.who = who;
  }
}

// "Now" by the clock of the machine that holds the folder, so computers whose own clocks disagree still agree
// on how old the note is.
function folderNow(dir) {
  const probe = path.join(dir, `clock-${os.hostname()}-${process.pid}.tmp`);
  try { fs.writeFileSync(probe, ''); return fs.statSync(probe).mtimeMs; }
  catch { return Date.now(); }
  finally { try { fs.unlinkSync(probe); } catch { /* nothing to remove */ } }
}

// Takes the data folder for this computer, or throws InUseError naming who has it. Returns { release }.
export function claim(dataDir) {
  const file = path.join(dataDir, 'in-use.json');
  const me = { computer: os.hostname(), user: os.userInfo().username, pid: process.pid, since: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(me), { flag: 'wx' });          // fails if someone's note is there
      const beat = setInterval(() => { try { fs.utimesSync(file, new Date(), new Date()); } catch { /* folder briefly unreachable */ } }, BEAT_MS);
      beat.unref();
      let released = false;
      return { file, release() { if (released) return; released = true; clearInterval(beat); try { fs.unlinkSync(file); } catch { /* already gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let who = null, age = Infinity;
      try { who = JSON.parse(fs.readFileSync(file, 'utf8')); age = folderNow(dataDir) - fs.statSync(file).mtimeMs; } catch { /* unreadable or just removed */ }
      // A note from this same computer counts only while the program that wrote it is still running.
      let mine = false;
      if (who && who.computer === me.computer) { try { process.kill(who.pid, 0); } catch { mine = true; } }
      if (who && age < STALE_MS && !mine) throw new InUseError(who);
      // Abandoned, unreadable, or left by an earlier run on this same computer: clear it and try again.
      try { fs.unlinkSync(file); } catch { /* someone else cleared it */ }
    }
  }
  throw new Error('Could not take the accounts folder. Try again in a moment.');
}

// Stops the server when nobody is using it: a while after the window says it is closing, or after a long
// silence (the window was killed, the computer slept and woke much later).
export function stopWhenIdle({ onStop, closingGraceMs = 45_000, silenceMs = 15 * 60_000 }) {
  let lastSeen = Date.now();
  let closingAt = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if ((closingAt && now - closingAt > closingGraceMs && lastSeen <= closingAt) || now - lastSeen > silenceMs) { clearInterval(timer); onStop(); }
  }, 5_000);
  timer.unref();
  return { seen() { lastSeen = Date.now(); }, closing() { closingAt = Date.now(); } };
}
