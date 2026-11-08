import { backupDatabase, getSetting, setSetting } from './db';
import {
  getRuntimeBool,
  getRuntimeEnv,
  getRuntimeEnvNumber,
} from './runtime-settings';

const LAST_BACKUP_KEY = 'backup:last_at';

/** 到点则生成一份 SQLite 快照；失败只记录日志，不影响抓取。 */
export function runBackupIfDue(): void {
  if (!getRuntimeBool('BACKUP_ENABLED', true)) return;

  const intervalMs =
    getRuntimeEnvNumber('BACKUP_INTERVAL_HOURS', 24, 1, 168) * 3_600_000;
  const last = getSetting(LAST_BACKUP_KEY);
  if (last && Date.now() - Date.parse(last) < intervalMs) return;

  const dir = getRuntimeEnv('BACKUP_DIR', './data/backups');
  const keep = getRuntimeEnvNumber('BACKUP_KEEP', 7, 1, 30);

  try {
    const file = backupDatabase(dir, keep);
    setSetting(LAST_BACKUP_KEY, new Date().toISOString());
    console.log(`[backup] saved=${file} keep=${keep}`);
  } catch (error) {
    console.warn(
      `[backup] 备份失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
