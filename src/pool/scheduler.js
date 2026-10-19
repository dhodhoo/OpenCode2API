/**
 * Health-aware selection across proxy-pool backend entries.
 *
 * The scheduler owns no I/O: it tracks per-entry health and in-flight counts,
 * and answers "which backend should serve this request". Callers report the
 * outcome with markSuccess/markFailure so a dead egress path (relay returning
 * 5xx, proxy timing out) is skipped for a cooldown instead of being retried
 * forever.
 */

export const POOL_STRATEGIES = Object.freeze(['round-robin', 'least-connections']);

const DEFAULT_FAILURE_COOLDOWN_MS = 30 * 1000;
const MAX_COOLDOWN_MULTIPLIER = 6;

export function createPoolScheduler(entries, options = {}) {
    const strategy = POOL_STRATEGIES.includes(options.strategy) ? options.strategy : 'round-robin';
    const failureCooldownMs = Number(options.failureCooldownMs) > 0
        ? Number(options.failureCooldownMs)
        : DEFAULT_FAILURE_COOLDOWN_MS;

    const states = new Map();
    entries.forEach((entry) => {
        states.set(entry.id, {
            entry,
            status: 'unknown',
            failures: 0,
            cooldownUntil: 0,
            inFlight: 0,
            totalRequests: 0,
            totalFailures: 0,
            lastUsedAt: null,
            lastError: null
        });
    });

    let cursor = 0;

    const stateOf = (entryOrId) => {
        const id = typeof entryOrId === 'string' ? entryOrId : entryOrId?.id;
        return id ? states.get(id) || null : null;
    };

    const isEligible = (state) => {
        if (!state) return false;
        if (state.status !== 'unhealthy') return true;
        return Date.now() >= state.cooldownUntil;
    };

    const pickByStrategy = (candidates) => {
        if (candidates.length === 0) return null;
        if (strategy === 'least-connections') {
            let best = candidates[0];
            for (const state of candidates) {
                if (state.inFlight < best.inFlight) best = state;
            }
            return best;
        }
        // Round-robin: advance past entries already visited.
        for (let i = 0; i < entries.length; i += 1) {
            const index = (cursor + i) % entries.length;
            const state = states.get(entries[index].id);
            if (candidates.includes(state)) {
                cursor = (index + 1) % entries.length;
                return state;
            }
        }
        return candidates[0];
    };

    return {
        strategy,
        entries,

        /**
         * Pick a backend. An affinity hit (the conversation already lives on
         * that backend) wins as long as the entry is eligible; otherwise the
         * strategy picks among eligible entries not in `exclude`.
         */
        select({ affinityId = null, exclude = [] } = {}) {
            const excluded = new Set(exclude);
            const affinityState = affinityId ? stateOf(affinityId) : null;
            if (affinityState && !excluded.has(affinityState.entry.id) && isEligible(affinityState)) {
                return affinityState.entry;
            }
            const candidates = [];
            for (const entry of entries) {
                if (excluded.has(entry.id)) continue;
                const state = states.get(entry.id);
                if (isEligible(state)) candidates.push(state);
            }
            const picked = pickByStrategy(candidates);
            return picked ? picked.entry : null;
        },

        acquire(entry) {
            const state = stateOf(entry);
            if (!state) return;
            state.inFlight += 1;
            state.totalRequests += 1;
            state.lastUsedAt = Date.now();
        },

        release(entry) {
            const state = stateOf(entry);
            if (!state) return;
            state.inFlight = Math.max(0, state.inFlight - 1);
        },

        markSuccess(entry) {
            const state = stateOf(entry);
            if (!state) return;
            state.status = 'healthy';
            state.failures = 0;
            state.cooldownUntil = 0;
            state.lastError = null;
        },

        markFailure(entry, error) {
            const state = stateOf(entry);
            if (!state) return;
            state.status = 'unhealthy';
            state.failures += 1;
            state.totalFailures += 1;
            state.lastError = error?.message || String(error || 'unknown error');
            const multiplier = Math.min(state.failures, MAX_COOLDOWN_MULTIPLIER);
            state.cooldownUntil = Date.now() + failureCooldownMs * multiplier;
        },

        isEligible,

        snapshot() {
            return entries.map((entry) => {
                const state = states.get(entry.id);
                return {
                    id: entry.id,
                    name: entry.name,
                    type: entry.type,
                    serverUrl: entry.serverUrl,
                    status: state.status,
                    eligible: isEligible(state),
                    inFlight: state.inFlight,
                    totalRequests: state.totalRequests,
                    totalFailures: state.totalFailures,
                    lastUsedAt: state.lastUsedAt,
                    lastError: state.lastError
                };
            });
        }
    };
}
