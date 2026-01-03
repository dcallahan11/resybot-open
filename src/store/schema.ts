import { z } from "zod";

export const DateOnlyStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected date in YYYY-MM-DD format");

export const HHMMSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "Expected time in HH:MM format (24-hour clock)");

export const AccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  authToken: z.string().min(1),
  paymentId: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Account = z.infer<typeof AccountSchema>;

export const AccountsSchema = z.array(AccountSchema);

export const TaskSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  backupAccountId: z.string().uuid().optional(),
  restaurantId: z.string().min(1),
  restaurantName: z.string().min(1).optional(),
  partySize: z.number().int().positive(),
  startDate: DateOnlyStringSchema,
  endDate: DateOnlyStringSchema,
  desiredTime: HHMMSchema.optional(),
  flexMinutes: z.number().int().min(0).max(6 * 60).optional(),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  delayMs: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Task = z.infer<typeof TaskSchema>;
export const TasksSchema = z.array(TaskSchema);

export const ScheduleKindSchema = z.enum(["once", "daily", "weekly"]);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

export const ScheduleSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  kind: ScheduleKindSchema,

  // For daily/weekly schedules
  time: HHMMSchema.optional(),
  // 0 = Sunday ... 6 = Saturday (used for weekly only)
  dayOfWeek: z.number().int().min(0).max(6).optional(),

  // For once schedules
  runAt: z.string().datetime().optional(),

  durationSec: z.number().int().min(1).max(60 * 60),
  enabled: z.boolean(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Schedule = z.infer<typeof ScheduleSchema>;
export const SchedulesSchema = z.array(ScheduleSchema);

export const ProxiesSchema = z.array(z.string().min(1));

export const AppInfoSchema = z.object({
  discordWebhook: z.string().url().optional(),
});

export type AppInfo = z.infer<typeof AppInfoSchema>;


