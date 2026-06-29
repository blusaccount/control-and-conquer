import { chromium } from 'playwright';

const SCRATCHPAD = '/tmp/claude-0/-home-user-control-and-conquer/656099db-947c-5807-8a39-73402352bf4a/scratchpad';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// Collect WS messages
const gameSnapshots = [];
page.on('websocket', ws => {
  ws.on('framereceived', frame => {
    try {
      const msg = JSON.parse(frame.payload);
      if (msg.type === 'SERVER_RASTER_SNAPSHOT') {
        const s = msg.payload;
        gameSnapshots.push({
          tick: s.tick,
          players: s.players.map(p => ({ name: p.name, troops: p.troops, tiles: p.tiles })),
          winner: s.winnerPlayerId,
          events: s.recentEvents?.slice(0, 3) ?? [],
        });
      }
    } catch {}
  });
});

await page.goto('http://localhost:3001/');
console.log('Startbildschirm geladen');
await page.screenshot({ path: `${SCRATCHPAD}/01_start.png` });

// Click "Play vs Bot"
await page.click('text=Play vs Bot');
console.log('"Play vs Bot" geklickt — warte auf Spielstart…');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${SCRATCHPAD}/02_ingame_2s.png` });

// Play for 45 seconds, clicking on the map periodically to expand
const GAME_DURATION_MS = 45000;
const CLICK_INTERVAL_MS = 3000;
const clicks = [
  { x: 900, y: 400 }, { x: 1000, y: 300 }, { x: 850, y: 500 },
  { x: 950, y: 350 }, { x: 1050, y: 450 }, { x: 800, y: 400 },
  { x: 750, y: 300 }, { x: 1100, y: 250 }, { x: 1000, y: 500 },
];
let clickIdx = 0;
const screenshotTimes = [5, 10, 20, 30, 45];
const screenshotPromises = screenshotTimes.map(t =>
  new Promise(resolve => setTimeout(async () => {
    await page.screenshot({ path: `${SCRATCHPAD}/game_${t}s.png` });
    console.log(`Screenshot bei ${t}s`);
    resolve();
  }, t * 1000))
);

const clickInterval = setInterval(async () => {
  const pos = clicks[clickIdx % clicks.length];
  clickIdx++;
  try { await page.mouse.click(pos.x, pos.y); } catch {}
}, CLICK_INTERVAL_MS);

await Promise.all([
  ...screenshotPromises,
  new Promise(r => setTimeout(r, GAME_DURATION_MS)),
]);
clearInterval(clickInterval);

await page.screenshot({ path: `${SCRATCHPAD}/03_final.png` });

// Read final DOM state
const domText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
console.log('\n--- DOM Endstand ---');
console.log(domText.replace(/\n{2,}/g, '\n'));

// Analyse snapshots
console.log('\n--- Spielverlauf (aus WebSocket) ---');
const sampled = gameSnapshots.filter((_, i, arr) => {
  const step = Math.max(1, Math.floor(arr.length / 8));
  return i % step === 0 || i === arr.length - 1;
});
for (const s of sampled) {
  const pline = s.players.map(p => `${p.name}: ${p.tiles}T ${p.troops}Tr`).join(' | ');
  console.log(`  Tick ${String(s.tick).padStart(4)}: ${pline}`);
}

const last = gameSnapshots[gameSnapshots.length - 1];
if (last) {
  console.log('\n--- Endstand ---');
  const sorted = [...last.players].sort((a, b) => b.tiles - a.tiles);
  const total = sorted.reduce((sum, p) => sum + p.tiles, 0) || 1;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    console.log(`  Platz ${i+1}: ${p.name}  ${p.tiles} Felder (${((p.tiles/total)*100).toFixed(1)}%)  ${p.troops} Truppen`);
  }
  if (last.winner !== null) {
    const winner = last.players.find(p => p.name.includes('Empire') || p.tiles === Math.max(...last.players.map(x=>x.tiles)));
    console.log(`\n  Gewinner-PlayerId: ${last.winner}`);
  } else {
    console.log(`\n  Noch kein Gewinner bei Tick ${last.tick}`);
  }
  console.log('\n--- Letzte Events ---');
  for (const e of last.events) console.log(`  • ${e}`);
} else {
  console.log('Keine WebSocket-Snapshots empfangen.');
}

console.log(`\nGesamt ${gameSnapshots.length} Snapshots empfangen.`);
await browser.close();
