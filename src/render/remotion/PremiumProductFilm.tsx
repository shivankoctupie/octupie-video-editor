import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { EditPlan } from "../../schema/editPlan.js";
import {
  ProceduralBackdrop,
  ColumnField,
  SafeArea,
  RisingHeading,
  ProofCard,
  LogoLockup,
  KineticCaption,
  SceneAsset,
  sceneFrames,
} from "./components.js";
import { TimelineStage } from "./TimelineStage.js";

/**
 * PremiumProductFilm: a 16:9 product-launch film. Product-led, elegant, no
 * overshoot. One hero action at a time. Frame 0 shows intentional content.
 * When the plan carries an editor timeline, the full timeline is composited
 * instead; legacy scene/caption plans render exactly as before.
 */
export const PremiumProductFilm: React.FC<{ plan: EditPlan }> = ({ plan }) => {
  const { width } = useVideoConfig();
  const { brand } = plan;
  if (plan.timeline) return <TimelineStage plan={plan} />;

  return (
    <AbsoluteFill style={{ backgroundColor: brand.paper }}>
      <ProceduralBackdrop paper={brand.paper} accent={brand.accent} paper2={brand.paper2} />
      <ColumnField color={brand.ink} spacing={180} opacity={0.05} />

      {plan.scenes.map((scene) => {
        const { from, durationInFrames } = sceneFrames(plan, scene);
        const hasMedia = Boolean(scene.sourceClipId || scene.broll);
        return (
          <Sequence key={scene.id} from={from} durationInFrames={durationInFrames} name={scene.id}>
            {hasMedia ? (
              <AbsoluteFill style={{ overflow: "hidden" }}>
                <SceneAsset plan={plan} scene={scene} />
              </AbsoluteFill>
            ) : (
            <SafeArea inset={plan.width * 0.07}>
              {scene.type === "logo-lockup" || scene.type === "cta" ? (
                <LogoLockup name={brand.name} accent={brand.accent} ink={brand.ink} font={brand.font} />
              ) : scene.type === "proof" || scene.type === "product-reveal" ? (
                <ProofCard
                  heading={scene.heading ?? brand.name}
                  body={scene.body}
                  paper={brand.paper}
                  ink={brand.ink}
                  accent={brand.accent}
                  font={brand.font}
                  width={width}
                />
              ) : (
                <RisingHeading
                  text={scene.heading ?? brand.name}
                  size={plan.width >= 1600 ? 118 : 84}
                  color={brand.ink}
                  accent={brand.accent}
                  emphasis={scene.emphasis}
                  font={brand.font}
                />
              )}
            </SafeArea>
            )}
          </Sequence>
        );
      })}

      {plan.captions.cards.map((card, i) => (
        <KineticCaption
          key={i}
          card={card}
          fps={plan.fps}
          bandY={plan.height * 0.82}
          size={40}
          color={brand.ink === "#111111" ? brand.ink : "#F7F5F0"}
          emphasis={brand.accent}
          font={brand.font}
          canvasWidth={width}
        />
      ))}
    </AbsoluteFill>
  );
};
