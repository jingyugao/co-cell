import type { Settings } from '../../../protocol/types';

export function effectiveSettings(settings: Settings): Settings {
  return settings.executionMode === 'e2b' ? { ...settings, sandboxMode: 'danger-full-access', networkAccessEnabled: true } : settings;
}
