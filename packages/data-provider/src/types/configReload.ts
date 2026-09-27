/** Results contain only section names and paths, never configuration values. */
export interface TConfigReloadSection {
  section: string;
  status: 'applied_live' | 'restart_required' | 'unchanged';
  restartRequired: boolean;
  restartRequiredPaths?: string[];
}

export interface TConfigReloadResult {
  scope: 'cluster' | 'local' | 'unchanged';
  distributed: boolean;
  generation?: number;
  propagationError?: string;
  sections: TConfigReloadSection[];
}

export interface TConfigReloadError {
  error: string;
  validationErrors?: Array<{ path: (string | number)[]; message: string }>;
}
