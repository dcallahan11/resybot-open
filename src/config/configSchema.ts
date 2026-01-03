import { z } from "zod";
import { DateOnlyStringSchema, HHMMSchema } from "../store/schema";

const ConfigAccountSchema = z.object({
  name: z.string().min(1),
  authToken: z.string().min(1),
  paymentId: z.number().int().nonnegative(),
});

const RunOnceSchema = z.object({
  kind: z.literal("once"),
  runAt: z.string().datetime(),
  durationSec: z.number().int().min(1).max(60 * 60).default(10),
  enabled: z.boolean().default(true),
});

const RunDailySchema = z.object({
  kind: z.literal("daily"),
  time: HHMMSchema,
  durationSec: z.number().int().min(1).max(60 * 60).default(10),
  enabled: z.boolean().default(true),
});

const RunWeeklySchema = z.object({
  kind: z.literal("weekly"),
  dayOfWeek: z.number().int().min(0).max(6),
  time: HHMMSchema,
  durationSec: z.number().int().min(1).max(60 * 60).default(10),
  enabled: z.boolean().default(true),
});

export const RunSchema = z.union([RunOnceSchema, RunDailySchema, RunWeeklySchema]);
export type RunConfig = z.infer<typeof RunSchema>;

const ReservationSchema = z.object({
  restaurantName: z.string().min(1).optional(),
  restaurantId: z.string().min(1),
  date: DateOnlyStringSchema,
  time: HHMMSchema,
  flexMinutes: z.number().int().min(0).max(6 * 60).default(30),
  partySize: z.number().int().positive(),
  pollDelayMs: z.number().int().min(0).default(250),
  run: RunSchema.optional(),
});

export type ReservationConfig = z.infer<typeof ReservationSchema>;

export const BotConfigSchema = z.object({
  version: z.literal(1),
  discordWebhook: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .transform((v) => (v ? v : undefined)),
  proxies: z.array(z.string().min(1)).default([]),
  accounts: z.array(ConfigAccountSchema).min(1).max(2),
  reservations: z.array(ReservationSchema).default([]),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;


