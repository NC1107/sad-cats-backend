/**
 * Daily cat-quest catalog. Three fixed quests whose progress is COMPUTED from
 * existing per-day data (combat_sessions / player_dispatches counted for today
 * UTC) — no separate progress counters to persist, only claims. Separate from
 * the main game's daily challenges.
 *
 * `metric` maps to a count the model computes for "today":
 *   wins_today        — combat_sessions today with result='win'
 *   dispatches_today  — player_dispatches started today
 *   battles_today     — combat_sessions today (any result)
 */

const DAILY_QUESTS = [
  { id: 'win_combats',   name: 'Win 3 combat encounters', icon: '⚔️', goal: 3, catnip: 20, metric: 'wins_today' },
  { id: 'dispatch_cats', name: 'Start 2 dispatch missions', icon: '🗺️', goal: 2, catnip: 15, metric: 'dispatches_today' },
  { id: 'fight_battles', name: 'Fight 5 battles',          icon: '🥊', goal: 5, catnip: 10, metric: 'battles_today' },
];

// Bonus for claiming all three in a day (a guaranteed toy + bonus catnip).
const ALL_DONE_BONUS = { catnip: 30 };

function getQuest(questId) {
  return DAILY_QUESTS.find(q => q.id === questId) || null;
}

module.exports = {
  DAILY_QUESTS,
  ALL_DONE_BONUS,
  getQuest,
};
