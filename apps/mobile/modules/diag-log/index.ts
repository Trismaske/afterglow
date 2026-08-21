/**
 * JS entry for the local diag-log Expo module (Android-only): the
 * rotating on-device diagnostics sink (m0.8.7). Lines arrive fully
 * formed from `src/lib/diagLog.ts` — this binding only hands them to the
 * native appender. A missing native side (iOS, web, a dev client built
 * before the module existed) collapses to a no-op: diagnostics degrade
 * to plain logcat, never to an error.
 */
import { requireOptionalNativeModule } from 'expo';

interface NativeApi {
  append(lines: string[]): Promise<null>;
  logDirPath(): string;
}

const native = requireOptionalNativeModule<NativeApi>('DiagLog');

/** Whether the native sink exists in this build. */
export function diagSinkAvailable(): boolean {
  return native != null;
}

/** Append pre-formatted lines to the rotating sink. Throws on I/O
 * failure when the module is present; resolves as a no-op when absent. */
export async function appendDiagLines(lines: string[]): Promise<void> {
  if (!native || lines.length === 0) return;
  await native.append(lines);
}

/** The sink directory's absolute path, or null without the module. */
export function diagLogDirPath(): string | null {
  try {
    return native?.logDirPath() ?? null;
  } catch {
    return null;
  }
}
