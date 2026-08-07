import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  CharacterMemberOutputSchema,
  CouncilConfigSchema,
  CouncilReportSchema,
  FinalCouncilReportSchema,
  MemberReportSchema,
  ScenePacketSchema,
  WorldMemberOutputSchema
} from "../src/contracts/index.js";

/**
 * 由 contracts 生成 JSON Schema（单一来源，禁止手写双份，R09）。
 * 使用所装 zod 版本原生 z.toJSONSchema（D22）；产物仅供文档与未来宿主使用。
 * 用法：npm run gen:schemas
 */

const TARGETS: Record<string, z.ZodType> = {
  "scene-packet.schema.json": ScenePacketSchema,
  "council-config.schema.json": CouncilConfigSchema,
  "world-member-output.schema.json": WorldMemberOutputSchema,
  "character-member-output.schema.json": CharacterMemberOutputSchema,
  "member-report.schema.json": MemberReportSchema,
  "council-report.schema.json": CouncilReportSchema,
  "final-council-report.schema.json": FinalCouncilReportSchema
};

const outDir = path.resolve(process.cwd(), "schemas");
await mkdir(outDir, { recursive: true });

for (const [fileName, schema] of Object.entries(TARGETS)) {
  const jsonSchema = z.toJSONSchema(schema);
  await writeFile(path.join(outDir, fileName), JSON.stringify(jsonSchema, null, 2) + "\n", "utf8");
  process.stderr.write(`generated schemas/${fileName}\n`);
}
