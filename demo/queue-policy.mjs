/**
 * MoFlux local admission queue policy used by the licensed benchmark arm.
 *
 * Queue capacity is granted by Latchflo so managed state remains authoritative.
 * Queue timeout remains Tyr construction-time behavior and is pinned in the
 * replica YAML. Interactive gets one short waiter per replica; batch remains
 * fail-fast so queueing cannot consume or obscure its protected floor.
 */
export const MOFLUX_QUEUE_POLICY = Object.freeze({
  "sim-interactive": Object.freeze({ maxQueuePerAgent: 1, queueTimeoutMs: 750 }),
  "sim-batch": Object.freeze({ maxQueuePerAgent: 0 }),
});

export function maxQueuePerAgentForPool(poolName) {
  return MOFLUX_QUEUE_POLICY[poolName]?.maxQueuePerAgent ?? 0;
}
