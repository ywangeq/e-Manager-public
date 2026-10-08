const CARD_SPOTLIGHT_SELECTOR = [
  ".metric-card",
  ".panel",
  ".entity-row",
  ".department-card",
  ".governance-owner-card",
  ".worker-card",
  ".org-tree-node-main",
  ".identity-grid > div",
  ".loop-step",
  ".governance-root",
  ".governance-layer",
  ".skill-draft-panel",
  ".detail-grid > div",
  ".governance-block",
].join(", ");

export function attachCardSpotlight(root) {
  if (!root) return () => {};

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (motionQuery.matches) return () => {};

  let activeCard = null;

  function clearActiveCard() {
    if (!activeCard) return;
    activeCard.classList.remove("is-spotlighted");
    activeCard = null;
  }

  function handlePointerMove(event) {
    if (!(event.target instanceof Element)) {
      clearActiveCard();
      return;
    }

    const card = event.target.closest(CARD_SPOTLIGHT_SELECTOR);
    if (!card || !root.contains(card)) {
      clearActiveCard();
      return;
    }

    if (activeCard && activeCard !== card) activeCard.classList.remove("is-spotlighted");

    const rect = card.getBoundingClientRect();
    card.style.setProperty("--card-x", `${event.clientX - rect.left}px`);
    card.style.setProperty("--card-y", `${event.clientY - rect.top}px`);
    card.classList.add("is-spotlighted");
    activeCard = card;
  }

  root.addEventListener("pointermove", handlePointerMove, { passive: true });
  root.addEventListener("pointerleave", clearActiveCard);

  return () => {
    root.removeEventListener("pointermove", handlePointerMove);
    root.removeEventListener("pointerleave", clearActiveCard);
    clearActiveCard();
  };
}
