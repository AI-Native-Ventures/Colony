import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";

const jobsDir = "jobs";
const files = readdirSync(jobsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f.replace(".json", ""), file: f }));

for (const job of files) {
  const outFile = `out/${job.name}.mp4`;
  console.log(`\n--- Rendering ${job.name} ---`);
  const start = Date.now();
  execSync(
    `npx remotion render src/index.ts T1 out/${job.name}.mp4 --props=${jobsDir}/${job.file} --concurrency=2`,
    { stdio: "inherit", cwd: "." },
  );
  const wallMs = Date.now() - start;
  console.log(`Render time for ${job.name}: ${(wallMs / 1000).toFixed(1)}s`);
  const stat = statSync(outFile);
  console.log(`File: ${outFile} (${stat.size} bytes)`);

  const frameFile = `out/frames/${job.name}-01s.png`;
  execSync(
    `ffmpeg -y -ss 1 -i out/${job.name}.mp4 -vframes 1 -q:v 2 out/frames/${job.name}-01s.png 2>/dev/null`,
    { stdio: "inherit", cwd: "." },
  );
}

console.log("\nBatch render complete.");
