package expo.modules.mediastoreactions

import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MediaStoreActionsModule : Module() {
  private lateinit var launcher: AppContextActivityResultLauncher<MediaStoreActionInput, Boolean>
  private var volumeReceiver: BroadcastReceiver? = null
  private var shareChosenReceiver: BroadcastReceiver? = null

  companion object {
    /** Same-app broadcast carrying the chooser's chosen-component
     * callback (m0.8.6 D10). Explicit action + setPackage + NOT_EXPORTED:
     * only the system-filled PendingIntent below ever sends it. */
    private const val ACTION_SHARE_CHOSEN = "expo.modules.mediastoreactions.SHARE_CHOSEN"
    private const val EXTRA_SHARE_TOKEN = "shareToken"
  }

  override fun definition() = ModuleDefinition {
    Name("MediaStoreActions")

    // m0.8.3 (Tristan, matrix): mount changes while the app stays
    // FOREGROUNDED have no navigation or AppState signal — the OS
    // broadcast is the only push. MEDIA_* are protected system
    // broadcasts (system-only senders), so no export flag concerns.
    // m0.8.6 D10: shareTargetChosen relays the chooser's
    // EXTRA_CHOSEN_COMPONENT — the fact "the user handed this batch to
    // an app", which is what promotes a share pass to 'shared'.
    Events("volumesChanged", "shareTargetChosen")

    OnCreate {
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_MEDIA_MOUNTED)
        addAction(Intent.ACTION_MEDIA_UNMOUNTED)
        addAction(Intent.ACTION_MEDIA_EJECT)
        addAction(Intent.ACTION_MEDIA_REMOVED)
        addAction(Intent.ACTION_MEDIA_BAD_REMOVAL)
        addDataScheme("file")
      }
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          sendEvent("volumesChanged", mapOf("action" to (intent.action ?: "")))
        }
      }
      volumeReceiver = receiver
      appContext.reactContext?.registerReceiver(receiver, filter)

      val chosen = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          @Suppress("DEPRECATION")
          val component = intent.getParcelableExtra<android.content.ComponentName>(
            Intent.EXTRA_CHOSEN_COMPONENT,
          )
          sendEvent(
            "shareTargetChosen",
            mapOf(
              "token" to intent.getIntExtra(EXTRA_SHARE_TOKEN, -1),
              "component" to (component?.flattenToShortString() ?: ""),
            ),
          )
        }
      }
      shareChosenReceiver = chosen
      // NOT_EXPORTED on EVERY API level (codex r2): the send side is an
      // explicit same-package PendingIntent, so nothing legitimate ever
      // arrives from outside — an exported registration on API 30-32
      // let any installed app forge a chosen event with a guessed
      // sequential token and promote an abandoned batch to 'shared'.
      // ContextCompat enforces the same isolation below 33 through the
      // androidx per-app signature permission.
      appContext.reactContext?.let {
        ContextCompat.registerReceiver(
          it,
          chosen,
          IntentFilter(ACTION_SHARE_CHOSEN),
          ContextCompat.RECEIVER_NOT_EXPORTED,
        )
      }
    }

    OnDestroy {
      volumeReceiver?.let { appContext.reactContext?.unregisterReceiver(it) }
      volumeReceiver = null
      shareChosenReceiver?.let { appContext.reactContext?.unregisterReceiver(it) }
      shareChosenReceiver = null
    }

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

    // D15 EXIF date rescue (m0.8.3): one header-only ExifInterface read
    // of DateTimeOriginal per photo that landed UNDATED at ingestion.
    // READ-ONLY by contract — the app never modifies original photo
    // bytes; the files are complete (exiftool-verified) and the gap is
    // Android's extraction, so there is nothing to repair. A failed read
    // reports its error string and a null date — the caller logs the
    // fallback loudly and the photo stays honestly undated.
    AsyncFunction("readExifDateTimeOriginal") { uriStrings: List<Uri> ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val resolver = context.contentResolver
      uriStrings.map { uri ->
        val (value, error) = exifDateTimeOriginal(resolver, uri)
        mapOf(
          "uri" to uri.toString(),
          "dateTimeOriginal" to value,
          "error" to error,
        )
      }
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

    // createWriteRequest approval probe: the documented path to write
    // access for other apps' media. Reuses the standard consent
    // launcher; reports approved/cancelled like trash/favourite.
    AsyncFunction("requestWriteAccess") Coroutine { uris: List<Uri> ->
      launch(uris, MediaStoreAction.WRITE, true)
    }

    // Volume-aware album catalog (m0.7 item E, C#2): the JS-side catalog
    // keys by lower-cased relative path and erases volume identity, so the
    // organize boundary needs this native query. Counts are per
    // (volume, bucket); the same DCIM/Camera path on primary and SD
    // storage yields two distinct entries.
    AsyncFunction("mediaGenerations") {
      // MediaStore's per-volume change counter (API 30+): bumps on ANY
      // insert/update/delete, so an unchanged generation is an OS-level
      // guarantee the library did not change — the scan skip's evidence.
      //
      // KEYED "<volume>|<version>": generations are comparable ONLY while
      // MediaStore.getVersion is unchanged (the contract requires a full
      // re-sync when it moves — a provider rebuild resets counters, so an
      // equal number would be a coincidence, not a proof). Baking the
      // version into the key makes a rebuild mismatch every stored key:
      // the skip fingerprint differs and the delta planner sees an
      // unknown volume, both of which land on a full pass with no
      // version-aware logic anywhere in JS. Volume names never contain
      // '|'; JS recovers the raw name as everything before the first '|'.
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val out = mutableMapOf<String, Double>()
      for (volume in MediaStore.getExternalVolumeNames(context)) {
        try {
          val version = MediaStore.getVersion(context, volume)
          out["$volume|$version"] = MediaStore.getGeneration(context, volume).toDouble()
        } catch (error: Exception) {
          // FAIL THE WHOLE CALL. This map is the scan skip's PROOF that
          // nothing changed, and a proof missing a volume is not a
          // proof — yet a partial map fingerprints and compares just
          // fine, so the same volume failing on two launches would
          // skip the scan forever while its photos changed underneath.
          // The caller catches this and simply does not skip.
          throw IllegalStateException("generation unreadable for volume $volume", error)
        }
      }
      out
    }

    /**
     * Rows whose MediaStore generation exceeds `since` on one volume —
     * the change discovery a DELTA scan is built on (m0.8.2 phase 1).
     *
     * TRASHED ROWS ARE INCLUDED (`QUERY_ARG_MATCH_TRASHED` /
     * `MATCH_INCLUDE`), and that is the point. A user "deleting" a photo
     * in their gallery is `createTrashRequest`: the
     * row SURVIVES with `IS_TRASHED = 1` for 30 days, and MediaStore
     * filters such rows out of every query by default. So the deletion
     * that a full pass can only infer from an absence shows up here as
     * an ordinary MODIFIED row — provided trashing bumps the generation,
     * which is exactly what phase 1 exists to measure.
     *
     * Fails the whole call on any error, for the same reason
     * `mediaGenerations` does: a partial change set is indistinguishable
     * from a complete one, and acting on it would silently skip photos.
     */
    AsyncFunction("mediaChangedSince") { volume: String, since: Double ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val out = mutableListOf<Map<String, Any?>>()
      val uri = MediaStore.Images.Media.getContentUri(volume)
      val selection =
        "${MediaStore.MediaColumns.GENERATION_ADDED} > ? OR " +
          "${MediaStore.MediaColumns.GENERATION_MODIFIED} > ?"
      val bound = since.toLong().toString()
      val queryArgs = android.os.Bundle().apply {
        putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_INCLUDE)
        putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
        putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(bound, bound))
      }
      try {
        context.contentResolver.query(
          uri,
          arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DATE_TAKEN,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.IS_TRASHED,
            MediaStore.MediaColumns.GENERATION_ADDED,
            MediaStore.MediaColumns.GENERATION_MODIFIED,
          ),
          queryArgs,
          null,
        )?.use { cursor ->
          val idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
          val takenCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_TAKEN)
          val modifiedCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
          val trashedCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.IS_TRASHED)
          val addedGenCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.GENERATION_ADDED)
          val modGenCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.GENERATION_MODIFIED)
          while (cursor.moveToNext()) {
            out.add(
              mapOf(
                "volumeName" to volume,
                "rawId" to cursor.getLong(idCol).toString(),
                // DATE_TAKEN is ms since epoch and NULL for undated
                // photos; DATE_MODIFIED is SECONDS. The JS side owns the
                // fallback, so both are reported raw.
                "dateTakenMs" to if (cursor.isNull(takenCol)) null else cursor.getLong(takenCol),
                "dateModifiedSec" to
                  if (cursor.isNull(modifiedCol)) null else cursor.getLong(modifiedCol),
                "isTrashed" to (cursor.getInt(trashedCol) != 0),
                "generationAdded" to cursor.getLong(addedGenCol).toDouble(),
                "generationModified" to cursor.getLong(modGenCol).toDouble(),
              ),
            )
          }
        } ?: throw IllegalStateException("null cursor for volume $volume")
      } catch (error: Exception) {
        throw IllegalStateException("change query failed for volume $volume", error)
      }
      out
    }

    /**
     * The mounted volume set (m0.8.3 phase 2, codex): reachability
     * decisions must never run blind, so the scan REQUIRES this and
     * aborts when it throws. MediaStore names every mounted volume
     * itself (primary → 'external_primary', others → lowercased FS UUID
     * — the identical mapping mechanism D applies to paths).
     */
    AsyncFunction("listMountedVolumes") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      MediaStore.getExternalVolumeNames(context).toList()
    }

    /**
     * Per-volume image counts (m0.8.3 phase 2) — one side of the
     * per-volume scan tripwires when the scope is "All folders" (a dirs
     * scope counts its own buckets instead). Default query args, so
     * trashed and pending rows are excluded exactly as they are from the
     * paging the scan does.
     *
     * ALL VOLUMES OR NONE, same rule as mediaGenerations: a partial
     * count map is indistinguishable from a complete one, and a missing
     * volume would hide exactly the tripwire this exists to fire.
     */
    AsyncFunction("countImagesByVolume") { volumes: List<String> ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val out = mutableMapOf<String, Double>()
      for (volume in volumes) {
        try {
          val uri = MediaStore.Images.Media.getContentUri(volume)
          val count = context.contentResolver.query(
            uri,
            arrayOf(MediaStore.MediaColumns._ID),
            null,
            null,
            null,
          )?.use { cursor -> cursor.count }
            ?: throw IllegalStateException("null cursor for volume $volume")
          out[volume] = count.toDouble()
        } catch (error: Exception) {
          throw IllegalStateException("count failed for volume $volume", error)
        }
      }
      out
    }

    AsyncFunction("listImageAlbums") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val out = mutableListOf<Map<String, Any?>>()
      val volumes = MediaStore.getExternalVolumeNames(context)
      for (volume in volumes) {
        val uri = MediaStore.Images.Media.getContentUri(volume)
        val counts = HashMap<Long, Triple<String, String, Int>>()
        try {
          val cursorOrNull = context.contentResolver.query(
            uri,
            arrayOf(
              MediaStore.Images.Media.BUCKET_ID,
              MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
              MediaStore.Images.Media.RELATIVE_PATH,
            ),
            null,
            null,
            null,
          )
          // A NULL cursor is a failed query, not an empty volume — the
          // `?.use` shortcut silently produced a partial catalog that
          // passed as complete, the exact all-volumes-or-none violation
          // the catch below exists to prevent (codex r5).
          ?: throw IllegalStateException("album query returned null cursor for volume $volume")
          cursorOrNull.use { cursor ->
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
          // FAIL THE WHOLE CALL, for the same reason as the generations
          // above: a partial catalog is indistinguishable from a
          // complete one. Silently dropping a volume hides the folders
          // the user selected on it, and can make the "is DCIM/Camera
          // present?" default-source probe answer no and broaden the
          // scope to every folder — the exact fail-OPEN the source
          // contract forbids. JS treats the error as "no catalog".
          throw IllegalStateException("album query failed for volume $volume", error)
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
    // m0.8.3 final cycle Q2: image details by CANONICAL volume-qualified
    // content URI. The merged-collection raw-id lookup (Expo) can resolve
    // ANOTHER volume's row when raw ids collide across volumes; querying
    // the exact per-volume URI is collision-proof. DATE_MODIFIED is
    // converted to ms here so JS consumers share one unit.
    AsyncFunction("queryImageDetails") { uriStrings: List<Uri> ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context unavailable")
      val resolver = context.contentResolver
      uriStrings.map { uri ->
        try {
          val row = resolver.query(
            uri,
            arrayOf(
              MediaStore.MediaColumns.DISPLAY_NAME,
              MediaStore.MediaColumns.DATE_MODIFIED,
              MediaStore.Images.Media.DATE_TAKEN,
              MediaStore.MediaColumns.DATA,
            ),
            null,
            null,
            null,
          )?.use { c ->
            if (c.moveToFirst()) mapOf(
              "uri" to uri.toString(),
              "status" to "found",
              "displayName" to (if (c.isNull(0)) null else c.getString(0)),
              "dateModifiedMs" to (if (c.isNull(1)) null else c.getLong(1) * 1000),
              "dateTakenMs" to (if (c.isNull(2)) null else c.getLong(2)),
              "data" to (if (c.isNull(3)) null else c.getString(3)),
            ) else null
          }
          row ?: mapOf("uri" to uri.toString(), "status" to "absent")
        } catch (error: Exception) {
          mapOf(
            "uri" to uri.toString(),
            "status" to "error",
            "message" to (error.message ?: error.javaClass.simpleName),
          )
        }
      }
    }

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
              //
              // "verification failed" is a SENTINEL, not prose: it is the
              // one message string the TS side compares (lib/
              // organizeFailures.ts UNVERIFIED_SENTINEL), because it is
              // ours rather than Android's. Every other message reaches
              // the user quoted verbatim and unparsed. Reword this and
              // that constant together, or an unconfirmed move silently
              // degrades to the generic "Android refused" line.
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
    //
    // m0.8.6 D10: the chooser carries an IntentSender (API 22+), so the
    // system reports WHICH app the user picked — the shareTargetChosen
    // event, keyed by `token` (the JS side passes its batch id). The
    // PendingIntent must be MUTABLE: the system fills
    // EXTRA_CHOSEN_COMPONENT into it. A dismissed sheet fires nothing —
    // absence of the event by foreground return IS the abandonment fact.
    AsyncFunction("shareUris") { uris: List<Uri>, token: Int ->
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
      val context = appContext.reactContext
        ?: return@AsyncFunction mapOf("result" to "error", "message" to "No context")
      val chosenIntent = Intent(ACTION_SHARE_CHOSEN).apply {
        setPackage(context.packageName)
        putExtra(EXTRA_SHARE_TOKEN, token)
      }
      val pending = android.app.PendingIntent.getBroadcast(
        context,
        token,
        chosenIntent,
        android.app.PendingIntent.FLAG_MUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val chooser = Intent.createChooser(send, null, pending.intentSender).apply {
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

  /** The one D15 read: DateTimeOriginal via a streamed header-only
   * ExifInterface parse. Returns (value, error) — exactly one is
   * non-null unless the tag is simply absent (null, null). A NULL input
   * stream is an ERROR, not an absent tag (codex r2): nothing was
   * parsed, so reporting it as a completed read would stamp the
   * once-per-content marker and permanently suppress the retry. */
  private fun exifDateTimeOriginal(resolver: ContentResolver, uri: Uri): Pair<String?, String?> =
    try {
      val stream = resolver.openInputStream(uri)
        ?: return Pair(null, "openInputStream returned null")
      val value = stream.use { s ->
        ExifInterface(s).getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
      }
      Pair(value, null)
    } catch (error: Exception) {
      Pair(null, "${error.javaClass.simpleName}: ${error.message}")
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
    val resolver = appContext.reactContext?.contentResolver ?: return null
    return resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
      if (!cursor.moveToFirst()) return@use null
      val index = cursor.getColumnIndex(column)
      if (index < 0) null else cursor.getInt(index) != 0
    }
  }
}
