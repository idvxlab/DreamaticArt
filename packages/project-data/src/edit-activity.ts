export interface EditActivity {
  at: string;
  actor: 'designer' | 'builder' | 'editor' | 'image' | 'system';
  label: string;
  state: 'started' | 'completed' | 'failed';
  detail?: string;
}

export interface EditAttempt {
  number: number;
  submittedAt: string;
  startedAt?: string;
  endedAt?: string;
  status?: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  events: EditActivity[];
  reportedTokens: number;
  reportedCalls: number;
  unreportedCalls: number;
}
