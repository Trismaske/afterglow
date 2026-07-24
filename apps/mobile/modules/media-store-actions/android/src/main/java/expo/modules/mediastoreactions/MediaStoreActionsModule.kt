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

    // Quad-state presence: a SUCCESSFUL query with an empty cursor is
    // authoritative "absent" (MATCH_INCLUDE covers trashed rows), while
    // every failure path — no context, null cursor, missing column,
    // exception — is "unknown". Feed reconciliation must never mistake a
    // transient failure for a deleted photo.
    AsyncFunction("mediaPresence") Coroutine { uri: Uri ->
      mediaPresenceOf(uri)
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

    // Volume-aware album catalog (m0.7 item E, C#2): the JS-side catalog
    // keys by lower-cased relative path and erases volume identity, so the
    // organize boundary needs this native query. Counts are per
    // (volume, bucket); the same DCIM/Camera path on primary and SD
    // storage yields two distinct entries.
    AsyncFunction("listImageAlbums") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val out = mutableListOf<Map<String, Any?>>()
      val volumes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        MediaStore.getExternalVolumeNames(context)
      } else {
        setOf("external")
      }
      for (volume in volumes) {
        val uri = MediaStore.Images.Media.getContentUri(volume)
        val counts = HashMap<Long, Triple<String, String, Int>>()
        try {
          context.contentResolver.query(
            uri,
            arrayOf(
              MediaStore.Images.Media.BUCKET_ID,
              MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
              MediaStore.Images.Media.RELATIVE_PATH,
            ),
            null,
            null,
            null,
          )?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
            val nameCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
            val pathCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)
            while (cursor.moveToNext()) {
              val bucket = cursor.getLong(idCol)
              val name = cursor.getString(nameCol) ?: continue
              val path = cursor.getString(pathCol) ?: continue
              val prev = counts[bucket]
              counts[bucket] = Triple(name, path, (prev?.third ?: 0) + 1)
            }
          }
        } catch (error: Exception) {
          // A failed volume yields no entries — callers treat partial
          // catalogs as fail-closed for organize targets.
          continue
        }
        for ((bucket, entry) in counts) {
          out.add(
            mapOf(
              "volumeName" to volume,
              "bucketId" to bucket.toString(),
              "displayName" to entry.first,
              "relativePath" to entry.second,
              "photoCount" to entry.third,
            ),
          )
        }
      }
      out
    }

    // READ-ONLY path lookup for the organize crash-repair precheck: the
    // mutating move must never run before consent — a lingering write
    // grant from an earlier batch would let resolver.update succeed
    // early. Nulls on any failure.
    AsyncFunction("queryRelativePaths") { uriStrings: List<Uri> ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val resolver = context.contentResolver
      uriStrings.map { uri ->
        try {
          val pair = resolver.query(
            uri,
            arrayOf(MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DATA),
            null,
            null,
            null,
          )?.use { c -> if (c.moveToFirst()) Pair(c.getString(0), c.getString(1)) else null }
          mapOf(
            "uri" to uri.toString(),
            "relativePath" to pair?.first,
            "data" to pair?.second,
          )
        } catch (error: Exception) {
          mapOf("uri" to uri.toString(), "relativePath" to null, "data" to null)
        }
      }
    }

    // Organize move (m0.7 item E, R#6): RELATIVE_PATH update per URI,
    // verified by re-query. Callers obtain write access first
    // (createWriteRequest); a move to the current path is reported
    // "already" so retries recognize completion without another prompt
    // (N#8).
    AsyncFunction("moveToRelativePath") { uriStrings: List<Uri>, relativePath: String ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
        return@AsyncFunction uriStrings.map {
          mapOf("uri" to it.toString(), "status" to "unsupported", "message" to "Requires Android 11")
        }
      }
      val resolver = context.contentResolver
      uriStrings.map { uri ->
        try {
          val current = resolver.query(
            uri,
            arrayOf(MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DATA),
            null,
            null,
            null,
          )?.use { c -> if (c.moveToFirst()) Pair(c.getString(0), c.getString(1)) else null }
          // RELATIVE_PATH can be null (legacy media at the volume root)
          // — a null source path is never "already at target". The same
          // non-empty DATA rule as the post-update verify applies: an
          // 'already' without a usable repair path would clear the queue
          // while the stored uri stays stale, with no retry route.
          val currentPath = current?.first
          val currentData = current?.second
          if (currentPath != null && currentPath.trimEnd('/') == relativePath.trimEnd('/') &&
            !currentData.isNullOrEmpty()
          ) {
            // Crash-retry repair: MediaStore already holds the target path
            // but SQLite may not — return the current data path so the
            // caller's uri refresh happens on this branch too.
            mapOf(
              "uri" to uri.toString(),
              "status" to "already",
              "message" to "already at target",
              "newData" to currentData,
            )
          } else {
            val values = android.content.ContentValues().apply {
              put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
            }
            resolver.update(uri, values, null, null)
            // Verify: the row must now report the target path.
            val after = resolver.query(
              uri,
              arrayOf(MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DATA),
              null,
              null,
              null,
            )?.use { c ->
              if (c.moveToFirst()) Pair(c.getString(0), c.getString(1)) else null
            }
            val afterPath = after?.first
            val afterData = after?.second
            if (
              afterPath != null && afterPath.trimEnd('/') == relativePath.trimEnd('/') &&
              !afterData.isNullOrEmpty()
            ) {
              mapOf(
                "uri" to uri.toString(),
                "status" to "moved",
                "message" to "verified",
                "newData" to afterData,
              )
            } else {
              // Missing/null path data is UNVERIFIED — reporting success
              // without a usable newData would clear the queue while the
              // stored uri stays stale, with no retry path.
              mapOf("uri" to uri.toString(), "status" to "error", "message" to "verification failed")
            }
          }
        } catch (error: Exception) {
          mapOf(
            "uri" to uri.toString(),
            "status" to "error",
            "message" to "${error.javaClass.simpleName}: ${error.message}",
          )
        }
      }
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

  /** Full-library read access. Android 14 "selected photos" access is
   * granted-but-partial: MediaStore queries silently filter to the
   * selection, so an empty cursor proves NOTHING about unselected
   * assets — emptiness is only authoritative with full access. */
  private fun hasFullImagesAccess(): Boolean {
    val context = appContext.reactContext ?: return false
    val permission = if (Build.VERSION.SDK_INT >= 33) {
      "android.permission.READ_MEDIA_IMAGES"
    } else {
      "android.permission.READ_EXTERNAL_STORAGE"
    }
    return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
  }

  private fun mediaPresenceOf(uri: Uri): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "unknown"
    val resolver = appContext.reactContext?.contentResolver ?: return "unknown"
    val queryArgs = android.os.Bundle().apply {
      putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE)
    }
    return try {
      val cursor = resolver.query(
        uri,
        arrayOf(MediaStore.MediaColumns.IS_TRASHED),
        queryArgs,
        null,
      ) ?: return "unknown"
      cursor.use { c ->
        if (!c.moveToFirst()) {
          if (hasFullImagesAccess()) "absent" else "unknown"
        } else {
          val index = c.getColumnIndex(MediaStore.MediaColumns.IS_TRASHED)
          when {
            index < 0 -> "unknown"
            c.getInt(index) != 0 -> "trashed"
            else -> "present"
          }
        }
      }
    } catch (error: Exception) {
      "unknown"
    }
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
