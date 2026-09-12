import type { FileNode } from "./fs";

const key = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");

/** One workspace generation. No directory request can populate another one. */
export class DirectoryTree {
  private directories = new Map<string, FileNode[]>();
  private pending = new Map<string, Promise<FileNode[]>>();
  private disposed = false;
  private active = 0;
  private waiting: Array<() => void> = [];
  readonly root: string;
  private read: (path: string) => Promise<FileNode[]>;
  constructor(root: string, read: (path: string) => Promise<FileNode[]>) {
    this.root = root;
    this.read = read;
  }

  dispose() { this.disposed = true; }

  private async readLevel(path: string) {
    if (this.active >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      if (this.disposed) throw new Error("目录加载已取消");
      return await this.read(path);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  async load(path: string): Promise<FileNode[]> {
    if (this.disposed) throw new Error("目录加载已取消");
    const id = key(path);
    const root = key(this.root);
    if (id !== root && !id.startsWith(root + "/")) throw new Error("目录不在当前项目中");
    const cached = this.directories.get(id);
    if (cached) return cached;
    const pending = this.pending.get(id);
    if (pending) return pending;
    const request = (async () => {
      // Loading a deep folder from notes mode also materializes its ancestors.
      if (id !== root) await this.load(path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || this.root);
      const nodes = await this.readLevel(id === root ? this.root : path);
      if (this.disposed) throw new Error("目录加载已取消");
      this.directories.set(id, nodes);
      return nodes;
    })();
    this.pending.set(id, request);
    try { return await request; } finally { this.pending.delete(id); }
  }

  snapshot(): FileNode[] {
    const build = (path: string): FileNode[] | null => {
      const nodes = this.directories.get(key(path));
      return nodes?.map((node) => node.is_dir ? { ...node, children: build(node.path) } : node) ?? null;
    };
    return build(this.root) ?? [];
  }
}
