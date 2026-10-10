/** A model option is identified by its channel and upstream model, never its label. */
export interface ManagedModel { id: string; model: string; visible: boolean }
export interface ModelChannel { id: string; name: string; endpoint: string; enabled: boolean; hasApiKey: boolean; models: ManagedModel[] }
export interface ModelCatalog { revision: number; defaultModelId: string | null; channels: ModelChannel[] }
export interface ModelChannelInput { id: string; name: string; endpoint: string; enabled: boolean; apiKey?: string; models: ManagedModel[] }
export interface ModelCatalogInput { revision: number; defaultModelId: string | null; channels: ModelChannelInput[] }
export interface ModelOption { id: string; model: string; channelId: string; channelName: string; label: string }
