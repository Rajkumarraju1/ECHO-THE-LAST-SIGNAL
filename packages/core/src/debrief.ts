import type { EchoDebrief, MatchState } from "./types.js";

/**
 * Every lead the final Echo decision and the debrief track, by evidence id.
 * The debrief names leads the crew never confirmed as gaps — it never
 * reveals what an unconfirmed lead would have said.
 */
export const LEAD_TITLES: Record<string, string> = {
  "signal-array-readout": "The K-7 signal phase",
  "power-relay-readout": "The K-7 load trace",
  "signal-origin-readout": "The origin triangulation",
  "vital-pattern-readout": "The impossible vital pattern",
  "echo-pulse-log": "The Echo pulse log",
  "relay-containment-record": "The K-7 containment"
};

/** Every manifestation id the scenario can ever fire — used only to acknowledge gaps. */
export const MANIFESTATION_TITLES: Record<string, string> = {
  "manifestation-echo-band": "The band answered in your own voices",
  "manifestation-airlock": "The inner door cycled for nobody",
  "manifestation-duplicates": "The sensor net briefly showed two of everyone"
};

/** Every act the debrief acknowledges by name. */
export const ACT_TITLES: Record<number, string> = {
  1: "Act I — Functional",
  2: "Act II — Uneasy",
  3: "Act III — Wrong",
  4: "Act IV — Failing"
};

const CHOICE_LINES: Record<string, string> = {
  isolate: "The crew sealed the Echo band inside the isolation lattice and rode out the silence.",
  sever: "The crew cut the antenna feeds. The Last Signal went out mid-word.",
  amplify: "The crew answered the impossible call at full power, voice for voice.",
  follow: "The crew plotted the impossible route and burned the reserves to follow it."
};

export function debriefChoiceLine(choice: string): string {
  return CHOICE_LINES[choice] ?? "The crew made the call that could not be taken back.";
}

/** Shared debrief skeleton: filled by the scenario's outcome functions. */
export function makeDebrief(match: MatchState, choice: string, choiceLine: string, outcomeLines: string[]): EchoDebrief {
  const standing = Object.values(match.players).filter((player) => !player.incapacitated).length;
  const total = Object.keys(match.players).length;
  const confirmed = match.scenario.confirmedLeads.map((lead) => LEAD_TITLES[lead] ?? lead).filter((title): title is string => Boolean(title));
  const missed = Object.entries(LEAD_TITLES).filter(([lead]) => !match.scenario.confirmedLeads.includes(lead)).map(([, title]) => title);
  const manifestationMissed = Object.entries(MANIFESTATION_TITLES).filter(([id]) => !match.scenario.manifestationIds.includes(id)).map(([, title]) => title);
  if (manifestationMissed.length > 0) missed.push(...manifestationMissed);
  const conditions = Object.values(match.systems).map((system) => `${systemLabelOf(system.id)} ${system.condition} (${system.stability}%)`).join(", ");
  const reached = `The crew reached ${ACT_TITLES[match.scenario.act] ?? `act ${match.scenario.act}`} before the final call.`;
  return {
    title: "Debrief — The Impossible Distress Call",
    choiceLine,
    outcomeLines: [...outcomeLines, reached],
    confirmedLeads: confirmed,
    missedLeads: missed,
    stationLine: `Station condition: ${conditions}.`,
    crewLine: standing === total ? `All ${total} crew members finished the shift standing.` : `${standing} of ${total} crew members finished the shift standing.`
  };
}

function systemLabelOf(id: string): string {
  switch (id) {
    case "power": return "Power";
    case "lifeSupport": return "Life support";
    case "hull": return "Hull integrity";
    case "navigation": return "Navigation";
    default: return id;
  }
}
