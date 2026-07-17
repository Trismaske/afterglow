/** Stack route params. Screens read session data from SessionContext. */
export type RootStackParamList = {
  Home: undefined;
  Groups: undefined;
  Duel: undefined;
  Singles: undefined;
  CullList: undefined;
  Summary: undefined;
  /** To-edit queue: every photo flagged "needs edit", across all days. */
  EditQueue: undefined;
  /** Day-scoped inbox-zero progress. `day` is a local "YYYY-MM-DD" key. */
  DayProgress: { day: string };
};
