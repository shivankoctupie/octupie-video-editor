import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { EditPlan } from "../../schema/editPlan.js";
import {
  ProceduralBackdrop,
  SafeArea,
  RisingHeading,
  ProofCard,
  LogoLockup,
  KineticCaption,
  SceneAsset,
  sceneFrames,
  hexAlpha,
} from "./components.js";

/**
 * FounderSocialReel: a 9:16 founder short. Persistent hook region above the
 * media, captions in the safe band, restrained motion. Frame 0 is intentional.
 */
export const FounderSocialReel: React.FC<{ plan: EditPlan }> = ({ plan }) => {
  const { width, height } = useVideoConfig();
  const { brand } = plan;
  const hookText = plan.scenes[0]?.heading ?? plan.title;

  return (
    <AbsoluteFill style={{ backgroundColor: brand.paper }}>
      <ProceduralBackdrop paper={brand.paper} accent={brand.accent} paper2={brand.paper2} />

      {/* Persistent hook region near the vertical third. */}
      <div style={{ position: "absolute", top: height * 0.16, left: width * 0.06, right: width * 0.06 }}>
        <RisingHeading
          text={hookText}
          size={66}
          color={brand.ink}
          accent={brand.accent}
          emphasis={plan.scenes[0]?.emphasis}
          font={brand.font}
        />
      </div>

      {/* Media slot with per-scene content. */}
      <div
        style={{
          position: "absolute",
          top: height * 0.4,
          left: width * 0.06,
          right: width * 0.06,
          height: height * 0.28,
        }}
      >
        {plan.scenes.map((scene) => {
          const { from, durationInFrames } = sceneFrames(plan, scene);
          const hasMedia = Boolean(scene.sourceClipId || scene.broll);
          return (
            <Sequence key={scene.id} from={from} durationInFrames={durationInFrames} name={scene.id}>
              <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: 20 }}>
                {hasMedia ? (
                  <SceneAsset plan={plan} scene={scene} />
                ) : scene.type === "logo-lockup" || scene.type === "cta" || scene.type === "payoff" ? (
                  <LogoLockup name={brand.name} accent={brand.accent} ink={brand.ink} font={brand.font} />
                ) : scene.type === "proof" || scene.type === "product-reveal" ? (
                  <ProofCard
                    heading={scene.heading ?? brand.name}
                    body={scene.body}
                    paper={brand.paper2 ?? brand.paper}
                    ink={brand.ink}
                    accent={brand.accent}
                    font={brand.font}
                    width={width}
                  />
                ) : (
                  <div
                    style={{
                      width: "84%",
                      height: "70%",
                      borderRadius: 20,
                      border: `1px solid ${hexAlpha(brand.ink, 0.14)}`,
                      background: hexAlpha(brand.accent, 0.1),
                    }}
                  />
                )}
              </AbsoluteFill>
            </Sequence>
          );
        })}
      </div>

      <SafeArea inset={0}>
        <></>
      </SafeArea>

      {plan.captions.cards.map((card, i) => (
        <KineticCaption
          key={i}
          card={card}
          fps={plan.fps}
          bandY={height * 0.69}
          size={54}
          color={brand.ink}
          emphasis={brand.accent}
          font={brand.font}
          canvasWidth={width}
        />
      ))}
    </AbsoluteFill>
  );
};
