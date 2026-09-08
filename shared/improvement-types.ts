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
export interface ImprovementProposal extends ImprovementInput, ImprovementContext {
  id: string;
  createdAt: string;
  status: 'pending';
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
  status: 'pending';
  duplicate: boolean;
}
