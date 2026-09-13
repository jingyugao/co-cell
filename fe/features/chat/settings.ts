import type { Settings } from '../../../protocol/types';

export function effectiveSettings(settings: Settings): Settings {
  return settings.executionMode === 'sandbox' ? { ...settings, sandboxMode: 'danger-full-access', networkAccessEnabled: true } : settings;
}
