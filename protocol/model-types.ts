export type ModelProtocol = 'responses' | 'anthropic-messages';
export type ModelAuthMode = 'api-key' | 'bearer';
export interface ClaudeModelAliases { haiku?: string; sonnet?: string; opus?: string }

/** A model option is identified by its channel and upstream model, never its label. */
export interface ManagedModel { id: string; model: string; visible: boolean }
export interface ModelChannel { id: string; name: string; endpoint: string; protocol?: ModelProtocol; authMode?: ModelAuthMode; claudeModelAliases?: ClaudeModelAliases; enabled: boolean; hasApiKey: boolean; models: ManagedModel[] }
export interface ModelCatalog { revision: number; defaultModelId: string | null; claudeDefaultModelId?: string | null; channels: ModelChannel[] }
export interface ModelChannelInput { id: string; name: string; endpoint: string; protocol?: ModelProtocol; authMode?: ModelAuthMode; claudeModelAliases?: ClaudeModelAliases; enabled: boolean; apiKey?: string; models: ManagedModel[] }
export interface ModelCatalogInput { revision: number; defaultModelId: string | null; claudeDefaultModelId?: string | null; channels: ModelChannelInput[] }
export interface ModelOption { id: string; model: string; channelId: string; channelName: string; label: string }
