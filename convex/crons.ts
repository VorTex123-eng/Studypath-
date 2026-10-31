/* Convex scheduled jobs for Studypath.
 * Daily push reminders run every 5 minutes (see push:sendDailyReminders):
 * the action itself decides who is due, so a fixed cron time is not
 * needed and each user keeps their own Settings reminder time.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("daily push reminders", { minutes: 5 }, internal.push.sendDailyReminders);
// General study nudges: every 4 hours, no user setting needed. The first
// one goes out 4 hours after this deploy, then every 4 hours after that.
crons.interval("general study reminders", { minutes: 240 }, internal.push.sendGeneralReminders);
export default crons;
