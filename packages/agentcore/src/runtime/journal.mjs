import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
/** Single-writer durable journal; page reads seek to recorded byte offsets. */
export class Journal {
  static async open(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const journal = new Journal();
    const metadata = join(directory, 'epoch');
    try { journal.epoch = (await readFile(metadata, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; journal.epoch = randomUUID(); await writeFile(metadata, journal.epoch, { mode: 0o600 }); }
    journal.file = await open(join(directory, 'events.jsonl'), 'a+', 0o600);
    const bytes = await journal.file.readFile();
    journal.offsets = [0];
    for (let i=0;i<bytes.length;i++) if (bytes[i]===10) {
      const event = JSON.parse(bytes.subarray(journal.offsets.at(-1), i).toString());
      if(event.seq !== journal.offsets.length) throw new Error('Invalid journal sequence');
      journal.offsets.push(i+1);
    }
    await journal.file.truncate(journal.offsets.at(-1));
    journal.tail = Promise.resolve();
    return journal;
  }
  append(message) {
    const next = this.tail.then(async () => {
      const event = { seq: this.offsets.length, at: Date.now(), message };
      const bytes = Buffer.from(JSON.stringify(event)+'\n');
      await this.file.writeFile(bytes); await this.file.sync();
      this.offsets.push(this.offsets.at(-1)+bytes.length);
      return event;
    });
    this.tail = next; return next;
  }
  async page(after=0, limit=200) {
    await this.tail;
    if(!Number.isSafeInteger(after)||after<0||after>=this.offsets.length) throw new Error('Invalid event cursor');
    const end=Math.min(after+limit,this.offsets.length-1);
    const data=Buffer.alloc(this.offsets[end]-this.offsets[after]);
    let offset=0; while(offset<data.length){const {bytesRead}=await this.file.read(data,offset,data.length-offset,this.offsets[after]+offset);if(!bytesRead)throw new Error('Journal truncated');offset+=bytesRead;}
    const events=data.length?data.toString().trimEnd().split('\n').map(JSON.parse):[];
    return {epoch:this.epoch,events,cursor:end};
  }
  async close(){try{await this.tail;}finally{await this.file.close();}}
}
