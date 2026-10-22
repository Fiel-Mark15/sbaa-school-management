import { ref } from 'vue';

export const connectingToPortal = ref(false);

export function isTemporaryConnectionFailure(error) {
  if (error?.code === 'ERR_CANCELED') return false;
  if ([502, 503, 504].includes(error?.response?.status)) return true;
  return !error?.response && ['ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK'].includes(error?.code);
}

export async function pollPortalHealth(probe, {
  durationMs = 60_000,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + durationMs;
  let attempts = 0;
  while (now() < deadline) {
    attempts += 1;
    try {
      await probe(Math.min(15_000, Math.max(1, deadline - now())));
      return;
    } catch (error) {
      if (!isTemporaryConnectionFailure(error) || now() >= deadline) throw error;
      const delay = Math.min(attempts * 2_000, 12_000, deadline - now());
      if (delay > 0) await sleep(delay);
    }
  }
  throw Object.assign(new Error('The school portal is not responding yet.'), { code: 'PORTAL_UNAVAILABLE' });
}

let pendingProbe;
export function waitForPortal(probe) {
  if (!pendingProbe) {
    connectingToPortal.value = true;
    pendingProbe = pollPortalHealth(probe).finally(() => {
      pendingProbe = null;
      connectingToPortal.value = false;
    });
  }
  return pendingProbe;
}
