const { withTransaction } = require('../config/database');
const rpgModel = require('../models/rpg.model');
const cardModel = require('../models/card.model');
const rpgStats = require('../utils/rpgStats');
const storyCatalog = require('../utils/rpgStoryCatalog');
const { simulateBattle } = require('../services/rpg-combat.service');
const logger = require('../utils/logger');
const { ValidationError } = require('../utils/errors');

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

module.exports = {
  getCats,
  getParty,
  setParty,
  startCombat,
  getStory,
};
