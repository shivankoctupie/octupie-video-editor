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
  return {
    durationInFrames: Math.max(1, Math.round(plan.duration * plan.fps)),
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
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
