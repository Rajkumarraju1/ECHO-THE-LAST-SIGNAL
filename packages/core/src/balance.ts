/**
 * ECHO: THE LAST SIGNAL — balance & pacing configuration.
 *
 * One home for every tunable constant. Two tiers live here:
 *
 *  - PRODUCTION values: the shipped first-scenario pacing. The default sweep
 *    interval is 60 seconds; the server entry point can still override it
 *    (ECHO_SWEEP_MS) so drills stay fast.
 *  - LAB DRILL values: the accelerated pacing used by laboratory rooms and the
 *    test harness. These never ship to a real scenario room; they exist so
 *    drills compress minutes into seconds without editing production numbers.
 *
 * Phase 5 (The Impossible Distress Call) tunes scenario pacing, act gating,
 * and Echo manifestation frequency from this file — it should not need to
 * touch engine code to do so.
 */

/** A crisis sweep is one "station clock" beat. Production pace: 60 seconds. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Stability lost per sweep while a system is not stable — always downwards. */
export const DETERIORATION_PER_SWEEP = 4;
/** Extra stability drain on dependents while a linked failure is active. */
export const LINKED_FAILURE_DRAIN = 2;
/** How long a failing system stays recoverable before it goes terminal. */
export const RECOVERY_WINDOW_MS = 60_000;
/** Strain limit per crew member; reaching it collapses them. */
export const STRAIN_LIMIT = 100;
export const STRAIN_PER_SWEEP = 2;
export const STRAIN_PER_ISOLATED_SWEEP = 6;
/** Strain gained per failed system per sweep — the synchronized crew drain. */
export const STRAIN_PER_FAILED_SYSTEM = 10;
/** Strain reduction from a Medical rescue on a collapsed crew member. */
export const RESCUE_STRAIN_REDUCTION = 35;
/** Extra strain cost of an emergency override on top of its resource cost. */
export const OVERRIDE_STRAIN_COST = 10;
/** How long a proposed quorum operation waits for confirmations before expiring. */
export const OPERATION_EXPIRY_MS = 30_000;
/** Delay to the next crisis pulse after every sweep. */
export const PULSE_DELAY_MS = 45_000;
/** Grid isolation duration and its stabilization amounts. */
export const ISOLATION_DURATION_MS = 90_000;
export const ISOLATION_POWER_RECOVERY = 10;
export const ISOLATION_RESONANCE_RELIEF = 8;
/** Resonance pressure thresholds (pressure 0–100). */
export const RESONANCE_CRITICAL_PRESSURE = 50;
export const RESONANCE_UNSTABLE_PRESSURE = 15;
/** Resonance pressure deltas: interference pulses push up, containment pulls down. */
export const RESONANCE_INTERFERENCE_PULSE = 6;
export const RESONANCE_SPIKE_INJECT = 30;
export const RELAY_CONTAINMENT_RESONANCE_RELIEF = 10;
/** Stability at or below this level telegraphs a critical warning. */
export const CRITICAL_THRESHOLD = 50;
/** Stability recovered per resource spent by a station procedure. */
export const PROCEDURE_POWER_RECOVERY = 18;
export const PROCEDURE_LIFE_SUPPORT_RECOVERY = 18;
export const PROCEDURE_HULL_RECOVERY = 15;
export const PROCEDURE_NAVIGATION_RECOVERY = 12;
/** Seed values applied when the station launches (the shared physical situation). */
export const SEED_POWER_STABILITY = 34;
export const SEED_RESONANCE_PRESSURE = 18;
/** Pulse damage per scheduled crisis pulse. */
export const SURGE_POWER_DAMAGE = 5;
export const STRAIN_PULSE_HULL_DAMAGE = 4;

/**
 * Resonance as strategic pressure. Echo engagement is a real cost center:
 *   - while resonance is critical, the power grid bleeds stability every sweep;
 *   - deliberate resonance operations trade it against other resources;
 *   - strong engineering mitigates this, but never erases it.
 */
/** Power stability lost per sweep while resonance sits at critical. */
export const RESONANCE_CRITICAL_POWER_DRAIN = 3;
/** Deep-listen: Communications studies the band — real lead, real pressure. */
export const DEEP_LISTEN_RESONANCE_PRESSURE = 14;
/** Pressure that vents harmlessly to space; the array cannot listen while venting. */
export const ECHO_VENT_DURATION_MS = 75_000;
export const ECHO_VENT_RESONANCE_RELIEF = 26;
export const ECHO_VENT_REPAIR_MATERIALS_COST = 1;

/**
 * The final Echo decision is a propose → co-authorize → execute sequence.
 * A proposal lapses visibly after this long without the domain seat's
 * co-authorization; nothing executes automatically on expiry.
 */
export const ECHO_DECISION_EXPIRY_MS = 45_000;

/**
 * Laboratory drill pacing. Lab rooms (room codes starting with "LAB") may
 * compress the production clock; scenario rooms never read these values.
 */
export const LAB_DRILL = {
  sweepIntervalMs: 20_000,
  /** Reserved for future lab-only acceleration of pulses and windows. */
  pulseDelayMs: 45_000
} as const;

/**
 * Scenario act pacing for Phase 5 (The Impossible Distress Call). Acts
 * advance on completed crisis sweeps; at the 60s production sweep this lands
 * the intended 20–25 minute match (a rushed run ~16min, a hard investigative
 * run 24–30min with maintenance pauses between pulses).
 */
export const SCENARIO_ACT_SWEEPS = {
  /** Act II — Uneasy: predicted failures begin occurring. */
  act2: 6,
  /** Act III — Wrong: Echo manifestations and hard-to-read evidence. */
  act3: 11,
  /** Act IV — Failing: the final Echo decision becomes available. */
  act4: 16
} as const;
