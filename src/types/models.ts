export type EntryFields = Record<string, string | number | boolean | undefined>;

export interface LogEntry {
  id: string;
  categoryId: string;
  at: string;
  fields: EntryFields;
  note: string;
  photos?: string[];
}

export interface BabyProfile {
  name: string;
  birthDate: string;
  gender: string;
  blood: string;
  avatar: string;
}

export type VaccineStatus = "todo" | "done";

export interface VaccineRow {
  id: string;
  name: string;
  dose: string;
  dueDate: string;
  status: VaccineStatus;
  doneAt: string;
}

export interface VaccineSettings {
  region: string;
  reminderDays: number;
  notificationsEnabled: boolean;
  notifiedMap: Record<string, boolean>;
}

export interface AuthUser {
  id: string;
  username: string;
  avatar: string;
}

export interface AuthState {
  token: string;
  user: AuthUser | null;
  csrf: string;
}

export type AiRole = "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
  ts: string;
}

export interface AiSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AiMessage[];
}

/** What the app may include in the client-built `baby_context` string sent to `/api/chat/stream`. */
export interface AiContextConsent {
  profile: boolean;
  vaccinesSummary: boolean;
  entriesSummary: boolean;
  includeNotesInEntries: boolean;
  includePhotosInEntries: boolean;
  /** When false, the backend will not register OpenAI-style tools (no DB reads via model). */
  allowServerTools: boolean;
}

export interface AiProject {
  instruction: string;
  activeSessionId: string;
  /** full_recent | stats_only | recent_7d | timeline_filter */
  contextPolicy: string;
  aiContextConsent?: Partial<AiContextConsent>;
  /** User acknowledged that AI sessions stay in localStorage unless exported. */
  syncSessionsDisclaimerAck?: boolean;
  sessions: AiSession[];
}

export interface FieldOption {
  v: string;
  t: string;
}

export type CategoryField =
  | {
      key: string;
      label: string;
      type: "text";
      placeholder?: string;
    }
  | {
      key: string;
      label: string;
      type: "number";
      step?: string;
      placeholder?: string;
    }
  | {
      key: string;
      label: string;
      type: "select";
      options: FieldOption[];
    };

export interface CategoryDef {
  id: string;
  label: string;
  emoji: string;
  fields: CategoryField[];
}

export interface VaccineTemplateRow {
  name: string;
  dose: string;
  day: number;
}

export interface ApiEntry {
  id: string;
  category_id: string;
  at: string;
  fields: Record<string, unknown>;
  note?: string;
  photos?: string[];
}

export interface AuthApiError extends Error {
  status?: number;
}
