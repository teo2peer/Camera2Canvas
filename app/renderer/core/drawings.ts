export interface DrawingRecord {
  id: string;
  url: string;
  palette: string[];
  w?: number;
  h?: number;
}

class Library {
  list: DrawingRecord[] = [];
  add(d: DrawingRecord) {
    if (!this.list.find((x) => x.id === d.id)) this.list.push(d);
  }
  remove(id: string) {
    this.list = this.list.filter((d) => d.id !== id);
  }
  pickRandom(n: number): DrawingRecord[] {
    if (this.list.length === 0) return [];
    const out: DrawingRecord[] = [];
    for (let i = 0; i < n; i++) out.push(this.list[Math.floor(Math.random() * this.list.length)]);
    return out;
  }
  latest(): DrawingRecord | null {
    return this.list.length ? this.list[this.list.length - 1] : null;
  }
}

export const library = new Library();
