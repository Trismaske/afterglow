package expo.modules.mediastoreactions

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Matrix
import android.graphics.Rect
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedRef
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The F22 region-zoom pipeline's native half (m0.8.8, G3 + D1–D7):
 * per-photo BitmapRegionDecoder instances behind integer handles, plus
 * the two decodes the JS overlay orders — a BASE (the whole image at a
 * JS-chosen power-of-2 sample) and a PATCH (a JS-chosen source rect at
 * a JS-chosen sample). All geometry decisions (D2 base formula, D4
 * sample selection, D5 margins, D7 retention) live in
 * src/lib/regionZoom.ts — this file only decodes what it is told.
 *
 * Delivery is a SharedRef<Bitmap> with nativeRefType "image" (D6):
 * expo-image's `source` prop accepts it directly (zero-copy, lossless);
 * JS releases refs explicitly when the retention cache evicts.
 *
 * ARGB_8888 everywhere — 16-bit banding would corrupt keep/cull
 * judgments (G3). Decodes run on Dispatchers.IO via the module's
 * Coroutine functions and serialize per decoder instance (BitmapRegion-
 * Decoder is not thread-safe); a decode racing a close loses cleanly
 * (the recycled decoder throws, surfaced as a rejected promise the JS
 * side fail-softs on).
 *
 * Formats: whatever BitmapRegionDecoder opens — JPEG, HEIF, and DNG via
 * its full-size embedded preview (all measured on the S10e, plan spike
 * section). A failed open rejects; JS logs once and leaves the overlay
 * on the stage-size cached image. No format allow-list.
 *
 * ORIENTATION: the decoders work in SENSOR space while every display
 * surface shows the EXIF-rotated image (portrait phone shots are
 * orientation=90 landscape files). `open` reports the rotation; JS maps
 * its display-space rects to sensor space (lib/regionZoom.ts, pure and
 * tested) and passes the rotation back, and the decode functions rotate
 * the finished bitmap so every returned ref is display-oriented.
 */

/** A decoded bitmap handed to expo-image's `source` prop (D6). */
class RegionBitmapRef(bitmap: Bitmap, appContext: AppContext) :
  SharedRef<Bitmap>(bitmap, appContext) {
  override val nativeRefType: String = "image"

  override fun getAdditionalMemoryPressure(): Int = ref.allocationByteCount
}

/** One open decoder; `lock` serializes decodes against close. */
private class OpenDecoder(val decoder: BitmapRegionDecoder) {
  val lock = Any()
  @Volatile var closed = false
}

object RegionZoom {
  private val handles = AtomicInteger(1)
  private val open = ConcurrentHashMap<Int, OpenDecoder>()

  data class Opened(
    val handle: Int,
    val width: Int,
    val height: Int,
    val rotation: Int,
    /** MediaStore DATE_MODIFIED (seconds; 0 = unknown) — JS invalidates
     * a retained base whose source bytes changed under the same id
     * (in-place edits keep id and uri — codex round 2). */
    val modTime: Long,
  )

  /** EXIF orientations carrying a REFLECTION (2 flip-H, 4 flip-V,
   * 5 transpose, 7 transverse): `rotationDegrees` collapses these to a
   * pure rotation, so the pipeline would render them unmirrored over
   * the correctly mirrored cached image. They reject into the
   * fail-soft path instead (codex round 2) — wrong content is never
   * the fallback. */
  private val MIRRORED_ORIENTATIONS = setOf(
    ExifInterface.ORIENTATION_FLIP_HORIZONTAL,
    ExifInterface.ORIENTATION_FLIP_VERTICAL,
    ExifInterface.ORIENTATION_TRANSPOSE,
    ExifInterface.ORIENTATION_TRANSVERSE,
  )

