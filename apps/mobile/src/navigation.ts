/** Route params. Screens read review data from ReviewContext (m0.8). */
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/**
 * Bottom tabs (m0.8 gate 4): Home · Edit · Favourite · Share · Organize,
 * count-badged. The bar exists only on these five surfaces — full-screen
 * review (Groups/Deck/Compare/…) lives in the parent stack above it.
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
  /** fromHome: opened via the Home queue card for global-queue
   * maintenance — confirming returns Home instead of the Summary. */
  CullList: { fromHome?: boolean } | undefined;
  Summary: undefined;
  /** History (m0.7): re-decidable current-state feed + share events. */
  History: undefined;
  /** Day-scoped inbox-zero progress. `day` is a local "YYYY-MM-DD" key. */
  DayProgress: { day: string };
  /** Global progress: state summary / filtered grid / state editor. */
  Progress: { label: string; startMs: number; endMs: number };
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
