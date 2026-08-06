import type { Schedule, ScheduleRun } from '../types.js';

export interface Notifier {
  notify(schedule: Schedule, run: ScheduleRun): Promise<void>;
}
