import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import schedule from "node-schedule";
import fs from "node:fs";
import path from "node:path";
import { botSubdir, ensureDir } from "../../src/core/paths.js";

// NOTE — KNOWN ARCH ISSUE (Sprint 7 will rewrite):
// Cron callbacks here use ctx.sendUserMessage() to inject into the LIVE session.
// This is incompatible with the per-fire fresh-session model agreed for scheduled
// plans (see plan_enforcer.seedPlan). Sprint 7 replaces the callback body with:
//     SessionManager.create() → seedPlan({ task, steps, originChannel }) →
//     spawn child Pi process or createAgentSession() against the new session.
// Until then, schedules WILL break across /new and process restarts because the
// captured ctx becomes stale. Use only for transient testing.

interface JobMeta {
    job: schedule.Job;
    cron: string;
    task: string;
}
const activeJobs = new Map<string, JobMeta>();

export default function (pi: ExtensionAPI) {
    function jobsDir(): string {
        const dir = botSubdir("jobs");
        ensureDir(dir);
        return dir;
    }

    function saveJobMeta(jobId: string, cron: string, task: string) {
        fs.writeFileSync(path.join(jobsDir(), `${jobId}.json`), JSON.stringify({ cron, task }));
    }

    function deleteJobMeta(jobId: string) {
        const jobFile = path.join(jobsDir(), `${jobId}.json`);
        if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile);
    }

    // 1. Tool for Recurring Tasks
    pi.registerTool({
        name: "schedule_recurring_task",
        label: "Schedule Recurring Task",
        description: "Schedule an autonomous task to run repeatedly using a Cron expression.",
        parameters: Type.Object({
            job_id: Type.String({ description: "A unique identifier for this job (e.g., 'daily_inventory')" }),
            cron_expression: Type.String({ description: "Cron expression (e.g., '0 9 * * *' for 9 AM daily)" }),
            task_instruction: Type.String({ description: "The exact instruction to execute when the time comes" })
        }),
        async execute(_id, params) {
            if (activeJobs.has(params.job_id)) {
                throw new Error(`Job '${params.job_id}' already exists. Cancel it first.`);
            }

            const job = schedule.scheduleJob(params.cron_expression, () => {
                // INTERIM behavior — Sprint 7 will swap this to a fresh-session seedPlan call.
                pi.sendUserMessage(
                    `[SYSTEM RECURRING TASK TRIGGERED] Job: ${params.job_id}\nInstruction: ${params.task_instruction}\nExecute this task now and report the outcome.`,
                    { deliverAs: "followUp" },
                );
            });
            if (!job) throw new Error("Invalid Cron Expression");

            activeJobs.set(params.job_id, { job, cron: params.cron_expression, task: params.task_instruction });
            saveJobMeta(params.job_id, params.cron_expression, params.task_instruction);

            const next = job.nextInvocation()?.toString() ?? "(no future invocations)";
            return {
                content: [{ type: "text", text: `Scheduled recurring task '${params.job_id}'. Next run: ${next}` }],
                details: { job_id: params.job_id, cron: params.cron_expression, next_run: next },
            };
        },
    });

    pi.registerTool({
        name: "schedule_reminder",
        label: "Schedule One-Off Reminder",
        description: "Schedule a one-time reminder or delayed task.",
        parameters: Type.Object({
            minutes_from_now: Type.Number({ description: "Delay in minutes" }),
            reminder_message: Type.String({ description: "What to remind the user or yourself to do" }),
        }),
        async execute(_id, params) {
            const delayMs = params.minutes_from_now * 60 * 1000;
            setTimeout(() => {
                pi.sendUserMessage(`[SYSTEM REMINDER TRIGGERED]\nInstruction: ${params.reminder_message}`, { deliverAs: "followUp" });
            }, delayMs);

            return {
                content: [{ type: "text", text: `Reminder set. Will trigger in ${params.minutes_from_now} minutes.` }],
                details: { minutes_from_now: params.minutes_from_now },
            };
        },
    });

    pi.registerTool({
        name: "cancel_scheduled_task",
        label: "Cancel Task",
        description: "Cancel an active recurring job.",
        parameters: Type.Object({
            job_id: Type.String({ description: "The unique job identifier" }),
        }),
        async execute(_id, params) {
            const jobData = activeJobs.get(params.job_id);
            if (jobData) {
                jobData.job.cancel();
                activeJobs.delete(params.job_id);
                deleteJobMeta(params.job_id);
                return {
                    content: [{ type: "text", text: `Job '${params.job_id}' cancelled.` }],
                    details: { job_id: params.job_id, cancelled: true },
                };
            }
            return {
                content: [{ type: "text", text: `Job '${params.job_id}' not found.` }],
                details: { job_id: params.job_id, cancelled: false },
            };
        },
    });

    pi.registerTool({
        name: "list_scheduled_tasks",
        label: "List Scheduled Tasks",
        description: "View all currently active background jobs, their cron schedules, and upcoming run times.",
        parameters: Type.Object({}),
        async execute() {
            if (activeJobs.size === 0) {
                return {
                    content: [{ type: "text", text: "There are currently no active scheduled tasks." }],
                    details: { jobs: [] },
                };
            }
            const lines = ["ACTIVE SCHEDULED TASKS:", ""];
            const jobs: { job_id: string; cron: string; task: string; next_run: string }[] = [];
            for (const [jobId, meta] of activeJobs.entries()) {
                const nextRun = meta.job.nextInvocation()?.toString() ?? "Unknown/Paused";
                lines.push(`- [${jobId}] Cron: "${meta.cron}" | Next Run: ${nextRun}\n  Task: ${meta.task}`);
                jobs.push({ job_id: jobId, cron: meta.cron, task: meta.task, next_run: nextRun });
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { jobs },
            };
        },
    });

    pi.registerTool({
        name: "update_scheduled_task",
        label: "Update Task",
        description: "Modify the schedule or instructions of an existing job without having to cancel and recreate it.",
        parameters: Type.Object({
            job_id: Type.String({ description: "The ID of the job to update" }),
            new_cron_expression: Type.Optional(Type.String({ description: "New cron expression (leave blank to keep current)" })),
            new_task_instruction: Type.Optional(Type.String({ description: "New instruction (leave blank to keep current)" })),
        }),
        async execute(_id, params) {
            const jobData = activeJobs.get(params.job_id);
            if (!jobData) throw new Error(`Job '${params.job_id}' not found.`);

            const finalCron = params.new_cron_expression ?? jobData.cron;
            const finalTask = params.new_task_instruction ?? jobData.task;

            jobData.job.cancel();
            const newJob = schedule.scheduleJob(finalCron, () => {
                pi.sendUserMessage(
                    `[SYSTEM RECURRING TASK TRIGGERED] Job: ${params.job_id}\nInstruction: ${finalTask}\nExecute this task now and report the outcome.`,
                    { deliverAs: "followUp" },
                );
            });
            if (!newJob) throw new Error("Invalid Cron Expression");

            activeJobs.set(params.job_id, { job: newJob, cron: finalCron, task: finalTask });
            saveJobMeta(params.job_id, finalCron, finalTask);

            const next = newJob.nextInvocation()?.toString() ?? "(no future invocations)";
            return {
                content: [{ type: "text", text: `Updated job '${params.job_id}'. Next run: ${next}` }],
                details: { job_id: params.job_id, cron: finalCron, task: finalTask, next_run: next },
            };
        },
    });
}
