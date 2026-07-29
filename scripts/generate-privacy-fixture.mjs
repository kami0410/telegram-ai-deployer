import path from "node:path";
import { generateProject } from "../lib/template.mjs";

const outputDir = process.argv[2];
if (!outputDir || !path.isAbsolute(outputDir)) throw new Error("An absolute fixture directory is required");
await generateProject({
  templateRoot: path.resolve("template"),
  outputDir,
  personaText: "PUBLIC TEST PERSONA",
});
