#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ─── Keys & TTLs ──────────────────────────────────────────────
const CANONICAL_KEY = 'theater-posture:sebuf:v1';
const STALE_KEY = 'theater_posture:sebuf:stale:v1';
const BACKUP_KEY = 'theater-posture:sebuf:backup:v1';

const CACHE_TTL = 1200;    // 20 min — must outlive the 10-min cron interval (2x)
const STALE_TTL = 86400;   // 24h
const BACKUP_TTL = 604800; // 7d

// ─── Theater definitions (mirrors ais-relay.cjs POSTURE_THEATERS) ─
const POSTURE_THEATERS = [
  { id: 'iran-theater', bounds: { north: 42, south: 20, east: 65, west: 30 }, thresholds: { elevated: 8, critical: 20 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 } },
  { id: 'taiwan-theater', bounds: { north: 30, south: 18, east: 130, west: 115 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'baltic-theater', bounds: { north: 65, south: 52, east: 32, west: 10 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'blacksea-theater', bounds: { north: 48, south: 40, east: 42, west: 26 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'korea-theater', bounds: { north: 43, south: 33, east: 132, west: 124 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'south-china-sea', bounds: { north: 25, south: 5, east: 121, west: 105 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'east-med-theater', bounds: { north: 37, south: 33, east: 37, west: 25 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'israel-gaza-theater', bounds: { north: 33, south: 29, east: 36, west: 33 }, thresholds: { elevated: 3, critical: 8 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'yemen-redsea-theater', bounds: { north: 22, south: 11, east: 54, west: 32 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
];

// ─── Military callsign detection (mirrors ais-relay.cjs) ────────
const THEATER_MIL_PREFIXES = [
  'RCH', 'REACH', 'MOOSE', 'EVAC', 'DUSTOFF', 'PEDRO',
  'DUKE', 'HAVOC', 'KNIFE', 'WARHAWK', 'VIPER', 'RAGE', 'FURY',
  'SHELL', 'TEXACO', 'ARCO', 'ESSO', 'PETRO',
  'SENTRY', 'AWACS', 'MAGIC', 'DISCO', 'DARKSTAR',
  'COBRA', 'PYTHON', 'RAPTOR', 'EAGLE', 'HAWK', 'TALON',
  'BOXER', 'OMNI', 'TOPCAT', 'SKULL', 'REAPER', 'HUNTER',
  'ARMY', 'NAVY', 'USAF', 'USMC', 'USCG',
  'CNV', 'EXEC',
  'NATO', 'GAF', 'RRF', 'RAF', 'FAF', 'IAF', 'RNLAF', 'BAF', 'DAF', 'HAF', 'PAF',
  'SWORD', 'LANCE', 'ARROW', 'SPARTAN',
  'RSAF', 'EMIRI', 'UAEAF', 'KAF', 'QAF', 'BAHAF', 'OMAAF',
  'IRIAF', 'IRGC',
  'TUAF',
  'RSD', 'RFF', 'VKS',
  'CHN', 'PLAAF', 'PLA',
];
const THEATER_MIL_SHORT_PREFIXES = ['AE', 'RF', 'TF', 'PAT', 'SAM', 'OPS', 'CTF', 'IRG', 'TAF'];
const THEATER_AIRLINE_CODES = new Set([
  'SVA', 'QTR', 'THY', 'UAE', 'ETD', 'GFA', 'MEA', 'RJA', 'KAC', 'ELY',
  'IAW', 'IRA', 'MSR', 'SYR', 'PGT', 'AXB', 'FDB', 'KNE', 'FAD', 'ADY', 'OMA',
  'ABQ', 'ABY', 'NIA', 'FJA', 'SWR', 'HZA', 'OMS', 'EGF', 'NOS', 'SXD',
]);

function theaterIsMilCallsign(callsign) {
  if (!callsign) return false;
  const cs = callsign.toUpperCase().trim();
  for (const prefix of THEATER_MIL_PREFIXES) {
    if (cs.startsWith(prefix)) return true;
  }
  for (const prefix of THEATER_MIL_SHORT_PREFIXES) {
    if (cs.startsWith(prefix) && cs.length > prefix.length && /\d/.test(cs.charAt(prefix.length))) return true;
  }
  if (/^[A-Z]{3}\d{1,2}$/.test(cs)) {
    const prefix = cs.slice(0, 3);
    if (!THEATER_AIRLINE_CODES.has(prefix)) return true;
  }
  return false;
}

function theaterDetectAircraftType(callsign) {
  if (!callsign) return 'unknown';
  const cs = callsign.toUpperCase().trim();
  if (/^(SHELL|TEXACO|ARCO|ESSO|PETRO|KC|STRAT)/.test(cs)) return 'tanker';
  if (/^(SENTRY|AWACS|MAGIC|DISCO|DARKSTAR|E3|E8|E6)/.test(cs)) return 'awacs';
  if (/^(RCH|REACH|MOOSE|EVAC|DUSTOFF|C17|C5|C130|C40)/.test(cs)) return 'transport';
  if (/^(HOMER|OLIVE|JAKE|PSEUDO|GORDO|RC|U2|SR)/.test(cs)) return 'reconnaissance';
  if (/^(RQ|MQ|REAPER|PREDATOR|GLOBAL)/.test(cs)) return 'drone';
  if (/^(DEATH|BONE|DOOM|B52|B1|B2)/.test(cs)) return 'bomber';
  if (/^(BOLT|VIPER|RAPTOR|BRONCO|EAGLE|HORNET|FALCON|STRIKE|TANGO|FURY)/.test(cs)) return 'fighter';
  return 'unknown';
}

// ─── Flight fetchers ────────────────────────────────────────────

async function fetchFromAdsbLol() {
  try {
    const resp = await fetch('https://api.adsb.lol/v2/mil', {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`[adsb.lol] API error: ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const aircraft = data.ac || [];
    const flights = [];
    const seenIds = new Set();
    for (const a of aircraft) {
      const lat = a.lat;
      const lon = a.lon;
      if (lat == null || lon == null) continue;
      if (a.alt_baro === 'ground') continue;
      const icao24 = (a.hex || '').trim().replace(/~/g, '');
      if (!icao24 || seenIds.has(icao24)) continue;
      const inTheater = POSTURE_THEATERS.some((t) =>
        lat >= t.bounds.south && lat <= t.bounds.north &&
        lon >= t.bounds.west && lon <= t.bounds.east
      );
      if (!inTheater) continue;
      seenIds.add(icao24);
      const callsign = (a.flight || '').trim();
      flights.push({
        id: icao24, callsign,
        lat, lon,
        altitude: typeof a.alt_baro === 'number' ? a.alt_baro : 0,
        heading: a.track || 0,
        speed: a.gs || 0,
        aircraftType: theaterDetectAircraftType(callsign),
      });
    }
    console.log(`[adsb.lol] Fetched ${flights.length} military flights in theater (${aircraft.length} global mil)`);
    return flights;
  } catch (err) {
    console.warn(`[adsb.lol] Fetch failed: ${err?.message || err}`);
    return null;
  }
}

const WINGBITS_MAX_BOX_NM = 2000;

async function fetchFromWingbits() {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) {
    console.warn('[Wingbits] WINGBITS_API_KEY not set — skipped');
    return null;
  }
  const areas = POSTURE_THEATERS.map((t) => ({
    alias: t.id,
    by: 'box',
    la: (t.bounds.north + t.bounds.south) / 2,
    lo: (t.bounds.east + t.bounds.west) / 2,
    w: Math.min(Math.abs(t.bounds.east - t.bounds.west) * 60, WINGBITS_MAX_BOX_NM),
    h: Math.min(Math.abs(t.bounds.north - t.bounds.south) * 60, WINGBITS_MAX_BOX_NM),
    unit: 'nm',
  }));
  try {
    const resp = await fetch('https://customer-api.wingbits.com/v1/flights', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      body: JSON.stringify(areas),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.warn(`[Wingbits] API error: ${resp.status} ${resp.statusText} — ${errBody.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json();
    const flights = [];
    const seenIds = new Set();
    for (const areaResult of data) {
      const flightList = Array.isArray(areaResult.data) ? areaResult.data
        : Array.isArray(areaResult.flights) ? areaResult.flights
        : Array.isArray(areaResult) ? areaResult : [];
      for (const f of flightList) {
        const icao24 = f.h || f.icao24 || f.id;
        if (!icao24 || seenIds.has(icao24)) continue;
        seenIds.add(icao24);
        const callsign = (f.f || f.callsign || f.flight || '').trim();
        if (!theaterIsMilCallsign(callsign)) continue;
        flights.push({
          id: icao24, callsign,
          lat: f.la || f.latitude || f.lat,
          lon: f.lo || f.longitude || f.lon || f.lng,
          altitude: f.ab || f.altitude || f.alt || 0,
          heading: f.th || f.heading || f.track || 0,
          speed: f.gs || f.groundSpeed || f.speed || f.velocity || 0,
          aircraftType: theaterDetectAircraftType(callsign),
        });
      }
    }
    console.log(`[Wingbits] Fetched ${flights.length} military flights from ${data.length} areas`);
    return flights;
  } catch (err) {
    console.warn(`[Wingbits] Fetch failed: ${err?.message || err}`);
    return null;
  }
}

// ─── Posture calculation ────────────────────────────────────────

// Standalone script: vessel counting from the relay's in-memory AIS feed is
// unavailable. Set trackedVessels to 0; flight-only posture is the primary
// signal for GitHub Actions runs. The relay's own seed loop retains full
// vessel-aware posture when running on Railway.
function countMilitaryVesselsInBounds(_bounds) {
  return 0;
}

function calculateTheaterPostures(flights) {
  return POSTURE_THEATERS.map((theater) => {
    const tf = flights.filter(
      (f) => f.lat >= theater.bounds.south && f.lat <= theater.bounds.north &&
        f.lon >= theater.bounds.west && f.lon <= theater.bounds.east,
    );
    const total = tf.length;
    const tankers = tf.filter((f) => f.aircraftType === 'tanker').length;
    const awacs = tf.filter((f) => f.aircraftType === 'awacs').length;
    const fighters = tf.filter((f) => f.aircraftType === 'fighter').length;
    const vesselCount = countMilitaryVesselsInBounds(theater.bounds);
    const vesselContribution = Math.min(vesselCount, Math.floor(theater.thresholds.elevated / 2));
    const combinedActivity = total + vesselContribution;
    const postureLevel = combinedActivity >= theater.thresholds.critical ? 'critical'
      : combinedActivity >= theater.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable = tankers >= theater.strikeIndicators.minTankers &&
      awacs >= theater.strikeIndicators.minAwacs && fighters >= theater.strikeIndicators.minFighters;
    const ops = [];
    if (strikeCapable) ops.push('strike_capable');
    if (tankers > 0) ops.push('aerial_refueling');
    if (awacs > 0) ops.push('airborne_early_warning');
    if (vesselCount > 0) ops.push('naval_presence');
    return {
      theater: theater.id, postureLevel, activeFlights: total,
      trackedVessels: vesselCount, activeOperations: ops, assessedAt: Date.now(),
    };
  });
}

// ─── Main fetch function ────────────────────────────────────────

async function fetchTheaterPosture() {
  let flights = [];
  const adsbLol = await fetchFromAdsbLol();
  if (adsbLol !== null) {
    flights = adsbLol;
  } else {
    const wb = await fetchFromWingbits();
    if (wb && wb.length > 0) flights = wb;
  }
  if (flights.length === 0) {
    console.warn('[TheaterPosture] No military flights from adsb.lol or Wingbits — continuing with vessel-only posture');
  }

  const theaters = calculateTheaterPostures(flights);
  const elevated = theaters.filter((t) => t.postureLevel !== 'normal').length;
  console.log(`  ${flights.length} mil flights, ${theaters.length} theaters (${elevated} elevated)`);
  return { theaters };
}

function validate(data) {
  return Array.isArray(data?.theaters) && data.theaters.length > 0;
}

function declareRecords(data) {
  return Array.isArray(data?.theaters) ? data.theaters.length : 0;
}

// ─── Publish extra keys (stale + backup mirrors) ────────────────

async function afterPublish(data, meta) {
  const recordCount = meta?.recordCount ?? (Array.isArray(data?.theaters) ? data.theaters.length : 0);
  const envelopeMeta = { fetchedAt: Date.now(), recordCount, sourceVersion: 'theater-posture', schemaVersion: 1, state: 'OK' };
  await writeExtraKey(STALE_KEY, data, STALE_TTL, envelopeMeta)
    .catch((e) => console.warn(`  stale key write failed: ${e.message}`));
  await writeExtraKey(BACKUP_KEY, data, BACKUP_TTL, envelopeMeta)
    .catch((e) => console.warn(`  backup key write failed: ${e.message}`));
}

// ─── Entry point ────────────────────────────────────────────────

runSeed('theater-posture', 'sebuf', CANONICAL_KEY, fetchTheaterPosture, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'theater-posture',
  afterPublish,
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 30,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
