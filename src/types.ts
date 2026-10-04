export type View = "today" | "program" | "recipes" | "prep" | "progress";
export type PlanMode = "full" | "modified";

export type DayEntry = {
  tasks: string[];
  water: number;
  reflection: string;
};

export type CoachState = {
  activeDay: number;
  planMode: PlanMode;
  days: Record<number, DayEntry>;
  reminders: boolean;
};

export type AccountUser = {
  openId: string;
  name: string;
  email: string;
};

export type WeightEntry = {
  id: number;
  weight: number;
  unit: "lb" | "kg";
  loggedAt: string;
};

export type ProgressPhoto = {
  id: number;
  capturedAt: string;
  caption: string;
  imageUrl: string;
};
