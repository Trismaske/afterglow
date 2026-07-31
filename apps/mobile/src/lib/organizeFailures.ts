/**
 * Why an organize move failed, in words a human can act on (m0.8.4) —
 * pure, unit-tested; the impure partner is OrganizeQueueScreen's move
 * loop, which renders this as one dialog after a run.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: classify from facts WE own,
 * never by reading Android's error text. A photo's own uri tells us it
 * lives in another app's storage; our own `unsupported` status tells us
 * the native module is absent. Both are stable across Android versions
 * and OEM skins, which exception wording is emphatically not — matching
 * on `"Primary directory ... not allowed"` would silently stop matching
 * the first time a vendor reworded it, and a diagnosis that quietly
 * degrades to nothing is worse than one that never claimed to know.
 *
 * Three tiers, always in this order:
 *   1. a cause we can PROVE from our data  → specific, actionable copy
 *   2. anything else                       → an honest generic line
 *   3. always, last                        → Android's own words, VERBATIM
 *
 * Tier 3 is what makes tiers 1-2 safe to be wrong: our reading sits
 * above the ground truth, never instead of it, so a misclassification
 * costs a confusing sentence rather than a false explanation. It is
 * also the line that makes a tester's screenshot diagnosable.
 *
 * If a future Android permits what tier 1 says it forbids, the move
 * simply succeeds and this copy stops appearing — a rule that goes
 * quiet when it becomes wrong, rather than one that starts lying.
 */

/** One failed row, as the move loop already holds it. */
export interface OrganizeFailure {
  /** `photos.uri` — the file:// path the scan stamped. Our data. */
  uri: string;
  /** Our own status, not Android's. */
  status: 'error' | 'unsupported';
  /**
   * Whatever rode back with the outcome. For a platform refusal this is
   * Android's own `"<ExceptionName>: <message>"`. NEVER parsed — quoted
   * verbatim in tier 3 and nowhere else.
   */
  message: string;
}

export interface OrganizeFailureReport {
  title: string;
  body: string;
}

/**
 * The native module's sentinel for "the update ran but the row does not
 * report the target path". OURS, not Android's — `moveToRelativePath`
 * writes this exact literal, and the Kotlin carries a note to change
 * both sides together. This is the one message string we compare, and
 * it is only safe because we author it.
 */
const UNVERIFIED_SENTINEL = 'verification failed';

/**
 * The package that owns a photo's storage, or null when it is ordinary
 * shared media. `Android/media/<pkg>` is the tree MediaStore indexes for
 * other apps (WhatsApp's images live there); `Android/data/<pkg>` is its
 * private sibling. Photos under either belong to that app, and Android
 * does not let us move files out of another package's storage.
 */
export function appOwningPackage(uri: string): string | null {
  return /\/Android\/(?:media|data)\/([A-Za-z0-9_.]+)\//.exec(uri)?.[1] ?? null;
}

type Cause = 'app-folder' | 'module-missing' | 'unverified' | 'unknown';

function causeOf(failure: OrganizeFailure): Cause {
  if (failure.status === 'unsupported') return 'module-missing';
  // Path first: an app-folder photo can never move, whatever else is
  // true of the attempt, and that is the one cause with real advice.
  if (appOwningPackage(failure.uri) !== null) return 'app-folder';
  if (failure.message === UNVERIFIED_SENTINEL) return 'unverified';
  return 'unknown';
}

function photos(n: number): string {
  return `${n} photo${n === 1 ? '' : 's'}`;
}

/** Agreement helpers. Every count here can be 1, and a dialog reading
 * "1 photo live in…" undercuts the copy it is trying to deliver — the
 * device pass caught exactly that, so each sentence below picks its
 * verb and pronoun explicitly rather than assuming plural. */
const one = (n: number) => n === 1;
const they = (n: number) => (one(n) ? 'it' : 'they');
const They = (n: number) => (one(n) ? 'It' : 'They');

/** How many distinct raw messages tier 3 prints before it stops. Two is
 * enough to show a run failed for more than one reason without turning
 * the dialog into a log. */
const MAX_QUOTED = 2;

/**
 * One dialog for a whole move run. Null when nothing failed — the
 * caller keeps its plain success toast for that path.
 *
 * Deliberately NOT per-photo: a run that fails 40 WhatsApp photos has
 * one cause and should say it once. Counts carry the scale.
 */
export function describeOrganizeFailures(
  failures: readonly OrganizeFailure[],
): OrganizeFailureReport | null {
  if (failures.length === 0) return null;

  const byCause = new Map<Cause, OrganizeFailure[]>();
  for (const failure of failures) {
    const cause = causeOf(failure);
    byCause.set(cause, [...(byCause.get(cause) ?? []), failure]);
  }

  const lines: string[] = [];

  const appFolder = byCause.get('app-folder');
  if (appFolder) {
    // Name the packages we actually found rather than a friendly label:
    // a package id is a fact, and a prettifying lookup table would be one
    // more thing that rots. Sorted so the sentence is stable run to run.
    const owners = [...new Set(appFolder.map((f) => appOwningPackage(f.uri)!))].sort();
    const n = appFolder.length;
    lines.push(
      `${photos(n)} ${one(n) ? 'lives' : 'live'} in another app's own storage ` +
        `(${owners.join(', ')}). Android does not let Afterglow move files out of another ` +
        `app's folder, so ${they(n)} will keep failing — remove ${they(n)} from the queue.`,
    );
  }

  const moduleMissing = byCause.get('module-missing');
  if (moduleMissing) {
    const n = moduleMissing.length;
    lines.push(
      `Afterglow's media module is not available in this build, so ${photos(n)} ` +
        `${one(n) ? 'was' : 'were'} left untouched.`,
    );
  }

  const unverified = byCause.get('unverified');
  if (unverified) {
    const n = unverified.length;
    lines.push(
      `Android did not confirm the new location for ${photos(n)}. ${They(n)} may or may not ` +
        `have moved, so ${they(n)} ${one(n) ? 'stays' : 'stay'} queued rather than being ` +
        `reported as done.`,
    );
  }

  const unknown = byCause.get('unknown');
  if (unknown) {
    const n = unknown.length;
    lines.push(
      `Android refused to move ${photos(n)}. ${They(n)} ${one(n) ? 'stays' : 'stay'} queued.`,
    );
  }

  // TIER 3. Verbatim, unparsed, last — the ground truth under whatever
  // the lines above claim. Blank messages are dropped rather than
  // printed as an empty quote.
  const quoted = [...new Set(failures.map((f) => f.message.trim()).filter(Boolean))];
  if (quoted.length > 0) {
    const shown = quoted.slice(0, MAX_QUOTED);
    const more = quoted.length - shown.length;
    lines.push(
      `Android said:\n${shown.map((m) => `• ${m}`).join('\n')}` +
        (more > 0 ? `\n• …and ${more} other message${more === 1 ? '' : 's'}` : ''),
    );
  }

  return {
    title: `Could not move ${photos(failures.length)}`,
    body: lines.join('\n\n'),
  };
}
