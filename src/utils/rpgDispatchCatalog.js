/**
 * Dispatch quest catalog (time-gated idle missions). Code-defined, like the
 * story catalog. Tiers escalate duration / cat count / reward and add a combined
 * stat-check gate. Numbers from V2_RPG_PLAN.md §A4.1.
 */

const DISPATCH_SLOTS = 3;

// statCheck: { stat: 'spd'|'atk'|'hp', min } — sum of that derived stat across
// the selected cats must meet `min`. null = no requirement.
const TIERS = [
  { id: 'patrol',     name: 'Patrol',     durationMin: 15,  cats: 1, catnip: 8,   xp: 80,   statCheck: null },
  { id: 'scout',      name: 'Scout',      durationMin: 60,  cats: 2, catnip: 25,  xp: 300,  statCheck: { stat: 'spd', min: 40 } },
  { id: 'expedition', name: 'Expedition', durationMin: 240, cats: 3, catnip: 90,  xp: 1200, statCheck: { stat: 'atk', min: 120 } },
  { id: 'saga',       name: 'Saga',       durationMin: 720, cats: 4, catnip: 250, xp: 3800, statCheck: { stat: 'hp',  min: 600 } },
];

const STAT_CHECK_LABEL = {
  spd: 'Combined SPD',
  atk: 'Combined ATK',
  hp: 'Combined HP',
};

function getTier(questId) {
  return TIERS.find(t => t.id === questId) || null;
}

/** Public tier list for the frontend, with a human-readable statCheck label. */
function publicTiers() {
  return TIERS.map(t => ({
    id: t.id,
    name: t.name,
    durationMin: t.durationMin,
    cats: t.cats,
    catnip: t.catnip,
    xp: t.xp,
    // Structured for the client's eligibility math; `label` for display. (No
    // more parsing a human string back into data on the frontend.)
    statCheck: t.statCheck
      ? { stat: t.statCheck.stat, min: t.statCheck.min, label: `${STAT_CHECK_LABEL[t.statCheck.stat]} ≥ ${t.statCheck.min}` }
      : null,
  }));
}

module.exports = {
  DISPATCH_SLOTS,
  TIERS,
  getTier,
  publicTiers,
};
