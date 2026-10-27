import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { generationJobs, videoTasks, workspaces } from "../db/schema";
import { refund, renewPeriod } from "./ledger";
import { sweepObjectCleanups } from "../lib/object-cleanup";

export type PollVideo = (videoTaskId: string) => Promise<unknown>;

export async function sweepHeldJobs(pollVideo?: PollVideo) {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`select pg_try_advisory_xact_lock(71423, 1) as locked`);
    if (!result[0]?.locked) return { skipped: true, checked: 0, refunded: 0, errors: 0 };
    const jobs = await tx.select({ id: generationJobs.id, capability: generationJobs.capability, taskId: videoTasks.id, timedOut: sql<boolean>`${generationJobs.createdAt} <= clock_timestamp() - interval '2 hours'` })
      .from(generationJobs).leftJoin(videoTasks, eq(videoTasks.jobId, generationJobs.id))
      .where(sql`${generationJobs.status} = 'held' and ${generationJobs.createdAt} <= clock_timestamp() - interval '30 minutes'`);
    const stats = { skipped: false, checked: jobs.length, refunded: 0, errors: 0 };
    for (const job of jobs) {
      try {
        if (job.capability === "video" && job.taskId && pollVideo) {
          try { await pollVideo(job.taskId); }
          catch { stats.errors++; }
        }
        if (job.capability !== "video" || job.timedOut || !job.taskId) {
          // 两小时前的任务也先确认上游终态；已结算任务的 refund 会幂等返回。
          const result = await refund(job.id, { status: "timeout", error: "生成任务超时，冻结点数已退还" });
          if (result.job.status === "timeout") stats.refunded++;
        }
      } catch {
        // 单个上游不可达不妨碍其他冻结任务回收；下次扫描继续尝试。
        stats.errors++;
      }
    }
    return stats;
  });
}

export async function sweepPeriods() {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`select pg_try_advisory_xact_lock(71423, 2) as locked`);
    if (!result[0]?.locked) return { skipped: true, renewed: 0, errors: 0 };
    const candidates = await tx.select({ id: workspaces.id }).from(workspaces)
      .where(sql`${workspaces.periodEnd} <= clock_timestamp() or exists (select 1 from credit_buckets b where b.workspace_id = ${workspaces.id} and b.remaining > 0 and b.expires_at <= clock_timestamp())`);
    const stats = { skipped: false, renewed: 0, errors: 0 };
    for (const workspace of candidates) {
      try {
        if (await renewPeriod(workspace.id)) stats.renewed++;
      } catch {
        stats.errors++;
      }
    }
    return stats;
  });
}

export function startSweeper(pollVideo?: PollVideo) {
  const runJobs = () => { void sweepHeldJobs(pollVideo).catch(() => console.error("生成任务扫描失败")); void sweepObjectCleanups().catch(() => console.error("素材清理扫描失败")); };
  const runPeriods = () => { void sweepPeriods().catch(() => console.error("点数周期扫描失败")); };
  runJobs();
  runPeriods();
  const jobsTimer = setInterval(runJobs, 5 * 60 * 1000);
  const periodsTimer = setInterval(runPeriods, 60 * 60 * 1000);
  jobsTimer.unref();
  periodsTimer.unref();
  return () => { clearInterval(jobsTimer); clearInterval(periodsTimer); };
}
