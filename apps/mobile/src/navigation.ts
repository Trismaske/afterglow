/** Stack route params. Screens read session data from SessionContext. */
export type RootStackParamList = {
  Home: undefined;
  Groups: undefined;
  /**
   * Swipe-deck group review (m0.4): page through a group, cull as you go.
   * m0.5: `groupId` opens a SPECIFIC group (any order, even a completed
   * one — browse/re-decide mode); omitted = the linear "continue" flow
   * (next incomplete group, then singles, then the cull list).
   */
  Deck: { groupId?: string } | undefined;
  /**
   * On-demand A/B flip + synced-zoom compare tool for two deck photos.
   * The verdict buttons record a compare (DuelRecord-shaped) and may cull.
   */
  Compare: { groupId?: string; aId: string; bId: string; singles?: boolean };
  Singles: undefined;
  CullList: undefined;
  Summary: undefined;
  /** To-edit queue: every photo flagged "needs edit", across all days. */
  EditQueue: undefined;
  /** Durable system-gallery favourite/unfavourite work. */
  FavouritesQueue: undefined;
  /** Multi-pass share queue (m0.7): persistent working set, sheet passes. */
  ShareQueue: undefined;
  /** Organize queue (m0.7): album moves via createWriteRequest. */
  OrganizeQueue: undefined;
  /** History (m0.7): re-decidable current-state feed + share events. */
  History: undefined;
  /** Day-scoped inbox-zero progress. `day` is a local "YYYY-MM-DD" key. */
  DayProgress: { day: string };
  /**
   * Global progress over the selected scope + source (m0.4): same state
   * summary / filtered grid / state editor as DayProgress. The range is
   * computed on Home at tap time (rolling scopes end at "now").
   */
  Progress: { label: string; startMs: number; endMs: number };
  /** Photo-source folder picker (m0.3.1): choose which directories feed reviews. */
  SourcePicker: undefined;
  /** App settings (m0.4): photo source, similarity threshold, version. */
  Settings: undefined;
};
