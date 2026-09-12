export interface ImprovementInput {
  category: string;
  title: string;
  observation: string;
  proposal: string;
  expected_benefit: string;
}
export interface ImprovementContext {
  projectId: string | null;
  projectName: string | null;
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  sandboxId: string | null;
}
export const IMPROVEMENT_STATUSES = ['pending', 'deferred', 'completed'] as const;
export type ImprovementStatus = typeof IMPROVEMENT_STATUSES[number];
export interface ImprovementStatusChange {
  id: string;
  fromStatus: ImprovementStatus;
  toStatus: ImprovementStatus;
  note: string | null;
  createdAt: string;
}
export interface ImprovementProposal extends ImprovementInput, ImprovementContext {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ImprovementStatus;
  statusNote: string | null;
  /** Included by detail and status update endpoints; omitted from list results. */
  statusHistory?: ImprovementStatusChange[];
  sourceAvailable?: boolean;
}
export interface ImprovementPage {
  items: ImprovementProposal[];
  total: number;
  categories: string[];
  projects: Array<{ id: string; name: string }>;
}
export interface ImprovementReceipt {
  id: string;
  status: ImprovementStatus;
  duplicate: boolean;
}
