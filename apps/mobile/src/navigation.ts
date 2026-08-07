/** Route params. Screens read review data from ReviewContext (m0.8). */
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/**
 * Bottom tabs (m0.8.1): Edit · Favourite · Home · Organize · Share,
 * count-badged, with Home as the raised center circle (MainTabBar). The
 * bar exists only on these five surfaces — full-screen review
 * (Groups/Deck/Compare/…) lives in the parent stack above it.
 */
export type MainTabParamList = {
  Home: undefined;
  /** To-edit queue: every photo flagged "needs edit", across all days. */
  EditQueue: undefined;
  /** Durable system-gallery favourite/unfavourite work. */
  FavouritesQueue: undefined;
  /** Multi-pass share queue (m0.7): persistent working set, sheet passes. */
  ShareQueue: undefined;
  /** Organize queue (m0.7): album moves via createWriteRequest. */
  OrganizeQueue: undefined;
};

export type RootStackParamList = {
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  Groups: undefined;
  /**
   * Swipe-deck review (m0.4): page through a unit, cull as you go.
   *
   * ONE route for both unit kinds since m0.8.5 (L4). The deck holds its
   * current unit in state and advances internally, so the app enters
   * this route once per review sitting instead of remounting per unit —
   * the remount cost ~300 ms of blank screen between units (F6).
   * The params name the unit the deck OPENS on, and the deck keeps them
   * in step as it advances, so re-entering from Home or the Timeline
   * always re-seeds even when it names the unit the route opened on.
   *
   * `day` present  = a singles unit: ONE day (a local "YYYY-MM-DD" key,
   *   or the undated pseudo-day), optionally narrowed by `from`/`to` to
   *   a timeline RUN's inclusive taken_at range (lib/timeline.ts).
   * `groupId` only = a SPECIFIC group, in any order, a completed one
   *   included (browse/re-decide mode).
   * neither       = the linear "continue" flow (next incomplete unit,
   *   then the cull list).
   *
   * Read them through `unitFromParams` (screens/DeckScreen.tsx) rather
   * than by hand: it is the one place that discriminates the shapes.
   */
  Deck: { groupId?: string; day?: string; from?: number; to?: number } | undefined;
  /**
   * On-demand A/B flip + synced-zoom compare tool for two deck photos.
   * The verdict buttons record a compare (DuelRecord-shaped) and may
   * write verdicts through the keep-both/cull dialog (m0.8.2, F15).
   * `day`/`from`/`to` mirror the opening singles deck's scope so the
   * position labels number over the same rows the deck shows.
   */
  Compare: {
    groupId?: string;
    aId: string;
    bId: string;
    singles?: boolean;
    day?: string;
    from?: number;
    to?: number;
  };
  /** fromHome: opened via the Home queue card for global-queue
   * maintenance — confirming returns Home instead of the Summary. */
  CullList: { fromHome?: boolean } | undefined;
  Summary: undefined;
  /** History (m0.7): re-decidable current-state feed + share events. */
  History: undefined;
  /** Stats: today vs goal, 30-day activity, library breakdown, queues,
   * all-time totals (shares Summary's queries — lib/statsLoad.ts). */
  Stats: undefined;
  /** Day-scoped inbox-zero progress. `day` is a local "YYYY-MM-DD" key. */
  DayProgress: { day: string };
  /** Library progress: state summary / filtered grid / state editor.
   * PARAMLESS since m0.8.2 — the arbitrary date range it used to carry
   * was set by nothing after sessions were removed, and every caller
   * passed the whole library. A day is reached through DayProgress. */
  Progress: undefined;
  /** Photo-source folder picker (m0.3.1): choose which directories feed reviews. */
  SourcePicker: undefined;
  /** App settings: photo source, daily goal, grouping strictness, accent. */
  Settings: undefined;
};

/** Props for a bottom-tab screen (tab + parent stack navigation). */
export type MainTabScreenProps<T extends keyof MainTabParamList> = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, T>,
  NativeStackScreenProps<RootStackParamList>
>;
