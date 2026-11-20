export type PiAgentError =
  | 'INVALID_REQUEST'
  | 'CONFIG_REQUIRED'
  | 'DIRECTORY_UNAVAILABLE'
  | 'PI_UNAVAILABLE'
  | 'ALREADY_RUNNING'
  | 'PROTOCOL_ERROR'
  | 'RUNTIME_ERROR'
  | 'EMPTY_RESULT'
  | 'STORAGE_ERROR'
  | 'INTERACTION_REQUIRED'
  | 'NOT_AVAILABLE';

export type PiAgentReply<T> = { ok: true; data: T } | { ok: false; error: PiAgentError };

export interface PiProjectConfig {
  enabled: boolean;
  /** Device-local opt-in; missing in older files means notifications are off. */
  notifyOnImport?: boolean;
  workingDirectory: string;
  executable: string;
  model: string;
  prompt: string;
}

export const DEFAULT_PI_PROMPT = `Analyze this CTeam work item: {{issueUrl}}
Super Productivity Task ID: {{taskId}}

Follow the AGENTS.md instructions in your working directory.
Use the locally installed CWLink to read the work item, then analyze the relevant code.
Use CWLink read-only: do not comment, transition, or otherwise change CTeam.
Return your analysis as Markdown, organized as you think appropriate.
If the work item or code cannot be read, explain what is missing instead of inventing an analysis.`;

export const DEFAULT_PI_PROJECT_CONFIG: PiProjectConfig = {
  enabled: false,
  notifyOnImport: false,
  workingDirectory: '',
  executable: 'pi',
  model: '',
  prompt: DEFAULT_PI_PROMPT,
};

export interface PiAnalysisRequest {
  taskId: string;
  projectId: string;
  issueUrl: string;
  instruction: string;
  newSession: boolean;
}

export type PiRunStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';

export interface PiAnalysisRun {
  id: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  /** Missing on older runs, whose sessions remain in the app's local directory. */
  sessionStorage?: 'pi-default';
  workingDirectory: string;
  status: PiRunStatus;
  startedAt: number;
  finishedAt?: number;
  issueUrl: string;
  prompt: string;
  markdown: string;
  error?: PiAgentError;
}

export interface PiTaskAnalysis {
  taskId: string;
  runs: PiAnalysisRun[];
}

export interface PiAgentElectronApi {
  getConfig(projectId: string): Promise<PiAgentReply<PiProjectConfig>>;
  saveConfig(
    projectId: string,
    config: PiProjectConfig,
  ): Promise<PiAgentReply<PiProjectConfig>>;
  getTask(taskId: string): Promise<PiAgentReply<PiTaskAnalysis>>;
  getResumeCommand(taskId: string, runId: string): Promise<PiAgentReply<string>>;
  start(request: PiAnalysisRequest): Promise<PiAgentReply<PiTaskAnalysis>>;
  stop(taskId: string): Promise<PiAgentReply<PiTaskAnalysis>>;
  onUpdate(listener: (state: PiTaskAnalysis) => void): () => void;
}
