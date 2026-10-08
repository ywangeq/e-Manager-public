import { useEffect } from "react";
import { gsap } from "gsap";

export function useCockpitMotion(rootRef, viewKey, selector) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const targets = root.querySelectorAll(selector);
      if (targets.length) gsap.fromTo(targets, { opacity: 0.8, y: 6 }, {
        opacity: 1, y: 0, duration: 0.24, stagger: 0.03,
        ease: "power2.out", overwrite: "auto", clearProps: "opacity,transform",
      });
    }, root);
    return () => media.revert();
  }, [rootRef, viewKey, selector]);
}
