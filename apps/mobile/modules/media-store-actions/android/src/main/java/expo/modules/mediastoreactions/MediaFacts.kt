/**
 * Media-kind facts (m0.9 phase 4) — the kind-aware half of the module.
 *
 * Two mechanisms live here:
 *
 *  1. The FILES-collection row shape every kind-aware MediaStore query
 *     shares (`MEDIA_KIND_SELECTION`, `MEDIA_FACTS_PROJECTION`,
 *     `mediaFactsRow`): images and videos are views over one files
 *     table, so one query answers for both kinds and the row's
 *     MEDIA_TYPE names the collection its actions must address.
 *  2. The bounded per-file read (`readMediaFactsOf`): motion-photo
 *     detection from the file's XMP plus M17's measurement rescue, one
 *     open per content version. READ-ONLY by contract — the app never
 *     modifies original media bytes.
 *
 * Motion detection reads the XMP through androidx ExifInterface, which
 * follows JPEG's segment table and HEIF's item index itself (the format
 * spike of 2026-09-08 found HEIC's XMP 1.58 MB into the file, AFTER the
 * primary image, so no fixed head read could find it). The XMP is
 * parsed by LOCAL NAME, never by prefix: the spike saw `GCamera:` and
 * `Camera:`, `Item:` and `ContainerItem:` across Samsung and Google
 * writers. Two shapes, both proven on real files:
 *
 *  - Android Motion Photo 1.0: `MotionPhoto="1"` and a Container
 *    Directory whose item with Semantic="MotionPhoto" carries the
 *    video's byte Length — the video is the LAST Length bytes of the
 *    file (file size − Length landed on the MP4's ftyp box on all four
 *    specimens: S23, S10e, Google JPEG, Google HEIC).
 *  - MicroVideo (older Google/Samsung): `MicroVideo="1"` and
 *    MicroVideoOffset = bytes from the end of the file (Google's sample).
 *
 * Attribute form only (every specimen); Samsung's SEF trailer is NOT
 * parsed — every Samsung motion photo seen carries the XMP, and the
 * trailer is present on plain stills too, so it is no signal by itself.
 */
package expo.modules.mediastoreactions

import android.content.Context
import android.database.Cursor
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.SystemClock
import android.provider.MediaStore
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** One per-file read request: which facts the caller is missing. */
class MediaFactsRequest : Record {
  @Field val uri: String = ""
  /** 'photo' | 'video' — the stored kind; videos are never motion photos
   * and measure through the metadata reader instead of a bitmap decode. */
  @Field val kind: String = "photo"
  @Field val motion: Boolean = false
  @Field val dimensions: Boolean = false
  @Field val duration: Boolean = false
}

/** `MEDIA_TYPE IN (image, video)` — the Files-collection filter. */
internal val MEDIA_KIND_SELECTION: String =
  "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (" +
    "${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, " +
    "${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"

internal val MEDIA_FACTS_PROJECTION: Array<String> = arrayOf(
  MediaStore.MediaColumns._ID,
  MediaStore.MediaColumns.DATA,
  MediaStore.MediaColumns.DISPLAY_NAME,
  MediaStore.MediaColumns.DATE_TAKEN,
  MediaStore.MediaColumns.DATE_MODIFIED,
  MediaStore.MediaColumns.GENERATION_MODIFIED,
  MediaStore.MediaColumns.WIDTH,
  MediaStore.MediaColumns.HEIGHT,
  MediaStore.MediaColumns.ORIENTATION,
  MediaStore.Files.FileColumns.MEDIA_TYPE,
  MediaStore.MediaColumns.MIME_TYPE,
  MediaStore.MediaColumns.DURATION,
  MediaStore.MediaColumns.SIZE,
)

internal fun kindOf(mediaType: Int): String =
  if (mediaType == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) "video" else "photo"

private fun Cursor.longOrNull(column: String): Long? {
  val index = getColumnIndexOrThrow(column)
  return if (isNull(index)) null else getLong(index)
}

private fun Cursor.stringOrNull(column: String): String? {
  val index = getColumnIndexOrThrow(column)
  return if (isNull(index)) null else getString(index)
}

/** One Files-collection row in the shape `loadMediaById` and
 * `queryMediaFacts` share. Nulls where MediaStore has no value — the JS
 * side owns every fallback (DATE_TAKEN → mtime, 0×0 → the measurement
 * rescue). WIDTH/HEIGHT are MediaStore's ENCODED dimensions with the
 * rotation kept apart in ORIENTATION; the row reports display-space
 * size (axes swapped for 90°/270°), the promise the schema makes. */
