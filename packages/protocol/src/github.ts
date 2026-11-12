// Settings › GitHub (PLNR-96): the integration's state as an admin sees it, GET /api/v1/workspaces/:ws/github.

/** A webhook delivery as settings show it. */
export interface GithubDeliveryView {
  id: string;
  /** With the action: pull_request.closed. */
  event: string;
  repo: string | null;
  at: string;
  status: number;
  error: string | null;
}

export interface GithubInstallationView {
  id: number;
  account: string;
  /** User or Organization. */
  type: string;
  /** Repositories of this installation that feed the workspace. */
  repositories: number;
  installedAt: string;
  installedBy: string | null;
  suspended: boolean;
}

export interface GithubRepoView {
  name: string;
  /** Project keys as they are now: the projects the repository is bound to, else those its links reach. */
  projects: string[];
  defaultBranch: string;
  enabled: boolean;
  lastDeliveryAt: string | null;
  error: string | null;
}

export interface GithubStatus {
  /** What is set on the server. All true: enabled; otherwise the rest of the answer is empty. */
  setup: { appId: boolean; privateKey: boolean; webhookSecret: boolean; installed: boolean };
  /** The App as GitHub answered with this key. `error`: GitHub refused it or could not be reached. */
  app: { slug: string | null; error: string | null; checkedAt: string | null };
  installations: GithubInstallationView[];
  lastDelivery: GithubDeliveryView | null;
  lastError: GithubDeliveryView | null;
  repositories: GithubRepoView[];
}
