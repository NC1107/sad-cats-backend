const { withTransaction } = require('../config/database');
const rpgModel = require('../models/rpg.model');
const cardModel = require('../models/card.model');
const rpgStats = require('../utils/rpgStats');
const storyCatalog = require('../utils/rpgStoryCatalog');
const dispatchCatalog = require('../utils/rpgDispatchCatalog');
const dailyCatalog = require('../utils/rpgDailyCatalog');
const { simulateBattle } = require('../services/rpg-combat.service');
const logger = require('../utils/logger');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

// UTC day boundary helpers for daily quests.
function utcDayInfo(now = new Date()) {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    questDate: midnight.toISOString().slice(0, 10), // YYYY-MM-DD
    since: midnight.toISOString(),
    resetAt: midnight.getTime() + 86400000,
  };
}

/**
 * Shape one DB cat row into the API contract: derived stats, role, xp-to-next,
 * level cap, and lazily-regenerated stamina.
 */
function shapeCat(row, isMember) {
  const level = Number(row.level) || 1;
  const role = rpgStats.roleFor(row.buff_type);
  // Stamina is null until the cat's stat row exists; treat as full pool.
  let stamina = rpgStats.staminaCap(isMember);
  if (row.stamina != null && row.stamina_updated_at) {
    stamina = rpgStats.regenStamina(Number(row.stamina), row.stamina_updated_at, isMember).stamina;
  }
  return {
    playerCardId: row.player_card_id,
    cardId: row.card_id,
    catName: row.cat_name,
    spriteFile: row.sprite_file,
    rarity: row.rarity,
    setId: row.set_id,
    buffType: row.buff_type,
    buffValue: Number(row.buff_value) || 0,
    level,
    xp: Number(row.xp) || 0,
    xpToNext: rpgStats.xpToNext(level),
    levelCap: rpgStats.levelCap(row.rarity),
    stamina,
    staminaCap: rpgStats.staminaCap(isMember),
    role: role.role,
    special: role.special,
    stats: rpgStats.deriveStats(row, level),
  };
}

/**
 * One-time starter gift: grant each owned card an XP head-start scaled by how
 * long ago it was obtained, capped at the cumulative XP to reach level 4. Runs
 * once per player (guarded by rpg_starter_grants). Honors veteran collectors
 * without a balance-breaking head start.
 */
async function grantStarterGiftIfNeeded(discordId, rows) {
  const alreadyGranted = await rpgModel.hasStarterGrant(discordId);
  if (alreadyGranted) return rows;

  const giftCap = rpgStats.cumulativeXpToReach(4);
  const now = Date.now();

  await withTransaction(async (client) => {
    // Re-check inside the txn to close the double-grant race.
    if (await rpgModel.hasStarterGrant(discordId, client)) return;
    for (const row of rows) {
      const daysOwned = Math.max(0, Math.floor((now - new Date(row.obtained_at).getTime()) / 86400000));
      const totalXp = Math.min(giftCap, daysOwned * 8);
      if (totalXp <= 0) continue;
      const { level, xp } = rpgStats.resolveLevelFromTotalXp(totalXp, rpgStats.levelCap(row.rarity));
      if (level > 1 || xp > 0) {
        await rpgModel.setLevelXp(row.player_card_id, discordId, row.card_id, level, xp, client);
        row.level = level;
        row.xp = xp;
      }
    }
    await rpgModel.markStarterGrant(discordId, client);
  });

  return rows;
}

/**
 * GET /api/rpg/cats
 * All owned cats with derived stats, the active party, and rosterBonus.
 */
