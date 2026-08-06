/**
 * runStore.ts —— learn run 状态的持久化({ownerRoot}/learn/runs.json)。
 *
 * run 是短生命周期、单机、量极小的状态,不进 DB(无 drizzle 迁移):
 * JSON 文件 + write-temp-then-rename 原子写足够。跨重启保留 awaiting-review
 * 的提案;单进程单 controller 串行写,无并发竞争。
 */

import fs from 'node:fs';
import path from 'node:path';

import { ownerScopedUserDataPath } from '../appSessionState';
import { createLogger } from '../logger';
import type { LearnRunPublic } from '../../shared/learnTypes';

const log = createLogger('learn-host:store');

/** 保留的历史 run 上限 —— 超出按 createdAt 淘汰最旧的终态 run。 */
const MAX_STORED_RUNS = 50;

function runsFile(): string {
  return ownerScopedUserDataPath('learn', 'runs.json');
}

interface RunsFileShape {
  schemaVersion: 1;
  runs: LearnRunPublic[];
}

export class LearnRunStore {
  private runs = new Map<string, LearnRunPublic>();
  /** 加载单飞:所有调用共享同一个 promise,await 返回时文件必已读完。
   *  (review 修正:此前先置 loaded 再异步读,首个 load 未完成时第二个调用
   *  立即返回空内存,随后 put() 落盘会丢掉尚未载入的历史 run。) */
  private loadPromise: Promise<void> | null = null;
  /** 写串行化:并发 put()(如多个 revision watcher)排队落盘,避免共用
   *  tmp 文件互相 rename 覆盖(review 修正)。 */
  private writeChain: Promise<void> = Promise.resolve();

  /** 启动时载入;文件缺失/损坏按空处理(run 不是关键数据,损坏不阻断)。幂等。 */
  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(runsFile(), 'utf8');
      const parsed = JSON.parse(raw) as RunsFileShape;
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.runs)) {
        for (const run of parsed.runs) {
          if (run && typeof run.runId === 'string') this.runs.set(run.runId, run);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('load runs.json failed (starting empty):', err);
      }
    }
  }

  list(): LearnRunPublic[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(runId: string): LearnRunPublic | undefined {
    return this.runs.get(runId);
  }

  /** upsert + 落盘(原子写)。淘汰超量的最旧终态 run。 */
  async put(run: LearnRunPublic): Promise<void> {
    this.runs.set(run.runId, run);
    this.evict();
    await this.persist();
  }

  private evict(): void {
    if (this.runs.size <= MAX_STORED_RUNS) return;
    const terminal = ['applied', 'discarded', 'failed', 'cancelled', 'expired'];
    const evictable = [...this.runs.values()]
      .filter((r) => terminal.includes(r.status))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const r of evictable) {
      if (this.runs.size <= MAX_STORED_RUNS) break;
      this.runs.delete(r.runId);
    }
  }

  private persist(): Promise<void> {
    // 快照在入队时取(this.list() 反映当前内存);串行链保证任意时刻只有一个
    // 写盘在跑,后写覆盖先写,最终状态 = 最新内存。tmp 名唯一防跨进程残留碰撞。
    const payload: RunsFileShape = { schemaVersion: 1, runs: this.list() };
    this.writeChain = this.writeChain.then(async () => {
      const file = runsFile();
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await fs.promises.rename(tmp, file);
      } catch (err) {
        log.warn('persist runs.json failed:', err);
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      }
    });
    return this.writeChain;
  }
}
