import React from "react";
import { Composition } from "remotion";
import type { EditPlan } from "../../schema/editPlan.js";
import { PremiumProductFilm } from "./PremiumProductFilm.js";
import { FounderSocialReel } from "./FounderSocialReel.js";
import { makeStarterPlan } from "../../presets/starter.js";
import { octupieProductLaunch, neutralFounderReel } from "../../presets/index.js";

const landscapeDefault = makeStarterPlan(octupieProductLaunch) as EditPlan;
const verticalDefault = makeStarterPlan(neutralFounderReel) as EditPlan;

function metaFromPlan(plan: EditPlan) {
  // Rendered geometry and length come from the timeline when the plan carries one, so the master
  // matches the editor document exactly; otherwise the plan-level fields drive a legacy render.
  const tl = plan.timeline;
  const fps = tl?.fps ?? plan.fps;
  const width = tl?.width ?? plan.width;
  const height = tl?.height ?? plan.height;
  const duration = tl?.duration ?? plan.duration;
  return {
    durationInFrames: Math.max(1, Math.round(duration * fps)),
    fps,
    width,
    height,
  };
}

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="PremiumProductFilm"
      component={PremiumProductFilm}
      defaultProps={{ plan: landscapeDefault }}
      durationInFrames={metaFromPlan(landscapeDefault).durationInFrames}
      fps={landscapeDefault.fps}
      width={landscapeDefault.width}
      height={landscapeDefault.height}
      calculateMetadata={({ props }) => metaFromPlan(props.plan)}
    />
    <Composition
      id="FounderSocialReel"
      component={FounderSocialReel}
      defaultProps={{ plan: verticalDefault }}
      durationInFrames={metaFromPlan(verticalDefault).durationInFrames}
      fps={verticalDefault.fps}
      width={verticalDefault.width}
      height={verticalDefault.height}
      calculateMetadata={({ props }) => metaFromPlan(props.plan)}
    />
  </>
);
