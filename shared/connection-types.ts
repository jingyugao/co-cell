export interface ConnectionInventory {
  configured: boolean;
  importedAt: string | null;
  scope: 'all-projects';
  connections: Array<{ id: string; type: 'mysql' | 'glab' | 'git' | 'lark' | 'meegle' | 'kubernetes'; name: string; host?: string; username?: string; note?: string }>;
  verification?: { checkedAt: string; results: Array<{ id: string; ok: boolean; message: string }> };
}
