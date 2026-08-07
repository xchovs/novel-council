import { z } from "zod";

/**
 * ScenePacket v1（data-contracts §2）。
 * strict：拼写错误与版本漂移必须给出清晰错误（§0 政策）。
 * 数组字段默认 []（§1.5）；unknown 优于编造。
 */

const stringList = z.array(z.string()).default([]);

export const PlanBeatSchema = z.strictObject({
  id: z.string().min(1),
  summary: z.string(),
  required: z.boolean().default(false),
  reason: z.string().default("")
});

export const TimeAndPlaceSchema = z.strictObject({
  time: z.string().default(""),
  place: z.string().default(""),
  elapsedSincePreviousScene: z.string().default("")
});

export const PacketCharacterSchema = z.strictObject({
  name: z.string().min(1),
  identity: stringList,
  confirmedHistory: stringList,
  currentKnowledge: stringList,
  misunderstandings: stringList,
  currentGoals: stringList,
  currentFears: stringList,
  physicalState: stringList,
  relationshipState: stringList,
  knownConstraints: stringList
});

export const SourceReferenceSchema = z.strictObject({
  path: z.string().min(1),
  scope: z.string().default("")
});

export const ScenePacketSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  sceneId: z.string().min(1),
  projectId: z.string().default(""),
  chapterId: z.string().default(""),
  // 暂定方案必须显式标注（规划 §4.2）；缺失或为 false 时给出清晰错误
  provisional: z.literal(true),
  authorRequest: z.string().default(""),
  chapterGoal: z.string().default(""),
  provisionalPlan: z.array(PlanBeatSchema).default([]),
  timeAndPlace: TimeAndPlaceSchema.prefault({}),
  canonFacts: stringList,
  worldStateSummary: stringList,
  recentEvents: stringList,
  characters: z.array(PacketCharacterSchema).default([]),
  authorConstraints: stringList,
  forbiddenOutcomes: stringList,
  openQuestions: stringList,
  sourceReferences: z.array(SourceReferenceSchema).default([])
});

export type PlanBeat = z.infer<typeof PlanBeatSchema>;
export type TimeAndPlace = z.infer<typeof TimeAndPlaceSchema>;
export type PacketCharacter = z.infer<typeof PacketCharacterSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type ScenePacket = z.infer<typeof ScenePacketSchema>;
