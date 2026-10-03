import { useEffect, useRef, useSyncExternalStore } from 'react';

const mobileQuery = '(max-width: 700px)';
const subscribeMobile = (notify: () => void) => {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};

export function useMobileLayout() {
  return useSyncExternalStore(subscribeMobile, () => window.matchMedia(mobileQuery).matches, () => false);
}

// Safari keeps the layout viewport tall when the software keyboard is open.
export function useMobileViewport() {
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const mobile = window.matchMedia(mobileQuery);
    const update = () => {
      if (!shell.current || viewport.scale !== 1) return;
      if (mobile.matches) {
        shell.current.style.setProperty('--mobile-viewport-height', `${viewport.height}px`);
        shell.current.style.setProperty('--mobile-viewport-top', `${viewport.offsetTop}px`);
      } else {
        shell.current.style.removeProperty('--mobile-viewport-height');
        shell.current.style.removeProperty('--mobile-viewport-top');
      }
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    mobile.addEventListener('change', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      mobile.removeEventListener('change', update);
    };
  }, []);
  return shell;
}