internal fun mediaFactsRow(cursor: Cursor): Map<String, Any?> {
  val encodedWidth = cursor.longOrNull(MediaStore.MediaColumns.WIDTH)?.toInt() ?: 0
  val encodedHeight = cursor.longOrNull(MediaStore.MediaColumns.HEIGHT)?.toInt() ?: 0
  val orientation = cursor.longOrNull(MediaStore.MediaColumns.ORIENTATION)?.toInt() ?: 0
  val swap = orientation == 90 || orientation == 270
  return mapOf(
  "rawId" to cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)).toString(),
  "dataPath" to cursor.stringOrNull(MediaStore.MediaColumns.DATA),
  "displayName" to cursor.stringOrNull(MediaStore.MediaColumns.DISPLAY_NAME),
  "dateTakenMs" to cursor.longOrNull(MediaStore.MediaColumns.DATE_TAKEN),
  "dateModifiedSec" to (cursor.longOrNull(MediaStore.MediaColumns.DATE_MODIFIED) ?: 0L),
  // The image cache version (m0.9 phase 3, item 3): bumps on ANY content
  // or metadata change, mtime-preserving editors included.
  "generationModified" to
    cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.GENERATION_MODIFIED))
      .toDouble(),
  "width" to (if (swap) encodedHeight else encodedWidth),
  "height" to (if (swap) encodedWidth else encodedHeight),
  "kind" to kindOf(cursor.getInt(cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE))),
  "mimeType" to cursor.stringOrNull(MediaStore.MediaColumns.MIME_TYPE),
  "durationMs" to cursor.longOrNull(MediaStore.MediaColumns.DURATION)?.toDouble(),
  "sizeBytes" to cursor.longOrNull(MediaStore.MediaColumns.SIZE)?.toDouble(),
  )
}

internal data class MotionFacts(val offset: Long, val length: Long, val presentationUs: Long?)

