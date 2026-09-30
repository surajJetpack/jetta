import { getSupportHealth, getSupportHealthRows } from "./lib/performance-sync";
import { generateHealthInsight, buildEvidence } from "./lib/health-insight";
(async () => {
  const h = (await getSupportHealth())!, rows = (await getSupportHealthRows())!;
  console.log("evidence entries:", buildEvidence(h, rows).length);
  const t = Date.now();
  const i = await generateHealthInsight(h, rows);
  console.log(JSON.stringify({ ...i, goingWell: i.goingWell.map((p) => [p.text, p.evidence?.title, p.evidence?.count]), watch: i.watch.map((p) => [p.text, p.evidence?.title, p.evidence?.count]), actions: i.actions.map((p) => [p.text, p.evidence?.title]) }, null, 1));
  console.log("ms", Date.now() - t);
  process.exit(0);
})();
