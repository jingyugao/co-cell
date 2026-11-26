export interface RemoteSkill {
  name: string;
  repository: string;
  ref: string;
  directory: string;
  commit: string;
}
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  revision: string;
  remoteSkills: RemoteSkill[];
}