  fun open(resolver: ContentResolver, uri: Uri): Opened {
    val stream = resolver.openInputStream(uri)
      ?: throw IllegalStateException("Could not open stream for $uri")
    val decoder = stream.use { BitmapRegionDecoder.newInstance(it) }
      ?: throw IllegalStateException("BitmapRegionDecoder returned null for $uri")
    // EXIF orientation from a fresh stream (the decoder consumed the
    // first). A FAILED read rejects the open (codex round 1): degrading
    // to 0 would render a rotated photo's base and patches in sensor
    // orientation over the correctly-oriented cached image — wrong
    // content, not fail-soft. Rejecting keeps JS on the cached image
    // (the documented fail-soft path). Only a successful read that
    // genuinely reports 0 uses 0. Mirrored orientations reject too
    // (MIRRORED_ORIENTATIONS above).
    val rotation = try {
      val exif = resolver.openInputStream(uri)?.use { ExifInterface(it) }
        ?: throw IllegalStateException("Could not re-open stream for EXIF orientation")
      val orientation = exif.getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL,
      )
      if (orientation in MIRRORED_ORIENTATIONS) {
        throw IllegalStateException("Mirrored EXIF orientation $orientation is not supported")
      }
      exif.rotationDegrees
    } catch (e: Exception) {
      decoder.recycle()
      throw IllegalStateException("EXIF orientation unusable for $uri: ${e.message}")
    }
    // The app stores photo uris as file:// + the MediaStore DATA path
    // (lib/media.ts) — a resolver query cannot answer MediaStore
    // columns for that scheme (codex round 3: the round-2 query was
    // inert), so file uris read the filesystem mtime directly (ms;
    // equality is all JS compares, so units never mix across schemes —
    // a photo's uri is stable). content:// uris query DATE_MODIFIED.
    // 0 = unknown; JS treats unknown as UNVERIFIABLE and re-decodes.
    val modTime = try {
      if (uri.scheme == "file") {
        java.io.File(requireNotNull(uri.path)).lastModified()
      } else {
        resolver.query(uri, arrayOf(android.provider.MediaStore.MediaColumns.DATE_MODIFIED), null, null, null)
          ?.use { if (it.moveToFirst()) it.getLong(0) else 0L } ?: 0L
      }
    } catch (_: Exception) {
      0L
    }
    val handle = handles.getAndIncrement()
    open[handle] = OpenDecoder(decoder)
    return Opened(handle, decoder.width, decoder.height, rotation, modTime)
  }

  /** Rotate a decoded (sensor-space) bitmap to display orientation. */
  private fun rotated(bitmap: Bitmap, rotation: Int): Bitmap {
    if (rotation == 0) return bitmap
    val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
    val out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (out !== bitmap) bitmap.recycle()
    return out
  }

  fun decodeRegion(
    handle: Int,
    x: Int,
    y: Int,
    width: Int,
    height: Int,
    sampleSize: Int,
    rotation: Int,
  ): Bitmap {
    val entry = open[handle] ?: throw IllegalStateException("Region decoder $handle is closed")
    synchronized(entry.lock) {
      if (entry.closed) throw IllegalStateException("Region decoder $handle is closed")
      // Clamp defensively to the source bounds — a rect drifting a pixel
      // out (float geometry upstream) must not fail the decode.
      val left = x.coerceIn(0, entry.decoder.width - 1)
      val top = y.coerceIn(0, entry.decoder.height - 1)
      val right = (x + width).coerceIn(left + 1, entry.decoder.width)
      val bottom = (y + height).coerceIn(top + 1, entry.decoder.height)
      val options = BitmapFactory.Options().apply {
        inSampleSize = sampleSize.coerceAtLeast(1)
        inPreferredConfig = Bitmap.Config.ARGB_8888
      }
      val decoded = entry.decoder.decodeRegion(Rect(left, top, right, bottom), options)
        ?: throw IllegalStateException("decodeRegion returned null")
      return rotated(decoded, rotation)
    }
  }

  fun close(handle: Int) {
    val entry = open.remove(handle) ?: return // idempotent
    synchronized(entry.lock) {
      entry.closed = true
      entry.decoder.recycle()
    }
  }

  /** The base decode: the whole image at `sampleSize` (BitmapFactory —
   * measured path). JS computes the sample from the D2 formula against
   * the dimensions `open` reported. */
  fun decodeScaled(resolver: ContentResolver, uri: Uri, sampleSize: Int, rotation: Int): Bitmap {
    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSize.coerceAtLeast(1)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val stream = resolver.openInputStream(uri)
      ?: throw IllegalStateException("Could not open stream for $uri")
    val decoded = stream.use { BitmapFactory.decodeStream(it, null, options) }
      ?: throw IllegalStateException("Base decode returned null for $uri")
    return rotated(decoded, rotation)
  }
}
