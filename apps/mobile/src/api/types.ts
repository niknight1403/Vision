/** Response shapes of the endpoints the mobile client actually calls. */

export interface AuthTokenPair {
  tokenType: "Bearer";
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface Deal {
  id: string;
  providerId?: string;
  title: string;
  productUrl: string;
  currency: string;
  purchasePriceMinor: string;
  totalCostCents: string;
  expectedProfitCents: string;
  simulated: boolean;
  riskPassed: boolean;
  riskReasons: string[];
  reviewStatus: string;
}

export interface Finding {
  role: string;
  status: string;
  summary: string;
  confidence: number;
  uncertainties: string[];
}

export interface Assessment {
  status: string;
  score: number;
  valuation_status: string;
  resale_value_low_minor: number | null;
  resale_value_high_minor: number | null;
  estimated_net_low_minor: number | null;
  estimated_net_high_minor: number | null;
  comparable_count: number;
  currency: string;
  confidence: number;
  findings: Finding[];
  conflicts: string[];
  next_actions: string[];
  purchase_authorized: boolean;
}

export interface VisualInspection {
  identified?: boolean;
  exact_model?: string;
  condition_grade?: string;
  details?: string;
  uncertainty_notes?: string[];
}

export type AgentTaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "CHECKPOINTED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | (string & {});

export interface TreasureAnalysisTask {
  taskId: string;
  status: AgentTaskStatus;
  result?: {
    assessment?: Assessment;
    visual_inspection?: VisualInspection;
    purchase_authorized?: boolean;
    authenticity_verified?: boolean;
  } | null;
  correlationId?: string;
  attempt?: number;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
  hasError?: boolean;
}

export interface EnqueuedAnalysis {
  taskId: string;
  status: AgentTaskStatus;
  correlationId?: string;
  execution?: string;
}

export interface OperationsOverview {
  status: string;
  readOnly: boolean;
  config: {
    tradingMode: string;
    liveTradingEnabled: boolean;
    testnetEnabled: boolean;
    emergencyStop: boolean;
  };
  providers: Array<{
    providerId: string;
    displayName: string;
    capabilities: string[];
    simulated: boolean;
  }>;
  queue: { pendingTasks: number; runningTasks: number; failedTasks: number };
  outbox: { pending: number; processing: number; deadLetters: number };
  killSwitch: { blockedScopes: number; failClosed: boolean };
  database: { reachable: boolean };
}

export const POLLABLE_TASK_STATUSES: readonly string[] = ["QUEUED", "RUNNING", "CHECKPOINTED"];
export const TERMINAL_TASK_STATUSES: readonly string[] = ["SUCCEEDED", "FAILED", "CANCELLED"];

export function isPollableTaskStatus(status: string): boolean {
  return POLLABLE_TASK_STATUSES.includes(status);
}

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}
