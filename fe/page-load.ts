import { startPageLoadTelemetry } from './lib/page-load';

try { startPageLoadTelemetry(); } catch { /* Loading the workspace never depends on diagnostics. */ }