const getCats = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const isMember = !!req.user.data.isMember;

    let rows = await rpgModel.getCatRows(discordId);
    rows = await grantStarterGiftIfNeeded(discordId, rows);

    const cats = rows.map(r => shapeCat(r, isMember));
    const [partySlots, totalLevels] = await Promise.all([
      rpgModel.getPartySlots(discordId),
      rpgModel.getTotalCatLevels(discordId),
    ]);

    const party = [null, null, null, null];
    for (const { slot, player_card_id } of partySlots) party[slot] = player_card_id;

    res.json({
      success: true,
      cats,
      party,
      rosterBonus: rpgStats.rosterBonus(totalLevels),
      totalCatLevels: totalLevels,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/rpg/party
 * Just the 4 active slots (lighter than getCats).
 */
const getParty = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const [slots, totalLevels] = await Promise.all([
      rpgModel.getPartySlots(discordId),
      rpgModel.getTotalCatLevels(discordId),
    ]);
    const party = [null, null, null, null];
    for (const { slot, player_card_id } of slots) party[slot] = player_card_id;
    res.json({ success: true, party, rosterBonus: rpgStats.rosterBonus(totalLevels) });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/rpg/party
 * Replace the party. Body { slots: [uuid|null × 4] }. Validates ownership +
 * no-duplicate, then rewrites in a transaction (delete-then-insert).
 */
const setParty = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { slots } = req.body;

    const present = slots.filter(Boolean);
    const unique = new Set(present);
    if (unique.size !== present.length) {
      throw new ValidationError('A cat cannot occupy two party slots');
    }

    const owned = await rpgModel.filterOwnedCardIds(discordId, present);
    const notOwned = present.filter(id => !owned.has(id));
    if (notOwned.length) {
      throw new ValidationError('Party includes a cat you do not own');
    }

    await withTransaction(async (client) => {
      await rpgModel.clearParty(discordId, client);
      for (let slot = 0; slot < slots.length; slot++) {
        if (slots[slot]) await rpgModel.insertPartySlot(discordId, slots[slot], slot, client);
      }
    });

    logger.info('Party updated', { discordId, filled: present.length });
    res.json({ success: true, party: slots });
  } catch (error) {
    next(error);
  }
};

/**
 * Build combat-ready party combatants from the player's active slots.
 * Returns [] if the party is empty.
 */
function buildPartyCombatants(rows, partySlots, discordId) {
  const bySlot = [];
  const rowById = new Map(rows.map(r => [r.player_card_id, r]));
  for (const { slot, player_card_id } of partySlots) {
    const row = rowById.get(player_card_id);
    if (!row) continue;
    const level = Number(row.level) || 1;
    bySlot[slot] = {
      playerCardId: row.player_card_id,
      discordId,
      cardId: row.card_id,
      rarity: row.rarity,
      name: row.cat_name,
      role: rpgStats.roleFor(row.buff_type).role,
      buffValue: Number(row.buff_value) || 0,
      level,
      xp: Number(row.xp) || 0,
      stats: rpgStats.deriveStats(row, level),
    };
  }
  return bySlot.filter(Boolean);
}

/**
 * POST /api/rpg/combat/start
 * Resolve a turn-based fight against a story node, server-side. Rewards (XP +
 * catnip + guaranteed chapter card) are granted only on the FIRST clear of the
 * player's current node — replays return the fight result with no rewards
 * (stamina-gated grinding arrives with the dispatch phase).
 */
const startCombat = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { encounterId } = req.body || {};

    const node = storyCatalog.getNode(encounterId);
    if (!node) throw new ValidationError('Unknown encounter');

    const [rows, partySlots] = await Promise.all([
      rpgModel.getCatRows(discordId),
      rpgModel.getPartySlots(discordId),
    ]);
    const party = buildPartyCombatants(rows, partySlots, discordId);
    if (party.length === 0) throw new ValidationError('Your party is empty — add cats before fighting');

    const seed = Math.floor(Math.random() * 0x7fffffff);
    const battle = simulateBattle(party, node.enemies, seed);

    const currentNode = await rpgModel.getStoryProgress(discordId);
    const isFirstClear = battle.result === 'win' && encounterId === currentNode;

    let rewards = { catnip: 0, xpEach: 0, leveledUp: [], cardGranted: null, advancedTo: null };

    if (isFirstClear) {
      const tier = node.tier;
      const maxEnemyLevel = node.enemies.reduce((m, e) => Math.max(m, e.level), 1);
      const catnip = 5 + 2 * tier;
      const survivorIds = new Set(battle.survivors);
      const survivors = party.filter(p => survivorIds.has(p.playerCardId));
      const xpEach = survivors.length ? Math.floor((10 + 4 * maxEnemyLevel) / survivors.length) : 0;

      rewards = await withTransaction(async (client) => {
        const leveledUp = [];
        for (const cat of survivors) {
          const r = await rpgModel.grantXp(cat, xpEach, client);
          if (r.leveledUp) leveledUp.push({ playerCardId: cat.playerCardId, level: r.level });
        }
        await cardModel.addCatnip(discordId, catnip, client);

        // Guaranteed chapter card on an elite (chapter-ending) node — idempotent.
        let cardGranted = null;
        if (node.elite && node.rewardCardId) {
          const firstClaim = await rpgModel.tryClaimNode(discordId, encounterId, client);
          if (firstClaim) {
            await cardModel.insertPlayerCard(discordId, node.rewardCardId, 'story', false, client);
            cardGranted = node.rewardCardId;
          }
        }

        // Advance to the next node in the chain.
        const next = storyCatalog.nextNodeId(encounterId);
        if (next) await rpgModel.setStoryProgress(discordId, next, client);

        return { catnip, xpEach, leveledUp, cardGranted, advancedTo: next };
      });
    }

    await rpgModel.insertCombatSession({
      discordId,
      encounterId,
      partySnapshot: party.map(p => ({ playerCardId: p.playerCardId, level: p.level, stats: p.stats })),
      seed,
      result: battle.result,
      turns: battle.turns,
      xpGranted: rewards.xpEach * (rewards.leveledUp.length || 0),
      catnipGranted: rewards.catnip,
    });

    res.json({
      success: true,
      result: battle.result,
      turns: battle.turns,
      log: battle.log,
      survivors: battle.survivors,
      rewardsGranted: isFirstClear,
      rewards,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/rpg/story
 * Static node map + this player's progress, claimed chapter rewards, and counts.
 */
const getStory = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const [currentNode, claims, wins] = await Promise.all([
      rpgModel.getStoryProgress(discordId),
      rpgModel.getStoryClaims(discordId),
      rpgModel.countCombatWins(discordId),
    ]);
    const parsed = storyCatalog.parseNodeId(currentNode) || { chapter: 1, node: 1 };
    const clearedCount = storyCatalog.nodeDepth(parsed.chapter, parsed.node) - 1;

    res.json({
      success: true,
      map: storyCatalog.getStoryMap(),
      currentNode,
      claims,
      clearedCount,
      totalNodes: storyCatalog.TOTAL_NODES,
      combatWins: wins,
    });
  } catch (error) {
    next(error);
  }
};

