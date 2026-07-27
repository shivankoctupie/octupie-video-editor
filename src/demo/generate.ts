import { neutralFounderReel } from "../presets/index.js";
import { makeStarterPlan } from "../presets/starter.js";
import { parseEditPlan, type EditPlan } from "../schema/editPlan.js";
import { renderPlan, type PipelineResult } from "../pipeline.js";

/**
 * Synthetic demo. Builds a short, fully procedural plan from the neutral preset,
 * validates it, then exercises the REAL renderer and QA (not a stub). Output
 * lands under the gitignored output directory.
 */
export async function runDemo(onStep: (msg: string) => void = () => {}): Promise<PipelineResult> {
  const raw = makeStarterPlan(neutralFounderReel, { title: "Octupie Video Editor Demo", duration: 4 });
  const parsed = parseEditPlan(raw);
  if (!parsed.ok || !parsed.plan) {
    throw new Error(`Demo plan failed validation:\n${parsed.errors.join("\n")}`);
  }
  const plan: EditPlan = parsed.plan;
  onStep(`demo plan: ${plan.title} (${plan.width}x${plan.height}, ${plan.duration}s @ ${plan.fps}fps)`);

  const result = await renderPlan(plan, { onStep });
  if (!result.report.pass) {
    const failed = result.report.gates.filter((g) => !g.pass).map((g) => `${g.name}: ${g.detail}`);
    throw new Error(`Demo QA failed:\n${failed.join("\n")}`);
  }
  return result;
}
