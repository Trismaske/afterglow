package expo.modules.imageembedder

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.imageembedder.ImageEmbedder
import com.google.mediapipe.tasks.vision.imageembedder.ImageEmbedder.ImageEmbedderOptions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * MediaPipe Image Embedder (MobileNetV3-large, bundled asset) — the m0.8
 * grouping feature (docs/Plan_m0.8.md; study data in docs/grouping-study/).
 *
 * embed(uri, decodeCap) decodes a MediaStore content uri (EXIF orientation
 * applied, long edge capped at decodeCap px — the caller-owned trade
 * between decode cost and downsampling fidelity; the JS wrapper supplies
 * the tuned default), runs the embedder (L2-normalized, float32), and
 * returns per-stage timings plus the vector as base64-encoded
 * little-endian float32 bytes — compact across the bridge; JS decodes with
 * Float32Array when it needs the values.
 */
private const val MODEL_ASSET = "mobilenet_v3_large.tflite"

class ImageEmbedderModule : Module() {
  /** Guards embedder lifecycle: teardown must not close it mid-inference. */
  private val embedderLock = Any()
  private var embedder: ImageEmbedder? = null
  private var destroyed = false

  private fun requireEmbedder(): ImageEmbedder {
    embedder?.let { return it }
    if (destroyed) throw CodedException("DESTROYED", "module torn down", null)
    val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "no react context", null)
    val options = ImageEmbedderOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL_ASSET).build())
      .setL2Normalize(true)
      .setQuantize(false)
      .build()
    return ImageEmbedder.createFromOptions(context, options).also { embedder = it }
  }

  // Every per-photo failure inside decodeInner surfaces as DECODE_FAILED so
  // JS can distinguish photo-level problems (skip the photo) from
  // engine-level ones (missing model, dead MediaPipe init — abort the scan).
  private fun decode(uriString: String, decodeCap: Int): Bitmap {
    if (decodeCap <= 0) throw CodedException("BAD_CAP", "decodeCap must be positive, got $decodeCap", null)
    try {
      return decodeInner(uriString, decodeCap)
    } catch (e: CodedException) {
      throw e
    } catch (e: Exception) {
      throw CodedException("DECODE_FAILED", uriString, e)
    }
  }

  private fun decodeInner(uriString: String, decodeCap: Int): Bitmap {
    val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "no react context", null)
    val uri = Uri.parse(uriString)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val source = ImageDecoder.createSource(context.contentResolver, uri)
      return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val long = maxOf(info.size.width, info.size.height)
        // ceil so the decoded long edge never exceeds decodeCap
        if (long > decodeCap) decoder.setTargetSampleSize((long + decodeCap - 1) / decodeCap)
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      }
    }
    // API 24–27 fallback: sampled decode (power-of-two ceiling keeps the long
    // edge ≤ decodeCap) + EXIF rotation, matching the ImageDecoder path.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri).use { stream ->
      BitmapFactory.decodeStream(stream, null, bounds)
    }
    val long = maxOf(bounds.outWidth, bounds.outHeight)
    if (long <= 0) throw CodedException("DECODE_FAILED", uriString, null)
    var sample = 1
    while (long / sample > decodeCap) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    val bitmap = context.contentResolver.openInputStream(uri).use { stream ->
      BitmapFactory.decodeStream(stream, null, opts)
    } ?: throw CodedException("DECODE_FAILED", uriString, null)
    val orientation = context.contentResolver.openInputStream(uri).use { stream ->
      if (stream == null) ExifInterface.ORIENTATION_NORMAL
      else ExifInterface(stream).getAttributeInt(
        ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    }
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
      else -> return bitmap
    }
    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (rotated !== bitmap) bitmap.recycle()
    return rotated
  }

  /**
   * 64-bit dHash of a decoded bitmap, replicating the app's pure pipeline
   * (lib/dhashDecode.ts lumaGridFromRgba + core dhash64) exactly: 8×9
   * box-averaged Rec.601 luma cells, bit = 1 when the right cell is
   * strictly brighter, row-major, MSB first, 16-char lowercase hex.
   * Computed here so the corpus scan gets vector + hash from ONE decode —
   * the expo-image-manipulator hash path leaks natively at corpus scale
   * (measured: lmkd kill at 4.5 GB RSS mid-backfill).
   */
  private fun dhashOf(bitmap: Bitmap): String {
    val w = bitmap.width
    val h = bitmap.height
    val rows = 8
    val cols = 9
    if (w < cols || h < rows) throw CodedException("TOO_SMALL", "image ${w}x$h below dhash grid", null)
    val pixels = IntArray(w * h)
    bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
    val cells = DoubleArray(rows * cols)
    for (r in 0 until rows) {
      val y0 = r * h / rows
      val y1 = maxOf(y0 + 1, (r + 1) * h / rows)
      for (c in 0 until cols) {
        val x0 = c * w / cols
        val x1 = maxOf(x0 + 1, (c + 1) * w / cols)
        var sum = 0.0
        for (y in y0 until y1) {
          var i = y * w + x0
          for (x in x0 until x1) {
            val p = pixels[i++]
            sum += 0.299 * ((p shr 16) and 0xff) + 0.587 * ((p shr 8) and 0xff) + 0.114 * (p and 0xff)
          }
        }
        cells[r * cols + c] = sum / ((y1 - y0) * (x1 - x0))
      }
    }
    var hash = 0L
    for (r in 0 until rows) for (c in 0 until cols - 1) {
      hash = (hash shl 1) or (if (cells[r * cols + c + 1] > cells[r * cols + c]) 1L else 0L)
    }
    return String.format("%016x", hash)
  }

  override fun definition() = ModuleDefinition {
    Name("ImageEmbedder")

    OnDestroy {
      synchronized(embedderLock) {
        destroyed = true
        embedder?.close()
        embedder = null
      }
    }

    // Coroutine on Dispatchers.Default so concurrent embed() calls DECODE in
    // parallel (a plain AsyncFunction serializes whole calls on the module
    // queue — measured on the S10e: zero overlap, 126 ms/photo effective at
    // any worker count). Inference stays serialized by embedderLock, so the
    // pipeline cost approaches max(decode, infer) with ≥ 2 JS workers.
    AsyncFunction("embed") Coroutine { uriString: String, decodeCap: Int, withDhash: Boolean ->
      withContext(Dispatchers.Default) {
        val t0 = SystemClock.elapsedRealtime()
        val bitmap = decode(uriString, decodeCap)
        try {
          val t1 = SystemClock.elapsedRealtime()
          // dHash rides the same decode (before inference — MPImage.close()
          // recycles the bitmap). A photo below the 9x8 hash grid still
          // embeds fine (MediaPipe resizes) — the OPTIONAL hash just
          // comes back null rather than failing the whole embed.
          val dhash = if (withDhash) {
            try {
              dhashOf(bitmap)
            } catch (e: CodedException) {
              if (e.code != "TOO_SMALL") throw e
              null
            }
          } else null
          // close() recycles the decoded bitmap — required during sustained
          // backfill; the lock keeps OnDestroy from closing the embedder
          // mid-inference
          val result = BitmapImageBuilder(bitmap).build().use { image ->
            synchronized(embedderLock) { requireEmbedder().embed(image) }
          }
          val t2 = SystemClock.elapsedRealtime()
          val vec = result.embeddingResult().embeddings()[0].floatEmbedding()
          val bytes = ByteBuffer.allocate(vec.size * 4).order(ByteOrder.LITTLE_ENDIAN)
          for (v in vec) bytes.putFloat(v)
          mapOf(
            "decodeMs" to (t1 - t0).toInt(),
            "inferMs" to (t2 - t1).toInt(),
            "dim" to vec.size,
            "vecB64" to Base64.encodeToString(bytes.array(), Base64.NO_WRAP),
            "dhashHex" to dhash,
          )
        } finally {
          if (!bitmap.isRecycled) bitmap.recycle()
        }
      }
    }

    // Standalone hash for photos whose embedding is already cached (the
    // scan's one-time hash backfill): one bounded decode, no inference.
    // The caller passes the SAME cap as the embed path — a hash must not
    // depend on which path produced it (the near-dup floor compares them).
    AsyncFunction("dhash") Coroutine { uriString: String, decodeCap: Int ->
      withContext(Dispatchers.Default) {
        val bitmap = decode(uriString, decodeCap)
        try {
          dhashOf(bitmap)
        } finally {
          bitmap.recycle()
        }
      }
    }
  }
}