// ========== Dispatch ==========

/**
 * GET /api/rpg/dispatch
 * Active missions (with live `ready` flag) + available tiers + slot count.
 */
const getDispatch = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const active = await rpgModel.getActiveDispatches(discordId);
    const now = Date.now();
    res.json({
      success: true,
      slots: dispatchCatalog.DISPATCH_SLOTS,
      tiers: dispatchCatalog.publicTiers(),
      active: active.map(d => {
        const tier = dispatchCatalog.getTier(d.quest_id);
        return {
          id: d.id,
          questId: d.quest_id,
          tierName: tier?.name || d.quest_id,
          startedAt: new Date(d.started_at).getTime(),
          endsAt: new Date(d.ends_at).getTime(),
          ready: new Date(d.ends_at).getTime() <= now,
          catIds: d.card_ids,
          reward: { catnip: tier?.catnip || 0, xp: tier?.xp || 0 },
        };
      }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/rpg/dispatch/accept  { questId, playerCardIds }
 * Validates tier, slot availability, ownership, availability, and the combined
 * stat check, then starts the mission.
 */
const acceptDispatch = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { questId, playerCardIds } = req.body;
    const tier = dispatchCatalog.getTier(questId);
    if (!tier) throw new ValidationError('Unknown dispatch quest');

    const ids = Array.isArray(playerCardIds) ? playerCardIds : [];
    if (ids.length !== tier.cats) throw new ValidationError(`This mission needs exactly ${tier.cats} cat(s)`);
    if (new Set(ids).size !== ids.length) throw new ValidationError('A cat cannot be sent twice');

    const active = await rpgModel.getActiveDispatches(discordId);
    if (active.length >= dispatchCatalog.DISPATCH_SLOTS) throw new ValidationError('All dispatch slots are in use');

    const owned = await rpgModel.filterOwnedCardIds(discordId, ids);
    if (ids.some(id => !owned.has(id))) throw new ValidationError('You do not own one of those cats');

    const busy = await rpgModel.getBusyCardIds(discordId);
    if (ids.some(id => busy.has(id))) throw new ValidationError('One of those cats is already on a mission');

    // Combined stat check (sum of the derived stat across the selected cats).
    if (tier.statCheck) {
      const rows = await rpgModel.getCatRows(discordId);
      const byId = new Map(rows.map(r => [r.player_card_id, r]));
      let total = 0;
      for (const id of ids) {
        const row = byId.get(id);
        if (row) total += rpgStats.deriveStats(row, Number(row.level) || 1)[tier.statCheck.stat];
      }
      if (total < tier.statCheck.min) {
        throw new ValidationError(`Combined ${tier.statCheck.stat.toUpperCase()} ${total} is below the required ${tier.statCheck.min}`);
      }
    }

    const endsAt = new Date(Date.now() + tier.durationMin * 60000).toISOString();
    const dispatch = await withTransaction(async (client) => rpgModel.insertDispatch(discordId, questId, endsAt, ids, client));

    res.json({ success: true, dispatch: { id: dispatch.id, questId, endsAt: new Date(endsAt).getTime() } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/rpg/dispatch/:id/collect
 * Grants catnip + XP (split among the cats) once the mission has returned.
 * The `collected` flag is the idempotency guard.
 */
const collectDispatch = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const dispatchId = req.params.id;

    const rewards = await withTransaction(async (client) => {
      const d = await rpgModel.getDispatchForCollect(dispatchId, discordId, client);
      if (!d) throw new NotFoundError('Dispatch not found');
      if (d.collected) throw new ConflictError('Mission already collected');
      if (new Date(d.ends_at).getTime() > Date.now()) throw new ValidationError('Mission has not returned yet');

      const tier = dispatchCatalog.getTier(d.quest_id);
      const cardIds = d.card_ids || [];
      const xpEach = cardIds.length ? Math.floor(tier.xp / cardIds.length) : 0;

      const rows = await rpgModel.getCatRows(discordId, client);
      const byId = new Map(rows.map(r => [r.player_card_id, r]));
      const leveledUp = [];
      for (const id of cardIds) {
        const row = byId.get(id);
        if (!row) continue;
        const cat = { playerCardId: id, discordId, cardId: row.card_id, rarity: row.rarity, level: Number(row.level) || 1, xp: Number(row.xp) || 0 };
        const r = await rpgModel.grantXp(cat, xpEach, client);
        if (r.leveledUp) leveledUp.push({ playerCardId: id, level: r.level });
      }
      await cardModel.addCatnip(discordId, tier.catnip, client);
      await rpgModel.markDispatchCollected(dispatchId, client);

      return { catnip: tier.catnip, xpEach, leveledUp, injured: [] };
    });

    res.json({ success: true, rewards });
  } catch (error) {
    next(error);
  }
};

// ========== Daily quests ==========

/**
 * GET /api/rpg/daily
 * Three quests with progress computed from today's combat/dispatch activity.
 */
const getDaily = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { questDate, since, resetAt } = utcDayInfo();
    const [counts, claims] = await Promise.all([
      rpgModel.getDailyCounts(discordId, since),
      rpgModel.getDailyClaims(discordId, questDate),
    ]);
    const claimed = new Set(claims);
    const quests = dailyCatalog.DAILY_QUESTS.map(q => ({
      id: q.id,
      name: q.name,
      icon: q.icon,
      goal: q.goal,
      progress: Math.min(q.goal, counts[q.metric] || 0),
      claimed: claimed.has(q.id),
      catnip: q.catnip,
    }));
    res.json({
      success: true,
      resetAt,
      quests,
      allClaimed: dailyCatalog.DAILY_QUESTS.every(q => claimed.has(q.id)),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/rpg/daily/:id/claim
 * Claims a completed daily quest (idempotent per UTC day). Completing all three
 * grants a bonus catnip payout.
 */
const claimDaily = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const questId = req.params.id;
    const quest = dailyCatalog.getQuest(questId);
    if (!quest) throw new ValidationError('Unknown daily quest');

    const { questDate, since } = utcDayInfo();
    const counts = await rpgModel.getDailyCounts(discordId, since);
    if ((counts[quest.metric] || 0) < quest.goal) throw new ValidationError('Quest not complete yet');

    const result = await withTransaction(async (client) => {
      const first = await rpgModel.tryClaimDaily(discordId, questDate, questId, client);
      if (!first) throw new ConflictError('Already claimed today');
      let balance = await cardModel.addCatnip(discordId, quest.catnip, client);

      // All-three bonus, guarded by a synthetic claim id so it pays once.
      const claims = await rpgModel.getDailyClaims(discordId, questDate, client);
      const allDone = dailyCatalog.DAILY_QUESTS.every(q => claims.includes(q.id));
      let bonus = 0;
      if (allDone && await rpgModel.tryClaimDaily(discordId, questDate, '__all_done__', client)) {
        bonus = dailyCatalog.ALL_DONE_BONUS.catnip;
        balance = await cardModel.addCatnip(discordId, bonus, client);
      }
      return { catnip: quest.catnip, bonus, balance };
    });

    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCats,
  getParty,
  setParty,
  startCombat,
  getStory,
  getDispatch,
  acceptDispatch,
  collectDispatch,
  getDaily,
  claimDaily,
};
