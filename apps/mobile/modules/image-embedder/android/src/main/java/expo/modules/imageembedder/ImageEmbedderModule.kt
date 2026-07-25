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
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * MediaPipe Image Embedder (MobileNetV3-large, bundled asset) — the m0.8
 * grouping feature (docs/Plan_m0.8.md; study data in docs/grouping-study/).
 *
 * embed(uri) decodes a MediaStore content uri (EXIF orientation applied,
 * long edge capped at DECODE_CAP px), runs the embedder (L2-normalized,
 * float32), and returns per-stage timings plus the vector as base64-encoded
 * little-endian float32 bytes — compact across the bridge; JS decodes with
 * Float32Array when it needs the values.
 */
private const val MODEL_ASSET = "mobilenet_v3_large.tflite"
private const val DECODE_CAP = 1024

class ImageEmbedderModule : Module() {
  private var embedder: ImageEmbedder? = null

  private fun requireEmbedder(): ImageEmbedder {
    embedder?.let { return it }
    val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "no react context", null)
    val options = ImageEmbedderOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL_ASSET).build())
      .setL2Normalize(true)
      .setQuantize(false)
      .build()
    return ImageEmbedder.createFromOptions(context, options).also { embedder = it }
  }

  private fun decode(uriString: String): Bitmap {
    val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "no react context", null)
    val uri = Uri.parse(uriString)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val source = ImageDecoder.createSource(context.contentResolver, uri)
      return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val long = maxOf(info.size.width, info.size.height)
        // ceil so the decoded long edge never exceeds DECODE_CAP
        if (long > DECODE_CAP) decoder.setTargetSampleSize((long + DECODE_CAP - 1) / DECODE_CAP)
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      }
    }
    // API 24–27 fallback: sampled decode (power-of-two ceiling keeps the long
    // edge ≤ DECODE_CAP) + EXIF rotation, matching the ImageDecoder path.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri).use { stream ->
      BitmapFactory.decodeStream(stream, null, bounds)
    }
    val long = maxOf(bounds.outWidth, bounds.outHeight)
    if (long <= 0) throw CodedException("DECODE_FAILED", uriString, null)
    var sample = 1
    while (long / sample > DECODE_CAP) sample *= 2
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

  override fun definition() = ModuleDefinition {
    Name("ImageEmbedder")

    OnDestroy {
      embedder?.close()
      embedder = null
    }

    AsyncFunction("embed") { uriString: String ->
      val t0 = SystemClock.elapsedRealtime()
      val bitmap = decode(uriString)
      val t1 = SystemClock.elapsedRealtime()
      // close() recycles the decoded bitmap — required during sustained backfill
      val result = BitmapImageBuilder(bitmap).build().use { image ->
        requireEmbedder().embed(image)
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
      )
    }
  }
}
