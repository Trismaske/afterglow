package expo.modules.mediastoreactions

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.MediaStore
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MediaStoreActionsModule : Module() {
  private lateinit var launcher: AppContextActivityResultLauncher<MediaStoreActionInput, Boolean>

  override fun definition() = ModuleDefinition {
    Name("MediaStoreActions")

    RegisterActivityContracts {
      launcher = registerForActivityResult(MediaStoreActionContract(this@MediaStoreActionsModule))
    }

    AsyncFunction("trash") Coroutine { uris: List<Uri> ->
      launch(uris, MediaStoreAction.TRASH, true)
    }

    AsyncFunction("setFavourite") Coroutine { uris: List<Uri>, value: Boolean ->
      launch(uris, MediaStoreAction.FAVOURITE, value)
    }

    AsyncFunction("isFavourite") Coroutine { uri: Uri ->
      queryFlag(uri, MediaStore.MediaColumns.IS_FAVORITE)
    }

    AsyncFunction("isTrashed") Coroutine { uri: Uri ->
      queryFlag(uri, MediaStore.MediaColumns.IS_TRASHED)
    }

    // ---- Gate-0 editor-launch diagnostic matrix (m0.7 item A) ----------
    // These functions exist to PROVE the Samsung grant failure mode before
    // any fix is chosen. They make no persistent changes.

    // Environment + permission probe: who are we, what does Android say
    // about our URI read/write permission, can we actually open the bytes,
    // and which handler packages are visible (possibly partial without
    // <queries> entries — that partiality is itself a diagnostic datum).
    AsyncFunction("editDiagnostics") { uri: Uri ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val resolver = context.contentResolver
      val readPerm = context.checkUriPermission(
        uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION,
      )
      val writePerm = context.checkUriPermission(
        uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
      val openStream = try {
        resolver.openInputStream(uri)?.use { it.read() }
        "ok"
      } catch (error: Exception) {
        "${error.javaClass.simpleName}: ${error.message}"
      }
      mapOf(
        "sdkInt" to Build.VERSION.SDK_INT.toString(),
        "device" to "${Build.MANUFACTURER} ${Build.MODEL}",
        "myUid" to Process.myUid().toString(),
        "myPackage" to context.packageName,
        "readPerm" to permissionLabel(readPerm),
        "writePerm" to permissionLabel(writePerm),
        "openStream" to openStream,
        "editHandlers" to visibleHandlers(uri, Intent.ACTION_EDIT),
        "viewHandlers" to visibleHandlers(uri, Intent.ACTION_VIEW),
      )
    }

    // One launch probe: dispatch the real intent with the requested grant
    // mode and report what the dispatch itself did. Resolves immediately —
    // the user observes whether an app opened and records it in the UI.
    AsyncFunction("probeLaunch") { uri: Uri, action: String, withWrite: Boolean ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction mapOf("result" to "error", "message" to "No current activity")
      val intent = Intent(action)
        .setDataAndType(uri, "image/*")
        .addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
            (if (withWrite) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0),
        )
      try {
        activity.startActivity(intent)
        mapOf("result" to "launched", "message" to "dispatch accepted")
      } catch (error: SecurityException) {
        mapOf("result" to "security", "message" to (error.message ?: "SecurityException"))
      } catch (error: ActivityNotFoundException) {
        mapOf("result" to "no_handler", "message" to (error.message ?: "ActivityNotFoundException"))
      } catch (error: Exception) {
        mapOf("result" to "error", "message" to "${error.javaClass.simpleName}: ${error.message}")
      }
    }

    // createWriteRequest approval probe (Android 11+): the documented path
    // to write access for other apps' media. Reuses the standard consent
    // launcher; reports approved/cancelled like trash/favourite.
    AsyncFunction("requestWriteAccess") Coroutine { uris: List<Uri> ->
      launch(uris, MediaStoreAction.WRITE, true)
    }

    // Multi-pass share (m0.7 item E, N#5/C#10): ACTION_SEND for one URI,
    // ACTION_SEND_MULTIPLE for more, read grant on every URI, wrapped in a
    // chooser. Resolves at DISPATCH (never waits for the sheet) so the JS
    // side can durably promote `launching` → `sheet_opened` immediately —
    // the at-most-once accounting boundary.
    AsyncFunction("shareUris") { uris: List<Uri> ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction mapOf("result" to "error", "message" to "No current activity")
      val send = if (uris.size == 1) {
        Intent(Intent.ACTION_SEND).apply {
          type = "image/*"
          putExtra(Intent.EXTRA_STREAM, uris[0])
        }
      } else {
        Intent(Intent.ACTION_SEND_MULTIPLE).apply {
          type = "image/*"
          putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
        }
      }
      send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      val chooser = Intent.createChooser(send, null).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      try {
        activity.startActivity(chooser)
        mapOf("result" to "dispatched", "message" to "sheet dispatch accepted")
      } catch (error: Exception) {
        mapOf("result" to "error", "message" to "${error.javaClass.simpleName}: ${error.message}")
      }
    }
  }

  private fun permissionLabel(result: Int): String =
    if (result == PackageManager.PERMISSION_GRANTED) "granted" else "denied"

  private fun visibleHandlers(uri: Uri, action: String): String {
    val pm = appContext.reactContext?.packageManager ?: return "unavailable"
    val intent = Intent(action).setDataAndType(uri, "image/*")
    return try {
      val handlers = pm.queryIntentActivities(intent, 0).map { it.activityInfo.packageName }
      if (handlers.isEmpty()) "none visible" else handlers.distinct().joinToString(", ")
    } catch (error: Exception) {
      "${error.javaClass.simpleName}: ${error.message}"
    }
  }

  private suspend fun launch(
    uris: List<Uri>,
    action: MediaStoreAction,
    value: Boolean,
  ): Map<String, String> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return mapOf("status" to "unsupported")
    }
    if (uris.isEmpty()) {
      return mapOf("status" to "applied")
    }
    val approved = launcher.launch(MediaStoreActionInput(uris, action, value))
    return mapOf("status" to if (approved) "applied" else "cancelled")
  }

  private fun queryFlag(uri: Uri, column: String): Boolean? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
    val resolver = appContext.reactContext?.contentResolver ?: return null
    return resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
      if (!cursor.moveToFirst()) return@use null
      val index = cursor.getColumnIndex(column)
      if (index < 0) null else cursor.getInt(index) != 0
    }
  }
}