// Local-name matching: an optional `prefix:` before every name.
private val MOTION_FLAG = Regex("""[:\s]MotionPhoto\s*(?:=\s*"1"|>\s*1\s*<)""")
private val CONTAINER_ITEM = Regex("""<(?:\w+:)?Item\b([^>]*?)/?>""")
private val MOTION_SEMANTIC = Regex("""(?:\w+:)?Semantic\s*=\s*"MotionPhoto"""")
private val ITEM_LENGTH = Regex("""(?:\w+:)?Length\s*=\s*"(\d+)"""")
private val MOTION_TIMESTAMP = Regex("""MotionPhotoPresentationTimestampUs\s*=\s*"(-?\d+)"""")
private val MICRO_FLAG = Regex("""[:\s]MicroVideo\s*(?:=\s*"1"|>\s*1\s*<)""")
private val MICRO_OFFSET = Regex("""MicroVideoOffset\s*=\s*"(\d+)"""")
private val MICRO_TIMESTAMP = Regex("""MicroVideoPresentationTimestampUs\s*=\s*"(-?\d+)"""")

private fun presentation(match: MatchResult?): Long? =
  match?.groupValues?.get(1)?.toLongOrNull()?.takeIf { it >= 0 }

/** The embedded video's position from the XMP, or null when the XMP
 * declares no motion photo (or declares one whose length cannot fit the
 * file — treated as not-motion, never as a guess). */
internal fun parseMotionXmp(xmp: String, fileSize: Long): MotionFacts? {
  if (MOTION_FLAG.containsMatchIn(xmp)) {
    for (item in CONTAINER_ITEM.findAll(xmp)) {
      val attrs = item.groupValues[1]
      if (!MOTION_SEMANTIC.containsMatchIn(attrs)) continue
      val length = ITEM_LENGTH.find(attrs)?.groupValues?.get(1)?.toLongOrNull() ?: continue
      if (length <= 0 || length >= fileSize) return null
      return MotionFacts(fileSize - length, length, presentation(MOTION_TIMESTAMP.find(xmp)))
    }
    return null
  }
  if (MICRO_FLAG.containsMatchIn(xmp)) {
    val fromEnd = MICRO_OFFSET.find(xmp)?.groupValues?.get(1)?.toLongOrNull() ?: return null
    if (fromEnd <= 0 || fromEnd >= fileSize) return null
    return MotionFacts(fileSize - fromEnd, fromEnd, presentation(MICRO_TIMESTAMP.find(xmp)))
  }
  return null
}

/** Samsung SEF trailer: does its directory carry a MotionPhoto_Data
 * block (tag 0x0a30)? Layout (format spike, 2026-09-08): the file ends
 * in `<u32 dirLen>"SEFT"`; the directory starts dirLen bytes before
 * that with "SEFH", then a u32, a u32 block count, and 12-byte entries
 * `<u16 pad><u16 tag><u32 offset><u32 length>`. False on any shape
 * mismatch — this is a tripwire, never a detector. */
internal fun sefDeclaresMotion(fd: java.io.FileDescriptor, size: Long): Boolean {
  if (size < 16) return false
  return try {
    FileInputStream(fd).channel.use { channel ->
      val tail = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
      channel.read(tail, size - 8)
      tail.flip()
      val dirLen = tail.int.toLong()
      val magic = ByteArray(4).also { tail.get(it) }
      if (String(magic, Charsets.US_ASCII) != "SEFT" || dirLen <= 12 || dirLen > 4096) return false
      val start = size - 8 - dirLen
      if (start < 0) return false
      val dir = ByteBuffer.allocate(dirLen.toInt()).order(ByteOrder.LITTLE_ENDIAN)
      channel.read(dir, start)
      dir.flip()
      val head = ByteArray(4).also { dir.get(it) }
      if (String(head, Charsets.US_ASCII) != "SEFH") return false
      dir.int // version
      val blocks = dir.int
      if (blocks < 0 || blocks > 64) return false
      repeat(blocks) {
        if (dir.remaining() < 12) return false
        dir.short // pad
        val tag = dir.short.toInt() and 0xffff
        dir.int; dir.int
        if (tag == 0x0a30) return true
      }
      false
    }
  } catch (error: Exception) {
    false
  }
}

/** The bounded per-file read. 'ok' = a COMPLETED read (every requested
 * fact found or honestly unavailable); 'error' = nothing concluded, the
 * caller must not stamp its once-per-content marker. */
internal fun readMediaFactsOf(context: Context, request: MediaFactsRequest): Map<String, Any?> {
  val start = SystemClock.elapsedRealtime()
  val out = mutableMapOf<String, Any?>("uri" to request.uri)
  try {
    val uri = Uri.parse(request.uri)
    val resolver = context.contentResolver
    if (request.kind == "video") {
      if (request.dimensions || request.duration) {
        MediaMetadataRetriever().use { reader ->
          reader.setDataSource(context, uri)
          if (request.duration) {
            out["durationMs"] = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
              ?.toLongOrNull()?.toDouble()
          }
          if (request.dimensions) {
            val w = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
            val h = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
            val rotation =
              reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            if (w != null && h != null && w > 0 && h > 0) {
              val swap = rotation == 90 || rotation == 270
              out["width"] = if (swap) h else w
              out["height"] = if (swap) w else h
            }
          }
        }
      }
    } else if (request.motion || request.dimensions) {
      val pfd = resolver.openFileDescriptor(uri, "r")
        ?: throw IllegalStateException("openFileDescriptor returned null")
      pfd.use {
        val exif = ExifInterface(it.fileDescriptor)
        if (request.motion) {
          // A completed read needs the file size the offsets derive from;
          // an unknown size (statSize -1 on some providers) is an ERROR,
          // never "no motion" — the caller must retry, not stamp.
          if (it.statSize < 0) throw IllegalStateException("file size unknown (statSize -1)")
          val xmp = exif.getAttributeBytes(ExifInterface.TAG_XMP)
          val motion = xmp?.let { bytes -> parseMotionXmp(String(bytes, Charsets.UTF_8), it.statSize) }
          out["motionOffset"] = motion?.offset?.toDouble()
          out["motionLength"] = motion?.length?.toDouble()
          out["motionPresentationUs"] = motion?.presentationUs?.toDouble()
          // The SEF tripwire (phase-4 close, Tristan 2026-09-09): the
          // trailer is NOT parsed for detection, but a file whose SEF
          // directory declares a MotionPhoto_Data block while its XMP
          // declares no motion is exactly the specimen the "XMP-less
          // Samsung motion photo" hypothesis lacks — reported so the
          // scan can log it once per pass. Reads ≤ a few hundred bytes.
          if (motion == null) out["sefMotionWithoutXmp"] = sefDeclaresMotion(it.fileDescriptor, it.statSize)
          if (motion != null) {
            // The embedded clip's duration — duration_ms describes motion
            // videos too. Read from the byte range the XMP named, never
            // an extracted copy; unreadable → honestly null.
            out["durationMs"] = try {
              MediaMetadataRetriever().use { reader ->
                reader.setDataSource(it.fileDescriptor, motion.offset, motion.length)
                reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                  ?.toLongOrNull()?.toDouble()
              }
            } catch (error: Exception) {
              null
            }
          }
        }
        if (request.dimensions) {
          val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
          // A missing stream is an ERROR (the read never happened), not
          // an honestly-unknown size.
          val stream = resolver.openInputStream(uri)
            ?: throw IllegalStateException("openInputStream returned null")
          stream.use { BitmapFactory.decodeStream(it, null, options) }
          if (options.outWidth > 0 && options.outHeight > 0) {
            val swap = exif.rotationDegrees == 90 || exif.rotationDegrees == 270
            out["width"] = if (swap) options.outHeight else options.outWidth
            out["height"] = if (swap) options.outWidth else options.outHeight
          }
        }
      }
    }
    out["status"] = "ok"
  } catch (error: Exception) {
    out["status"] = "error"
    out["message"] = "${error.javaClass.simpleName}: ${error.message}"
  }
  out["elapsedMs"] = (SystemClock.elapsedRealtime() - start).toDouble()
  return out
}
