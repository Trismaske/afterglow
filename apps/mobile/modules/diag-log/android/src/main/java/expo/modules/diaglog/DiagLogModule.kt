package expo.modules.diaglog

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * The on-device diagnostics sink (m0.8.7): a rotating set of plain-text
 * segments in the app's external-files directory —
 * `Android/data/<pkg>/files/diag/diag-<epoch ms>.log` — readable by
 * `adb pull`, surviving locks, process death and reboots. 50 MB total as
 * ten 5 MB segments; the oldest segment is pruned when an append pushes
 * the count past ten. Lines arrive fully formed from the JS side
 * (timestamp + level + message) — this module only persists them.
 *
 * Device-local only: nothing here transmits anything anywhere. Export is
 * the parked field-diagnostics design's problem, gated on its own
 * scrub-or-disclose decision.
 */
private const val SEGMENT_MAX_BYTES = 5L * 1024 * 1024
private const val MAX_SEGMENTS = 10

class DiagLogModule : Module() {
  private val lock = Any()

  private fun diagDir(): File {
    val context = appContext.reactContext
      ?: throw IllegalStateException("Android context unavailable")
    // External-files is the adb-reachable home; the internal files dir is
    // the deliberate fallback for the rare unmounted-storage window —
    // loud, because pulls would come up empty while it is in effect.
    val external = context.getExternalFilesDir(null)
    if (external == null) {
      Log.w("DiagLog", "external files dir unavailable — diagnostics fall back to internal storage")
    }
    return File(external ?: context.filesDir, "diag")
  }

  private fun segments(dir: File): List<File> =
    (dir.listFiles { f -> f.isFile && f.name.startsWith("diag-") && f.name.endsWith(".log") })
      ?.sortedBy { it.name }
      ?: emptyList()

  override fun definition() = ModuleDefinition {
    Name("DiagLog")

    /** Append pre-formatted lines; rotates and prunes as needed. Throws
     * on I/O failure — the JS side treats that as "sink unavailable"
     * rather than pretending the lines landed. */
    AsyncFunction("append") { lines: List<String> ->
      if (lines.isEmpty()) return@AsyncFunction null
      val dir = diagDir()
      synchronized(lock) {
        if (!dir.exists() && !dir.mkdirs()) {
          throw IllegalStateException("cannot create ${dir.path}")
        }
        var current = segments(dir).lastOrNull()
        if (current == null || current.length() >= SEGMENT_MAX_BYTES) {
          current = File(dir, "diag-${System.currentTimeMillis()}.log")
        }
        current.appendText(lines.joinToString("\n", postfix = "\n"))
        val all = segments(dir)
        for (stale in all.dropLast(MAX_SEGMENTS)) {
          if (!stale.delete()) Log.w("DiagLog", "could not prune ${stale.name}")
        }
      }
      null
    }

    /** The sink directory's absolute path (Settings/debug surfaces; the
     * pull instructions in the docs quote it). */
    Function("logDirPath") {
      diagDir().path
    }
  }
}
