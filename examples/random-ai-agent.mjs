#!/usr/bin/env node
/**
 * Example AI agent for Control & Conquer using the REST API.
 *
 * Plays a full game autonomously:
 *  1. Creates a game session
 *  2. Picks a random valid spawn from availableSpawns
 *  3. Expands toward random frontier tiles each tick
 *  4. Proposes alliances with other surviving players
 *  5. Exits when the match ends
 *
 * Usage:
 *   node examples/random-ai-agent.mjs [base-url] [map-id] [difficulty]
 *
 * Examples:
 *   node examples/random-ai-agent.mjs
 *   node examples/random-ai-agent.mjs http://localhost:3000 earth-standard hard
 */

const BASE_URL = process.argv[2] ?? "http://localhost:3000";
const MAP_ID = process.argv[3] ?? "earth-standard";
const DIFFICULTY = process.argv[4] ?? "medium";

const POLL_MS = 500;          // how often to poll game state
const EXPAND_FRACTION = 0.5;  // fraction of troops to send per expand
const LOG_EVERY = 10;         // log every N polls

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  console.log(`Connecting to ${BASE_URL} — map: ${MAP_ID}, difficulty: ${DIFFICULTY}`);

  // 1. Create game session
  const { gameId } = await api("POST", "/api/games", {
    mapId: MAP_ID,
    difficulty: DIFFICULTY,
    botCount: 6,
    playerName: "AIAgent",
    autoSpawn: false,
  });
  console.log(`Game created: ${gameId}`);

  let polls = 0;
  let spawned = false;
  let allianceAttempted = new Set();

  while (true) {
    await sleep(POLL_MS);
    polls++;

    let state;
    try {
      state = await api("GET", `/api/games/${gameId}`);
    } catch (e) {
      console.error("State fetch failed:", e.message);
      continue;
    }

    if (polls % LOG_EVERY === 0 || state.matchEnded) {
      const me = state.me;
      console.log(
        `[tick=${state.tick} phase=${state.phase}]`,
        me
          ? `tiles=${me.tiles} troops=${me.troops} gold=${me.gold}`
          : "not spawned",
        `frontier=${state.frontier.length}`,
      );
    }

    // Match over
    if (state.matchEnded) {
      const winner = state.players.find((p) => p.playerId === state.winner);
      if (winner && winner.playerId === state.playerId) {
        console.log("Victory!");
      } else if (winner) {
        console.log(`Match ended — winner: ${winner.name}`);
      } else {
        console.log("Match ended.");
      }
      break;
    }

    // Spawn phase — pick a spawn position
    if (state.phase === "spawn" && !spawned) {
      if (state.availableSpawns.length > 0) {
        const spawn = pick(state.availableSpawns);
        try {
          await api("POST", `/api/games/${gameId}/spawn`, { x: spawn.x, y: spawn.y });
          console.log(`Spawned at (${spawn.x}, ${spawn.y})`);
          spawned = true;
        } catch (e) {
          console.warn("Spawn failed:", e.message);
        }
      }
      continue;
    }

    // Playing phase
    if (state.phase !== "playing" || !state.me) continue;

    // Try to expand toward a random frontier tile
    if (state.frontier.length > 0) {
      const target = pick(state.frontier);
      try {
        await api("POST", `/api/games/${gameId}/expand`, {
          targetX: target.x,
          targetY: target.y,
          percent: Math.round(EXPAND_FRACTION * 100),
        });
      } catch {
        // expand rejections are normal (cooldowns, etc.)
      }
    }

    // Propose alliance with a random other surviving player we haven't tried
    const others = state.players.filter(
      (p) =>
        p.playerId !== state.playerId &&
        !p.eliminated &&
        !allianceAttempted.has(p.playerId) &&
        !state.alliances.some(
          (a) =>
            (a[0] === state.playerId && a[1] === p.playerId) ||
            (a[1] === state.playerId && a[0] === p.playerId),
        ),
    );
    if (others.length > 0 && Math.random() < 0.05) {
      const partner = pick(others);
      allianceAttempted.add(partner.playerId);
      try {
        await api("POST", `/api/games/${gameId}/ally`, {
          action: "propose",
          targetPlayerId: partner.playerId,
        });
      } catch {
        // alliance proposals can be rejected silently
      }
    }

    // Accept any incoming alliance requests
    for (const req of state.allianceRequests ?? []) {
      if (req.to === state.playerId) {
        try {
          await api("POST", `/api/games/${gameId}/ally`, {
            action: "respond",
            targetPlayerId: req.from,
            accept: true,
          });
          console.log(`Accepted alliance from player ${req.from}`);
        } catch {
          // ignore
        }
      }
    }
  }

  // Clean up
  try {
    await api("DELETE", `/api/games/${gameId}`);
  } catch {
    // session may already be cleaned up
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
