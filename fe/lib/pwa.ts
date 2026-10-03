export function registerPwa() {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return;

  const register = async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      let lastChecked = Date.now();
      const checkForUpdate = () => {
        if (document.visibilityState !== 'visible' || !navigator.onLine || Date.now() - lastChecked < 60 * 60 * 1000) return;
        lastChecked = Date.now();
        void registration.update().catch(() => {});
      };
      window.addEventListener('online', checkForUpdate);
      document.addEventListener('visibilitychange', checkForUpdate);
    } catch (error) {
      console.warn('CoCell PWA registration failed', error);
    }
  };

  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}
